'use strict';
// npm test  ->  generates a throw-away self-signed cert, then runs the SSRF unit tests and the API suite.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aryan-tls-'));
const key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem');
let r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' });
if (r.status !== 0) { console.error('openssl needed for tests:', String(r.stderr)); process.exit(2); }
const clean = { ...process.env }; delete clean.GW_ALLOW_PRIVATE; delete clean.FIREBASE_TEST_NO_AUTH; clean.NODE_ENV = 'production';
const a = spawnSync(process.execPath, [path.join(__dirname, 'ssrf.js')], { stdio: 'inherit', env: clean });
const b = spawnSync(process.execPath, [path.join(__dirname, 'suite.js')], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', NODE_EXTRA_CA_CERTS: cert, GW_ALLOW_PRIVATE: '1', FIREBASE_TEST_NO_AUTH: '1', TEST_TLS_KEY: key, TEST_TLS_CERT: cert } });
const c = spawnSync(process.execPath, [path.join(__dirname, 'notify.js')], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', NODE_EXTRA_CA_CERTS: cert, GW_ALLOW_PRIVATE: '1', FIREBASE_TEST_NO_AUTH: '1', TEST_TLS_KEY: key, TEST_TLS_CERT: cert } });
const d = spawnSync(process.execPath, [path.join(__dirname, 'adminsec.js')], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', FIREBASE_TEST_NO_AUTH: '1' } });
process.exit(a.status || b.status || c.status || d.status || 0);
