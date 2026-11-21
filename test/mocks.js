'use strict';
// Test doubles: a Realtime-Database REST mock (with real ETag / If-Match semantics), an identity-lookup mock,
// and mock payment gateways served over HTTPS. Used ONLY by the test-suite.
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const seg = (p) => String(p || '').split('/').filter(Boolean).map(decodeURIComponent);
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const etagOf = (v) => (v == null ? 'null_etag' : crypto.createHash('md5').update(JSON.stringify(v)).digest('hex'));

function startRtdb() {
  const S = { tree: {}, reqs: [], failNext: null };
  const getAt = (path) => { let n = S.tree; for (const s of seg(path)) { if (n == null || typeof n !== 'object') return null; n = n[s]; } return n === undefined ? null : n; };
  const setAt = (path, v) => {
    const s = seg(path); if (!s.length) { S.tree = v || {}; return; }
    let n = S.tree; for (let i = 0; i < s.length - 1; i++) { if (n[s[i]] == null || typeof n[s[i]] !== 'object') n[s[i]] = {}; n = n[s[i]]; }
    if (v == null) delete n[s[s.length - 1]]; else n[s[s.length - 1]] = clone(v);
  };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const url = new URL(req.url, 'http://x'); const path = url.pathname.replace(/\.json$/, ''); S.reqs.push(req.method + ' ' + path);
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (S.failNext && S.failNext.test(req.method + ' ' + path)) { S.failNext = null; return send(500, { error: 'injected failure' }); }
      const cur = getAt(path); const body = b ? JSON.parse(b) : null; const im = req.headers['if-match'];
      if (req.method === 'GET') return send(200, cur, req.headers['x-firebase-etag'] ? { ETag: etagOf(cur) } : {});
      if ((req.method === 'PUT' || req.method === 'DELETE') && im && im !== etagOf(cur)) return send(412, cur, { ETag: etagOf(cur) });
      if (req.method === 'PUT') { setAt(path, body); return send(200, body); }
      if (req.method === 'DELETE') { setAt(path, null); return send(200, null); }
      if (req.method === 'PATCH') { for (const k of Object.keys(body)) setAt(path + '/' + k, body[k]); return send(200, body); }
      if (req.method === 'POST') { const id = '-M' + crypto.randomBytes(8).toString('hex'); setAt(path + '/' + id, body); return send(200, { name: id }); }
      send(405, { error: 'x' });
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ S, srv, url: 'http://127.0.0.1:' + srv.address().port, getAt, setAt })));
}

function startIdentity(emails) { // token "tok:<email>" is valid
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { const t = (JSON.parse(b || '{}').idToken || ''); const m = /^tok:(.+)$/.exec(t); res.writeHead(m ? 200 : 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(m ? { users: [{ localId: 'L1', email: m[1], emailVerified: true }] } : { error: { message: 'INVALID_ID_TOKEN' } })); }); });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, url: 'http://127.0.0.1:' + srv.address().port })));
}

/** mock gateways over HTTPS. behaviour is controlled through the returned state object G */
function startGateways(tls) {
  const G = { fam: { orders: {}, key: 'fam_key_123456', mode: 'ok', calls: [] }, zap: { orders: {}, key: 'zap_key_abcdef', mode: 'ok', calls: [] }, mivo: { orders: {}, key: 'mivo_key_999999', mode: 'ok', calls: [] } };
  const handler = (forced) => (req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const url = new URL(req.url, 'https://x'); const host = (req.headers.host || '').split(':')[0]; const q = url.searchParams;
      const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const html = (code = 404) => { res.writeHead(code, { 'Content-Type': 'text/html' }); res.end('<html>Not Found</html>'); };
      const which = forced;
      const st = G[which]; const p = url.pathname; st.calls.push({ method: req.method, path: p, query: Object.fromEntries(q), headers: req.headers, body: b });
      if (st.mode === 'down500') return html(500);
      if (st.mode === 'nonjson') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>maintenance</html>'); }
      /* ---- FAM style ---- */
      if (which === 'fam') {
        const key = req.headers['x-api-key'] || q.get('api_key');
        if (p === '/api/qr.php') {
          if (key !== st.key) return json({ status: 'unauthorized', message: 'Invalid API key' }, 401);
          const id = 'FAM' + crypto.randomBytes(5).toString('hex').toUpperCase(); const amt = Number(q.get('amount'));
          st.orders[id] = { amount: amt, paid: false, state: 'pending' };
          return json({ status: 'success', data: { order_id: id, checkout_url: 'https://pay.example/checkout/' + id, qr_url: 'https://pay.example/qr/' + id + '.png', amount: amt, payable_amount: amt } });
        }
        if (p === '/api/verify-order.php') {
          if (key !== st.key) return json({ status: 'unauthorized', message: 'Invalid API key' }, 401);
          const o = st.orders[q.get('order_id')]; if (!o) return json({ status: 'error', message: 'Order not found' }, 404);
          if (o.state === 'paid') return json({ status: 'success', data: { order_id: q.get('order_id'), status: 'success', amount: o.reportAmount != null ? o.reportAmount : o.amount, utr: 'UTR' + q.get('order_id') } });
          if (o.state === 'expired') return json({ status: 'expired', message: 'expired' });
          if (o.state === 'failed') return json({ status: 'success', data: { order_id: q.get('order_id'), status: 'failed' } });
          if (st.mode === 'tricky') return json({ status: 'success', data: { order_id: q.get('order_id'), status: 'pending', amount: o.amount } }); // outer success but NOT paid
          return json({ status: 'pending', message: 'waiting for payment' });
        }
        if (p === '/api/checkout-status.php') return json({ status: 'pending' });
        return html();
      }
      /* ---- ZapUPI style (POST JSON) ---- */
      if (which === 'zap') {
        const j = b ? JSON.parse(b) : {};
        if (p === '/api/create-order') {
          if (req.method !== 'POST' || j.zap_key !== st.key) return json({ status: 'error', message: 'Invalid zap_key' });
          st.orders[j.order_id] = { amount: Number(j.amount), state: 'pending', body: j };
          return json({ status: 'success', payment_url: 'https://pay.zapupi.example/p/' + j.order_id });
        }
        if (p === '/api/order-status') {
          if (j.zap_key !== st.key) return json({ status: 'error', message: 'Invalid zap_key' });
          const o = st.orders[j.order_id]; if (!o) return json({ status: 'error', message: 'Order not found' });
          return json({ status: 'success', data: { order_id: j.order_id, status: o.state === 'paid' ? 'success' : o.state === 'expired' ? 'expired' : 'pending', amount: o.amount, utr: 'ZUTR1' } });
        }
        return html();
      }
      /* ---- "Mivopay" style: invented ONLY for testing the custom-mapping adapter (bearer header + form body) ---- */
      if (p === '/api/order.php') {
        if (req.headers.authorization !== 'Bearer ' + st.key) return json({ code: 401, msg: 'bad token' }, 401);
        const f = new URLSearchParams(b); const id = f.get('merchant_order'); st.orders[id] = { amount: Number(f.get('amt')), state: 'pending' };
        return json({ code: 0, result: { pay_link: 'https://pay.mivo.example/' + id, ref: id } });
      }
      if (p === '/api/verify-order.php') {
        if (req.headers.authorization !== 'Bearer ' + st.key) return json({ code: 401, msg: 'bad token' }, 401);
        const f = new URLSearchParams(b); const o = st.orders[f.get('merchant_order')]; if (!o) return json({ code: 404, msg: 'no such order' });
        return json({ code: 0, result: { merchant_order: f.get('merchant_order'), state: o.state === 'paid' ? 'PAID' : 'WAITING', amt: o.amount, txn: 'T1' } });
      }
      html();
    });
  };
  const mk = (which) => new Promise(r => { const srv = https.createServer({ key: tls.key, cert: tls.cert }, handler(which)); srv.listen(0, '127.0.0.1', () => r({ srv, base: 'https://localhost:' + srv.address().port })); });
  return Promise.all([mk('fam'), mk('zap'), mk('mivo')]).then(([fam, zap, mivo]) => ({ G, fam, zap, mivo, close: () => [fam, zap, mivo].forEach(x => x.srv.close()) }));
}
module.exports = { startRtdb, startIdentity, startGateways };
