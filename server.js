'use strict';
// ARYAN PANEL SHOP - Render Web Service: serves the site (public/) + secure payment API (/api/*).
// No npm dependencies (Node 18+). Secrets live ONLY in environment variables / Firebase server-only nodes.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { FirebaseDB } = require('./lib/firebase');
const { Payments, PayError } = require('./lib/payments');
const { safeRequest } = require('./lib/netguard');

const VERSION = '2.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };

function createApp(env = process.env) {
  const fb = new FirebaseDB(env);
  const pay = new Payments(fb, env, console);
  const adminEmails = new Set(String(env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const origins = new Set(String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean));
  const publicBase = String(env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const staticSupplierHosts = new Set(['bantibhaiya.to', ...String(env.GW_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)]);

  /* ---------- tiny in-memory rate limiter ---------- */
  const buckets = new Map();
  const limited = (ip, name, max, windowMs = 60000) => {
    const k = name + '|' + ip; const now = Date.now(); let b = buckets.get(k);
    if (!b || now > b.reset) b = { n: 0, reset: now + windowMs }; b.n++; buckets.set(k, b);
    if (buckets.size > 5000) for (const [kk, v] of buckets) if (now > v.reset) buckets.delete(kk);
    return b.n > max;
  };
  const clientIp = (req) => String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '');

  /* ---------- helpers ---------- */
  const send = (res, status, obj, extra = {}) => { const body = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(body); };
  const ok = (res, data) => send(res, 200, { ok: true, data });
  const fail = (res, status, code, message) => send(res, status, { ok: false, error: { code, message } });
  const readBody = (req, limit = 100 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new PayError('Request too large', 'ETOOBIG', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const parseBody = async (req) => {
    const raw = await readBody(req); if (!raw) return {};
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('application/json')) { try { return JSON.parse(raw); } catch (e) { throw new PayError('JSON galat hai', 'EBADJSON', 400); } }
    if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
    try { return JSON.parse(raw); } catch (e) { return Object.fromEntries(new URLSearchParams(raw)); }
  };
  const cors = (req, res) => {
    const o = String(req.headers.origin || '').replace(/\/$/, '');
    if (o && origins.has(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Max-Age', '600'); }
  };
  const needFb = (res) => { if (fb.configured()) return false; fail(res, 503, 'ENOFB', 'Server me Firebase credentials set nahi hain (FIREBASE_SERVICE_ACCOUNT env variable). Deployment guide dekho.'); return true; };
  const requireAdmin = async (req, res) => {
    if (!adminEmails.size) { fail(res, 503, 'ENOADMIN', 'Server me ADMIN_EMAILS env variable set nahi hai.'); return null; }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) { fail(res, 401, 'EAUTH', 'Admin login token missing'); return null; }
    try { const u = await fb.verifyIdToken(m[1]); if (!adminEmails.has(u.email)) { fail(res, 403, 'EFORBIDDEN', 'Ye account admin nahi hai'); return null; } return u; }
    catch (e) { fail(res, 401, 'EAUTH', e.message); return null; }
  };
  const baseOf = (req) => publicBase || ((req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host);

  /* ---------- supplier proxy (/api/gw) : same behaviour as the old Vercel function, but SSRF-hardened ---------- */
  let hostCache = { t: 0, hosts: new Set() };
  async function supplierHosts() {
    if (Date.now() - hostCache.t < 60000) return hostCache.hosts;
    const hosts = new Set(staticSupplierHosts);
    try { const s = (await fb.get('suppliers')) || {}; Object.values(s).forEach(o => ['apiUrl', 'balanceUrl'].forEach(f => { try { if (o && o[f]) hosts.add(new URL(o[f]).hostname.toLowerCase()); } catch (e) {} })); } catch (e) {}
    hostCache = { t: Date.now(), hosts }; return hosts;
  }
  async function handleGw(req, res, url) {
    const blocked = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json', 'x-gw': 'blocked', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ status: 'error', message: msg })); };
    let u; try { u = new URL(url.searchParams.get('u') || ''); } catch (e) { return blocked(400, 'bad url'); }
    const host = u.hostname.toLowerCase(); const allowed = await supplierHosts();
    if (!allowed.has(host)) return blocked(403, 'host not allowed');
    const headers = { Accept: 'application/json' }; const key = u.searchParams.get('api_key'); if (key) headers['X-Api-Key'] = key;
    if (req.headers['x-master-key']) headers['x-master-key'] = String(req.headers['x-master-key']).slice(0, 300);
    let body; const method = req.method === 'POST' ? 'POST' : 'GET';
    if (method === 'POST') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = await readBody(req); }
    u.protocol = 'https:';
    try {
      const r = await safeRequest({ url: u.toString(), method, headers, body, timeoutMs: 20000, allowedHosts: allowed });
      let okJson = true; try { JSON.parse(r.text); } catch (e) { okJson = false; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'x-gw': 'ok', 'Cache-Control': 'no-store' });
      res.end(okJson ? r.text : JSON.stringify({ status: 'error', message: 'Gateway ne JSON nahi diya (HTTP ' + r.status + ')' }));
    } catch (e) {
      if (e.code === 'EGWBLOCKED') return blocked(403, e.message);
      res.writeHead(200, { 'Content-Type': 'application/json', 'x-gw': 'ok', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'error', message: 'Gateway timeout / unreachable' }));
    }
  }

  /* ---------- routes ---------- */
  async function api(req, res, url) {
    const ip = clientIp(req); const p = url.pathname; const m = req.method;
    if (p === '/api/health' && m === 'GET') {
      const out = { status: 'up', version: VERSION, time: new Date().toISOString(), firebaseConfigured: fb.configured(), adminConfigured: adminEmails.size > 0 };
      if (url.searchParams.get('deep') === '1' && fb.configured()) { try { await fb.get('site_settings/maintenance'); out.firebase = 'reachable'; } catch (e) { out.firebase = 'error: ' + e.message; } }
      return ok(res, out);
    }
    if (p === '/api/gw' && (m === 'GET' || m === 'POST')) { if (limited(ip, 'gw', 120)) return fail(res, 429, 'ERATE', 'Too many requests'); return handleGw(req, res, url); }

    if (p === '/api/pay/create' && m === 'POST') {
      if (limited(ip, 'create', Number(env.RATE_CREATE_PER_MIN) || 10)) return fail(res, 429, 'ERATE', 'Bahut zyada requests, 1 minute baad try karo');
      if (needFb(res)) return; const b = await parseBody(req);
      try { return ok(res, await pay.createPayment({ uid: b.uid, amount: b.amount, gatewayId: b.gatewayId, name: b.name, phone: b.phone, returnUrl: b.returnUrl, publicBase: baseOf(req) })); }
      catch (e) { return fail(res, e.status || 502, e.code || 'EGATEWAY', e.message); }
    }
    if (p === '/api/pay/verify' && m === 'POST') {
      if (limited(ip, 'verify', 90)) return fail(res, 429, 'ERATE', 'Too many requests');
      if (needFb(res)) return; const b = await parseBody(req);
      try { return ok(res, await pay.verifyPayment(b.orderId, { uid: b.uid })); } catch (e) { return fail(res, e.status || 500, e.code || 'EVERIFY', e.message); }
    }
    if (p === '/api/pay/cancel' && m === 'POST') {
      if (limited(ip, 'cancel', 30)) return fail(res, 429, 'ERATE', 'Too many requests');
      if (needFb(res)) return; const b = await parseBody(req);
      try { return ok(res, await pay.cancelPayment(b.orderId, b.uid)); } catch (e) { return fail(res, e.status || 500, e.code || 'ECANCEL', e.message); }
    }
    // Gateway webhook: the payload is NEVER trusted. We only take the order id and re-verify against the gateway API.
    if (p.startsWith('/api/pay/webhook/') && (m === 'POST' || m === 'GET')) {
      if (limited(ip, 'hook', 60)) return fail(res, 429, 'ERATE', 'Too many requests');
      if (needFb(res)) return; const b = m === 'POST' ? await parseBody(req) : {}; const q = url.searchParams;
      const oid = String(b.order_id || b.orderId || q.get('order_id') || q.get('orderId') || '').slice(0, 120);
      if (!oid) return fail(res, 400, 'EORDER', 'order_id missing');
      try { const r = await pay.verifyPayment(oid); return ok(res, { orderId: r.orderId, status: r.status }); } catch (e) { return fail(res, e.status || 500, e.code || 'EVERIFY', e.message); }
    }

    if (p === '/api/admin/gateways' && m === 'POST') {
      if (limited(ip, 'admin', 60)) return fail(res, 429, 'ERATE', 'Too many requests');
      if (needFb(res)) return; const admin = await requireAdmin(req, res); if (!admin) return;
      const b = await parseBody(req);
      try {
        switch (b.action) {
          case 'list': return ok(res, (await pay.loadGateways()).map(g => pay.publicView(g)));
          case 'save': { const id = await pay.saveGateway(b.gateway || {}); fb.push('audit_logs', { admin: admin.email, action: 'save_gateway', detail: id, ts: Date.now() }).catch(() => {}); return ok(res, { id }); }
          case 'delete': await pay.deleteGateway(String(b.id || '')); fb.push('audit_logs', { admin: admin.email, action: 'delete_gateway', detail: b.id, ts: Date.now() }).catch(() => {}); return ok(res, { id: b.id });
          case 'toggle': await pay.toggleGateway(String(b.id || ''), b.enabled); return ok(res, { id: b.id });
          case 'primary': await pay.setPrimary(String(b.id || '')); return ok(res, { id: b.id });
          case 'test': return ok(res, await pay.testGatewayById(String(b.id || ''), { deep: !!b.deep, redirectUrl: baseOf(req) + '/?ap=return' }));
          case 'migrate': return ok(res, await pay.migrateGateways());
          case 'status': return ok(res, { firebaseConfigured: true, adminEmails: adminEmails.size, publicBase: baseOf(req), reconciler: env.AUTO_RECONCILE !== '0' });
          default: return fail(res, 400, 'EACTION', 'Unknown action');
        }
      } catch (e) { return fail(res, e.status || 500, e.code || 'EADMIN', e.message); }
    }
    return fail(res, 404, 'ENOTFOUND', 'API route nahi mila');
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname); if (rel === '/' || rel === '') rel = '/index.html'; if (rel === '/admin' || rel === '/admin/') rel = '/Admin.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (env.NODE_ENV === 'production' && env.FORCE_HTTPS !== '0' && req.headers['x-forwarded-proto'] === 'http') { res.writeHead(301, { Location: 'https://' + req.headers.host + req.url }); return res.end(); }
      if (url.pathname.startsWith('/api/')) {
        cors(req, res);
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        return await api(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, url);
    } catch (e) {
      if (!res.headersSent) { if (e instanceof PayError) return fail(res, e.status, e.code, e.message); console.error('[server]', e); return fail(res, 500, 'EINTERNAL', 'Server error'); }
      try { res.end(); } catch (x) {}
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 20000;
  if (env.AUTO_RECONCILE !== '0') pay.startReconciler();
  return { server, fb, pay };
}

if (require.main === module) {
  const { server, fb } = createApp();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`ARYAN PANEL server v${VERSION} listening on :${port}`);
    if (!fb.configured()) console.warn('WARNING: FIREBASE_SERVICE_ACCOUNT not set - payment API will return 503 until you add it.');
    if (!process.env.ADMIN_EMAILS) console.warn('WARNING: ADMIN_EMAILS not set - admin gateway API disabled.');
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
module.exports = { createApp };
