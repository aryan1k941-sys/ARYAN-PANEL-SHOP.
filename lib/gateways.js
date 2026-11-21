'use strict';
// Payment gateway adapters. Each gateway has its OWN request format - they are NOT assumed to be identical.
//   fam    : FamGateway   - GET  <base>/api/qr.php , GET <base>/api/verify-order.php       (copied from the working integration)
//   zapupi : ZapUPI       - POST <base>/api/create-order , POST <base>/api/order-status    (copied from the bot's working code)
//   custom : anything else (e.g. Mivopay) - driven by an admin-supplied JSON mapping. Without a mapping it refuses to
//            run and says "API documentation needed" instead of guessing.
const { safeRequest, validateGatewayUrl } = require('./netguard');

const lc = (x) => String(x == null ? '' : x).trim().toLowerCase();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const PAID = ['success', 'paid', 'completed', 'confirmed', 'successful', 'captured', 'credited'];
const FAILED = ['failed', 'failure', 'cancelled', 'canceled', 'rejected', 'declined'];
const EXPIRED = ['expired', 'timeout', 'timed_out', 'timedout'];
const AUTHBAD = /unauthori[sz]ed|invalid.{0,12}(api|zap|key|token|credential)|api.?key.{0,20}(invalid|wrong|missing|required)|forbidden|access denied/i;

const getPath = (o, p) => { if (!p) return undefined; return String(p).split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); };
const pick = (o, paths) => { for (const p of paths) { const v = getPath(o, p); if (v !== undefined && v !== null && v !== '') return v; } return undefined; };

class GatewayError extends Error { constructor(message, code, extra) { super(message); this.code = code || 'EGATEWAY'; Object.assign(this, extra || {}); } }

function inferStyle(g) {
  if (g.style && ['fam', 'zapupi', 'custom'].includes(g.style)) return g.style;
  let h = ''; try { h = new URL(g.baseUrl).hostname.toLowerCase(); } catch (e) {}
  if (/famgateway/.test(h)) return 'fam';
  if (/zapupi/.test(h)) return 'zapupi';
  return 'custom';
}
const LEGACY_FAM_PATHS = ['/api/qr.php', '/api/verify-order.php'];
const DEFAULT_PATHS = {
  fam: { create: '/api/qr.php', verify: '/api/verify-order.php' },
  zapupi: { create: '/api/create-order', verify: '/api/order-status' },
  custom: { create: '', verify: '' }
};
function resolvePaths(g, style) {
  let c = g.createPath || '', v = g.verifyPath || '';
  // The admin panel pre-filled ZapUPI with FamGateway's paths (/api/qr.php). Those are wrong for ZapUPI -> use the real ones.
  if (style === 'zapupi') { if (!c || LEGACY_FAM_PATHS.includes(c)) c = DEFAULT_PATHS.zapupi.create; if (!v || LEGACY_FAM_PATHS.includes(v)) v = DEFAULT_PATHS.zapupi.verify; }
  if (style === 'fam') { c = c || DEFAULT_PATHS.fam.create; v = v || DEFAULT_PATHS.fam.verify; }
  return { create: c, verify: v };
}
function endpoint(g, path) {
  if (!path || !String(path).startsWith('/') || /\.\.|\/\/|[#\\@\s]/.test(path)) throw new GatewayError('Gateway path galat hai: ' + path, 'EBADCONFIG');
  const base = new URL(g.baseUrl);
  const u = new URL(base.origin + path);
  if (u.origin !== base.origin) throw new GatewayError('Gateway path base host se bahar ja raha hai', 'EBADCONFIG');
  return u;
}
const hostsOf = (g) => new Set([new URL(g.baseUrl).hostname.toLowerCase()]);

/** one HTTP call -> { status, json, text, ms } ; network failures become GatewayError with a real message */
async function call(g, { method, url, headers = {}, body, timeoutMs }) {
  let r;
  try { r = await safeRequest({ url: url.toString(), method, headers: { Accept: 'application/json', ...headers }, body, timeoutMs: timeoutMs || 20000, allowedHosts: hostsOf(g) }); }
  catch (e) {
    const code = e.code === 'ETIMEOUT' ? 'ETIMEOUT' : e.code === 'EGWBLOCKED' ? 'EGWBLOCKED' : 'ENETWORK';
    const msg = e.code === 'ETIMEOUT' ? 'Gateway timeout (20s) - server ne jawab nahi diya'
      : e.code === 'EGWBLOCKED' ? 'Request block hui: ' + e.message
      : e.code === 'ENOTFOUND' ? 'Gateway ka domain nahi mila (DNS): ' + new URL(g.baseUrl).hostname
      : e.code === 'ECONNREFUSED' ? 'Gateway ne connection refuse kiya'
      : /certificate|SSL|TLS/i.test(e.message || '') ? 'Gateway ka HTTPS certificate galat hai: ' + e.message
      : 'Gateway se connect nahi ho paya: ' + (e.code || e.message);
    throw new GatewayError(msg, code);
  }
  let json = null; try { json = JSON.parse(r.text); } catch (e) {}
  return { status: r.status, json, text: r.text, ms: r.ms, contentType: String(r.headers['content-type'] || '') };
}
const snippet = (t, key) => { let s = String(t || '').replace(/\s+/g, ' ').slice(0, 240); if (key) s = s.split(key).join('***'); return s; };

/** Strict reading of a verify response. Inner payment status wins over the outer "request ok" status. */
function interpret(j) {
  if (!j || typeof j !== 'object') return { state: 'unknown' };
  const d = (j.data && typeof j.data === 'object' && !Array.isArray(j.data)) ? j.data : {};
  const inner = lc(pick(d, ['status', 'payment_status', 'txn_status', 'order_status']));
  const outer = lc(j.status);
  const msg = String(j.message || j.error || d.message || '');
  const flagPaid = d.is_paid === true || d.paid === true || j.is_paid === true || j.paid === true;
  const cls = (s) => PAID.includes(s) ? 'paid' : EXPIRED.includes(s) ? 'expired' : FAILED.includes(s) ? 'failed' : 'pending';
  let state;
  if (inner) state = cls(inner);
  else if (flagPaid) state = 'paid';
  else if (AUTHBAD.test(outer) || AUTHBAD.test(msg)) state = 'unauthorized';
  else if (outer) state = outer === 'error' || outer === 'fail' ? (/not.?found|no.?order|invalid.?order/i.test(msg) ? 'notfound' : 'error') : cls(outer);
  else state = 'unknown';
  const amt = pick(d, ['amount', 'paid_amount', 'payable_amount']) ?? pick(j, ['amount']);
  return {
    state, message: msg,
    orderId: pick(d, ['order_id', 'orderId', 'client_order_id']) ?? pick(j, ['order_id']),
    amount: amt == null || isNaN(Number(amt)) ? null : round2(amt),
    reference: String(pick(d, ['utr', 'reference', 'txn_id', 'rrn', 'transaction_id']) ?? '')
  };
}

/* ------------------------------------------------------------------ FAM */
const fam = {
  async create(g, { amount, name, phone, redirectUrl }) {
    const p = resolvePaths(g, 'fam'); const q = new URLSearchParams({ api_key: g.apiKey, amount: amount.toFixed(2), customer_name: name || 'user' });
    if (phone) q.set('customer_phone', phone); if (redirectUrl) q.set('redirect_url', redirectUrl);
    const u = endpoint(g, p.create); u.search = q.toString();
    const r = await call(g, { method: 'GET', url: u, headers: { 'X-Api-Key': g.apiKey } });
    if (!r.json) throw new GatewayError(`Gateway ne JSON nahi diya (HTTP ${r.status}): ${snippet(r.text, g.apiKey)}`, 'EBADRESPONSE', { http: r.status });
    if (lc(r.json.status) !== 'success' || !r.json.data) throw new GatewayError(r.json.message || `Order create nahi hua (HTTP ${r.status})`, AUTHBAD.test(JSON.stringify(r.json)) ? 'EAUTH' : 'EREJECTED', { http: r.status });
    const d = r.json.data;
    const orderId = d.order_id; const url = d.checkout_url || d.payment_url || d.qr_url; const qr = d.qr_url || d.qr || '';
    if (!orderId) throw new GatewayError('Gateway ne order ID return nahi kiya', 'EBADRESPONSE');
    if (!url) throw new GatewayError('Gateway ne checkout/QR URL return nahi kiya', 'EBADRESPONSE');
    return { gatewayOrderId: String(orderId), checkoutUrl: String(url), qr: String(qr || ''), amount: round2(d.amount ?? amount), payAmount: round2(d.payable_amount ?? d.amount ?? amount), expiresIn: Number(d.expires_in) || 0 };
  },
  async verify(g, orderId) {
    const p = resolvePaths(g, 'fam'); let sawJson = false, last = null, unauthorized = false, expired = false, mismatch = false;
    const attempts = [
      () => { const u = endpoint(g, p.verify); u.search = new URLSearchParams({ order_id: orderId }).toString(); return call(g, { method: 'GET', url: u, headers: { 'X-Api-Key': g.apiKey } }); },
      () => { const u = endpoint(g, p.verify); u.search = new URLSearchParams({ api_key: g.apiKey, order_id: orderId }).toString(); return call(g, { method: 'GET', url: u }); },
      () => { const u = endpoint(g, '/api/checkout-status.php'); u.search = new URLSearchParams({ order_id: orderId }).toString(); return call(g, { method: 'GET', url: u }); }
    ];
    let netErr = null;
    for (const a of attempts) {
      let r; try { r = await a(); } catch (e) { netErr = e; continue; }
      if (!r.json) continue; sawJson = true; last = r;
      const it = interpret(r.json);
      if (it.state === 'unauthorized' || r.status === 401 || r.status === 403) { unauthorized = true; continue; }
      if (it.orderId && String(it.orderId) !== String(orderId)) { mismatch = true; continue; }
      if (it.state === 'paid' && r.status === 200) return { ...it, raw: r.json };
      if (it.state === 'expired') expired = true;
      if (it.state === 'failed') return { ...it, raw: r.json };
    }
    if (mismatch) return { state: 'error', message: 'Gateway ne alag order ID return kiya (mismatch)' };
    if (expired) return { state: 'expired' };
    if (!sawJson) throw netErr || new GatewayError('Gateway ne JSON nahi diya', 'EBADRESPONSE');
    if (unauthorized) return { state: 'unauthorized', message: 'API key galat hai ya gateway ne reject ki' };
    return { state: 'pending', message: last && last.json && last.json.message || '' };
  },
  probeVerify(g, orderId) {
    const p = resolvePaths(g, 'fam'); const u = endpoint(g, p.verify); u.search = new URLSearchParams({ order_id: orderId }).toString();
    return call(g, { method: 'GET', url: u, headers: { 'X-Api-Key': g.apiKey }, timeoutMs: 12000 });
  },
  needsMapping: false
};

/* --------------------------------------------------------------- ZAPUPI */
const zapupi = {
  async create(g, { amount, name, redirectUrl, webhookUrl, orderRef }) {
    const p = resolvePaths(g, 'zapupi'); const payload = { zap_key: g.apiKey, amount: String(round2(amount)), order_id: orderRef, remark: `Wallet Deposit | ${name || 'user'}` };
    if (redirectUrl) Object.assign(payload, { success_url: redirectUrl, failed_url: redirectUrl, timeout_url: redirectUrl });
    if (webhookUrl) payload.webhook_url = webhookUrl;
    const r = await call(g, { method: 'POST', url: endpoint(g, p.create), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.json) throw new GatewayError(`ZapUPI ne JSON nahi diya (HTTP ${r.status}): ${snippet(r.text, g.apiKey)}`, 'EBADRESPONSE', { http: r.status });
    const url = r.json.payment_url || (r.json.data && (r.json.data.payment_url || r.json.data.checkout_url));
    if (lc(r.json.status) !== 'success' || !url) throw new GatewayError(r.json.message || 'ZapUPI ne valid payment link return nahi kiya', AUTHBAD.test(JSON.stringify(r.json)) ? 'EAUTH' : 'EREJECTED', { http: r.status });
    const d = r.json.data || {};
    return { gatewayOrderId: orderRef, checkoutUrl: String(url), qr: String(d.qr_url || d.qr || ''), amount: round2(amount), payAmount: round2(d.payable_amount ?? amount), expiresIn: 0 };
  },
  async verify(g, orderId) {
    const p = resolvePaths(g, 'zapupi');
    const r = await call(g, { method: 'POST', url: endpoint(g, p.verify), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zap_key: g.apiKey, order_id: orderId }) });
    if (!r.json) throw new GatewayError(`ZapUPI ne JSON nahi diya (HTTP ${r.status}): ${snippet(r.text, g.apiKey)}`, 'EBADRESPONSE', { http: r.status });
    if (r.status === 401 || r.status === 403 || AUTHBAD.test(JSON.stringify(r.json))) return { state: 'unauthorized', message: r.json.message || 'Zap key galat hai' };
    if (lc(r.json.status) !== 'success') { const it = interpret(r.json); return { ...it, state: it.state === 'paid' ? 'pending' : it.state }; } // outer must be success for ZapUPI
    const it = interpret(r.json);
    if (it.orderId && String(it.orderId) !== String(orderId)) return { state: 'error', message: 'Gateway ne alag order ID return kiya (mismatch)' };
    return { ...it, raw: r.json };
  },
  probeVerify(g, orderId) {
    const p = resolvePaths(g, 'zapupi');
    return call(g, { method: 'POST', url: endpoint(g, p.verify), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zap_key: g.apiKey, order_id: orderId }), timeoutMs: 12000 });
  },
  needsMapping: false
};

/* --------------------------------------------------------------- CUSTOM */
function parseMapping(g) {
  let m = g.mapping; if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = null; } }
  if (!m || typeof m !== 'object' || !m.create || !m.verify || !m.create.orderIdPath && !m.create.clientOrderId || !(m.create.urlPath || m.create.qrPath) || !m.verify.statusPath || !(m.verify.paidValues || []).length) return null;
  return m;
}
function buildReq(g, spec, values) {
  const method = String(spec.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const f = spec.fields || {}; const data = {};
  for (const k of Object.keys(f)) if (values[k] !== undefined && values[k] !== '') data[f[k]] = values[k];
  Object.assign(data, spec.extra || {});
  const headers = {}; const authName = spec.authName || 'api_key'; const authVal = (spec.authPrefix || '') + g.apiKey;
  if (spec.authIn === 'header') headers[authName] = authVal; else data[authName] = g.apiKey;
  const bodyType = spec.body || (method === 'GET' ? 'query' : 'json');
  const u = endpoint(g, spec.path); let body;
  if (method === 'GET' || bodyType === 'query') u.search = new URLSearchParams(data).toString();
  else if (bodyType === 'form') { body = new URLSearchParams(data).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  else { body = JSON.stringify(data); headers['Content-Type'] = 'application/json'; }
  return { method, url: u, headers, body };
}
const custom = {
  needsMapping: true,
  async create(g, { amount, name, phone, redirectUrl, webhookUrl, orderRef }) {
    const m = parseMapping(g); if (!m) throw new GatewayError('Is gateway ka API format configure nahi hai - gateway ki API documentation chahiye (Admin > Edit gateway > API format).', 'ENEEDSDOCS');
    const c = m.create; const spec = { ...c, path: resolvePaths(g, 'custom').create };
    const r = await call(g, buildReq(g, spec, { amount: amount.toFixed(2), orderId: orderRef, name, phone, redirect: redirectUrl, webhook: webhookUrl, remark: 'Wallet Deposit' }));
    if (!r.json) throw new GatewayError(`Gateway ne JSON nahi diya (HTTP ${r.status}): ${snippet(r.text, g.apiKey)}`, 'EBADRESPONSE', { http: r.status });
    const okv = (c.okValues || ['success']).map(lc);
    if (c.okPath && !okv.includes(lc(getPath(r.json, c.okPath)))) throw new GatewayError(String(getPath(r.json, c.messagePath || 'message') || 'Order create nahi hua'), AUTHBAD.test(JSON.stringify(r.json)) ? 'EAUTH' : 'EREJECTED', { http: r.status });
    const oid = c.clientOrderId ? orderRef : getPath(r.json, c.orderIdPath);
    const url = getPath(r.json, c.urlPath) || getPath(r.json, c.qrPath);
    if (!oid || !url) throw new GatewayError('Gateway response me order ID / payment URL nahi mila (mapping check karo)', 'EBADRESPONSE');
    const amt = c.amountPath ? getPath(r.json, c.amountPath) : null;
    return { gatewayOrderId: String(oid), checkoutUrl: String(url), qr: String(getPath(r.json, c.qrPath) || ''), amount: round2(amt ?? amount), payAmount: round2(amt ?? amount), expiresIn: 0 };
  },
  async verify(g, orderId) {
    const m = parseMapping(g); if (!m) throw new GatewayError('Is gateway ka API format configure nahi hai - gateway ki API documentation chahiye.', 'ENEEDSDOCS');
    const v = m.verify; const spec = { ...v, path: resolvePaths(g, 'custom').verify };
    const r = await call(g, buildReq(g, spec, { orderId }));
    if (!r.json) throw new GatewayError(`Gateway ne JSON nahi diya (HTTP ${r.status})`, 'EBADRESPONSE', { http: r.status });
    if (r.status === 401 || r.status === 403 || AUTHBAD.test(JSON.stringify(r.json))) return { state: 'unauthorized', message: String(r.json.message || 'API key galat hai') };
    if (v.okPath && !(v.okValues || ['success']).map(lc).includes(lc(getPath(r.json, v.okPath)))) return { state: 'error', message: String(getPath(r.json, v.messagePath || 'message') || 'Gateway error') };
    const st = lc(getPath(r.json, v.statusPath));
    const state = (v.paidValues || []).map(lc).includes(st) ? 'paid' : (v.expiredValues || EXPIRED).map(lc).includes(st) ? 'expired' : (v.failedValues || FAILED).map(lc).includes(st) ? 'failed' : 'pending';
    const ret = v.orderIdPath ? getPath(r.json, v.orderIdPath) : undefined;
    if (ret != null && String(ret) !== String(orderId)) return { state: 'error', message: 'Gateway ne alag order ID return kiya (mismatch)' };
    const a = v.amountPath ? getPath(r.json, v.amountPath) : null;
    return { state, amount: a == null || isNaN(Number(a)) ? null : round2(a), reference: String(v.refPath ? (getPath(r.json, v.refPath) || '') : ''), raw: r.json };
  },
  probeVerify(g, orderId) {
    const m = parseMapping(g); if (!m) throw new GatewayError('API format (documentation) configure nahi hai', 'ENEEDSDOCS');
    return call(g, { ...buildReq(g, { ...m.verify, path: resolvePaths(g, 'custom').verify }, { orderId }), timeoutMs: 12000 });
  }
};
const ADAPTERS = { fam, zapupi, custom };
const adapterFor = (g) => ADAPTERS[inferStyle(g)];

/* --------------------------------------------------------- validation */
function validateGatewayConfig(rec) {
  const errs = [];
  if (!rec.name || String(rec.name).length > 60) errs.push('Gateway name zaroori hai (max 60 chars)');
  try { validateGatewayUrl(rec.baseUrl, null); const u = new URL(rec.baseUrl); if (u.pathname !== '/' && u.pathname !== '') errs.push('API URL sirf base host hona chahiye (path alag field me)'); } catch (e) { errs.push('API URL valid https:// URL hona chahiye (' + e.message + ')'); }
  for (const k of ['createPath', 'verifyPath']) if (rec[k] && (!String(rec[k]).startsWith('/') || /\.\.|\/\/|[#\\@\s]/.test(rec[k]))) errs.push(k + ' "/" se shuru hona chahiye (jaise /api/qr.php)');
  if (!(rec.minAmount > 0)) errs.push('Min amount > 0 hona chahiye');
  if (!(rec.maxAmount >= rec.minAmount)) errs.push('Max amount, min se kam nahi ho sakta');
  if (!['fam', 'zapupi', 'custom'].includes(rec.style)) errs.push('API style galat hai');
  if (rec.style === 'custom' && rec.mapping) { try { const m = typeof rec.mapping === 'string' ? JSON.parse(rec.mapping) : rec.mapping; if (typeof m !== 'object') throw 0; } catch (e) { errs.push('API format JSON valid nahi hai'); } }
  return errs;
}

/* --------------------------------------------------------------- TEST */
/** Safe connection test. NEVER reports "connected" just because a dummy order returned an error.
 *  levels: unreachable | bad_endpoint | auth_failed | needs_docs | reachable | verified
 *  `deep` also creates one real UNPAID order at the minimum amount (no money moves unless someone pays it). */
async function testGateway(g, { deep = false, redirectUrl = '' } = {}) {
  const style = inferStyle(g); const ad = ADAPTERS[style]; const out = { style, level: 'unknown', message: '', details: {}, createdOrder: null };
  if (!g.apiKey) { out.level = 'auth_failed'; out.message = 'API key set nahi hai.'; return out; }
  if (ad.needsMapping && !parseMapping(g)) { out.level = 'needs_docs'; out.message = 'Is gateway ka request/response format (API documentation) abhi configure nahi hai - bina docs ke connect hone ka dawa nahi kiya ja sakta.'; return out; }
  let r;
  try { r = await ad.probeVerify(g, 'TESTPROBE' + Date.now().toString(36)); }
  catch (e) { out.level = e.code === 'ENEEDSDOCS' ? 'needs_docs' : 'unreachable'; out.message = e.message; return out; }
  out.details = { http: r.status, contentType: r.contentType, ms: r.ms, body: snippet(r.text, g.apiKey) };
  if (r.status === 401 || r.status === 403 || (r.json && AUTHBAD.test(JSON.stringify(r.json)))) { out.level = 'auth_failed'; out.message = 'Gateway ne API key reject ki: ' + out.details.body; return out; }
  if (!r.json) { out.level = 'bad_endpoint'; out.message = `Endpoint JSON nahi de raha (HTTP ${r.status}, ${r.contentType || 'no content-type'}) - base URL / path galat ho sakta hai.`; return out; }
  const orderMissing = /not.?found|no.?(such.?)?order|invalid.?order|order.{0,20}(exist|found)/i.test(JSON.stringify(r.json));
  if ((r.status === 404 && !orderMissing) || r.status >= 500) { out.level = 'bad_endpoint'; out.message = `Endpoint ne HTTP ${r.status} diya - path galat ya gateway down.`; return out; }
  out.level = 'reachable';
  out.message = 'Gateway JSON me jawab de raha hai aur API key reject nahi hui. (Pakka "verified" tabhi hoga jab ek asli order create ho jaye.)';
  if (deep) {
    try {
      const o = await ad.create(g, { amount: Math.max(Number(g.minAmount) || 1, 1), name: 'gateway-test', phone: '', redirectUrl, orderRef: (style === 'zapupi' ? 'ZAPUPITEST' : 'TEST') + Date.now().toString(36).toUpperCase() });
      out.level = 'verified'; out.message = 'Asli test order create ho gaya (unpaid). Gateway sach me connected hai.'; out.createdOrder = { orderId: o.gatewayOrderId, checkoutUrl: o.checkoutUrl, amount: o.amount };
    } catch (e) { out.level = e.code === 'EAUTH' ? 'auth_failed' : e.code === 'ENEEDSDOCS' ? 'needs_docs' : 'reachable'; out.message = 'Deep test fail: ' + e.message; out.details.createError = e.message; }
  }
  return out;
}

module.exports = { inferStyle, adapterFor, resolvePaths, validateGatewayConfig, testGateway, interpret, GatewayError, round2, parseMapping, ADAPTERS };
