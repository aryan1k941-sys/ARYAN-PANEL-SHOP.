'use strict';
process.env.ADMIN_SESSION_REQUIRED = '0'; process.env.ADMIN_AUTOBAN = '0'; // legacy tests exercise endpoints directly; security flow is tested in test/adminsec.js
// Runs against: real server.js + real lib/*, with MOCK Firebase REST, MOCK identity service and MOCK HTTPS gateways.
// (Real gateway credentials / docs are NOT available here, so no real gateway is contacted.)
const fs = require('fs'), path = require('path');
const { startRtdb, startIdentity, startGateways } = require('./mocks');
let pass = 0, failN = 0; const failures = [];
const t = async (name, fn) => { try { await fn(); pass++; console.log('  PASS  ' + name); } catch (e) { failN++; failures.push(name); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'eq') + ': got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const truthy = (v, m) => { if (!v) throw new Error('expected truthy: ' + m); };

(async () => {
  const tls = { key: fs.readFileSync(process.env.TEST_TLS_KEY), cert: fs.readFileSync(process.env.TEST_TLS_CERT) };
  const db = await startRtdb(); const idn = await startIdentity(); const gw = await startGateways(tls); const G = gw.G;
  Object.assign(process.env, { FIREBASE_DB_URL: db.url, IDENTITY_LOOKUP_URL: idn.url, ADMIN_EMAILS: 'boss@example.com', AUTO_RECONCILE: '0', RATE_CREATE_PER_MIN: '1000', PUBLIC_BASE_URL: 'https://shop.example.com' });
  const { createApp } = require('../server'); const app = createApp(process.env);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + app.server.address().port;
  const post = async (p, body, headers = {}) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
  const admin = (body) => post('/api/admin/gateways', body, { Authorization: 'Bearer tok:boss@example.com' });
  const bal = (uid) => Number((db.getAt(`users/${uid}/balance`)) || 0);
  const reset = () => { db.S.tree = { users: { u1: { username: 'tester', balance: 100, role: 'User' }, ub: { username: 'banned', balance: 0, status: 'Banned' } } }; for (const k of ['fam', 'zap', 'mivo']) { G[k].orders = {}; G[k].mode = 'ok'; G[k].calls = []; } };
  const addGw = async (g) => { const r = await admin({ action: 'save', gateway: g }); if (!r.j.ok) throw new Error('save gw: ' + JSON.stringify(r.j)); return r.j.data.id; };
  const FAM = (o = {}) => ({ name: 'FAMPAY.XL', baseUrl: gw.fam.base, style: 'fam', createPath: '/api/qr.php', verifyPath: '/api/verify-order.php', apiKey: G.fam.key, minAmount: 1, maxAmount: 50000, priority: 1, enabled: true, ...o });
  const ZAP = (o = {}) => ({ name: 'ZapUPI', baseUrl: gw.zap.base, style: 'zapupi', createPath: '/api/qr.php', verifyPath: '/api/verify-order.php', apiKey: G.zap.key, minAmount: 1, maxAmount: 50000, priority: 2, enabled: true, ...o });
  const MIVO_MAP = { create: { method: 'POST', body: 'form', authIn: 'header', authName: 'Authorization', authPrefix: 'Bearer ', fields: { amount: 'amt', orderId: 'merchant_order' }, clientOrderId: true, okPath: 'code', okValues: ['0'], urlPath: 'result.pay_link' }, verify: { method: 'POST', body: 'form', authIn: 'header', authName: 'Authorization', authPrefix: 'Bearer ', fields: { orderId: 'merchant_order' }, okPath: 'code', okValues: ['0'], statusPath: 'result.state', paidValues: ['PAID'], orderIdPath: 'result.merchant_order', amountPath: 'result.amt', refPath: 'result.txn' } };
  const MIVO = (o = {}) => ({ name: 'Mivopay', baseUrl: gw.mivo.base, style: 'custom', createPath: '/api/order.php', verifyPath: '/api/verify-order.php', apiKey: G.mivo.key, minAmount: 1, maxAmount: 50000, priority: 3, enabled: true, ...o });

  console.log('\n== health / routing / static ==');
  await t('health endpoint returns JSON envelope', async () => { const r = await (await fetch(BASE + '/api/health')).json(); eq(r.ok, true); eq(r.data.status, 'up'); });
  await t('unknown API route -> 404 JSON', async () => { const r = await fetch(BASE + '/api/nope'); eq(r.status, 404); eq((await r.json()).ok, false); });
  await t('static: / serves index.html, server.js is NOT served, traversal blocked', async () => {
    eq((await fetch(BASE + '/')).status, 200); eq((await fetch(BASE + '/Admin.html')).status, 200);
    eq((await fetch(BASE + '/server.js')).status, 404); eq((await fetch(BASE + '/lib/firebase.js')).status, 404);
    const raw = await new Promise((res) => { const s = require('net').connect(app.server.address().port, '127.0.0.1', () => s.write('GET /..%2fserver.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')); let d = ''; s.on('data', c => d += c); s.on('close', () => res(d)); });
    truthy(/ 40[34] /.test(raw.split('\r\n')[0]), 'traversal status ' + raw.split('\r\n')[0]);
  });

  console.log('\n== admin API security ==');
  reset();
  await t('admin API without token -> 401', async () => eq((await post('/api/admin/gateways', { action: 'list' })).status, 401));
  await t('admin API with non-admin account -> 403', async () => eq((await post('/api/admin/gateways', { action: 'list' }, { Authorization: 'Bearer tok:user@example.com' })).status, 403));
  await t('admin API with invalid token -> 401', async () => eq((await post('/api/admin/gateways', { action: 'list' }, { Authorization: 'Bearer garbage' })).status, 401));
  await t('Save gateway: key goes to server-only node, NOT to browser-readable node', async () => {
    const id = await addGw(FAM()); eq(db.getAt(`gateway_secrets/${id}/apiKey`), G.fam.key); eq(db.getAt(`payment_gateways/${id}/apiKey`), null);
    const l = (await admin({ action: 'list' })).j.data[0]; eq(l.keySet, true); eq(l.keyHint, '••••' + G.fam.key.slice(-3)); truthy(!JSON.stringify(l).includes(G.fam.key), 'full key leaked in list');
  });
  await t('Edit with blank key keeps existing key; new key replaces it', async () => {
    const id = Object.keys(db.getAt('payment_gateways'))[0];
    await admin({ action: 'save', gateway: { ...FAM(), id, apiKey: '', name: 'FAMPAY.XL v2' } }); eq(db.getAt(`gateway_secrets/${id}/apiKey`), G.fam.key); eq(db.getAt(`payment_gateways/${id}/name`), 'FAMPAY.XL v2');
    await admin({ action: 'save', gateway: { ...FAM(), id, apiKey: 'newkey_777777' } }); eq(db.getAt(`gateway_secrets/${id}/apiKey`), 'newkey_777777'); await admin({ action: 'save', gateway: { ...FAM(), id, apiKey: G.fam.key } });
  });
  await t('Validation: http:// / bad path / min>max / IP host rejected', async () => {
    const bad = async (o) => { const r = await admin({ action: 'save', gateway: FAM(o) }); eq(r.j.ok, false); };
    await bad({ createPath: 'api/qr.php' }); await bad({ createPath: '/../etc' }); await bad({ minAmount: 500, maxAmount: 10 }); await bad({ apiKey: '' , name: '' });
  });
  await t('Legacy gateway with apiKey inside public node gets migrated to secrets', async () => {
    db.setAt('payment_gateways/legacy1', { name: 'Old', baseUrl: gw.fam.base, apiKey: 'legacykey_1234', enabled: false, priority: 50 });
    const r = await admin({ action: 'migrate' }); eq(r.j.ok, true); eq(db.getAt('payment_gateways/legacy1/apiKey'), null); eq(db.getAt('gateway_secrets/legacy1/apiKey'), 'legacykey_1234'); eq(db.getAt('payment_gateways/legacy1/keySet'), true);
    db.setAt('payment_gateways/legacy1', null); db.setAt('gateway_secrets/legacy1', null);
  });

  console.log('\n== create order ==');
  reset(); const famId = await addGw(FAM());
  await t('unknown user rejected', async () => eq((await post('/api/pay/create', { uid: 'nobody', amount: 50 })).status, 404));
  await t('banned user rejected', async () => eq((await post('/api/pay/create', { uid: 'ub', amount: 50 })).status, 403));
  await t('amount below min / above max / NaN rejected with real message', async () => {
    for (const a of [0, -5, 'abc', 60000]) { const r = await post('/api/pay/create', { uid: 'u1', amount: a }); eq(r.j.ok, false, 'amount ' + a); }
    const r = await post('/api/pay/create', { uid: 'u1', amount: 60000 }); truthy(/50000/.test(r.j.error.message), r.j.error.message);
  });
  let fo;
  await t('FAM: order created via GET with api_key + X-Api-Key (existing working format preserved)', async () => {
    const r = await post('/api/pay/create', { uid: 'u1', amount: 150, phone: '9876543210', returnUrl: 'https://shop.example.com/?ap=return' }); eq(r.j.ok, true, JSON.stringify(r.j)); fo = r.j.data;
    truthy(fo.checkoutUrl.startsWith('https://pay.example/checkout/'), 'checkout'); truthy(fo.orderId.startsWith('FAM'), 'order id'); eq(fo.status, 'pending'); eq(fo.amount, 150);
    const c = G.fam.calls.find(x => x.path === '/api/qr.php'); eq(c.method, 'GET'); eq(c.query.api_key, G.fam.key); eq(c.headers['x-api-key'], G.fam.key); eq(c.query.amount, '150.00'); eq(c.query.customer_phone, '9876543210');
    truthy(!JSON.stringify(r.j).includes(G.fam.key), 'key leaked to browser');
  });
  await t('pending transaction saved in Firebase (status pending, not credited)', async () => { const rec = db.getAt('auto_payments/' + fo.orderId); eq(rec.status, 'pending'); eq(rec.credited, false); eq(rec.uid, 'u1'); eq(rec.amount, 150); truthy(db.getAt('pending_payments/' + fo.orderId), 'pending index'); eq(bal('u1'), 100); });

  console.log('\n== verification + wallet credit ==');
  await t('unpaid order stays pending, wallet unchanged', async () => { const r = await post('/api/pay/verify', { orderId: fo.orderId, uid: 'u1' }); eq(r.j.data.status, 'pending'); eq(bal('u1'), 100); });
  await t('someone else cannot verify/cancel my order', async () => { eq((await post('/api/pay/verify', { orderId: fo.orderId, uid: 'u2' })).status, 403); eq((await post('/api/pay/cancel', { orderId: fo.orderId, uid: 'u2' })).status, 403); });
  await t('forged browser "success" has no effect: there is no endpoint to mark paid + gateway still says pending', async () => {
    const r = await post('/api/pay/verify', { orderId: fo.orderId, uid: 'u1', status: 'success', paid: true, amount: 150 }); eq(r.j.data.status, 'pending'); eq(bal('u1'), 100);
  });
  await t('outer status=success but inner payment status=pending is NOT treated as paid', async () => { G.fam.mode = 'tricky'; const r = await post('/api/pay/verify', { orderId: fo.orderId, uid: 'u1' }); eq(r.j.data.status, 'pending'); eq(bal('u1'), 100); G.fam.mode = 'ok'; });
  await t('wrong paid amount -> rejected, flagged for review, NO credit', async () => {
    const r0 = await post('/api/pay/create', { uid: 'u1', amount: 200 }); const o = r0.j.data; G.fam.orders[o.orderId].state = 'paid'; G.fam.orders[o.orderId].reportAmount = 20;
    const r = await post('/api/pay/verify', { orderId: o.orderId, uid: 'u1' }); eq(r.j.data.status, 'failed'); eq(bal('u1'), 100); eq(db.getAt('auto_payments/' + o.orderId + '/status'), 'amount_mismatch'); eq(db.getAt('auto_payments/' + o.orderId + '/needsReview'), true);
    eq((await post('/api/pay/verify', { orderId: o.orderId, uid: 'u1' })).j.data.status, 'failed'); eq(bal('u1'), 100);
  });
  await t('confirmed payment -> wallet credited once, ledger entry written, status success', async () => {
    G.fam.orders[fo.orderId].state = 'paid';
    const r = await post('/api/pay/verify', { orderId: fo.orderId, uid: 'u1' }); eq(r.j.data.status, 'success'); eq(r.j.data.balance, 250); eq(bal('u1'), 250);
    const rec = db.getAt('auto_payments/' + fo.orderId); eq(rec.credited, true); eq(rec.status, 'success'); eq(rec.reference, 'UTR' + fo.orderId); eq(rec.amountVerified, true);
    const led = db.getAt(`users/u1/transactions/dep_${fo.orderId}`); eq(led.type, 'Deposit'); eq(led.amount, 150); eq(db.getAt('pending_payments/' + fo.orderId), null);
  });
  await t('duplicate verify (sequential) does not credit twice', async () => { for (let i = 0; i < 3; i++) { const r = await post('/api/pay/verify', { orderId: fo.orderId, uid: 'u1' }); eq(r.j.data.status, 'success'); } eq(bal('u1'), 250); });
  await t('20 parallel verifies of a freshly paid order -> exactly ONE credit (atomic)', async () => {
    const o = (await post('/api/pay/create', { uid: 'u1', amount: 40 })).j.data; G.fam.orders[o.orderId].state = 'paid'; const before = bal('u1');
    const rs = await Promise.all(Array.from({ length: 20 }, () => post('/api/pay/verify', { orderId: o.orderId, uid: 'u1' })));
    eq(bal('u1'), before + 40, 'balance'); eq(Object.keys(db.getAt('users/u1/transactions')).filter(k => k === 'dep_' + o.orderId).length, 1);
    truthy(rs.every(r => r.j.ok), 'all responses ok');
  });
  await t('expired order -> expired, no credit; failed -> failed, no credit', async () => {
    const o1 = (await post('/api/pay/create', { uid: 'u1', amount: 11 })).j.data; G.fam.orders[o1.orderId].state = 'expired'; const b = bal('u1');
    eq((await post('/api/pay/verify', { orderId: o1.orderId, uid: 'u1' })).j.data.status, 'expired'); eq(db.getAt('auto_payments/' + o1.orderId + '/status'), 'expired');
    const o2 = (await post('/api/pay/create', { uid: 'u1', amount: 12 })).j.data; G.fam.orders[o2.orderId].state = 'failed';
    eq((await post('/api/pay/verify', { orderId: o2.orderId, uid: 'u1' })).j.data.status, 'failed'); eq(bal('u1'), b);
  });
  await t('invalid / unknown order id -> 404, no credit', async () => eq((await post('/api/pay/verify', { orderId: 'FAKE123', uid: 'u1' })).status, 404));
  await t('webhook ignores payload claims and re-verifies via gateway API', async () => {
    const o = (await post('/api/pay/create', { uid: 'u1', amount: 25 })).j.data; const b = bal('u1');
    let r = await post('/api/pay/webhook/' + famId, { order_id: o.orderId, status: 'success', amount: 25 }); eq(r.j.data.status, 'pending'); eq(bal('u1'), b);
    G.fam.orders[o.orderId].state = 'paid'; r = await post('/api/pay/webhook/' + famId, { order_id: o.orderId }); eq(r.j.data.status, 'success'); eq(bal('u1'), b + 25);
  });
  await t('deposit bonus applied exactly once and recorded', async () => {
    db.setAt('payment_settings', { bonusEnabled: true, bonusPct: 10, bonusMin: 100 });
    const o = (await post('/api/pay/create', { uid: 'u1', amount: 100 })).j.data; G.fam.orders[o.orderId].state = 'paid'; const b = bal('u1');
    await Promise.all([post('/api/pay/verify', { orderId: o.orderId }), post('/api/pay/verify', { orderId: o.orderId })]); eq(bal('u1'), b + 110); eq(db.getAt('users/u1/transactions/bonus_' + o.orderId + '/amount'), 10); db.setAt('payment_settings', null);
  });
  await t('cancel: pending -> cancelled; cannot cancel a credited order', async () => {
    const o = (await post('/api/pay/create', { uid: 'u1', amount: 30 })).j.data; eq((await post('/api/pay/cancel', { orderId: o.orderId, uid: 'u1' })).j.data.status, 'cancelled');
    eq((await post('/api/pay/cancel', { orderId: fo.orderId, uid: 'u1' })).j.data.status, 'success');
  });
  await t('DB failure BEFORE balance change releases claim (retry later works, still single credit)', async () => {
    const o = (await post('/api/pay/create', { uid: 'u1', amount: 15 })).j.data; G.fam.orders[o.orderId].state = 'paid'; const b = bal('u1');
    db.S.failNext = /GET \/users\/u1\/balance/; const r = await post('/api/pay/verify', { orderId: o.orderId, uid: 'u1' }); eq(r.j.ok, false); eq(bal('u1'), b); eq(db.getAt('auto_payments/' + o.orderId + '/status'), 'pending');
    const r2 = await post('/api/pay/verify', { orderId: o.orderId, uid: 'u1' }); eq(r2.j.data.status, 'success'); eq(bal('u1'), b + 15);
  });
  await t('reconciler credits a confirmed payment although the user never came back', async () => {
    const o = (await post('/api/pay/create', { uid: 'u1', amount: 55 })).j.data; G.fam.orders[o.orderId].state = 'paid'; const b = bal('u1');
    db.setAt('pending_payments/' + o.orderId + '/lastCheck', 0); db.setAt('pending_payments/' + o.orderId + '/createdAt', Date.now() - 60000);
    const r = await app.pay.reconcileOnce(); truthy(r.credited >= 1, JSON.stringify(r)); eq(bal('u1'), b + 55); const r2 = await app.pay.reconcileOnce(); eq(bal('u1'), b + 55, 'no repeat credit');
  });

  console.log('\n== ZapUPI (format taken from your bot code) ==');
  reset(); await addGw(ZAP({ priority: 1 }));
  let zo;
  await t('ZapUPI create: POST JSON {zap_key, amount, order_id, ...} to /api/create-order (wrong legacy /api/qr.php path auto-corrected)', async () => {
    const r = await post('/api/pay/create', { uid: 'u1', amount: 99, returnUrl: 'https://shop.example.com/?ap=return' }); eq(r.j.ok, true, JSON.stringify(r.j)); zo = r.j.data; truthy(zo.orderId.startsWith('ZAPUPI'), zo.orderId);
    const c = G.zap.calls.find(x => x.path === '/api/create-order'); eq(c.method, 'POST'); const body = JSON.parse(c.body); eq(body.zap_key, G.zap.key); eq(body.amount, '99'); eq(body.order_id, zo.orderId); truthy(body.webhook_url.endsWith('/api/pay/webhook/' + db.getAt('payment_gateways') && Object.keys(db.getAt('payment_gateways'))[0]), 'webhook url');
    eq(zo.checkoutUrl, 'https://pay.zapupi.example/p/' + zo.orderId);
  });
  await t('ZapUPI verify: POST /api/order-status -> pending then credited once', async () => {
    eq((await post('/api/pay/verify', { orderId: zo.orderId, uid: 'u1' })).j.data.status, 'pending'); G.zap.orders[zo.orderId].state = 'paid';
    const r = await post('/api/pay/verify', { orderId: zo.orderId, uid: 'u1' }); eq(r.j.data.status, 'success'); eq(bal('u1'), 199); await post('/api/pay/verify', { orderId: zo.orderId, uid: 'u1' }); eq(bal('u1'), 199);
    const c = G.zap.calls.filter(x => x.path === '/api/order-status').pop(); eq(JSON.parse(c.body).zap_key, G.zap.key);
  });
  await t('ZapUPI wrong key -> real error shown to user', async () => { const id = Object.keys(db.getAt('payment_gateways'))[0]; await admin({ action: 'save', gateway: { ...ZAP({ priority: 1 }), id, apiKey: 'WRONG_KEY_000' } }); const r = await post('/api/pay/create', { uid: 'u1', amount: 20 }); eq(r.j.ok, false); truthy(/zap_key/i.test(r.j.error.message), r.j.error.message); });

  console.log('\n== Mivopay / custom mapping (no docs => refuses to guess) ==');
  reset(); const mivoId = await addGw(MIVO({ mapping: '' }));
  await t('custom gateway WITHOUT API-format mapping: create fails with "documentation needed", nothing invented', async () => { const r = await post('/api/pay/create', { uid: 'u1', amount: 20 }); eq(r.j.ok, false); truthy(/documentation/i.test(r.j.error.message), r.j.error.message); eq(G.mivo.calls.length, 0, 'no request sent'); });
  await t('Test Gateway on unconfigured custom gateway -> needs_docs (NOT connected)', async () => { const r = await admin({ action: 'test', id: mivoId }); eq(r.j.data.level, 'needs_docs'); eq(db.getAt(`payment_gateways/${mivoId}/status`), 'needs_docs'); });
  await t('custom mapping (bearer header + form body + custom response fields) -> create + verify + credit', async () => {
    await addGw(MIVO({ id: mivoId, apiKey: '', mapping: JSON.stringify(MIVO_MAP) }));
    const r = await post('/api/pay/create', { uid: 'u1', amount: 75 }); eq(r.j.ok, true, JSON.stringify(r.j)); const o = r.j.data; truthy(o.checkoutUrl.startsWith('https://pay.mivo.example/'), o.checkoutUrl);
    eq(G.mivo.calls.find(c => c.path === '/api/order.php').headers.authorization, 'Bearer ' + G.mivo.key);
    eq((await post('/api/pay/verify', { orderId: o.orderId, uid: 'u1' })).j.data.status, 'pending'); G.mivo.orders[o.gatewayOrderId].state = 'paid';
    const v = await post('/api/pay/verify', { orderId: o.orderId, uid: 'u1' }); eq(v.j.data.status, 'success'); eq(bal('u1'), 175);
  });

  console.log('\n== priority + fallback + real errors ==');
  reset(); await addGw(FAM({ priority: 1 })); await addGw(ZAP({ priority: 2 }));
  await t('first gateway down (HTTP 500) -> automatic fallback to next gateway', async () => { G.fam.mode = 'down500'; const r = await post('/api/pay/create', { uid: 'u1', amount: 60 }); eq(r.j.ok, true, JSON.stringify(r.j)); eq(r.j.data.gatewayName, 'ZapUPI'); G.fam.mode = 'ok'; });
  await t('user-selected gateway is tried first', async () => { const zid = Object.entries(db.getAt('payment_gateways')).find(([, g]) => g.name === 'ZapUPI')[0]; const r = await post('/api/pay/create', { uid: 'u1', amount: 61, gatewayId: zid }); eq(r.j.data.gatewayName, 'ZapUPI'); });
  await t('all gateways failing -> the REAL error is returned', async () => { G.fam.mode = 'nonjson'; G.zap.mode = 'nonjson'; const r = await post('/api/pay/create', { uid: 'u1', amount: 62 }); eq(r.j.ok, false); truthy(/JSON/i.test(r.j.error.message), r.j.error.message); truthy(db.getAt('gateway_logs'), 'logged'); G.fam.mode = 'ok'; G.zap.mode = 'ok'; });
  await t('disabled gateway is never used', async () => { for (const id of Object.keys(db.getAt('payment_gateways'))) await admin({ action: 'toggle', id, enabled: false }); const r = await post('/api/pay/create', { uid: 'u1', amount: 62 }); eq(r.j.ok, false); truthy(/ON nahi/.test(r.j.error.message), r.j.error.message); for (const id of Object.keys(db.getAt('payment_gateways'))) await admin({ action: 'toggle', id, enabled: true }); });
  await t('Set primary / delete gateway (removes secret too)', async () => { const ids = Object.keys(db.getAt('payment_gateways')); await admin({ action: 'primary', id: ids[1] }); eq(db.getAt(`payment_gateways/${ids[1]}/priority`), 1); await admin({ action: 'delete', id: ids[1] }); eq(db.getAt(`payment_gateways/${ids[1]}`), null); eq(db.getAt(`gateway_secrets/${ids[1]}`), null); });

  console.log('\n== Test Gateway (must not fake "connected") ==');
  reset(); const tId = await addGw(FAM());
  const lvl = async (id, deep) => (await admin({ action: 'test', id, deep })).j.data;
  await t('good key, endpoint answers JSON "order not found" -> only "reachable", NOT verified', async () => { const r = await lvl(tId); eq(r.level, 'reachable'); truthy(!/connected/i.test(r.message) || /verified/i.test(r.message), r.message); });
  await t('deep test creates a real UNPAID order -> verified', async () => { const r = await lvl(tId, true); eq(r.level, 'verified'); truthy(r.createdOrder.orderId, 'order'); eq(db.getAt(`payment_gateways/${tId}/status`), 'verified'); });
  await t('wrong API key -> auth_failed', async () => { await addGw(FAM({ id: tId, apiKey: 'bad_key_000000' })); eq((await lvl(tId)).level, 'auth_failed'); await addGw(FAM({ id: tId, apiKey: G.fam.key })); });
  await t('endpoint returns HTML/404 -> bad_endpoint', async () => { G.fam.mode = 'nonjson'; eq((await lvl(tId)).level, 'bad_endpoint'); G.fam.mode = 'down500'; eq((await lvl(tId)).level, 'bad_endpoint'); G.fam.mode = 'ok'; });
  await t('host unreachable (closed port) -> unreachable with real reason', async () => { const id = await addGw(FAM({ name: 'dead', baseUrl: 'https://localhost:1', priority: 9 })); const r = await lvl(id); eq(r.level, 'unreachable'); truthy(r.message.length > 5, r.message); });
  await t('ZapUPI test: wrong legacy path is auto-corrected to /api/order-status', async () => { const id = await addGw(ZAP()); const r = await lvl(id); eq(r.level, 'reachable'); truthy(G.zap.calls.some(c => c.path === '/api/order-status'), 'used real path'); });

  console.log('\n== supplier proxy /api/gw (SSRF) ==');
  await t('host not in allow-list -> 403 blocked, nothing sent', async () => { const r = await fetch(BASE + '/api/gw?u=' + encodeURIComponent('https://evil.example.com/x')); eq(r.status, 403); eq(r.headers.get('x-gw'), 'blocked'); });
  await t('http:// , file:// , bad URL and metadata IP are refused', async () => {
    for (const u of ['http://127.0.0.1/', 'file:///etc/passwd', 'not a url', 'https://169.254.169.254/latest/meta-data/']) { const r = await fetch(BASE + '/api/gw?u=' + encodeURIComponent(u)); truthy([400, 403].includes(r.status), u + ' -> ' + r.status); }
  });
  await t('payment-gateway hosts are NOT reachable through the generic proxy', async () => { const r = await fetch(BASE + '/api/gw?u=' + encodeURIComponent(gw.fam.base + '/api/verify-order.php?order_id=1')); eq(r.status, 403); });

  console.log('\n== rate limiting ==');
  reset(); await addGw(FAM());
  await t('create-order is rate limited (HTTP 429 after N/min per IP)', async () => {
    const app2 = require('../server').createApp({ ...process.env, RATE_CREATE_PER_MIN: '5' }); await new Promise(r => app2.server.listen(0, '127.0.0.1', r)); const B2 = 'http://127.0.0.1:' + app2.server.address().port; let n429 = 0, nOk = 0;
    for (let i = 0; i < 9; i++) { const r = await fetch(B2 + '/api/pay/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: 'u1', amount: 10 + i }) }); if (r.status === 429) n429++; else nOk++; }
    app2.server.close(); eq(nOk, 5, 'allowed'); eq(n429, 4, 'blocked');
  });

  console.log(`\n${pass} passed, ${failN} failed`); if (failN) console.log('FAILED: ' + failures.join(' | '));
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASH', e); process.exit(2); });
