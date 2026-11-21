'use strict';
// Telegram channel alerts against: real server.js + lib/notify.js, MOCK Firebase, MOCK identity, MOCK Telegram (HTTPS).
const fs = require('fs'), https = require('https');
const { startRtdb, startIdentity } = require('./mocks');
let pass = 0, failN = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); } catch (e) { failN++; console.log('  FAIL  ' + n + '\n        ' + (e && e.message)); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'eq') + ': got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const truthy = (v, m) => { if (!v) throw new Error('expected truthy: ' + m); };
(async () => {
  const tls = { key: fs.readFileSync(process.env.TEST_TLS_KEY), cert: fs.readFileSync(process.env.TEST_TLS_CERT) };
  const TOKEN = '123456789:AAFakeTokenFakeTokenFakeTokenFake_12345';
  const tg = { sent: [], mode: 'ok' };
  const tgSrv = https.createServer(tls, (req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url); const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!m || m[1] !== TOKEN) return send({ ok: false, error_code: 401, description: 'Unauthorized' });
    const p = JSON.parse(b || '{}');
    if (m[2] === 'getMe') return send({ ok: true, result: { username: 'aryan_bot' } });
    if (m[2] === 'getChat') return p.chat_id === '@mychannel' ? send({ ok: true, result: { id: -100123, title: 'My Channel' } }) : send({ ok: false, description: 'Bad Request: chat not found' });
    if (m[2] === 'sendMessage') { if (tg.mode === 'down') return send({ ok: false, description: 'Forbidden: bot is not a member of the channel chat' }); tg.sent.push(p); return send({ ok: true, result: { message_id: tg.sent.length } }); }
    send({ ok: false, description: 'unknown' });
  }); });
  await new Promise(r => tgSrv.listen(0, '127.0.0.1', r));
  const db = await startRtdb(); const idn = await startIdentity();
  Object.assign(process.env, { FIREBASE_DB_URL: db.url, IDENTITY_LOOKUP_URL: idn.url, ADMIN_EMAILS: 'boss@example.com', AUTO_RECONCILE: '0', TELEGRAM_API_BASE: 'https://127.0.0.1:' + tgSrv.address().port });
  const { createApp } = require('../server'); const app = createApp(process.env);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + app.server.address().port;
  const post = async (p, body, h = {}) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
  const adm = (body) => post('/api/admin/notify', body, { Authorization: 'Bearer tok:boss@example.com' });
  const N = app.notify; const last = () => tg.sent[tg.sent.length - 1];
  const CFG = { enabled: true, botToken: TOKEN, chatId: '@mychannel', channelUrl: 'https://t.me/mychannel', siteUrl: 'https://shop.example.com', brand: 'ARYAN PANEL SHOP' };

  console.log('\n== admin settings ==');
  await t('notify admin API needs admin login', async () => { eq((await post('/api/admin/notify', { action: 'get' })).status, 401); eq((await post('/api/admin/notify', { action: 'get' }, { Authorization: 'Bearer tok:user@example.com' })).status, 403); });
  await t('save: token goes to server-only node, never returned; public node has only links', async () => {
    const r = await adm({ action: 'save', config: CFG }); eq(r.j.ok, true, JSON.stringify(r.j));
    eq(db.getAt('notify_secrets/botToken'), TOKEN); eq(db.getAt('notify_config/botToken'), null);
    truthy(!JSON.stringify(r.j).includes(TOKEN), 'token leaked'); eq(r.j.data.config.tokenSet, true);
    eq(db.getAt('site_settings/channel/siteUrl'), 'https://shop.example.com'); eq(db.getAt('site_settings/channel/chatId'), null); truthy(!JSON.stringify(db.getAt('site_settings/channel')).includes('AAFake'), 'token in public node');
  });
  await t('validation: bad channel id / http link / bad token rejected', async () => {
    for (const bad of [{ chatId: 'my channel!' }, { siteUrl: 'http://x.com' }, { channelUrl: 'javascript:alert(1)' }, { botToken: 'nope' }]) eq((await adm({ action: 'save', config: bad })).j.ok, false);
  });
  await t('blank token on re-save keeps the old token', async () => { await adm({ action: 'save', config: { brand: 'ARYAN X', botToken: '' } }); eq(db.getAt('notify_secrets/botToken'), TOKEN); await adm({ action: 'save', config: { brand: 'ARYAN PANEL SHOP' } }); });
  await t('test: verifies bot + channel and posts a sample with both buttons', async () => {
    tg.sent.length = 0; const r = await adm({ action: 'test', event: 'purchase' }); eq(r.j.ok, true, JSON.stringify(r.j)); eq(r.j.data.bot, '@aryan_bot'); eq(tg.sent.length, 1);
    eq(last().reply_markup.inline_keyboard[0].map(b => b.url), ['https://shop.example.com', 'https://t.me/mychannel']); truthy(/NEW KEY SOLD/.test(last().text), 'title');
  });
  await t('test with wrong channel -> clear error', async () => { await adm({ action: 'save', config: { chatId: '@wrongchan' } }); const r = await adm({ action: 'test' }); eq(r.j.ok, false); truthy(/Channel ID galat/.test(r.j.error.message), r.j.error.message); await adm({ action: 'save', config: { chatId: '@mychannel' } }); });

  console.log('\n== deposits ==');
  db.S.tree.users = { u1: { username: 'rahulkumar', balance: 0, role: 'User' } };
  await t('credited deposit -> one channel alert, username masked, buttons present', async () => {
    tg.sent.length = 0; const rec = { uid: 'u1', username: 'rahulkumar', amount: 500, gatewayName: 'ZapUPI' };
    await N.deposit('ORD1', rec, 50); eq(tg.sent.length, 1); const m = last().text;
    truthy(/NEW DEPOSIT/.test(m) && /₹500/.test(m) && /₹50/.test(m), m); truthy(!m.includes('rahulkumar') && /ra\*+r/.test(m), 'masked: ' + m); truthy(last().reply_markup, 'buttons');
    await N.deposit('ORD1', rec, 50); eq(tg.sent.length, 1, 'duplicate must not resend');
  });
  await t('userMode full / hide respected; HTML in names escaped', async () => {
    await adm({ action: 'save', config: { userMode: 'full' } }); tg.sent.length = 0; await N.deposit('ORD2', { username: '<b>x</b>&', amount: 10 }, 0); truthy(last().text.includes('&lt;b&gt;x&lt;/b&gt;&amp;'), last().text);
    await adm({ action: 'save', config: { userMode: 'hide' } }); await N.deposit('ORD3', { username: 'secretname', amount: 10 }, 0); truthy(!last().text.includes('secretname') && /Hidden User/.test(last().text), last().text);
    await adm({ action: 'save', config: { userMode: 'mask' } });
  });
  await t('event toggle off / master off / min deposit => nothing sent', async () => {
    await adm({ action: 'save', config: { events: { deposit: false } } }); tg.sent.length = 0; await N.deposit('ORD4', { username: 'abcdef', amount: 99 }, 0); eq(tg.sent.length, 0);
    await adm({ action: 'save', config: { events: { deposit: true }, minDeposit: 200 } }); await N.deposit('ORD5', { username: 'abcdef', amount: 99 }, 0); eq(tg.sent.length, 0);
    await adm({ action: 'save', config: { minDeposit: 0, enabled: false } }); await N.deposit('ORD6', { username: 'abcdef', amount: 99 }, 0); eq(tg.sent.length, 0); await adm({ action: 'save', config: { enabled: true } });
  });
  await t('Telegram down -> failure logged, claim released so it can retry, payment code unaffected', async () => {
    tg.mode = 'down'; const r = await N.deposit('ORD7', { username: 'abcdef', amount: 99 }, 0); eq(r.sent, false); eq(db.getAt('notify_sent/dep_ORD7'), null);
    tg.mode = 'ok'; tg.sent.length = 0; const r2 = await N.deposit('ORD7', { username: 'abcdef', amount: 99 }, 0); eq(r2.sent, true);
    truthy(Object.values(db.getAt('notify_logs') || {}).some(l => l.ok === false), 'failure logged');
  });

  console.log('\n== purchases (key hidden) ==');
  await t('first poll only sets the cursor (no flood of old orders)', async () => { db.setAt('orders', { '-Ma1': { uid: 'u1', username: 'old', product: 'Old', total: 1, ts: 1 } }); tg.sent.length = 0; const r = await N.pollOrders(); eq(r.init, true); eq(tg.sent.length, 0); });
  await t('new order -> alert with product/plan/price, key hidden, once only', async () => {
    db.setAt('orders/-Mb2', { uid: 'u1', username: 'rahulkumar', product: 'Free Fire Panel', duration: '7 Days', qty: 2, total: 598, source: 'web', keyCode: 'SECRET-KEY-123' });
    tg.sent.length = 0; await N.pollOrders(); await N.pollOrders(); eq(tg.sent.length, 1); const m = last().text;
    truthy(/Free Fire Panel/.test(m) && /7 Days/.test(m) && /₹598/.test(m) && /tg-spoiler/.test(m) && /hidden/i.test(m), m); truthy(!m.includes('SECRET-KEY-123'), 'KEY LEAKED');
  });
  await t('web order by a referred user also announces commission; API order does not', async () => {
    db.setAt('users/ref1', { username: 'refererman' }); db.setAt('users/u2', { username: 'buyer22', referredBy: 'ref1' }); db.setAt('site_settings/reseller_upgrade', { commissionPct: 5 });
    db.setAt('orders/-Mc3', { uid: 'u2', username: 'buyer22', product: 'P', duration: '1 Day', qty: 1, total: 200, source: 'web' });
    tg.sent.length = 0; await N.pollOrders(); eq(tg.sent.length, 2); truthy(/REFERRAL COMMISSION/.test(last().text) && /₹10/.test(last().text), last().text);
    db.setAt('orders/-Md4', { uid: 'u2', username: 'buyer22', product: 'P', duration: '1 Day', qty: 1, total: 200, source: 'api' }); tg.sent.length = 0; await N.pollOrders(); eq(tg.sent.length, 1);
  });

  console.log('\n== signup / reseller / referral pings ==');
  await t('signup ping: real new user -> signup + referral alert; fake / old / repeat -> nothing', async () => {
    db.setAt('users/u3', { username: 'newguy99', referredBy: 'ref1', joinedAt: Date.now(), role: 'User' }); tg.sent.length = 0;
    eq((await post('/api/notify', { event: 'signup', uid: 'u3' })).j.ok, true); eq(tg.sent.length, 2); truthy(/NEW MEMBER/.test(tg.sent[0].text) && /NEW REFERRAL/.test(tg.sent[1].text), 'titles');
    await post('/api/notify', { event: 'signup', uid: 'u3' }); eq(tg.sent.length, 2, 'repeat');
    await post('/api/notify', { event: 'signup', uid: 'nobody' }); db.setAt('users/uold', { username: 'oldtimer', joinedAt: 1000 }); await post('/api/notify', { event: 'signup', uid: 'uold' }); eq(tg.sent.length, 2, 'fake/old');
    eq((await post('/api/notify', { event: 'hack', uid: 'u3' })).status, 400);
  });
  await t('reseller ping: only when DB role is Reseller, once', async () => {
    tg.sent.length = 0; await post('/api/notify', { event: 'reseller', uid: 'u1', via: 'upgrade' }); eq(tg.sent.length, 0, 'not a reseller yet');
    db.setAt('users/u1/role', 'Reseller'); await post('/api/notify', { event: 'reseller', uid: 'u1', via: 'upgrade' }); await post('/api/notify', { event: 'reseller', uid: 'u1', via: 'upgrade' });
    eq(tg.sent.length, 1); truthy(/NEW RESELLER/.test(last().text) && /Wallet Upgrade/.test(last().text), last().text);
  });
  await t('admin broadcast posts a premium announcement; empty/too long rejected; non-admin blocked', async () => {
    tg.sent.length = 0; const r = await adm({ action: 'broadcast', text: 'Big <sale> today!' }); eq(r.j.ok, true, JSON.stringify(r.j)); truthy(/ANNOUNCEMENT/.test(last().text) && last().text.includes('Big &lt;sale&gt; today!'), last().text);
    eq((await adm({ action: 'broadcast', text: '  ' })).j.ok, false); eq((await adm({ action: 'broadcast', text: 'x'.repeat(1600) })).j.ok, false);
    eq((await post('/api/admin/notify', { action: 'broadcast', text: 'hi' }, { Authorization: 'Bearer tok:user@example.com' })).status, 403);
  });
  await t('every alert carries the premium footer + website/channel buttons', async () => { truthy(tg.sent.every(m => /Premium Panel Store/.test(m.text) && m.reply_markup && m.parse_mode === 'HTML'), 'footer/buttons'); });
  console.log(`\n${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
})();
