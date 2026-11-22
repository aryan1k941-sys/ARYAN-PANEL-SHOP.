'use strict';
// Admin security: single-session lock, device list, kick/revoke, intruder auto-ban, security event log.
// All state lives in server-only RTDB nodes (admin_sessions, admin_security, security_events, security_blocklist).
const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ipKey = (ip) => String(ip || 'unknown').replace(/[^A-Za-z0-9]/g, '_').slice(0, 60);
const SecErr = (m, code, status) => { const e = new Error(m); e.code = code; e.status = status; return e; };

function parseUA(ua = '') {
  ua = String(ua);
  const os = /Android ([\d.]+)/.test(ua) ? 'Android ' + RegExp.$1 : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Windows NT ([\d.]+)/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const type = /Mobile|Android|iPhone/.test(ua) ? 'mobile' : /iPad|Tablet/.test(ua) ? 'tablet' : 'desktop';
  return { os, browser: br, type, label: `${br} on ${os}` };
}
function jwtAuthTime(tok) { try { const p = JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64').toString('utf8')); return Number(p.auth_time) || 0; } catch (e) { return 0; } }

class AdminSec {
  constructor(fb, env = process.env, log = console) {
    this.fb = fb; this.env = env; this.log = log;
    this.adminEmails = new Set(String(env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    this.recovery = String(env.ADMIN_RECOVERY_CODE || '');
    this.required = env.ADMIN_SESSION_REQUIRED !== '0';
    this.freshSec = Number(env.ADMIN_FRESH_LOGIN_SEC) || 600;
    this._touch = new Map(); this._strikes = new Map();
  }
  async settings() {
    let s = null; try { s = await this.fb.get('admin_security/settings'); } catch (e) {}
    s = s || {};
    return { policy: s.policy === 'replace' ? 'replace' : 'lock', idleMin: Math.min(240, Math.max(5, Number(s.idleMin) || 20)), strictIp: !!s.strictIp };
  }
  async saveSettings(b) {
    const cur = await this.settings();
    const n = { policy: b.policy === 'replace' ? 'replace' : b.policy === 'lock' ? 'lock' : cur.policy, idleMin: Math.min(240, Math.max(5, Number(b.idleMin) || cur.idleMin)), strictIp: b.strictIp === undefined ? cur.strictIp : !!b.strictIp };
    await this.fb.set('admin_security/settings', n); return n;
  }
  async event(type, o = {}) {
    const row = { ts: Date.now(), type, email: o.email || '', ip: o.ip || '', device: o.ua ? parseUA(o.ua).label : '', detail: String(o.detail || '').slice(0, 160), severity: o.severity || 'info' };
    try { await this.fb.push('security_events', row); } catch (e) { this.log.warn && this.log.warn('[sec] event write failed', e.message); }
    return row;
  }
  async events(n = 60) {
    let r = null; try { r = await this.fb.query('security_events', { orderBy: '$key', limitToLast: n }); } catch (e) { r = null; }
    return Object.entries(r || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.ts - a.ts);
  }
  /* ---- IP blocklist ---- */
  async isBlocked(ip) {
    try { const b = await this.fb.get('security_blocklist/ips/' + ipKey(ip)); if (b && (!b.until || b.until > Date.now())) return true; } catch (e) {}
    return false;
  }
  async blockIp(ip, reason, hours = 24) { await this.fb.set('security_blocklist/ips/' + ipKey(ip), { ip, reason: String(reason || '').slice(0, 100), at: Date.now(), until: hours ? Date.now() + hours * 3600000 : 0 }); }
  async unblock(key) { await this.fb.remove('security_blocklist/ips/' + ipKey(key)); }
  async blocklist() { let b = null; try { b = await this.fb.get('security_blocklist/ips'); } catch (e) {} return Object.entries(b || {}).map(([k, v]) => ({ key: k, ...v })).filter(x => !x.until || x.until > Date.now()); }

  /** Someone who is NOT an admin touched the admin API. Block the IP, ban the account, log it. Never touches real admins. */
  async intruder({ email, uid, ip, ua, why }) {
    email = String(email || '').toLowerCase();
    if (email && this.adminEmails.has(email)) return;
    const actions = [];
    if (this.env.ADMIN_AUTOBAN === '0') { await this.event('intruder_blocked', { email, ip, ua, severity: 'critical', detail: why + ' (auto-ban OFF)' }); return; }
    try { await this.blockIp(ip, 'Admin panel intrusion: ' + why, 24); actions.push('ip-blocked'); } catch (e) {}
    if (email) {
      try {
        const users = await this.fb.get('users'); let n = 0;
        for (const [id, u] of Object.entries(users || {})) if (u && String(u.email || '').toLowerCase() === email && u.status !== 'Banned') { await this.fb.update('users/' + id, { status: 'Banned', bannedReason: 'Admin panel intrusion attempt', bannedAt: Date.now() }); n++; }
        if (n) actions.push(n + ' user banned');
      } catch (e) {}
      if (uid && this.fb.disableAuthUser) { try { await this.fb.disableAuthUser(uid); actions.push('auth-disabled'); } catch (e) {} }
    }
    await this.event('intruder_blocked', { email, ip, ua, severity: 'critical', detail: `${why} → ${actions.join(', ') || 'logged'}` });
  }

  /* ---- sessions ---- */
  async _all() { let s = null; try { s = await this.fb.get('admin_sessions'); } catch (e) {} return s || {}; }
  async _active(idleMs) {
    const all = await this._all(), now = Date.now(), out = [];
    for (const [id, s] of Object.entries(all)) { if (!s) continue; if (now - (s.lastSeen || 0) > idleMs) { this.fb.remove('admin_sessions/' + id).catch(() => {}); continue; } out.push({ id, ...s }); }
    return out;
  }
  async login({ user, idToken, ip, ua, recoveryCode }) {
    const st = await this.settings(), idleMs = st.idleMin * 60000;
    if (jwtAuthTime(idToken) && Date.now() / 1000 - jwtAuthTime(idToken) > this.freshSec) throw SecErr('Password se naya login karo (purana token chal nahi sakta)', 'ESTALE', 401);
    const active = await this._active(idleMs);
    if (active.length) {
      const okRec = this.recovery && recoveryCode && crypto.timingSafeEqual(Buffer.from(sha(recoveryCode)), Buffer.from(sha(this.recovery)));
      if (okRec) { for (const a of active) await this.fb.remove('admin_sessions/' + a.id); await this.event('recovery_login', { email: user.email, ip, ua, severity: 'warn', detail: 'Recovery code se purane sessions hataye' }); }
      else if (st.policy === 'lock') {
        const a = active[0]; await this.event('login_blocked', { email: user.email, ip, ua, severity: 'warn', detail: 'Doosra device login ki koshish — admin already logged in (' + (a.device && a.device.label) + ')' });
        throw SecErr(`Admin panel abhi doosre device (${(a.device && a.device.label) || 'unknown'}) par khula hai. Wahan se logout karo ya Recovery Code use karo.`, 'ELOCKED', 409);
      } else { for (const a of active) await this.fb.remove('admin_sessions/' + a.id); await this.event('session_replaced', { email: user.email, ip, ua, severity: 'warn', detail: 'Naye login ne purana session hata diya' }); }
    }
    const token = crypto.randomBytes(32).toString('hex'), id = sha(token).slice(0, 24), now = Date.now();
    await this.fb.set('admin_sessions/' + id, { hash: sha(token), email: user.email, ip, ua: String(ua || '').slice(0, 200), device: parseUA(ua), createdAt: now, lastSeen: now });
    await this.event('login', { email: user.email, ip, ua, detail: 'Admin login OK' });
    return { sessionToken: token, sid: id, settings: st };
  }
  /** returns the session or throws ESESSION */
  async check(token, { ip, ua, user }) {
    if (!/^[0-9a-f]{64}$/.test(String(token || ''))) throw SecErr('Admin session missing — dobara login karo', 'ESESSION', 401);
    const id = sha(token).slice(0, 24); const s = await this.fb.get('admin_sessions/' + id);
    const st = await this.settings();
    if (!s || s.hash !== sha(token)) throw SecErr('Session khatam ho gaya (kisi ne kick kar diya ya logout hua)', 'ESESSION', 401);
    if (user && s.email !== user.email) { await this.event('session_mismatch', { email: user.email, ip, ua, severity: 'critical', detail: 'Session token kisi aur email ka tha' }); throw SecErr('Session invalid', 'ESESSION', 401); }
    if (Date.now() - (s.lastSeen || 0) > st.idleMin * 60000) { await this.fb.remove('admin_sessions/' + id).catch(() => {}); await this.event('session_expired', { email: s.email, ip, ua, detail: 'Idle timeout' }); throw SecErr('Idle timeout — dobara login karo', 'ESESSION', 401); }
    if (st.strictIp && s.ip !== ip) { await this.fb.remove('admin_sessions/' + id).catch(() => {}); await this.event('ip_changed', { email: s.email, ip, ua, severity: 'critical', detail: `IP badal gaya (${s.ip} → ${ip}). Session kill.` }); throw SecErr('IP badalne par session band', 'ESESSION', 401); }
    const last = this._touch.get(id) || 0; if (Date.now() - last > 15000) { this._touch.set(id, Date.now()); this.fb.update('admin_sessions/' + id, { lastSeen: Date.now(), lastIp: ip }).catch(() => {}); }
    return { id, ...s };
  }
  async list(currentId) {
    const st = await this.settings(); const a = await this._active(st.idleMin * 60000);
    return a.map(s => ({ id: s.id, device: s.device, ip: s.ip, email: s.email, createdAt: s.createdAt, lastSeen: s.lastSeen, current: s.id === currentId })).sort((x, y) => y.lastSeen - x.lastSeen);
  }
  async revoke(id, by, ip, ua, detail) { await this.fb.remove('admin_sessions/' + String(id).replace(/[^0-9a-f]/g, '')); await this.event('session_revoked', { email: by, ip, ua, severity: 'warn', detail: detail || 'Session kick kiya' }); }
  async revokeOthers(currentId, by, ip, ua) { const all = await this._all(); let n = 0; for (const id of Object.keys(all)) if (id !== currentId) { await this.fb.remove('admin_sessions/' + id); n++; } await this.event('sessions_revoked_all', { email: by, ip, ua, severity: 'warn', detail: n + ' device logout kiye' }); return n; }
  async revokeAll(by, ip, ua) { const all = await this._all(); for (const id of Object.keys(all)) await this.fb.remove('admin_sessions/' + id); await this.event('panic_logout', { email: by, ip, ua, severity: 'critical', detail: 'Sab devices se logout (panic)' }); }
}
module.exports = { AdminSec, parseUA, jwtAuthTime };
