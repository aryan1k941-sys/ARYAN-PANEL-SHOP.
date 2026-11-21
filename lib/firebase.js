'use strict';
// Zero-dependency Firebase Realtime Database client for the server (REST + service-account OAuth).
// Atomic updates use RTDB ETag conditional writes (same concurrency control the browser SDK's runTransaction uses).
const crypto = require('crypto');

const DEFAULT_DB = 'https://aryan-mods-4c084-default-rtdb.firebaseio.com';
const DEFAULT_WEB_KEY = 'AIzaSyDh8_kBDSXrbHbqYwXgjYRFP0loNmbQQqM'; // public web key (same as in index.html)
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function parseServiceAccount(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  try { if (!s.startsWith('{')) s = Buffer.from(s, 'base64').toString('utf8'); const j = JSON.parse(s); if (j.client_email && j.private_key) return j; } catch (e) {}
  return null;
}

class FirebaseDB {
  constructor(env = process.env) {
    this.url = String(env.FIREBASE_DB_URL || DEFAULT_DB).replace(/\/$/, '');
    this.sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
    this.secret = env.FIREBASE_DB_SECRET || '';
    this.webKey = env.FIREBASE_WEB_API_KEY || DEFAULT_WEB_KEY;
    this.tokenUrl = env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
    this.identityUrl = env.IDENTITY_LOOKUP_URL || 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';
    this.noAuth = env.NODE_ENV !== 'production' && env.FIREBASE_TEST_NO_AUTH === '1'; // tests against a local mock only
    this._tok = null; this._tokExp = 0; this._idCache = new Map();
  }
  configured() { return !!(this.sa || this.secret || this.noAuth); }

  async accessToken() {
    if (this._tok && Date.now() < this._tokExp - 60000) return this._tok;
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64u(JSON.stringify({ iss: this.sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email', aud: this.tokenUrl, iat: now, exp: now + 3600 }));
    const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(this.sa.private_key);
    const r = await fetch(this.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + b64u(sig) }), signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw dbErr('Firebase service-account login failed: ' + (j.error_description || j.error || r.status), 'EFBAUTH');
    this._tok = j.access_token; this._tokExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return this._tok;
  }
  async _url(path, query = {}) {
    const q = new URLSearchParams(query);
    if (this.sa) q.set('access_token', await this.accessToken()); else if (this.secret) q.set('auth', this.secret);
    const clean = String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `${this.url}/${clean}.json${q.toString() ? '?' + q : ''}`;
  }
  async _req(method, path, { body, headers = {}, query } = {}) {
    if (!this.configured()) throw dbErr('Server Firebase credentials not configured (set FIREBASE_SERVICE_ACCOUNT)', 'ENOFB');
    const r = await fetch(await this._url(path, query), { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
    return { status: r.status, ok: r.ok, json, etag: r.headers.get('etag'), text };
  }
  _fail(r, what) { return dbErr(`Firebase ${what} failed (HTTP ${r.status})${r.json && r.json.error ? ': ' + r.json.error : ''}`, 'EFB' + r.status); }

  /** REST query. Only $key ordering is used by the server (always indexed): query('orders', { orderBy: '$key', limitToLast: 30 }) */
  async query(path, q = {}) {
    const query = {}; for (const [k, v] of Object.entries(q)) query[k] = typeof v === 'number' ? String(v) : JSON.stringify(v);
    const r = await this._req('GET', path, { query }); if (!r.ok) throw this._fail(r, 'query ' + path); return r.json;
  }
  async get(path) { const r = await this._req('GET', path); if (!r.ok) throw this._fail(r, 'read ' + path); return r.json; }
  async set(path, value) { const r = await this._req('PUT', path, { body: value }); if (!r.ok) throw this._fail(r, 'write ' + path); return value; }
  async update(path, obj) { const r = await this._req('PATCH', path, { body: obj }); if (!r.ok) throw this._fail(r, 'update ' + path); return obj; }
  async remove(path) { const r = await this._req('DELETE', path); if (!r.ok) throw this._fail(r, 'delete ' + path); }
  async push(path, value) { const r = await this._req('POST', path, { body: value }); if (!r.ok) throw this._fail(r, 'push ' + path); return r.json && r.json.name; }

  /** create only if nothing exists at path. returns true if created. */
  async createIfAbsent(path, value) {
    const r = await this._req('PUT', path, { body: value, headers: { 'if-match': 'null_etag' } });
    if (r.status === 412) return false;
    if (!r.ok) throw this._fail(r, 'create ' + path);
    return true;
  }

  /** Atomic read-modify-write. fn(current) -> new value, or undefined to abort. */
  async transaction(path, fn, tries = 12) {
    for (let i = 0; i < tries; i++) {
      const g = await this._req('GET', path, { headers: { 'X-Firebase-ETag': 'true' } });
      if (!g.ok) throw this._fail(g, 'read ' + path);
      const cur = g.json === undefined ? null : g.json;
      const next = fn(cur);
      if (next === undefined) return { committed: false, value: cur };
      const w = next === null
        ? await this._req('DELETE', path, { headers: { 'if-match': g.etag || 'null_etag' } })
        : await this._req('PUT', path, { body: next, headers: { 'if-match': g.etag || 'null_etag' } });
      if (w.status === 412) { await new Promise(r => setTimeout(r, 15 + Math.random() * 40)); continue; }
      if (!w.ok) throw this._fail(w, 'transaction ' + path);
      return { committed: true, value: next };
    }
    throw dbErr('Firebase transaction contention, try again', 'ETXN');
  }

  /** Verify a Firebase Auth ID token (admin panel login) -> { uid, email } */
  async verifyIdToken(idToken) {
    if (!idToken || idToken.length > 4096) throw dbErr('Missing token', 'EAUTH');
    const k = crypto.createHash('sha256').update(idToken).digest('hex');
    const hit = this._idCache.get(k); if (hit && hit.exp > Date.now()) return hit.user;
    const r = await fetch(`${this.identityUrl}?key=${encodeURIComponent(this.webKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }), signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    const u = j && j.users && j.users[0];
    if (!r.ok || !u || !u.email) throw dbErr('Invalid or expired admin login', 'EAUTH');
    const user = { uid: u.localId, email: String(u.email).toLowerCase(), emailVerified: !!u.emailVerified };
    this._idCache.set(k, { user, exp: Date.now() + 5 * 60000 });
    if (this._idCache.size > 200) this._idCache.clear();
    return user;
  }
}
function dbErr(m, code) { const e = new Error(m); e.code = code; return e; }

module.exports = { FirebaseDB, parseServiceAccount };
