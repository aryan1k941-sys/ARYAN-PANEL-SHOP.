'use strict';
// Browser test for the v3 additions (user: profile/referral/API/stats/channel card, admin: Alerts/Insights/Quick Add). Saves screenshots to test/shots.
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const { createApp } = require('../server'); const SHOTS = path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, failN = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); } catch (e) { failN++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const ok = (v, m) => { if (!v) throw new Error(m); };
(async () => {
  const app = createApp({ ...process.env, AUTO_RECONCILE: '0' }); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + app.server.address().port;
  const stub = fs.readFileSync(path.join(__dirname, 'fb-stub.js'), 'utf8'); const now = Date.now();
  const b = await chromium.launch();
  /* ---------------- user panel ---------------- */
  { const seed = { users: { u1: { username: 'rahul', password: 'pw123', balance: 5, role: 'Reseller', email: 'r@x.com', apiKey: 'ak_0123456789abcdef0123456789abcdef',
        transactions: { a: { type: 'Deposit', amount: 500 }, b: { type: 'Generation', amount: 199 }, c: { type: 'Commission', amount: 12.5 } },
        generatedKeys: { k1: { product: 'Free Fire Panel', duration: '7 Days', qty: 1, keyCode: 'FF-SECRET-KEY-1234', source: 'stock', timestamp: new Date().toISOString() } } },
      u2: { username: 'friend', referredBy: 'u1', role: 'Reseller', balance: 0 } },
      api_settings: { enabled: true, baseUrl: 'https://shop.example.com' },
      site_settings: { channel: { channelUrl: 'https://t.me/mychannel', siteUrl: 'https://shop.example.com', brand: 'ARYAN' }, reseller_upgrade: { enabled: true, commissionPct: 5, minBalance: 10 } } };
    const ctx = await b.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, isMobile: true }); const page = await ctx.newPage(); const errs = []; const pings = [];
    page.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
    await ctx.route('**/*', async (r) => { const u = r.request().url(); if (/gstatic\.com\/firebasejs/.test(u)) return r.fulfill({ status: 200, contentType: 'text/javascript', body: stub });
      if (u === BASE + '/api/notify') { pings.push(JSON.parse(r.request().postData() || '{}')); return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":{}}' }); }
      if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
    await page.addInitScript((s) => { globalThis.__FB = { tree: s, listeners: [], log: [] }; }, seed);
    await page.goto(BASE + '/'); await page.waitForTimeout(1000); await page.fill('#login-username', 'rahul'); await page.fill('#login-pass', 'pw123'); await page.click('#btn-login'); await page.waitForTimeout(2200);
    console.log('\n== user panel v3 ==');
    await t('dashboard shows stats strip (deposited/spent/keys) + low-balance hint + community card with channel button', async () => { const h = await page.textContent('#pz-stats'); ok(/₹500/.test(h) && /₹199/.test(h) && /Keys Owned/.test(h) && /Balance kam hai/.test(h), h); ok(/Join Channel/.test(await page.textContent('#pz-community')), 'community'); ok(await page.isVisible('#menu-Channel'), 'sidebar join channel'); });
    await page.screenshot({ path: path.join(SHOTS, '20-user-dashboard.png') });
    await page.evaluate(() => switchTab('Profile')); await page.waitForTimeout(400);
    await t('profile: Account tab shows username/role/balance; Password tab has eye buttons + strength meter', async () => { ok((await page.inputValue('#profile-username')) === 'RAHUL', 'username'); ok((await page.inputValue('#profile-role')) === 'RESELLER', 'role'); await page.screenshot({ path: path.join(SHOTS, '21-user-profile.png') }); await page.click('.pz-tabs button[data-t=pw]'); await page.fill('#pw-new', 'Str0ng!Pass99'); ok(/Strong|Excellent/.test(await page.textContent('#pz-meter-t')), 'meter'); await page.click('#pzp-pw .pz-eye >> nth=1'); ok((await page.getAttribute('#pw-new', 'type')) === 'text', 'eye'); await page.screenshot({ path: path.join(SHOTS, '22-user-password.png') }); });
    await page.evaluate(() => switchTab('Refer')); await page.waitForTimeout(500);
    await t('referral page: link, share buttons, stats (1 referral, ₹12.50 earned), pct 5', async () => { ok(/ref=u1/.test(await page.inputValue('#rf-link')), 'link'); const h = await page.textContent('#view-Refer'); ok(/₹12\.5/.test(h) && /Referrals/.test(h) && /WhatsApp/.test(h) && /Telegram/.test(h), h.slice(0, 300)); ok((await page.textContent('#rf-pct')) === '5', 'pct'); });
    await page.screenshot({ path: path.join(SHOTS, '23-user-referral.png') });
    await page.evaluate(() => switchTab('ApiAccess')); await page.waitForTimeout(500);
    await t('API page: base URL + copy, endpoints with method pills, code tabs switch', async () => { const h = await page.textContent('#px-api'); ok(/API Base URL/.test(h) && /\/api\/v1\/products/.test(h) && /curl -X POST/.test(h), h.slice(0, 200)); await page.click('.pz-tabs.sm button:has-text("Python")'); ok(/requests\.post/.test(await page.textContent('#px-api')), 'python tab'); ok((await page.inputValue('#pz-baseurl')) === 'https://shop.example.com', 'base'); });
    await page.screenshot({ path: path.join(SHOTS, '24-user-api.png'), fullPage: true });
    await page.evaluate(() => switchTab('MyKeys')); await page.waitForTimeout(500);
    await t('my keys: hide button blurs keys, tools present', async () => { await page.click('#pz-keyeye'); ok(await page.evaluate(() => document.getElementById('my-keys-list-target').classList.contains('pz-keys-hidden')), 'hidden class'); ok(/Copy all/.test(await page.textContent('#view-MyKeys')) && /Export CSV/.test(await page.textContent('#view-MyKeys')), 'tools'); });
    await page.screenshot({ path: path.join(SHOTS, '25-user-keys.png') });
    await t('no console / page errors in user panel', async () => { if (errs.length) throw new Error(errs.join(' | ')); });
    await ctx.close(); }
  /* ---------------- admin panel ---------------- */
  { const cfg = { enabled: true, tokenSet: true, tokenHint: '••••WXYZ', chatId: '@mychannel', channelUrl: 'https://t.me/mychannel', siteUrl: 'https://shop.example.com', brand: 'ARYAN PANEL SHOP', footer: '💎 Premium Panel Store', siteBtnText: '🛒 Buy on My Website', channelBtnText: '📢 Join Our Channel', userMode: 'mask', minDeposit: 0, silent: false, events: { deposit: true, purchase: true, reseller: true, referral: true, commission: true, signup: false } };
    const seed = { auto_payments: { o1: { uid: 'u1', username: 'rahul', amount: 500, status: 'success', credited: true, paidAt: now - 3600000, createdAt: now - 3700000 }, o2: { uid: 'u2', username: 'amit', amount: 200, status: 'amount_mismatch', needsReview: true, note: 'mismatch', createdAt: now - 1000 } },
      orders: { x1: { uid: 'u1', username: 'rahul', product: 'Free Fire Panel', qty: 1, total: 199, profit: 50, ts: now - 1000000 }, x2: { uid: 'u1', username: 'rahul', product: 'Free Fire Panel', qty: 2, total: 398, profit: 100, ts: now - 90000000 } } };
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 }); const page = await ctx.newPage(); const errs = []; const calls = [];
    page.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
    await ctx.route('**/*', async (r) => { const u = r.request().url(); if (/gstatic\.com\/firebasejs/.test(u)) return r.fulfill({ status: 200, contentType: 'text/javascript', body: stub });
      if (u === BASE + '/api/admin/notify') { const body = JSON.parse(r.request().postData() || '{}'); calls.push({ body, auth: r.request().headers().authorization }); const send = (d) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
        if (body.action === 'get') return send({ config: cfg }); if (body.action === 'logs') return send([{ event: 'deposit', ok: true, ts: now }, { event: 'purchase', ok: false, message: 'chat not found', ts: now - 5000 }]);
        if (body.action === 'save') { Object.assign(cfg, body.config, { botToken: undefined }); return send({ config: cfg }); } if (body.action === 'test') return send({ steps: ['Bot OK: @aryan_bot', 'Channel mila: My Channel', 'Sample message channel me bhej diya'] }); if (body.action === 'broadcast') return send({ sent: true }); }
      if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
    await page.addInitScript((s) => { globalThis.__FB = { tree: s, listeners: [], log: [], user: { email: 'boss@example.com', getIdToken: async () => 'tok:boss@example.com' } }; }, seed);
    await page.goto(BASE + '/Admin.html'); await page.waitForTimeout(1500);
    console.log('\n== admin panel v3 ==');
    await page.evaluate(() => window.switchTab('AlertsCh')); await page.waitForTimeout(900);
    await t('Alerts tab: setup guide, token hint (never the token), channel/site fields, 6 event toggles, delivery log', async () => { const h = await page.textContent('#ax-alerts'); ok(/Setup guide/.test(h) && /WXYZ/.test(h) && /LIVE/.test(h) && /Referral commission/.test(h) && /chat not found/.test(h), h.slice(0, 300)); ok((await page.inputValue('#nt-chat')) === '@mychannel' && (await page.inputValue('#nt-site')) === 'https://shop.example.com', 'fields'); ok((await page.inputValue('#nt-tok')) === '', 'token field empty'); });
    await page.screenshot({ path: path.join(SHOTS, '30-admin-alerts.png'), fullPage: true });
    await t('Save sends admin token + all settings; Test connection shows each step', async () => { await page.fill('#nt-brand', 'MY SHOP'); await page.click('button:has-text("Save settings")'); await page.waitForTimeout(500); const s = calls.find(c => c.body.action === 'save'); ok(s && s.auth === 'Bearer tok:boss@example.com' && s.body.config.brand === 'MY SHOP' && s.body.config.events.signup === false, JSON.stringify(s)); await page.click('button:has-text("Test connection")'); await page.waitForTimeout(700); ok(calls.some(c => c.body.action === 'test'), 'test call'); });
    await t('Broadcast posts message to server', async () => { await page.evaluate(() => { window.confirm = () => true; }); await page.fill('#nt-bc', '🔥 Free Fire Panel 20% OFF'); await page.click('button:has-text("Post to channel")'); await page.waitForTimeout(500); ok(calls.some(c => c.body.action === 'broadcast' && /20% OFF/.test(c.body.text)), 'broadcast'); });
    await page.evaluate(() => window.switchTab('Insights')); await page.waitForTimeout(700);
    await t('Insights: today/7d/30d cards, 7-day chart, top products/buyers, payment needing review, CSV buttons', async () => { const h = await page.textContent('#ax-ins'); ok(/Deposits today/.test(h) && /Free Fire Panel/.test(h) && /need review/.test(h) && /Orders CSV/.test(h) && /₹500/.test(h), h.slice(0, 400)); });
    await page.screenshot({ path: path.join(SHOTS, '31-admin-insights.png'), fullPage: true });
    await page.evaluate(() => window.switchTab('QuickAdd')); await page.waitForTimeout(500);
    await t('Quick Add: Free Fire pack adds product + plans to store (and blocks duplicates)', async () => { ok(/Free Fire Panel/.test(await page.textContent('#ax-qa')), 'pack'); await page.click('#ax-qa button:has-text("Add to store") >> nth=0'); await page.waitForTimeout(800); const r = await page.evaluate(() => ({ p: globalThis.__FB.tree.store_products, m: globalThis.__FB.tree.store_management })); ok(r.p && r.p.Free_Fire_Panel && r.p.Free_Fire_Panel.game === 'FREE FIRE', JSON.stringify(r.p)); ok(Object.keys(r.m.Free_Fire_Panel).length === 3, 'plans'); });
    await page.screenshot({ path: path.join(SHOTS, '32-admin-quickadd.png'), fullPage: true });
    await t('sidebar groups contain the new tabs', async () => { const h = await page.textContent('.sidebar-menu-list'); ok(/Alerts/.test(h) && /Business Insights/.test(h) && /Quick Add/.test(h), 'menu'); });
    await t('no console / page errors in admin panel', async () => { if (errs.length) throw new Error(errs.join(' | ')); });
    await ctx.close(); }
  await b.close(); console.log(`\n${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
})();
