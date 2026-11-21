'use strict';
// ARYAN PANEL SHOP - Render Web Service: serves the site (public/) + secure payment API (/api/*).
// No npm dependencies (Node 18+). Secrets live ONLY in environment variables / Firebase server-only nodes.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { FirebaseDB } = require('./lib/firebase');
const { Payments, PayError } = require('./lib/payments');
const { safeRequest } = require('./lib/netguard');
const { Notifier } = require('./lib/notify');

const VERSION = '2.1.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };

function createApp(env = process.env) {
  const fb = new FirebaseDB(env);
  const pay = new Payments(fb, env, console);
  const notify = new Notifier(fb, env, console); pay.notify = notify;
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
    if (o && origins.has(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Max-Age', '600'); }
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

  /* ---------- reseller API v1 (/api/v1/*) ---------- */
  async function apiV1Auth(req, res, permission) {
    if (needFb(res)) return null;
    const raw = String(req.headers['x-api-key'] || '').trim() || ((/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '')) || [])[1] || '').trim();
    if (!raw) { fail(res, 401, 'EAUTH', 'API key missing'); return null; }
    const clients = (await fb.get('api_clients')) || {};
    const users = (await fb.get('users')) || {};
    let uid = null, user = null, client = null;
    for (const [id, c] of Object.entries(clients)) {
      if (c && c.status === 'active' && String(users[id]?.apiKey || '') === raw) { uid = id; user = users[id] || {}; client = c; break; }
    }
    if (!uid) {
      // Custom username/password panel users are not Firebase Auth users, so the browser
      // cannot safely create api_clients through client-side Firebase rules.
      // If a user's current API key matches, provision the server-side API client record
      // automatically on first authenticated API request.
      for (const [id, u] of Object.entries(users)) {
        if (u && String(u.apiKey || '') === raw && String(u.role || '').toLowerCase() === 'reseller') {
          uid = id; user = u;
          client = { uid: id, username: u.username || '', status: 'active', createdAt: Date.now(),
            permissions: { 'products.read': true, 'balance.read': true, 'orders.create': true, 'orders.read': true },
            rateLimit: 60, requests: 0 };
          try { await fb.set(`api_clients/${id}`, client); } catch (e) {}
          break;
        }
      }
    }
    if (!uid || !client || client.status !== 'active') { fail(res, 401, 'EAUTH', 'API key invalid ya revoked hai'); return null; }
    const perms = client.permissions || {};
    if (permission && perms[permission] === false) { fail(res, 403, 'EFORBIDDEN', 'API permission allowed nahi hai'); return null; }
    const limit = Math.max(1, Number(client.rateLimit) || 60);
    if (limited(clientIp(req), 'api-v1-' + uid, limit)) { fail(res, 429, 'ERATE', 'API rate limit exceed ho gaya'); return null; }
    try { await fb.update(`api_clients/${uid}`, { requests: (Number(client.requests) || 0) + 1, lastRequestAt: Date.now() }); } catch (e) {}
    return { uid, user, client };
  }
  const apiV1Reply = (res, status, success, data) => send(res, status, { success, ...(success ? { data } : { error: data }) });
  const apiV1Products = async () => {
    const [sp, mg] = await Promise.all([fb.get('store_products'), fb.get('management')]);
    const products = [];
    const src = sp || {};
    const prices = mg || {};
    for (const [key, raw] of Object.entries(src)) {
      const m = raw || {};
      const plansObj = prices[key] || m.plans || {};
      const plans = Object.entries(plansObj).map(([pk, x]) => ({
        duration: String(x?.daysPlan || pk),
        price: Number(x?.priceRate) || 0,
        resellerPrice: x?.resellerPrice != null && x?.resellerPrice !== '' ? Number(x.resellerPrice) : null
      })).filter(x => x.price > 0 || x.resellerPrice != null);
      const pid = m.pid != null ? String(m.pid) : '';
      if (!pid) continue;
      products.push({ pid, product_id: pid, name: String(m.name || m.productName || key), status: String(m.status || 'ACTIVE').toUpperCase(), category: String(m.category || m.game || ''), plans });
    }
    return products;
  };
  async function apiV1Order(req, res, auth, body) {
    const pid = String(body.pid ?? body.product_id ?? '').trim();
    const duration = String(body.duration ?? '').trim();
    const qty = Math.max(1, Math.min(100, parseInt(body.quantity ?? body.qty ?? 1, 10) || 1));
    if (!pid || !duration) return apiV1Reply(res, 400, false, { code: 'EBADREQUEST', message: 'pid/product_id aur duration required hain' });
    const products = await apiV1Products();
    const product = products.find(p => String(p.pid) === pid && p.status !== 'INACTIVE');
    if (!product) return apiV1Reply(res, 404, false, { code: 'ENOTFOUND', message: 'Product PID nahi mila' });
    const plan = product.plans.find(x => String(x.duration).toLowerCase() === duration.toLowerCase());
    if (!plan) return apiV1Reply(res, 404, false, { code: 'EDURATION', message: 'Is product ka duration nahi mila' });
    const reseller = String(auth.user.role || '').toLowerCase() === 'reseller';
    const unitPrice = reseller && plan.resellerPrice != null ? plan.resellerPrice : plan.price;
    const total = Math.round(unitPrice * qty * 100) / 100;
    const maps = (await fb.get('pid_mappings')) || {};
    // Fallback: use ARYAN PID + duration against mapping records if productKey lookup above is unavailable.
    const productKeys = Object.entries((await fb.get('store_products')) || {}).filter(([k,v]) => String(v?.pid || '') === pid).map(([k])=>k);
    const cands = Object.values(maps).filter(m => m && m.enabled !== false && productKeys.includes(String(m.productKey)) && String(m.planKey || '') === String(duration)).sort((a,b)=>(Number(a.priority)||100)-(Number(b.priority)||100));
    if (!cands.length) return apiV1Reply(res, 409, false, { code: 'EMAPPING', message: 'Is PID/duration ka supplier mapping nahi hai' });
    const current = Number((await fb.get(`users/${auth.uid}/balance`)) || 0);
    if (current < total) return apiV1Reply(res, 402, false, { code: 'EBALANCE', message: `Insufficient balance. Required ₹${total.toFixed(2)}, available ₹${current.toFixed(2)}` });
    const deb = await fb.transaction(`users/${auth.uid}/balance`, cur => { const n=Number(cur)||0; return n >= total ? Math.round((n-total)*100)/100 : undefined; });
    if (!deb.committed) return apiV1Reply(res, 409, false, { code: 'EBALANCE', message: 'Balance change nahi ho saka, retry karo' });
    let keys = [], used = null, lastErr = 'Supplier ne key nahi di';
    const allowed = await supplierHosts();
    try {
      for (const m of cands) {
        const s = (await fb.get(`suppliers/${m.supplierId}`)) || {};
        if (!s.enabled || !s.apiUrl || !s.apiKey) continue;
        try {
          const u = new URL(s.apiUrl); const host=u.hostname.toLowerCase(); if (!allowed.has(host)) throw Object.assign(new Error('Supplier host allowed nahi hai'), {code:'EGWBLOCKED'});
          const headers={'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'}; if (s.masterKey) headers['x-master-key']=String(s.masterKey).slice(0,300);
          const r=await safeRequest({url:s.apiUrl,method:'POST',headers,body:new URLSearchParams({api_key:String(s.apiKey),action:'buy',product_id:String(m.supplierPid),duration:String(m.supplierDuration || duration),quantity:String(qty)}).toString(),timeoutMs:20000,allowedHosts:allowed});
          const j=(()=>{try{return JSON.parse(r.text)}catch(e){return null}})();
          const got=j && Array.isArray(j.keys)?j.keys.filter(Boolean):(j&&j.key?[j.key]:[]);
          if (got.length >= qty) { keys=got.slice(0,qty); used=m; break; }
          lastErr=(j&&(j.message||j.error))||`Supplier HTTP ${r.status}`;
        } catch(e) { lastErr=e.message||'Supplier request failed'; }
      }
      if (!keys.length) throw Object.assign(new Error(lastErr), {code:'ESUPPLIER'});
      const orderId='api_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
      for (const k of keys) await fb.push(`users/${auth.uid}/generatedKeys`, { product: product.name, pid, duration: plan.duration, qty: 1, keyCode:String(k), timestamp:new Date().toISOString(), source:'api', supplier:true, price:unitPrice });
      await fb.push('orders', { uid:auth.uid, username:auth.user.username||'', productKey:used.productKey, product:product.name, pid, duration:plan.duration, planKey:plan.duration, qty:keys.length, unitPrice, total:Math.round(unitPrice*keys.length*100)/100, status:'delivered', source:'api', apiOrderId:orderId, supplierId:used.supplierId, supplierPid:used.supplierPid, ts:Date.now() });
      await fb.push(`users/${auth.uid}/transactions`, { type:'API Purchase', amount:-Math.round(unitPrice*keys.length*100)/100, description:`API order ${orderId} - ${product.name}`, date:new Date().toLocaleString(), ts:Date.now() });
      return apiV1Reply(res, 200, true, { order_id:orderId, pid, product:product.name, duration:plan.duration, quantity:keys.length, unit_price:unitPrice, total:Math.round(unitPrice*keys.length*100)/100, status:'delivered', keys });
    } catch(e) {
      await fb.transaction(`users/${auth.uid}/balance`, cur=>Math.round(((Number(cur)||0)+total)*100)/100).catch(()=>{});
      return apiV1Reply(res, 502, false, { code:e.code||'ESUPPLIER', message:e.message||'Supplier purchase failed; balance refunded' });
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
    if (p === '/api/v1/products' && m === 'GET') {
      const a = await apiV1Auth(req, res, 'products.read'); if (!a) return;
      try { return apiV1Reply(res, 200, true, await apiV1Products()); } catch(e) { return apiV1Reply(res, 500, false, { code:'EAPI', message:e.message }); }
    }
    if (p === '/api/v1/balance' && m === 'GET') {
      const a = await apiV1Auth(req, res, 'balance.read'); if (!a) return;
      try { const balance=Number((await fb.get(`users/${a.uid}/balance`))||0); return apiV1Reply(res,200,true,{balance, currency:'INR'}); } catch(e) { return apiV1Reply(res,500,false,{code:'EAPI',message:e.message}); }
    }
    if (p === '/api/v1/order' && m === 'POST') {
      const a = await apiV1Auth(req, res, 'orders.create'); if (!a) return;
      try { return await apiV1Order(req,res,a,await parseBody(req)); } catch(e) { return apiV1Reply(res,500,false,{code:'EAPI',message:e.message}); }
    }
    if (p.startsWith('/api/v1/order/') && m === 'GET') {
      const a = await apiV1Auth(req, res, 'orders.read'); if (!a) return;
      const oid=decodeURIComponent(p.slice('/api/v1/order/'.length));
      const all=(await fb.get('orders'))||{}; const found=Object.values(all).find(o=>o && o.uid===a.uid && String(o.apiOrderId||o.order_id||'')===oid);
      if (!found) return apiV1Reply(res,404,false,{code:'ENOTFOUND',message:'Order nahi mila'});
      return apiV1Reply(res,200,true,found);
    }
    if (p === '/api/v1/orders' && m === 'GET') {
      const a = await apiV1Auth(req, res, 'orders.read'); if (!a) return;
      const all=(await fb.get('orders'))||{}; const list=Object.values(all).filter(o=>o&&o.uid===a.uid&&o.source==='api').sort((x,y)=>(Number(y.ts)||0)-(Number(x.ts)||0));
      return apiV1Reply(res,200,true,list);
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

    // Browser pings for signup / reseller. The server re-reads the database, so a fake ping can never produce a fake alert.
    if (p === '/api/notify' && m === 'POST') {
      if (limited(ip, 'notify', 30)) return fail(res, 429, 'ERATE', 'Too many requests');
      if (needFb(res)) return; const b = await parseBody(req);
      if (!['signup', 'reseller'].includes(b.event)) return fail(res, 400, 'EACTION', 'Unknown event');
      return ok(res, await notify.clientEvent(b.event, b.uid, String(b.via || '')));
    }
    if (p === '/api/admin/notify' && m === 'POST') {
      if (limited(ip, 'admin', 60)) return fail(res, 429, 'ERATE', 'Too many requests');
      if (needFb(res)) return; const admin = await requireAdmin(req, res); if (!admin) return;
      const b = await parseBody(req);
      try {
        switch (b.action) {
          case 'get': return ok(res, { config: notify.publicConfig(await notify.loadConfig(true)), publicBase: baseOf(req) });
          case 'save': { const c = await notify.saveConfig(b.config || {}); fb.push('audit_logs', { admin: admin.email, action: 'save_notify', detail: c.chatId || '', ts: Date.now() }).catch(() => {}); return ok(res, { config: c }); }
          case 'test': return ok(res, await notify.test(String(b.event || 'deposit')));
          case 'broadcast': { const r = await notify.broadcast(b.text); fb.push('audit_logs', { admin: admin.email, action: 'broadcast', detail: String(b.text).slice(0, 80), ts: Date.now() }).catch(() => {}); return ok(res, r); }
          case 'logs': return ok(res, await notify.recentLogs(30));
          default: return fail(res, 400, 'EACTION', 'Unknown action');
        }
      } catch (e) { return fail(res, e.status || 502, e.code || 'ENOTIFY', e.message); }
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
  if (env.AUTO_RECONCILE !== '0') { pay.startReconciler(); notify.startWatcher(); }
  return { server, fb, pay, notify };
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
