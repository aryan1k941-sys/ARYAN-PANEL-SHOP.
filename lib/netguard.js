'use strict';
// Safe outbound HTTPS client (SSRF protection).
//  - https only, no credentials in URL, port 443 only
//  - hostname must be in the caller-supplied allow-list
//  - DNS result is checked at connect time (blocks private / loopback / link-local, defeats DNS rebinding)
//  - redirects are never followed, response size + time are capped
const https = require('https');
const dns = require('dns');
const net = require('net');

const TEST_MODE = process.env.NODE_ENV !== 'production' && process.env.GW_ALLOW_PRIVATE === '1';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || l.startsWith('fc') || l.startsWith('fd')) return true;
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true;
}

function safeLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { all: true, family: options && options.family }, (err, addrs) => {
    if (err) return cb(err);
    const ok = (addrs || []).filter(a => TEST_MODE || !isPrivateIp(a.address));
    if (!ok.length) { const e = new Error('Blocked: host resolves to a private/internal address'); e.code = 'EGWBLOCKED'; return cb(e); }
    if (options && options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function validateGatewayUrl(raw, allowedHosts) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw blocked('Invalid URL'); }
  if (u.protocol !== 'https:') throw blocked('Only HTTPS URLs are allowed');
  if (u.username || u.password) throw blocked('Credentials in URL are not allowed');
  if (!TEST_MODE && u.port && u.port !== '443') throw blocked('Only port 443 is allowed');
  const host = u.hostname.toLowerCase();
  if (net.isIP(host) && !TEST_MODE) throw blocked('IP address hosts are not allowed');
  if (host === 'localhost' && !TEST_MODE) throw blocked('localhost is not allowed');
  if (allowedHosts && !allowedHosts.has(host)) throw blocked('Host not allowed: ' + host);
  return u;
}
function blocked(msg) { const e = new Error(msg); e.code = 'EGWBLOCKED'; return e; }

function safeRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 15000, maxBytes = 1024 * 1024, allowedHosts }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = validateGatewayUrl(url, allowedHosts); } catch (e) { return reject(e); }
    const t0 = Date.now();
    const opts = { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { ...headers }, lookup: safeLookup, timeout: timeoutMs, servername: u.hostname };
    if (body != null) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(Object.assign(new Error('Response too large'), { code: 'ETOOBIG' })); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0 }));
      res.on('error', reject);
    });
    const hard = setTimeout(() => req.destroy(Object.assign(new Error('Gateway timeout'), { code: 'ETIMEOUT' })), timeoutMs + 1000);
    req.on('timeout', () => req.destroy(Object.assign(new Error('Gateway timeout'), { code: 'ETIMEOUT' })));
    req.on('error', (e) => { clearTimeout(hard); reject(e); });
    req.on('close', () => clearTimeout(hard));
    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = { safeRequest, validateGatewayUrl, isPrivateIp, TEST_MODE };
