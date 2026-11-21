'use strict';
// Telegram channel alerts: deposit / key purchase / new reseller / referral / signup.
// - Bot token + chat id live ONLY on the server (Firebase nodes notify_secrets / notify_config, both locked by rules).
// - Keys are NEVER sent to the channel (always shown as hidden).
// - Messages are built from database records, never from text sent by a browser, so nobody can spam fake alerts.
const { safeRequest } = require('./netguard');

const EVENTS = ['deposit', 'purchase', 'reseller', 'referral', 'commission', 'signup'];
const DEFAULTS = {
  enabled: false, chatId: '', channelUrl: '', siteUrl: '', brand: 'ARYAN PANEL SHOP',
  footer: '💎 Premium Panel Store • Trusted • Instant Delivery',
  userMode: 'mask', silent: false, minDeposit: 0,
  siteBtnText: '🛒 Buy on My Website', channelBtnText: '📢 Join Our Channel',
  events: { deposit: true, purchase: true, reseller: true, referral: true, commission: true, signup: true }
};
const esc = (t) => String(t == null ? '' : t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const nowIN = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
const httpsUrl = (u) => { u = String(u || '').trim(); return /^https:\/\/[^\s]+$/i.test(u) ? u.slice(0, 500) : ''; };
const LINE = '━━━━━━━━━━━━━━━━━━';

function maskName(n) { n = String(n || 'user'); if (n.length <= 2) return n[0] + '*'; if (n.length <= 4) return n[0] + '***'; return n.slice(0, 2) + '*'.repeat(Math.min(5, n.length - 3)) + n.slice(-1); }

class Notifier {
  constructor(fb, env = process.env, log = console) {
    this.fb = fb; this.env = env; this.log = log;
    const testBase = env.NODE_ENV !== 'production' && env.TELEGRAM_API_BASE;
    this.tgBase = String(testBase || 'https://api.telegram.org').replace(/\/$/, '');
    this.tgHosts = new Set([new URL(this.tgBase).hostname.toLowerCase()]);
    this._cfg = null; this._cfgAt = 0; this._t = null; this._fails = new Map();
  }

  /* ---------- config ---------- */
  async loadConfig(force) {
    if (!force && this._cfg && Date.now() - this._cfgAt < 15000) return this._cfg;
    const [c, tok] = await Promise.all([this.fb.get('notify_config'), this.fb.get('notify_secrets/botToken')]);
    const cfg = { ...DEFAULTS, ...(c || {}), events: { ...DEFAULTS.events, ...((c || {}).events || {}) }, botToken: String(tok || '') };
    this._cfg = cfg; this._cfgAt = Date.now(); return cfg;
  }
  publicConfig(cfg) { const { botToken, ...rest } = cfg; return { ...rest, tokenSet: !!botToken, tokenHint: botToken ? '••••' + botToken.slice(-4) : '' }; }
  async saveConfig(input = {}) {
    const old = await this.loadConfig(true); const errs = [];
    const chatId = String(input.chatId == null ? old.chatId : input.chatId).trim();
    if (chatId && !/^(@[A-Za-z0-9_]{4,64}|-?\d{5,20})$/.test(chatId)) errs.push('Channel ID galat: @channelusername ya -100xxxxxxxxxx format me daalo');
    const channelUrl = input.channelUrl == null ? old.channelUrl : String(input.channelUrl).trim();
    const siteUrl = input.siteUrl == null ? old.siteUrl : String(input.siteUrl).trim();
    if (channelUrl && !httpsUrl(channelUrl)) errs.push('Channel link https:// se start hona chahiye (jaise https://t.me/yourchannel)');
    if (siteUrl && !httpsUrl(siteUrl)) errs.push('Website link https:// se start hona chahiye');
    const newTok = String(input.botToken || '').trim();
    if (newTok && !/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(newTok)) errs.push('Bot token ka format galat hai (BotFather wala token paste karo)');
    if (errs.length) { const e = new Error(errs.join('. ')); e.code = 'EVALIDATION'; e.status = 400; throw e; }
    const ev = {}; for (const k of EVENTS) ev[k] = input.events && k in input.events ? !!input.events[k] : old.events[k];
    const rec = {
      enabled: input.enabled == null ? !!old.enabled : !!input.enabled, chatId, channelUrl, siteUrl,
      brand: String(input.brand == null ? old.brand : input.brand).trim().slice(0, 40) || DEFAULTS.brand,
      footer: String(input.footer == null ? old.footer : input.footer).trim().slice(0, 160),
      userMode: ['mask', 'full', 'hide'].includes(input.userMode) ? input.userMode : old.userMode,
      silent: input.silent == null ? !!old.silent : !!input.silent,
      minDeposit: Math.max(0, Number(input.minDeposit == null ? old.minDeposit : input.minDeposit) || 0),
      siteBtnText: String(input.siteBtnText == null ? old.siteBtnText : input.siteBtnText).trim().slice(0, 40) || DEFAULTS.siteBtnText,
      channelBtnText: String(input.channelBtnText == null ? old.channelBtnText : input.channelBtnText).trim().slice(0, 40) || DEFAULTS.channelBtnText,
      events: ev, updatedAt: Date.now()
    };
    if (newTok) await this.fb.set('notify_secrets/botToken', newTok); // secret first
    await this.fb.set('notify_config', rec);
    // public, browser-readable bits only (links + name). No token / chat id here.
    await this.fb.set('site_settings/channel', { channelUrl, siteUrl, brand: rec.brand, updatedAt: rec.updatedAt });
    this._cfg = null; return this.publicConfig(await this.loadConfig(true));
  }

  /* ---------- Telegram ---------- */
  async tg(token, method, payload) {
    if (!token) throw Object.assign(new Error('Bot token set nahi hai'), { code: 'ENOTOKEN' });
    let r;
    try { r = await safeRequest({ url: `${this.tgBase}/bot${token}/${method}`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}), timeoutMs: 15000, allowedHosts: this.tgHosts }); }
    catch (e) { throw Object.assign(new Error('Telegram se connect nahi hua: ' + String(e.message).replace(token, '***')), { code: 'ETGNET' }); }
    let j = null; try { j = JSON.parse(r.text); } catch (e) {}
    if (!j || !j.ok) {
      const d = (j && j.description) || ('HTTP ' + r.status);
      const hint = /chat not found/i.test(d) ? ' — Channel ID galat hai ya bot channel me add nahi hai' : /not enough rights|administrator|forbidden/i.test(d) ? ' — Bot ko channel me Admin banao (Post messages permission)' : /unauthorized/i.test(d) ? ' — Bot token galat hai' : '';
      throw Object.assign(new Error(String(d).replace(token, '***') + hint), { code: 'ETG', retryAfter: j && j.parameters && j.parameters.retry_after });
    }
    return j.result;
  }
  buttons(cfg) {
    const row = []; const s = httpsUrl(cfg.siteUrl), c = httpsUrl(cfg.channelUrl);
    if (s) row.push({ text: cfg.siteBtnText, url: s }); if (c) row.push({ text: cfg.channelBtnText, url: c });
    return row.length ? { inline_keyboard: [row] } : undefined;
  }
  who(cfg, name) { return cfg.userMode === 'hide' ? 'Hidden User' : cfg.userMode === 'full' ? esc(name || 'user') : esc(maskName(name)); }

  /* ---------- message templates (HTML, premium look) ---------- */
  render(event, d, cfg) {
    const head = (emoji, title) => `${emoji} <b>${title}</b> ${emoji}\n${LINE}\n`;
    const foot = `${LINE}\n${esc(cfg.footer)}\n🕒 ${nowIN()}\n<b>${esc(cfg.brand)}</b>`;
    const u = this.who(cfg, d.username);
    let body;
    switch (event) {
      case 'deposit':
        body = head('💰', 'NEW DEPOSIT RECEIVED') + `👤 <b>User:</b> ${u}\n💵 <b>Amount:</b> <b>${inr(d.amount)}</b>\n` + (d.bonus > 0 ? `🎁 <b>Bonus:</b> ${inr(d.bonus)}\n` : '') + `🏦 <b>Method:</b> UPI${d.gatewayName ? ' • ' + esc(d.gatewayName) : ''}\n✅ <b>Status:</b> Verified &amp; Credited\n`; break;
      case 'purchase':
        body = head('🔑', 'NEW KEY SOLD') + `👤 <b>Buyer:</b> ${u}\n📦 <b>Product:</b> ${esc(d.product)}\n⏱ <b>Plan:</b> ${esc(d.duration)}\n🔢 <b>Quantity:</b> ${esc(d.qty || 1)}\n💳 <b>Paid:</b> <b>${inr(d.total)}</b>\n🔐 <b>Key:</b> <tg-spoiler>●●●●●●●●●●●●</tg-spoiler> <i>(hidden for security)</i>\n` + (d.source === 'api' ? '🔌 <b>Via:</b> Reseller API\n' : ''); break;
      case 'reseller':
        body = head('👑', 'NEW RESELLER JOINED') + `👤 <b>User:</b> ${u}\n🏅 <b>Rank:</b> Reseller (special rates unlocked)\n` + (d.via ? `🚀 <b>Via:</b> ${esc({ upgrade: 'Wallet Upgrade', free: 'Free Referral Reward', admin: 'Admin Promotion', referral: 'Referrer Promotion' }[d.via] || d.via)}\n` : ''); break;
      case 'referral':
        body = head('🤝', 'NEW REFERRAL') + `👤 <b>New Member:</b> ${u}\n🔗 <b>Invited by:</b> ${cfg.userMode === 'hide' ? 'Hidden User' : cfg.userMode === 'full' ? esc(d.referrer) : esc(maskName(d.referrer))}\n🎉 <i>Community is growing!</i>\n`; break;
      case 'commission':
        body = head('🎁', 'REFERRAL COMMISSION') + `🔗 <b>Earned by:</b> ${cfg.userMode === 'hide' ? 'Hidden User' : cfg.userMode === 'full' ? esc(d.referrer) : esc(maskName(d.referrer))}\n💵 <b>Commission:</b> <b>${inr(d.commission)}</b>\n📈 <b>Rate:</b> ${esc(d.pct)}%\n`; break;
      case 'signup':
        body = head('🆕', 'NEW MEMBER') + `👤 <b>User:</b> ${u}\n🎊 <i>Welcome to ${esc(cfg.brand)}!</i>\n`; break;
      default: body = head('📣', 'ANNOUNCEMENT') + esc(d.text || '') + '\n';
    }
    return body + foot;
  }

  /* ---------- sending ---------- */
  /** returns { sent, skipped?, error? }. dedupe: string key -> sent at most once (claimed in notify_sent). Never throws. */
  async send(event, data, { dedupe, force, cfgOverride } = {}) {
    let claimed = false;
    try {
      const cfg = cfgOverride || await this.loadConfig();
      if (!force && (!cfg.enabled || !cfg.events[event])) return { sent: false, skipped: 'disabled' };
      if (!cfg.botToken || !cfg.chatId) return { sent: false, skipped: 'not_configured' };
      if (event === 'deposit' && !force && Number(data.amount) < Number(cfg.minDeposit || 0)) return { sent: false, skipped: 'below_min' };
      if (dedupe) { if (!(await this.fb.createIfAbsent(`notify_sent/${String(dedupe).replace(/[.#$\[\]\/]/g, '_').slice(0, 120)}`, { ts: Date.now(), event }))) return { sent: false, skipped: 'duplicate' }; claimed = true; }
      const payload = { chat_id: cfg.chatId, text: this.render(event, data, cfg), parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: !!cfg.silent };
      const kb = this.buttons(cfg); if (kb) payload.reply_markup = kb;
      let res;
      try { res = await this.tg(cfg.botToken, 'sendMessage', payload); }
      catch (e) { if (e.code === 'ETG' && e.retryAfter && e.retryAfter <= 10) { await new Promise((r) => setTimeout(r, e.retryAfter * 1000 + 200)); res = await this.tg(cfg.botToken, 'sendMessage', payload); } else throw e; }
      this.fb.push('notify_logs', { event, ok: true, msgId: res && res.message_id, ts: Date.now() }).catch(() => {});
      return { sent: true, messageId: res && res.message_id };
    } catch (e) {
      if (claimed) await this.fb.remove(`notify_sent/${String(dedupe).replace(/[.#$\[\]\/]/g, '_').slice(0, 120)}`).catch(() => {}); // allow a retry later
      this.log.warn && this.log.warn(`[notify] ${event} failed: ${e.message}`);
      this.fb.push('notify_logs', { event, ok: false, message: String(e.message).slice(0, 200), ts: Date.now() }).catch(() => {});
      return { sent: false, error: e.message };
    }
  }
  /** admin free-text post to the channel (keeps the premium footer + buttons) */
  async broadcast(text) {
    text = String(text || '').trim(); if (!text) throw Object.assign(new Error('Message khali hai'), { code: 'EVALIDATION', status: 400 });
    if (text.length > 1500) throw Object.assign(new Error('Message 1500 characters se chhota rakho'), { code: 'EVALIDATION', status: 400 });
    const r = await this.send('broadcast', { text }, { force: true });
    if (!r.sent) throw Object.assign(new Error(r.error || (r.skipped === 'not_configured' ? 'Pehle Bot token aur Channel ID save karo' : 'Message nahi gaya')), { code: 'ETG', status: 502 });
    return r;
  }
  async recentLogs(n = 30) { const l = (await this.fb.query('notify_logs', { orderBy: '$key', limitToLast: n })) || {}; return Object.values(l).sort((a, b) => b.ts - a.ts); }

  /** admin "Send test": verifies the token (getMe), the channel (getChat) and posts a sample message. */
  async test(event = 'deposit') {
    const cfg = await this.loadConfig(true); const out = { steps: [] };
    if (!cfg.botToken) throw Object.assign(new Error('Pehle Bot token save karo'), { code: 'ENOTOKEN', status: 400 });
    if (!cfg.chatId) throw Object.assign(new Error('Pehle Channel ID save karo'), { code: 'ENOCHAT', status: 400 });
    const me = await this.tg(cfg.botToken, 'getMe', {}); out.bot = '@' + me.username; out.steps.push('Bot OK: @' + me.username);
    const chat = await this.tg(cfg.botToken, 'getChat', { chat_id: cfg.chatId }); out.chat = chat.title || chat.username || String(chat.id); out.steps.push('Channel mila: ' + out.chat);
    const sample = { deposit: { username: 'aryan_demo', amount: 500, bonus: 50, gatewayName: 'ZapUPI' }, purchase: { username: 'aryan_demo', product: 'Free Fire Panel', duration: '7 Days', qty: 1, total: 299 }, reseller: { username: 'aryan_demo', via: 'upgrade' }, referral: { username: 'new_member', referrer: 'aryan_demo' }, commission: { referrer: 'aryan_demo', commission: 15, pct: 5 }, signup: { username: 'new_member' } };
    const r = await this.send(EVENTS.includes(event) ? event : 'deposit', sample[event] || sample.deposit, { force: true, cfgOverride: cfg });
    if (!r.sent) throw Object.assign(new Error(r.error || 'Test message nahi gaya'), { code: 'ETG', status: 502 });
    out.steps.push('Sample message channel me bhej diya'); out.sent = true; return out;
  }

  /* ---------- events ---------- */
  deposit(key, rec, bonus) { return this.send('deposit', { username: rec.username, amount: rec.amount, bonus, gatewayName: rec.gatewayName }, { dedupe: 'dep_' + key }); }

  async orderAlert(key, o) {
    await this.send('purchase', { username: o.username, product: o.product, duration: o.duration, qty: o.qty, total: o.total, source: o.source }, { dedupe: 'ord_' + key });
    if (o.source === 'web' && o.uid) { // browser pays the referrer commission on web purchases -> announce it too
      const [u, rs] = await Promise.all([this.fb.get(`users/${o.uid}`), this.fb.get('site_settings/reseller_upgrade')]);
      const pct = Number(rs && rs.commissionPct != null ? rs.commissionPct : 1);
      if (u && u.referredBy && pct > 0) {
        const ref = await this.fb.get(`users/${u.referredBy}/username`);
        const commission = Math.round((Number(o.total) || 0) * pct) / 100;
        if (commission > 0) await this.send('commission', { referrer: ref || 'user', commission, pct }, { dedupe: 'com_' + key });
      }
    }
  }
  /** polls new orders (push keys are time-ordered) and announces them once. Starts from "now" the first time. */
  async pollOrders() {
    const cfg = await this.loadConfig(); const last = await this.fb.get('notify_state/lastOrderKey');
    const recent = (await this.fb.query('orders', { orderBy: '$key', limitToLast: 40 })) || {}; const keys = Object.keys(recent).sort();
    if (!keys.length) return { processed: 0 };
    if (!last) { await this.fb.set('notify_state/lastOrderKey', keys[keys.length - 1]); return { processed: 0, init: true }; }
    let processed = 0;
    for (const k of keys) {
      if (k <= last) continue;
      const o = recent[k]; if (!o || typeof o !== 'object') { await this.fb.set('notify_state/lastOrderKey', k); continue; }
      if (cfg.enabled && cfg.botToken && cfg.chatId) {
        const r = await this.orderAlert(k, o).then(() => null, (e) => e);
        const f = (this._fails.get(k) || 0) + 1;
        if (r && f < 3) { this._fails.set(k, f); break; } // retry on next poll, keep order
        this._fails.delete(k);
      }
      await this.fb.set('notify_state/lastOrderKey', k); processed++;
    }
    return { processed };
  }
  /** browser pings (signup / reseller). We re-read the database and only announce real, not-yet-announced facts. */
  async clientEvent(type, uid, via) {
    uid = String(uid || ''); if (!/^[A-Za-z0-9_\-]{1,100}$/.test(uid)) return { sent: false, skipped: 'bad_uid' };
    const u = await this.fb.get(`users/${uid}`); if (!u || typeof u !== 'object') return { sent: false, skipped: 'no_user' };
    if (type === 'signup') {
      if (!u.joinedAt || Date.now() - Number(u.joinedAt) > 15 * 60000) return { sent: false, skipped: 'not_new' };
      const r = await this.send('signup', { username: u.username }, { dedupe: 'su_' + uid });
      if (u.referredBy && /^[A-Za-z0-9_\-]{1,100}$/.test(String(u.referredBy)) && u.referredBy !== uid) { const rn = await this.fb.get(`users/${u.referredBy}/username`); if (rn) await this.send('referral', { username: u.username, referrer: rn }, { dedupe: 'rf_' + uid }); }
      return r;
    }
    if (type === 'reseller') {
      if (String(u.role).toLowerCase() !== 'reseller') return { sent: false, skipped: 'not_reseller' };
      return this.send('reseller', { username: u.username, via: ['upgrade', 'free', 'admin', 'referral'].includes(via) ? via : '' }, { dedupe: 'rs_' + uid });
    }
    return { sent: false, skipped: 'unknown_event' };
  }

  startWatcher(ms = 10000) {
    if (this._t) return; let busy = false;
    this._t = setInterval(async () => { if (busy || !this.fb.configured()) return; busy = true; try { await this.pollOrders(); } catch (e) { this.log.warn && this.log.warn('[notify] poll: ' + e.message); } finally { busy = false; } }, ms);
    this._t.unref && this._t.unref();
  }
  stopWatcher() { clearInterval(this._t); this._t = null; }
}
module.exports = { Notifier, EVENTS, DEFAULTS, maskName };
