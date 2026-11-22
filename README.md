# ARYAN PANEL SHOP v2.1
- `server.js` + `lib/` : zero-dependency Node backend (static site + `/api/pay/*`, `/api/admin/gateways`, `/api/gw`, `/api/health`)
- `public/` : index.html (user panel), Admin.html (admin panel)
- `test/` : `npm test` (backend, mocks), `node test/ui.js`, `node test/admin-ui.js` (Playwright)
- Hinglish deployment guide: RENDER_GUIDE_HINGLISH.md
- `lib/notify.js` : Telegram channel alerts (deposit / key sale / reseller / referral / signup / broadcast) — configured from Admin > Alerts & Channel
- New admin tabs: Alerts & Channel, Business Insights, Quick Add Packs (Free Fire). New user pages: premium Profile (Account/Password/API), Refer & Earn, API docs, stats strip
- `node test/plus-ui.js` : browser test for the v2.1 screens

## v3.0 "ROYAL / CONSOLE" upgrade
- **User panel**: new Royal look (saffron/ember on obsidian), premium tactile buttons everywhere, bottom dock with centre Deposit button, Instant Top-up (₹20/50/100/200/custom → real `/api/pay/create`), low-balance auto top-up (shortfall, min ₹20) on Buy Keys + dashboard, rank & 7-day chart & recent activity, Deposit quick amounts + recent deposits, Buy Keys sort, Support Hub (Telegram / WhatsApp / YouTube / Instagram / Discord / Email + FAQ + ticket templates), My Resellers network (search, filters, balances, Add Balance transfer, Make Reseller), login/register extras (trust badges, social icons, show/hide password, strength meter).
- **Admin panel**: new teal/ice Console look, live KPIs, 14-day deposits-vs-sales chart, top resellers/products, low stock, live feed, instant announcement, Users/Transactions CSV export, new support-link fields (WhatsApp, YouTube, Instagram, Discord, email, hours) in Site Links.
- Screenshots: `demo_v3/`

## v3.1 Security
- Admin: single-device lock, device list, kick/panic, idle logout, strict IP, intruder auto-ban, security log, password change → **Security Center** tab. Server: `lib/adminsec.js`, route `/api/admin/session`.
- Every `/api/admin/*` call now needs the server-approved session (`X-Admin-Session`). See `SECURITY_GUIDE_HINGLISH.md`, `tools/make-rules.js`, `.env.example`.
- User panel: login history + auto-logout card in Profile.
- Tests: `npm test` (93 backend incl. `test/adminsec.js`), `node test/sec-ui.js` (browser).
