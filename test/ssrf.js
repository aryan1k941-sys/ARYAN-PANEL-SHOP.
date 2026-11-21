'use strict';
// SSRF unit tests for lib/netguard.js - run with a CLEAN env (no GW_ALLOW_PRIVATE), as in production.
const { safeRequest, isPrivateIp, validateGatewayUrl } = require('../lib/netguard');
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + ' :: ' + e.message); } };
const rejects = async (p, re) => { try { await p; } catch (e) { if (!re || re.test(e.message + ' ' + e.code)) return; throw new Error('wrong error: ' + e.message); } throw new Error('request was NOT blocked'); };
(async () => {
  console.log('\n== SSRF guard (production mode) ==');
  await t('private / loopback / link-local / CGNAT / mapped addresses detected', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) if (!isPrivateIp(ip)) throw new Error(ip + ' not flagged');
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111']) if (isPrivateIp(ip)) throw new Error(ip + ' wrongly flagged');
  });
  const hosts = (...h) => new Set(h);
  await t('http:// rejected', () => rejects(safeRequest({ url: 'http://example.com/', allowedHosts: hosts('example.com') }), /HTTPS/));
  await t('URL credentials rejected', () => rejects(safeRequest({ url: 'https://user:pw@example.com/', allowedHosts: hosts('example.com') }), /Credentials/));
  await t('non-443 port rejected', () => rejects(safeRequest({ url: 'https://example.com:8443/', allowedHosts: hosts('example.com') }), /port/));
  await t('IP literal host rejected even if allow-listed', () => rejects(safeRequest({ url: 'https://127.0.0.1/', allowedHosts: hosts('127.0.0.1') }), /IP address/));
  await t('cloud metadata IP rejected', () => rejects(safeRequest({ url: 'https://169.254.169.254/latest/meta-data/', allowedHosts: hosts('169.254.169.254') }), /IP address/));
  await t('localhost rejected even if allow-listed', () => rejects(safeRequest({ url: 'https://localhost/', allowedHosts: hosts('localhost') }), /localhost/));
  await t('host not in allow-list rejected', () => rejects(safeRequest({ url: 'https://example.com/', allowedHosts: hosts('other.com') }), /not allowed/));
  await t('allow-listed hostname that RESOLVES to a private IP is blocked at connect time (DNS rebinding defence)', async () => {
    // "localhost" resolves to 127.0.0.1 but is rejected earlier; use a name that resolves privately via /etc/hosts-style 'localtest.me' is not available offline,
    // so exercise the lookup hook directly with a fake resolver result.
    const dns = require('dns'); const orig = dns.lookup; dns.lookup = (h, o, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]);
    try { await rejects(safeRequest({ url: 'https://pay.rebind.example/x', allowedHosts: hosts('pay.rebind.example'), timeoutMs: 3000 }), /private|internal|EGWBLOCKED/); } finally { dns.lookup = orig; }
  });
  await t('validateGatewayUrl accepts a normal https host', () => { validateGatewayUrl('https://famgateway.in/api/qr.php', hosts('famgateway.in')); });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
