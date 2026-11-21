'use strict';
// Payment orders: create -> verify (server side, with gateway API) -> atomic one-time wallet credit.
// The browser can never mark an order paid. Only verifyPayment() does, after the gateway itself confirms.
const crypto = require('crypto');
const { adapterFor, inferStyle, validateGatewayConfig, testGateway, round2 } = require('./gateways');

const ORDER_TTL_MS = 10 * 60 * 1000;          // shown to the user as the payment window
const RECONCILE_WINDOW_MS = 60 * 60 * 1000;   // server keeps checking pending orders for 1 hour (late payments still get credited)
const MAX_AMOUNT_HARD = 1000000;
const safeKey = (s) => String(s).replace(/[.#$\[\]\/\s]/g, '_').slice(0, 120);
const nowIN = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

class PayError extends Error { constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; } }

class Payments {
  constructor(fb, env = process.env, log = console) { this.fb = fb; this.env = env; this.log = log; this.requireGwAmount = env.REQUIRE_GATEWAY_AMOUNT === '1'; this.notify = null; }

  /* ---------------- gateway store (public node + server-only secret node) ---------------- */
  async loadGateways() {
    const [pub, sec] = await Promise.all([this.fb.get('payment_gateways'), this.fb.get('gateway_secrets')]);
    return Object.entries(pub || {}).filter(([, g]) => g && typeof g === 'object').map(([id, g]) => ({
      id, ...g, style: inferStyle(g), apiKey: (sec && sec[id] && sec[id].apiKey) || g.apiKey || '', baseUrl: String(g.baseUrl || '').replace(/\/$/, '')
    }));
  }
  async loadGateway(id) { const l = await this.loadGateways(); return l.find(g => g.id === id) || null; }
  publicView(g) { const { apiKey, mapping, ...rest } = g; return { ...rest, keySet: !!apiKey, keyHint: apiKey ? '••••' + String(apiKey).slice(-3) : '', mapping: typeof mapping === 'string' ? mapping : mapping ? JSON.stringify(mapping) : '' }; }

  /** move any apiKey that is sitting in the browser-readable node into gateway_secrets (nothing is deleted before it is copied) */
  async migrateGateways() {
    const pub = (await this.fb.get('payment_gateways')) || {}; let moved = 0, created = 0;
    for (const [id, g] of Object.entries(pub)) {
      if (!g || typeof g !== 'object' || !g.apiKey) continue;
      await this.fb.set(`gateway_secrets/${id}/apiKey`, String(g.apiKey));
      const back = await this.fb.get(`gateway_secrets/${id}/apiKey`);
      if (back !== String(g.apiKey)) throw new PayError('Secret copy verify nahi hui, migration roki gayi', 'EMIGRATE', 500);
      await this.fb.update(`payment_gateways/${id}`, { apiKey: null, keySet: true, keyHint: '••••' + String(g.apiKey).slice(-3), style: inferStyle(g) });
      moved++;
    }
    const old = await this.fb.get('auto_payment_settings'); // legacy single-gateway settings (old "Auto Payment")
    if (old && old.apiKey && !old.migrated) {
      const exists = (await this.loadGateways()).some(g => g.apiKey === old.apiKey);
      if (!exists) {
        const id = await this.fb.push('payment_gateways', { name: 'FAM Gateway', baseUrl: 'https://famgateway.in', createPath: '/api/qr.php', verifyPath: '/api/verify-order.php', style: 'fam', minAmount: Number(old.minAmount) || 1, maxAmount: Number(old.maxAmount) || 50000, priority: 1, enabled: !!old.enabled, keySet: true, keyHint: '••••' + String(old.apiKey).slice(-3), createdAt: Date.now(), updatedAt: Date.now() });
        await this.fb.set(`gateway_secrets/${id}/apiKey`, String(old.apiKey)); created++;
      }
      await this.fb.update('auto_payment_settings', { migrated: true, enabled: false, apiKey: null });
    }
    return { moved, created };
  }

  async saveGateway(input) {
    const id = input.id ? String(input.id) : '';
    const old = id ? await this.loadGateway(id) : null;
    if (id && !old) throw new PayError('Gateway nahi mila', 'ENOTFOUND', 404);
    const style = ['fam', 'zapupi', 'custom'].includes(input.style) ? input.style : inferStyle(input);
    let base = String(input.baseUrl || '').trim().replace(/^http:\/\//i, 'https://'); let cp = String(input.createPath || '').trim(), vp = String(input.verifyPath || '').trim();
    try { const u = new URL(base); if (u.pathname && u.pathname !== '/') { // admin pasted a full endpoint -> split into base + path
      if (!cp) cp = u.pathname; base = u.origin; } else base = u.origin; } catch (e) {}
    const rec = { name: String(input.name || '').trim(), baseUrl: base, createPath: cp, verifyPath: vp, style, minAmount: Number(input.minAmount) || 1, maxAmount: Number(input.maxAmount) || 50000, priority: parseInt(input.priority, 10) || 100, enabled: input.enabled !== false, updatedAt: Date.now() };
    if (style === 'custom') rec.mapping = typeof input.mapping === 'string' ? input.mapping.trim() : (input.mapping ? JSON.stringify(input.mapping) : '');
    else rec.mapping = null;
    const errs = validateGatewayConfig({ ...rec, mapping: rec.mapping || undefined });
    const newKey = String(input.apiKey || '').trim();
    if (!newKey && !(old && old.apiKey)) errs.push('API key zaroori hai');
    if (errs.length) throw new PayError(errs.join('. '), 'EVALIDATION', 400);
    const key = newKey || old.apiKey;
    let rid = id;
    if (newKey || !old) { // secret first, so a gateway never exists without its key
      if (!rid) rid = await this.fb.push('payment_gateways', { name: rec.name, createdAt: Date.now() });
      await this.fb.set(`gateway_secrets/${rid}/apiKey`, key);
    }
    Object.assign(rec, { keySet: true, keyHint: '••••' + key.slice(-3), apiKey: null });
    if (!old) rec.createdAt = Date.now();
    if (old && (old.baseUrl !== base || newKey)) Object.assign(rec, { status: 'unknown', statusNote: 'Config badla - dobara Test karo', lastCheck: null, lastCreateOkAt: null });
    await this.fb.update(`payment_gateways/${rid}`, rec);
    return rid;
  }
  async deleteGateway(id) { await this.fb.remove(`payment_gateways/${id}`); await this.fb.remove(`gateway_secrets/${id}`); }
  async toggleGateway(id, enabled) { const g = await this.loadGateway(id); if (!g) throw new PayError('Gateway nahi mila', 'ENOTFOUND', 404); await this.fb.update(`payment_gateways/${id}`, { enabled: enabled === undefined ? !g.enabled : !!enabled, updatedAt: Date.now() }); }
  async setPrimary(id) {
    const list = await this.loadGateways(); if (!list.some(g => g.id === id)) throw new PayError('Gateway nahi mila', 'ENOTFOUND', 404);
    const ups = {}; list.forEach(g => { ups[`${g.id}/priority`] = g.id === id ? 1 : Math.max(2, Number(g.priority) === 1 ? 2 : Number(g.priority) || 100); });
    await this.fb.update('payment_gateways', ups);
  }
  async testGatewayById(id, { deep, redirectUrl } = {}) {
    const g = await this.loadGateway(id); if (!g) throw new PayError('Gateway nahi mila', 'ENOTFOUND', 404);
    const res = await testGateway(g, { deep, redirectUrl });
    const ups = { status: res.level, statusNote: res.message.slice(0, 300), lastCheck: Date.now() };
    if (res.level === 'verified') ups.lastCreateOkAt = Date.now();
    await this.fb.update(`payment_gateways/${id}`, ups);
    return res;
  }

  /* ---------------- create order ---------------- */
  async createPayment({ uid, amount, gatewayId, name, phone, returnUrl, publicBase }) {
    uid = String(uid || ''); if (!/^[A-Za-z0-9_\-]{1,100}$/.test(uid)) throw new PayError('User ID galat hai', 'EUSER');
    const user = await this.fb.get(`users/${uid}`);
    if (!user || typeof user !== 'object') throw new PayError('User nahi mila. Dobara login karo.', 'EUSER', 404);
    if (user.status === 'Banned') throw new PayError('Aapka account suspended hai.', 'EBANNED', 403);
    amount = Number(amount); if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT_HARD) throw new PayError('Amount galat hai', 'EAMOUNT');
    amount = round2(amount);
    const phoneClean = String(phone || '').replace(/\D/g, '').slice(0, 10);
    const all = (await this.loadGateways()).filter(g => g.enabled && g.apiKey && g.baseUrl);
    if (!all.length) throw new PayError('Abhi koi payment gateway ON nahi hai.', 'ENOGATEWAY', 503);
    let cands = all.filter(g => amount >= (Number(g.minAmount) || 1) && amount <= (Number(g.maxAmount) || 50000)).sort((a, b) => (Number(a.priority) || 100) - (Number(b.priority) || 100));
    if (!cands.length) { const mn = Math.min(...all.map(g => Number(g.minAmount) || 1)), mx = Math.max(...all.map(g => Number(g.maxAmount) || 50000)); throw new PayError(`Amount ₹${mn} se ₹${mx} ke beech hona chahiye.`, 'EAMOUNT'); }
    if (gatewayId) { const i = cands.findIndex(g => g.id === gatewayId); if (i > 0) cands.unshift(cands.splice(i, 1)[0]); }
    let lastErr = null;
    for (const g of cands) {
      const orderRef = (inferStyle(g) === 'zapupi' ? 'ZAPUPI' : 'AP') + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();
      try {
        const redirect = returnUrl && /^https:\/\//i.test(returnUrl) || (returnUrl && /^http:\/\/(localhost|127\.0\.0\.1)/i.test(returnUrl)) ? returnUrl.slice(0, 480) : '';
        const o = await adapterFor(g).create(g, { amount, name: String(name || user.username || 'user').slice(0, 60), phone: phoneClean, redirectUrl: redirect, webhookUrl: publicBase ? `${publicBase}/api/pay/webhook/${g.id}` : '', orderRef });
        if (Math.abs(o.amount - amount) > 0.009) throw Object.assign(new Error(`Gateway ne alag amount return kiya (₹${o.amount})`), { code: 'EAMOUNT' });
        const key = safeKey(o.gatewayOrderId); const createdAt = Date.now();
        const rec = { uid, username: user.username || '', amount, payAmount: o.payAmount, gatewayId: g.id, gatewayName: g.name || '', gatewayOrderId: o.gatewayOrderId, clientOrderId: orderRef, status: 'pending', credited: false, checkoutUrl: o.checkoutUrl, qr: o.qr || '', createdAt, expiresAt: createdAt + (o.expiresIn ? o.expiresIn * 1000 : ORDER_TTL_MS) };
        if (!(await this.fb.createIfAbsent(`auto_payments/${key}`, rec))) throw new Error('Duplicate order ID gateway se aaya, dobara try karo');
        await this.fb.set(`pending_payments/${key}`, { uid, createdAt, lastCheck: 0 });
        this.fb.update(`payment_gateways/${g.id}`, { status: 'verified', statusNote: 'Asli order create hua', lastCreateOkAt: createdAt, lastCheck: createdAt }).catch(() => {});
        return { orderId: key, gatewayOrderId: o.gatewayOrderId, amount, payAmount: o.payAmount, checkoutUrl: o.checkoutUrl, qr: o.qr || '', expiresAt: rec.expiresAt, gatewayId: g.id, gatewayName: g.name || '', status: 'pending' };
      } catch (e) {
        lastErr = e;
        this.log.warn && this.log.warn(`[pay] create failed on ${g.name}: ${e.message}`);
        this.fb.push('gateway_logs', { gatewayId: g.id, ok: false, stage: 'create', message: String(e.message).slice(0, 200), ts: Date.now() }).catch(() => {});
      }
    }
    throw new PayError(lastErr ? lastErr.message : 'Order create nahi hua', lastErr && lastErr.code || 'EGATEWAY', 502);
  }

  /* ---------------- verify (+credit) ---------------- */
  async orderView(key, rec, extra = {}) {
    return { orderId: key, gatewayOrderId: rec.gatewayOrderId || key, amount: rec.amount, status: rec.status, credited: !!rec.credited, bonus: Number(rec.bonus) || 0, gatewayName: rec.gatewayName || '', expiresAt: rec.expiresAt || 0, ...extra };
  }
  async verifyPayment(orderId, { uid } = {}) {
    const key = safeKey(orderId); if (!key) throw new PayError('Order ID missing', 'EORDER');
    const rec = await this.fb.get(`auto_payments/${key}`);
    if (!rec) throw new PayError('Order record nahi mila', 'ENOTFOUND', 404);
    if (uid && rec.uid !== uid) throw new PayError('Ye order aapka nahi hai', 'EFORBIDDEN', 403);
    if (rec.credited === true || rec.status === 'success') return this.orderView(key, rec, { status: 'success', balance: await this._balance(rec.uid), reference: rec.reference || '', message: 'Payment already credited' });
    if (rec.status === 'crediting') return this.orderView(key, rec, { message: 'Credit process ho raha hai, thodi der baad check karo' });
    if (['amount_mismatch', 'failed'].includes(rec.status)) return this.orderView(key, rec, { status: 'failed', message: rec.note || 'Order failed' });
    const g = await this.loadGateway(rec.gatewayId);
    if (!g || !g.apiKey) return this.orderView(key, rec, { status: 'error', message: 'Gateway configuration nahi mili. Admin se contact karo.' });
    let v;
    try { v = await adapterFor(g).verify(g, rec.gatewayOrderId || key); }
    catch (e) { this.fb.push('gateway_logs', { gatewayId: g.id, ok: false, stage: 'verify', message: String(e.message).slice(0, 200), ts: Date.now() }).catch(() => {}); return this.orderView(key, rec, { status: 'error', message: e.message }); }
    this.fb.update(`pending_payments/${key}`, { lastCheck: Date.now() }).catch(() => {});
    if (v.state === 'paid') {
      const got = v.amount;
      if (got != null && Math.abs(got - rec.amount) > 0.01 && Math.abs(got - (rec.payAmount || rec.amount)) > 0.01) {
        await this.fb.update(`auto_payments/${key}`, { status: 'amount_mismatch', needsReview: true, note: `Gateway amount ₹${got} order amount ₹${rec.amount} se match nahi hua`, gatewayAmount: got });
        await this.fb.remove(`pending_payments/${key}`).catch(() => {});
        return this.orderView(key, rec, { status: 'failed', message: 'Paid amount order se match nahi hua. Admin se contact karo.' });
      }
      if (got == null && this.requireGwAmount) return this.orderView(key, rec, { status: 'error', message: 'Gateway ne amount confirm nahi kiya, credit roka gaya' });
      return this.creditOrder(key, rec, { reference: v.reference || '', amountVerified: got != null });
    }
    if (v.state === 'expired') { await this._finish(key, rec, 'expired'); return this.orderView(key, rec, { status: 'expired', message: 'Payment time expire ho gaya.' }); }
    if (v.state === 'failed') { await this._finish(key, rec, 'failed'); return this.orderView(key, rec, { status: 'failed', message: 'Gateway ne payment fail bataya.' }); }
    if (v.state === 'unauthorized') return this.orderView(key, rec, { status: 'error', message: 'Gateway API key galat hai. Admin se contact karo.' });
    if (v.state === 'error' || v.state === 'unknown' || v.state === 'notfound') return this.orderView(key, rec, { status: 'error', message: v.message || 'Gateway se sahi jawab nahi mila' });
    return this.orderView(key, rec, { status: 'pending', message: 'Payment abhi receive nahi hui' });
  }
  async _finish(key, rec, status) {
    await this.fb.transaction(`auto_payments/${key}`, (c) => (c && !c.credited && c.status !== 'success' && c.status !== 'crediting') ? { ...c, status } : undefined);
    await this.fb.remove(`pending_payments/${key}`).catch(() => {});
  }
  async _bonusOf(key) { try { return Number(await this.fb.get(`auto_payments/${key}/bonus`)) || 0; } catch (e) { return 0; } }
  async _balance(uid) { try { return Number(await this.fb.get(`users/${uid}/balance`)) || 0; } catch (e) { return 0; } }

  /** exactly-once credit. Step 1 atomically claims the order (pending -> crediting); only the winner touches the wallet. */
  async creditOrder(key, rec, { reference, amountVerified }) {
    const claim = await this.fb.transaction(`auto_payments/${key}`, (c) => {
      if (!c || c.credited === true || ['success', 'crediting', 'amount_mismatch'].includes(c.status)) return undefined;
      return { ...c, status: 'crediting', creditingAt: Date.now() };
    });
    if (!claim.committed) { const cur = await this.fb.get(`auto_payments/${key}`); return this.orderView(key, cur || rec, { status: cur && (cur.credited || cur.status === 'success') ? 'success' : 'pending', balance: await this._balance(rec.uid), message: 'Payment already processed' }); }
    const amount = round2(rec.amount); let balanceApplied = false;
    try {
      await this.fb.transaction(`users/${rec.uid}/balance`, (cur) => round2((Number(cur) || 0) + amount));
      balanceApplied = true;
      let bonus = 0;
      try {
        const s = (await this.fb.get('payment_settings')) || {};
        if (s.bonusEnabled && Number(s.bonusPct) > 0 && amount >= (Number(s.bonusMin) || 0)) {
          bonus = Math.round(amount * Number(s.bonusPct)) / 100;
          if (bonus > 0) {
            await this.fb.transaction(`users/${rec.uid}/balance`, (cur) => round2((Number(cur) || 0) + bonus));
            await this.fb.set(`users/${rec.uid}/transactions/bonus_${key}`, { type: 'Bonus', amount: bonus, description: `Deposit bonus ${s.bonusPct}% on ₹${amount}`, source: 'bonus', ts: Date.now(), date: nowIN() });
          }
        }
      } catch (e) { this.log.warn && this.log.warn('[pay] bonus failed: ' + e.message); }
      await this.fb.set(`users/${rec.uid}/transactions/dep_${key}`, { type: 'Deposit', amount, description: `Auto Payment Deposit (UPI) - ${key}`, source: 'gateway', orderId: key, ts: Date.now(), date: nowIN() });
      await this.fb.update(`auto_payments/${key}`, { status: 'success', credited: true, paidAt: Date.now(), creditedAt: Date.now(), reference, amountVerified: !!amountVerified, bonus });
      await this.fb.remove(`pending_payments/${key}`).catch(() => {});
      if (this.notify) this.notify.deposit(key, { ...rec, amount }, bonus).catch(() => {}); // channel alert, never blocks the credit
    } catch (e) {
      if (!balanceApplied) { // definite failure before any money moved -> release the claim so it can be retried
        await this.fb.transaction(`auto_payments/${key}`, (c) => c && c.status === 'crediting' && !c.credited ? { ...c, status: 'pending', creditingAt: null } : undefined).catch(() => {});
      } else { await this.fb.update(`auto_payments/${key}`, { needsReview: true, note: 'Balance add ho gaya par record finalize nahi hua: ' + e.message }).catch(() => {}); }
      throw new PayError('Credit fail: ' + e.message, 'ECREDIT', 500);
    }
    return this.orderView(key, { ...rec, status: 'success', credited: true }, { status: 'success', credited: true, bonus: await this._bonusOf(key), balance: await this._balance(rec.uid), reference, message: 'Payment verified, balance add ho gaya' });
  }

  async cancelPayment(orderId, uid) {
    const key = safeKey(orderId); const rec = await this.fb.get(`auto_payments/${key}`);
    if (!rec) throw new PayError('Order record nahi mila', 'ENOTFOUND', 404);
    if (rec.uid !== uid) throw new PayError('Ye order aapka nahi hai', 'EFORBIDDEN', 403);
    const r = await this.fb.transaction(`auto_payments/${key}`, (c) => c && c.status === 'pending' && !c.credited ? { ...c, status: 'cancelled', cancelledAt: Date.now() } : undefined);
    return { orderId: key, status: r.committed ? 'cancelled' : r.value && r.value.status };
  }

  /* ---------------- background reconciler: credits confirmed payments even if the user closed the page ---------------- */
  async reconcileOnce(limit = 20) {
    const pend = (await this.fb.get('pending_payments')) || {}; const now = Date.now(); let checked = 0, credited = 0;
    for (const [key, p] of Object.entries(pend)) {
      if (checked >= limit) break;
      const age = now - (p.createdAt || 0);
      if (age > RECONCILE_WINDOW_MS) { await this._finish(key, null, 'expired').catch(() => {}); continue; }
      const gap = age < 10 * 60000 ? 15000 : 120000; if (now - (p.lastCheck || 0) < gap) continue;
      checked++;
      try { const r = await this.verifyPayment(key); if (r.status === 'success' && r.message === 'Payment verified, balance add ho gaya') credited++; } catch (e) { this.log.warn && this.log.warn(`[reconcile] ${key}: ${e.message}`); }
    }
    return { checked, credited };
  }
  startReconciler(ms = 20000) {
    if (this._t) return; let busy = false;
    this._t = setInterval(async () => { if (busy || !this.fb.configured()) return; busy = true; try { await this.reconcileOnce(); } catch (e) { this.log.warn && this.log.warn('[reconcile] ' + e.message); } finally { busy = false; } }, ms);
    this._t.unref && this._t.unref();
  }
  stopReconciler() { clearInterval(this._t); this._t = null; }
}

module.exports = { Payments, PayError, safeKey };
