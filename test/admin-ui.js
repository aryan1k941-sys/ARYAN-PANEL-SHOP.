'use strict';
// Browser test of the ADMIN gateway screen. Firebase = in-memory stub, /api/admin/gateways = SIMULATED in this test
// (the real endpoint logic is covered by test/suite.js). Checks UI wiring, no key leakage in DOM, honest status labels.
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const { createApp } = require('../server'); const SHOTS = path.join(__dirname, 'shots');
let pass = 0, failN = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); } catch (e) { failN++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const ok = (v, m) => { if (!v) throw new Error(m); }; const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
(async () => {
  const app = createApp({ ...process.env, AUTO_RECONCILE: '0' }); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + app.server.address().port;
  const stub = fs.readFileSync(path.join(__dirname, 'fb-stub.js'), 'utf8');
  const seed = { payment_gateways: {
      g1: { name: 'FAMPAY.XL', baseUrl: 'https://famgateway.in', style: 'fam', createPath: '/api/qr.php', verifyPath: '/api/verify-order.php', keySet: true, keyHint: '••••a1b', enabled: true, priority: 1, minAmount: 1, maxAmount: 50000, status: 'verified', statusNote: 'Asli order create hua', lastCheck: Date.now() - 3600000 },
      g2: { name: 'ZapUPI', baseUrl: 'https://pay.zapupi.com', style: 'zapupi', createPath: '/api/create-order', verifyPath: '/api/order-status', keySet: true, keyHint: '••••c9d', enabled: false, priority: 2, minAmount: 1, maxAmount: 50000, status: 'reachable', lastCheck: Date.now() - 600000 },
      g3: { name: 'Mivopay', baseUrl: 'https://mivopay.shop', style: 'custom', createPath: '/api/order.php', verifyPath: '/api/verify-order.php', keySet: true, keyHint: '••••e77', enabled: true, priority: 100, minAmount: 1, maxAmount: 50000, status: 'needs_docs', statusNote: 'Format (API documentation) abhi configure nahi hai', lastCheck: Date.now() - 60000 } },
    auto_payments: { o1: { uid: 'u1', username: 'rahul', amount: 150, gatewayId: 'g1', status: 'success', createdAt: Date.now() - 7200000 }, o2: { uid: 'u2', username: 'amit', amount: 500, gatewayId: 'g2', status: 'pending', createdAt: Date.now() - 100000 }, o3: { uid: 'u3', username: 'sam', amount: 200, gatewayId: 'g1', status: 'amount_mismatch', needsReview: true, createdAt: Date.now() - 900000 } } };
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 }); const page = await ctx.newPage(); const errs = []; const calls = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  await ctx.route('**/*', async (r) => { const u = r.request().url();
    if (/gstatic\.com\/firebasejs/.test(u)) return r.fulfill({ status: 200, contentType: 'text/javascript', body: stub });
    if (u === BASE + '/api/admin/gateways') {
      const hdr = r.request().headers().authorization; const body = JSON.parse(r.request().postData() || '{}'); calls.push({ body, hdr });
      const out = await page.evaluate(([b]) => { const G = globalThis.__FB; const gws = G.tree.payment_gateways = G.tree.payment_gateways || {};
        const fire = () => G.fire('payment_gateways');
        if (b.action === 'status') return { ok: true, data: {} };
        if (b.action === 'save') { const g = b.gateway; const id = g.id || 'gN' + Object.keys(gws).length; const old = gws[id] || {}; const key = g.apiKey || 'oldkey000'; const { apiKey, id: _i, ...pub } = g; gws[id] = { ...old, ...pub, keySet: true, keyHint: '••••' + key.slice(-3) }; fire(); return { ok: true, data: { id } }; }
        if (b.action === 'toggle') { gws[b.id].enabled = !gws[b.id].enabled; fire(); return { ok: true, data: {} }; }
        if (b.action === 'delete') { delete gws[b.id]; fire(); return { ok: true, data: {} }; }
        if (b.action === 'primary') { Object.keys(gws).forEach(k => gws[k].priority = k === b.id ? 1 : 2); fire(); return { ok: true, data: {} }; }
        if (b.action === 'test') return { ok: true, data: b.deep ? { level: 'verified', message: 'Asli test order create ho gaya (unpaid). Gateway sach me connected hai.', details: { http: 200, contentType: 'application/json', ms: 412, body: '{"status":"error","message":"Order not found"}' }, createdOrder: { orderId: 'TESTORDER9A1', amount: 1 } } : { level: 'reachable', message: 'Gateway JSON me jawab de raha hai aur API key reject nahi hui. (Pakka "verified" tabhi hoga jab ek asli order create ho jaye.)', details: { http: 404, contentType: 'application/json', ms: 388, body: '{"status":"error","message":"Order not found"}' } } };
        if (b.action === 'migrate') return { ok: true, data: { moved: 0, created: 0 } }; return { ok: false, error: { message: 'x' } }; }, [body]);
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) }); }
    if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
  await page.addInitScript((s) => { globalThis.__FB = { tree: s, listeners: [], log: [], user: { email: 'boss@example.com', getIdToken: async () => 'tok:boss@example.com' } }; }, seed);
  await page.goto(BASE + '/Admin.html'); await page.waitForTimeout(1500);
  console.log('\n== Admin panel: payment gateways ==');
  await t('admin workspace opens without errors', async () => { ok(await page.isVisible('#block-workspace'), 'workspace'); eq(errs, [], 'errors'); });
  await page.evaluate(() => window.switchTab('Gateways')); await page.waitForTimeout(900);
  await t('gateway table lists all three with HONEST status labels (verified / reachable / needs docs)', async () => { const h = await page.textContent('#ax-gw'); ok(/FAMPAY\.XL/.test(h) && /ZapUPI/.test(h) && /Mivopay/.test(h), 'names'); ok(/Connected - asli order ban gaya/.test(h), 'verified label'); ok(/Reachable/.test(h) && /verified" nahi/.test(h), 'reachable label'); ok(/API docs chahiye/.test(h), 'needs docs label'); ok(!/Connect nahi hua/.test(h), 'no stale label'); });
  await t('API keys are never shown (only last-3 hint)', async () => { const h = await page.content(); ok(/••••a1b/.test(h), 'hint'); ok(!/apiKey/.test(await page.evaluate(() => document.getElementById('ax-gw').innerHTML)), 'no apiKey in DOM'); });
  await page.screenshot({ path: path.join(SHOTS, '11-admin-gateways.png') });
  await t('Test button calls server with admin token and shows real result (reachable, NOT verified)', async () => { await page.evaluate(() => window.axTestGw('g2')); await page.waitForTimeout(600); const c = calls.filter(x => x.body.action === 'test').pop(); eq([c.body.id, c.body.deep, c.hdr], ['g2', false, 'Bearer tok:boss@example.com'], 'call'); const h = await page.textContent('body'); ok(/Reachable - key reject nahi hui/.test(h) && /Order not found/.test(h), 'result modal'); });
  await page.screenshot({ path: path.join(SHOTS, '12-admin-test-result.png') });
  await page.evaluate(() => document.querySelector('[data-x]').click()); await page.waitForTimeout(200);
  await t('Deep test -> verified with test order id', async () => { await page.evaluate(() => window.axTestGw('g1', true)); await page.waitForTimeout(600); ok(/Connected - asli order ban gaya/.test(await page.textContent('body')) && /TESTORDER9A1/.test(await page.textContent('body')), 'deep result'); await page.evaluate(() => document.querySelector('[data-x]').click()); });
  await t('Edit gateway: key field empty (not pre-filled), saved hint shown, path/min/max/priority/ON fields present', async () => {
    await page.evaluate(() => window.axEditGw('g2')); await page.waitForTimeout(300);
    eq(await page.inputValue('#gw-key'), '', 'key field'); const h = await page.content(); ok(/••••c9d saved/.test(h), 'hint'); for (const id of ['gw-name', 'gw-url', 'gw-cp', 'gw-vp', 'gw-min', 'gw-max', 'gw-prio', 'gw-en', 'gw-style', 'gw-map']) ok(await page.$('#' + id), id + ' missing');
    eq([await page.inputValue('#gw-cp'), await page.inputValue('#gw-vp')], ['/api/create-order', '/api/order-status'], 'ZapUPI real paths'); });
  await page.screenshot({ path: path.join(SHOTS, '13-admin-edit-gateway.png') });
  await t('Save with blank key sends no key; server keeps the old one', async () => { await page.fill('#gw-prio', '5'); await page.click('#gw-save'); await page.waitForTimeout(800); const c = calls.filter(x => x.body.action === 'save').pop().body.gateway; eq([c.id, c.apiKey, c.priority, c.style], ['g2', '', 5, 'zapupi'], 'save body'); });
  await t('Add Mivopay preset opens as Custom style, asks for docs', async () => { await page.evaluate(() => window.axEditGw('', 'mivo')); await page.waitForTimeout(300); eq(await page.inputValue('#gw-style'), 'custom', 'style'); eq(await page.inputValue('#gw-url'), 'https://mivopay.shop', 'url'); await page.evaluate(() => document.querySelector('[data-x]').click()); });
  await t('Enable/Disable, Primary, Delete go through the server and update the table', async () => {
    await page.evaluate(() => window.axToggleGw('g3')); await page.waitForTimeout(400); eq(await page.evaluate(() => globalThis.__FB.tree.payment_gateways.g3.enabled), false, 'toggled');
    await page.evaluate(() => window.axPrimaryGw('g3')); await page.waitForTimeout(400); eq(await page.evaluate(() => globalThis.__FB.tree.payment_gateways.g3.priority), 1, 'primary');
    page.once('dialog', d => d.accept()); await page.evaluate(() => window.axDelGw('g3')); await page.waitForTimeout(500); eq(await page.evaluate(() => !!globalThis.__FB.tree.payment_gateways.g3), false, 'deleted'); });
  await t('Payments tab shows orders incl. amount-mismatch flagged for review', async () => { await page.evaluate(() => window.axGwTab('pay')); await page.waitForTimeout(300); const h = await page.textContent('#ax-gw'); ok(/review: amount_mismatch/.test(h) && /success/.test(h) && /pending/.test(h), 'payments table'); });
  await page.screenshot({ path: path.join(SHOTS, '14-admin-payments.png') });
  await t('no console / page errors', async () => eq(errs, [], 'errors'));
  await b.close(); app.server.close(); console.log(`\n${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
