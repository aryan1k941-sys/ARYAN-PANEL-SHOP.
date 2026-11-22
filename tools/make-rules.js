'use strict';
// node tools/make-rules.js you@gmail.com[,second@gmail.com]  ->  firebase-rules-admin-lock.json (merge into Firebase Console > Realtime Database > Rules)
const emails = String(process.argv[2] || process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(e => /^[^@'"\s]+@[^@'"\s]+$/.test(e));
if (!emails.length) { console.error('Usage: node tools/make-rules.js admin@gmail.com'); process.exit(1); }
const ADMIN = `auth != null && auth.token.email_verified == true && (${emails.map(e => `auth.token.email == '${e}'`).join(' || ')})`;
const adminWrite = ['announcements', 'api_settings', 'auto_payment_settings', 'branding', 'media', 'payment_settings', 'pid_mappings', 'product_maintenance', 'site_settings', 'store_management', 'store_products', 'suppliers', 'supplier_settings', 'telegram_settings'];
const rules = {};
for (const n of adminWrite) rules[n] = { '.write': ADMIN };
rules.admin_audit = { '.read': ADMIN, '.write': ADMIN };
for (const n of ['admin_sessions', 'admin_security', 'security_events', 'security_blocklist']) rules[n] = { '.read': false, '.write': false }; // only the server (service account) can touch these
const out = { _README: 'MERGE these nodes into your existing rules (do not replace the whole file). Only the admin Gmail(s) can WRITE site/product/payment settings; the security nodes are server-only.', rules };
require('fs').writeFileSync(require('path').join(__dirname, '..', 'firebase-rules-admin-lock.json'), JSON.stringify(out, null, 2));
console.log('Written firebase-rules-admin-lock.json for:', emails.join(', '));
