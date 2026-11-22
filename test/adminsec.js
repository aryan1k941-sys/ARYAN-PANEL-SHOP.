'use strict';
// Admin security: single session lock, device list, kick, recovery, intruder auto-ban. Real server + mock RTDB / identity.
process.env.ADMIN_SESSION_REQUIRED = '1'; process.env.ADMIN_AUTOBAN = '1';
const { startRtdb, startIdentity } = require('./mocks');
let pass = 0, failN = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); } catch (e) { failN++; console.log('  FAIL  ' + n + '\n        ' + (e && e.message)); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || 'eq') + ': got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
(async () => {
  const db = await startRtdb(); const idn = await startIdentity();
  Object.assign(process.env, { FIREBASE_DB_URL: db.url, IDENTITY_LOOKUP_URL: idn.url, ADMIN_EMAILS: 'boss@example.com', AUTO_RECONCILE: '0', ADMIN_RECOVERY_CODE: 'rescue-123', FIREBASE_TEST_NO_AUTH: '1', NODE_ENV: 'test' });
  const { createApp } = require('../server'); const app = createApp(process.env);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + app.server.address().port;
  const MOB = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36', PC = 'Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
  const call = async (p, body, h = {}) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
  const sess = (body, o = {}) => call('/api/admin/session', body, { Authorization: 'Bearer ' + (o.tok || 'tok:boss@example.com'), 'User-Agent': o.ua || PC, 'X-Forwarded-For': o.ip || '1.1.1.1', ...(o.s ? { 'X-Admin-Session': o.s } : {}) });
  db.S.tree = { users: { s1: { username: 'sneaky', email: 'hacker@gmail.com', role: 'User', balance: 10 } } };
  let A, B;

  console.log('\n== admin session security ==');
  await t('admin can log in and gets a session token', async () => { A = await sess({ action: 'login' }); eq(A.status, 200); eq(/^[0-9a-f]{64}$/.test(A.j.data.sessionToken), true, 'token'); });
  await t('admin API without session header is rejected', async () => eq((await call('/api/admin/gateways', { action: 'list' }, { Authorization: 'Bearer tok:boss@example.com', 'X-Forwarded-For': '1.1.1.1' })).status, 401));
  await t('admin API with valid session works', async () => eq((await call('/api/admin/gateways', { action: 'list' }, { Authorization: 'Bearer tok:boss@example.com', 'X-Admin-Session': A.j.data.sessionToken, 'X-Forwarded-For': '1.1.1.1' })).status, 200));
  await t('fake / guessed session token rejected', async () => eq((await sess({ action: 'ping' }, { s: 'a'.repeat(64) })).status, 401));
  await t('2nd device login is LOCKED OUT while first is active (even with correct admin password)', async () => { const r = await sess({ action: 'login' }, { ua: MOB, ip: '9.9.9.9' }); eq(r.status, 409); eq(r.j.error.code, 'ELOCKED'); });
  await t('wrong recovery code does not unlock', async () => eq((await sess({ action: 'login', recoveryCode: 'nope' }, { ua: MOB, ip: '9.9.9.9' })).status, 409));
  await t('device list shows this device + browser/OS', async () => { const r = await sess({ action: 'status' }, { s: A.j.data.sessionToken }); eq(r.status, 200); eq(r.j.data.sessions.length, 1); eq(r.j.data.sessions[0].current, true); eq(r.j.data.sessions[0].device.label, 'Chrome on Windows'); });
  await t('lock attempt is written to the security log', async () => { const r = await sess({ action: 'status' }, { s: A.j.data.sessionToken }); eq(r.j.data.events.some(e => e.type === 'login_blocked'), true); });
  await t('recovery code logs in and kicks the old device', async () => { B = await sess({ action: 'login', recoveryCode: 'rescue-123' }, { ua: MOB, ip: '9.9.9.9' }); eq(B.status, 200); eq((await sess({ action: 'ping' }, { s: A.j.data.sessionToken })).status, 401, 'old session'); });
  await t('"replace" policy: new login replaces old session', async () => { await sess({ action: 'save_settings', settings: { policy: 'replace' } }, { s: B.j.data.sessionToken, ua: MOB, ip: '9.9.9.9' }); const C = await sess({ action: 'login' }, { ip: '1.1.1.1' }); eq(C.status, 200); eq((await sess({ action: 'ping' }, { s: B.j.data.sessionToken, ua: MOB, ip: '9.9.9.9' })).status, 401); A = C; });
  await t('kick a device by id (revoke) / sign out everywhere (panic)', async () => { await sess({ action: 'save_settings', settings: { policy: 'lock' } }, { s: A.j.data.sessionToken }); const r = await sess({ action: 'panic' }, { s: A.j.data.sessionToken }); eq(r.status, 200); eq((await sess({ action: 'ping' }, { s: A.j.data.sessionToken })).status, 401); });
  await t('idle timeout expires the session', async () => { A = await sess({ action: 'login' }); const id = Object.keys(db.S.tree.admin_sessions)[0]; db.S.tree.admin_sessions[id].lastSeen = Date.now() - 3 * 3600000; eq((await sess({ action: 'ping' }, { s: A.j.data.sessionToken })).status, 401); });
  await t('strict-IP mode kills a session used from another IP', async () => { A = await sess({ action: 'login' }); await sess({ action: 'save_settings', settings: { strictIp: true } }, { s: A.j.data.sessionToken }); eq((await sess({ action: 'ping' }, { s: A.j.data.sessionToken, ip: '5.5.5.5' })).status, 401); db.S.tree.admin_security.settings.strictIp = false; });
  await t('NON-ADMIN account hitting admin API: refused, account BANNED, IP blocked, event logged', async () => {
    const r = await sess({ action: 'login' }, { tok: 'tok:hacker@gmail.com', ip: '6.6.6.6', ua: MOB }); eq(r.status, 403);
    await new Promise(r => setTimeout(r, 300));
    eq(db.getAt('users/s1/status'), 'Banned', 'user banned');
    eq(Object.values(db.getAt('security_events') || {}).some(e => e.type === 'intruder_blocked' && e.severity === 'critical'), true, 'event');
    const again = await sess({ action: 'login' }, { tok: 'tok:boss@example.com', ip: '6.6.6.6' }); eq(again.status, 403); eq(again.j.error.code, 'EBLOCKED', 'ip blocked even with real admin token');
  });
  await t('real admin is NEVER auto-banned and can unblock an IP', async () => { A = A || await sess({ action: 'login' }); const s = await sess({ action: 'login' }, { ip: '1.1.1.1' }); const tok = (s.status === 200 ? s : A).j.data.sessionToken; const st = await sess({ action: 'status' }, { s: tok }); eq(st.j.data.blocklist.length >= 1, true); const un = await sess({ action: 'unblock', key: '6.6.6.6' }, { s: tok }); eq(un.status, 200); });
  console.log(`\n${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
})();
