'use strict';
// Browser test of the USER PANEL (index.html) with: in-memory Firebase stub + MOCKED /api/pay/* responses.
// Checks: no console/page errors, every onclick handler exists, buttons work, deposit UI flow, atomic buy flow. Saves screenshots.
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const { createApp } = require('../server');
const SHOTS = path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, failN = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); } catch (e) { failN++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const ok = (v, m) => { if (!v) throw new Error(m); }; const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
const QR = 'data:image/png;base64,' + require('child_process').execFileSync('python3', ['-c', `
import base64,io,random
from PIL import Image
random.seed(7); n=29; img=Image.new('RGB',(n*8,n*8),'white'); px=img.load()
def box(x0,y0):
    for y in range(7):
        for x in range(7):
            on = x in(0,6) or y in(0,6) or (2<=x<=4 and 2<=y<=4)
            for dy in range(8):
                for dx in range(8): px[(x0+x)*8+dx,(y0+y)*8+dy]=(0,0,0) if on else (255,255,255)
for y in range(n):
    for x in range(n):
        if random.random()<.5:
            for dy in range(8):
                for dx in range(8): px[x*8+dx,y*8+dy]=(0,0,0)
for (a,b) in((0,0),(n-7,0),(0,n-7)):
    for y in range(-1,8):
        for x in range(-1,8):
            if 0<=a+x<n and 0<=b+y<n:
                for dy in range(8):
                    for dx in range(8): px[(a+x)*8+dx,(b+y)*8+dy]=(255,255,255)
    box(a,b)
bio=io.BytesIO(); img.save(bio,'PNG'); print(base64.b64encode(bio.getvalue()).decode(),end='')
`]).toString().trim(); // SAMPLE placeholder image (not a real UPI QR) - only used for the demo screenshot
(async () => {
  const app = createApp({ ...process.env, AUTO_RECONCILE: '0' }); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + app.server.address().port;
  const stub = fs.readFileSync(path.join(__dirname, 'fb-stub.js'), 'utf8');
  const seed = { users: { u1: { username: 'rahul', password: 'pw123', balance: 100, role: 'User', email: 'r@x.com', referralCode: 'RAHUL1' } },
    store_management: { XYZ_CHEATS_FF_NONROOT___ROOT: { p7: { daysPlan: '7 Days', priceRate: 100, productName: 'XYZ Cheats FF' }, p30: { daysPlan: '30 Days', priceRate: 300 }, bad: null } },
    store_products: { XYZ_CHEATS_FF_NONROOT___ROOT: { name: 'XYZ Cheats FF', game: 'FF', status: 'ACTIVE', tags: ['HOT'] } },
    key_stock: { XYZ_CHEATS_FF_NONROOT___ROOT: { p7: { k1: 'KEY-AAA-111', k2: 'KEY-BBB-222' } } },
    payment_gateways: { g1: { name: 'FAMPAY.XL', baseUrl: 'https://famgateway.in', keySet: true, keyHint: '••••a1b', enabled: true, priority: 1, minAmount: 1, maxAmount: 50000, status: 'verified' },
                        g2: { name: 'ZapUPI', baseUrl: 'https://pay.zapupi.com', keySet: true, enabled: true, priority: 2, minAmount: 10, maxAmount: 20000 } } };
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, isMobile: true });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  const api = { create: null, verify: [] , calls: [] };
  await ctx.route('**/*', async (r) => { const u = r.request().url();
    if (/gstatic\.com\/firebasejs/.test(u)) return r.fulfill({ status: 200, contentType: 'text/javascript', body: stub });
    if (u.startsWith(BASE + '/api/pay/')) { const ep = u.slice(BASE.length); const body = JSON.parse(r.request().postData() || '{}'); api.calls.push({ ep, body });
      const send = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (ep === '/api/pay/create') return api.create ? send(api.create(body)) : send({ ok: false, error: { code: 'EGATEWAY', message: 'Gateway ne JSON nahi diya (HTTP 404): <html>Not Found' } });
      if (ep === '/api/pay/verify') return send(api.verify.length ? api.verify.shift() : { ok: true, data: { status: 'pending' } });
      if (ep === '/api/pay/cancel') return send({ ok: true, data: { status: 'cancelled' } }); }
    if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
  await page.addInitScript((s) => { globalThis.__FB = { tree: s, listeners: [], log: [] }; }, seed);
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const bal = () => page.evaluate(() => globalThis.__FB.tree.users.u1.balance);

  console.log('\n== logged-out: login / register screens ==');
  await page.goto(BASE + '/'); await page.waitForTimeout(1200);
  await t('login screen shows, no JS errors', async () => { ok(await page.isVisible('#login-box'), 'login box'); eq(errs, [], 'errors'); });
  await shot('01-login');
  await t('wrong password rejected', async () => { await page.fill('#login-username', 'rahul'); await page.fill('#login-pass', 'wrong'); await page.click('#btn-login'); await page.waitForTimeout(600); ok(await page.isVisible('#login-box'), 'still on login'); });
  await t('correct login works', async () => { await page.fill('#login-pass', 'pw123'); await page.click('#btn-login'); await page.waitForTimeout(1500); ok(await page.isVisible('#login-box') === false, 'login box hidden'); eq(await page.evaluate(() => localStorage.getItem('panel_uid')), 'u1', 'saved uid'); });
  await page.waitForTimeout(500); await shot('02-dashboard');

  console.log('\n== every onclick handler exists (this is the "setLang is not defined" class of bug) ==');
  await t('all inline handlers are defined on window', async () => {
    const miss = await page.evaluate(async () => { const html = await (await fetch('/')).text(); const names = [...new Set([...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]))]; return names.filter(n => typeof window[n] !== 'function'); });
    eq(miss, [], 'missing handlers');
  });
  await t('all tabs open without errors', async () => {
    for (const tab of ['Dashboard', 'BuyKeys', 'AddFunds', 'History', 'MyKeys', 'Profile', 'Refer', 'MyResellers', 'Support', 'Catalog', 'ApiAccess', 'Premium', 'TelegramInfo']) { await page.evaluate((x) => window.switchTab(x), tab); await page.waitForTimeout(150); }
    eq(errs, [], 'errors after tab sweep');
  });
  await t('language EN <-> HI buttons', async () => { await page.evaluate(() => window.setLang('hi')); eq(await page.evaluate(() => localStorage.getItem('panel_lang')), 'hi', 'hi'); await page.evaluate(() => window.setLang('en')); eq(await page.evaluate(() => localStorage.getItem('panel_lang')), 'en', 'en'); });
  await t('theme + search + filters do not throw', async () => { await page.evaluate(() => { window.cycleTheme(); document.querySelector('#thm-grid button[data-k]').click(); window.bkSearchInput('xyz'); window.bkSearchInput(''); window.bkSetFilter && window.bkSetFilter('ALL'); window.mkReset && window.mkReset(); }); eq(errs, [], 'errors'); });

  console.log('\n== Buy Keys (atomic wallet debit + stock) ==');
  await page.evaluate(() => window.switchTab('BuyKeys')); await page.waitForTimeout(400); await shot('03-buykeys');
  await t('product with a null/broken plan record renders (no "reading XYZ_CHEATS..." crash)', async () => { ok((await page.textContent('#bk-grid')).includes('XYZ Cheats'), 'product rendered'); });
  await t('buy 1 key: balance debited once, key delivered, stock reduced', async () => {
    await page.evaluate(() => window.bkBuyRow('XYZ_CHEATS_FF_NONROOT___ROOT', 0)); await page.waitForTimeout(1200);
    eq(await bal(), 0, 'balance'); const u = await page.evaluate(() => globalThis.__FB.tree.users.u1); eq(Object.values(u.generatedKeys).map(k => k.keyCode), ['KEY-AAA-111'], 'key');
    eq(Object.keys(await page.evaluate(() => globalThis.__FB.tree.key_stock.XYZ_CHEATS_FF_NONROOT___ROOT.p7)).length, 1, 'stock left');
  });
  await shot('04-mykeys');
  await t('second buy with insufficient funds is refused, nothing changes', async () => { await page.evaluate(() => window.switchTab('BuyKeys')); await page.evaluate(() => window.bkBuyRow('XYZ_CHEATS_FF_NONROOT___ROOT', 0)); await page.waitForTimeout(800); eq(await bal(), 0, 'balance'); });
  await t('stock sold out -> refund, balance restored', async () => {
    await page.evaluate(() => { globalThis.__FB.tree.users.u1.balance = 100; globalThis.__FB.tree.key_stock.XYZ_CHEATS_FF_NONROOT___ROOT.p7 = {}; });
    await page.evaluate(() => window.bkBuyRow('XYZ_CHEATS_FF_NONROOT___ROOT', 0)); await page.waitForTimeout(900); eq(await bal(), 100, 'balance after refund');
  });

  console.log('\n== Add Balance (payment flow via server API) ==');
  await page.evaluate(() => { globalThis.__FB.tree.users.u1.balance = 100; window.switchTab('AddFunds'); }); await page.waitForTimeout(500); await shot('05-addfunds');
  await t('gateway list shows ONLY enabled gateways with public data (no API key anywhere in DOM)', async () => { const h = await page.content(); ok(/FAMPAY\.XL/.test(h), 'fam listed'); ok(!/fam_key|apiKey/i.test(await page.evaluate(() => document.getElementById('ap-method-list').innerHTML)), 'no key in DOM'); });
  await t('amount below minimum / above maximum is blocked in the browser too', async () => { for (const v of ['0', '99999999']) { await page.fill('#ap-amount', v); await page.click('#ap-pay-btn'); await page.waitForTimeout(150); } eq(api.calls.filter(c => c.ep === '/api/pay/create').length, 0, 'no API call made'); });
  await t('server/gateway error is shown to the user verbatim (not hidden)', async () => { await page.fill('#ap-amount', '150'); await page.click('#ap-pay-btn'); await page.waitForTimeout(500); ok(/Gateway ne JSON nahi diya \(HTTP 404\)/.test(await page.textContent('#toast, .toast, body')), 'real error shown'); });
  await shot('06-gateway-error');
  api.create = (b) => ({ ok: true, data: { orderId: 'FAM9C1A77E2', gatewayOrderId: 'FAM9C1A77E2', amount: b.amount, payAmount: b.amount, checkoutUrl: 'https://pay.example/checkout/FAM9C1A77E2', qr: QR, expiresAt: Date.now() + 9.5 * 60000, gatewayId: 'g1', gatewayName: 'FAMPAY.XL', status: 'pending' } });
  await t('create order -> payment screen with order id, status, gateway, QR, timer', async () => {
    await page.fill('#ap-amount', '150'); await page.fill('#ap-phone', '9876543210'); await page.click('#ap-pay-btn'); await page.waitForTimeout(700);
    const c = api.calls.filter(x => x.ep === '/api/pay/create').pop().body; eq([c.uid, c.amount, c.phone], ['u1', 150, '9876543210'], 'request body'); ok(!('apiKey' in c), 'no key sent');
    const txt = await page.textContent('#ap-modal'); ok(/FAM9C1A77E2/.test(txt) && /Pending/.test(txt) && /FAMPAY\.XL/.test(txt) && /150\.00/.test(txt), 'modal text: ' + txt.slice(0, 160)); ok(await page.isVisible('#ap-modal img'), 'QR image');
  });
  await shot('07-payment-screen');
  await t('"I have paid" while still unpaid -> stays pending with message, wallet NOT changed', async () => { api.verify.push({ ok: true, data: { status: 'pending' } }); await page.evaluate(() => window.apCheckNow()); await page.waitForTimeout(700); ok(/abhi receive nahi hui/.test(await page.textContent('#ap-modal')), 'pending note'); eq(await bal(), 100, 'balance'); });
  await t('server confirms payment -> success screen shows amount, new balance, order id', async () => {
    api.verify.push({ ok: true, data: { status: 'success', credited: true, amount: 150, balance: 250, orderId: 'FAM9C1A77E2', reference: 'UTR4455', bonus: 15 } }); await page.evaluate(() => window.apCheckNow()); await page.waitForTimeout(700);
    const txt = await page.textContent('#ap-modal'); ok(/Payment Successful/.test(txt) && /250\.00/.test(txt) && /\+₹150\.00/.test(txt) && /UTR4455/.test(txt) && /Bonus/.test(txt), 'success text: ' + txt);
    eq(await page.evaluate(() => localStorage.getItem('ap_pending_order')), null, 'pending cleared');
  });
  await shot('08-payment-success');
  await t('browser never credits the wallet itself (balance only changes through the server)', async () => { eq(await bal(), 100, 'stub balance untouched by browser'); });
  await t('expired / failed responses show a clear failure screen', async () => { await page.evaluate(() => window.apCloseModal()); await page.fill('#ap-amount', '151'); await page.click('#ap-pay-btn'); await page.waitForTimeout(500); api.verify.push({ ok: true, data: { status: 'expired' } }); await page.evaluate(() => window.apCheckNow()); await page.waitForTimeout(600); ok(/Payment Not Completed/.test(await page.textContent('#ap-modal')), 'failed screen'); });
  await shot('09-payment-failed');
  await t('cancel calls the server', async () => { await page.evaluate(() => window.apCloseModal()); await page.fill('#ap-amount', '152'); await page.click('#ap-pay-btn'); await page.waitForTimeout(400); await page.evaluate(() => window.apCancelPending()); await page.waitForTimeout(300); ok(api.calls.some(c => c.ep === '/api/pay/cancel'), 'cancel call'); });
  await page.evaluate(() => { window.apCloseModal(); window.switchTab('History'); }); await page.waitForTimeout(300); await shot('10-history');

  await t('page logout button works', async () => { await page.evaluate(() => document.getElementById('btn-logout').click()); await page.waitForTimeout(800); eq(await page.evaluate(() => localStorage.getItem('panel_uid')), null, 'uid cleared'); });
  await t('NO console / page errors during the whole session', async () => eq(errs.filter(e => !/\[buy\] Error: Stock khatam/.test(e)), [], 'errors (the intentional sold-out log is expected)'));
  await b.close(); app.server.close(); console.log(`\n${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
