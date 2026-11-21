# ARYAN PANEL SHOP – Render Deployment Guide (Hinglish)

## Sabse pehle: kya badla hai?
- **Pehle** site Static thi aur payment ka sara kaam (gateway call, verify, wallet credit) **browser** me hota tha. Isliye `Connect nahi hua` aa raha tha (browser se gateway CORS block karta hai) aur koi bhi API key / credit fake kar sakta tha.
- **Ab** ek chhota **Node.js backend** (`server.js`) hai jo site bhi serve karta hai aur payment API bhi chalata hai. API key sirf server par rehti hai, wallet sirf server credit karta hai (ek hi baar).
- **Zaroori:** Render par ab **Web Service** banani hai, **Static Site nahi**. Static Site par secure payment possible hi nahi (frontend JS me secret chhupa nahi sakte).

## Step 1 – Firebase service account key lo (5 min)
1. Firebase Console → Project `aryan-mods-4c084` → ⚙ **Project settings** → **Service accounts**.
2. **Generate new private key** dabao → ek `.json` file download hogi.
3. Is file ko **kisi ko mat do, GitHub par mat daalo**. Uska poora text Render me daalna hai (Step 3).

## Step 2 – Code Render par daalo
1. Is ZIP ke saare files apne GitHub repo me daalo (purane `index.html`, `Admin.html`, `api/` hata do – ab sab `public/` me hai).
2. Render → **New +** → **Web Service** → apna repo chuno.
3. Settings: **Runtime = Node**, **Build Command** = `echo ok`, **Start Command** = `node server.js`, **Health Check Path** = `/api/health`.
   (Ya repo me `render.yaml` hai, "Blueprint" se auto ban jayega.)

## Step 3 – Environment variables (Render → Environment)
| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Step 1 wali JSON file ka **poora text** paste karo |
| `ADMIN_EMAILS` | Admin ka Gmail (jis se Admin panel me login karte ho). Kai ho to comma se: `a@gmail.com,b@gmail.com` |
| `PUBLIC_BASE_URL` | Tumhari site ka URL, jaise `https://aryan-xxxx.onrender.com` |
| `NODE_ENV` | `production` |

Baaki optional hain, `.env.example` me likhe hain.

## Step 4 – Deploy ke baad check karo
1. Browser me kholo: `https://TUMHARI-SITE.onrender.com/api/health` → `"status":"up"`, `"firebaseConfigured":true`, `"adminConfigured":true` aana chahiye.
   `...?deep=1` lagaoge to Firebase se connection bhi check hoga.
2. Admin panel kholo (`/Admin.html`) → login → **Payment Gateways**.
   - Pehli baar kholte hi purani API keys **apne aap server par secure** ho jati hain (browser wale database se hat jati hain). Toast aayega.
3. Har gateway par **Test** dabao, phir **Deep test** (ye gateway par 1 *unpaid* test order banata hai, paisa nahi katta). Result sach batayega:
   - 🟢 *Connected – asli order ban gaya*
   - 🟠 *Reachable (key reject nahi hui)* – abhi pakka nahi
   - 🔴 *API key reject / URL galat / Connect nahi hua*
   - 🟠 *API docs chahiye* – format pata nahi (Mivopay)

## Step 5 – Firebase Rules (zaroori)
`firebase-rules-addendum.json` me 6 nodes hain. Firebase Console → Realtime Database → **Rules** me apne maujooda rules me **ye nodes jodo** (poore rules replace mat karna). Isse API keys aur payment records browser se nahi chhede ja sakte.
⚠ Rules Playground me test karke hi Publish karo.

## Kaun si file kahan jayegi (purane ko replace karo)
| Nayi file | Kaam |
|---|---|
| `server.js`, `package.json`, `render.yaml` | Backend (naye, repo ke root me) |
| `lib/*.js` | Gateway adapters, payment logic, Firebase REST, SSRF guard (naye) |
| `public/index.html` | User panel – **purani `index.html` ko replace** |
| `public/Admin.html` | Admin panel – **purani `Admin.html` ko replace** |
| `api/gw.js` (purana Vercel proxy) | **Hata do** – ab `server.js` ke andar `/api/gw` hai (supplier calls ke liye) |
| `FF_PANEL_SELLING_BOT_FILE.py` | Jaisa hai waisa rakho (⚠ niche Security dekho) |

## Gateway ki asli API jaankari (jo mujhe docs/code se mili)
| Gateway | Status |
|---|---|
| **FAMPAY.XL** | Aapki purani working integration jaisa hi: `GET /api/qr.php?api_key&amount&customer_name`, verify `GET /api/verify-order.php?order_id` (header `X-Api-Key`). Preserve kiya. |
| **ZapUPI** | Aapke **Python bot ke code** me asli format mila: `POST /api/create-order` (JSON: `zap_key, amount, order_id, remark, success_url…`) aur `POST /api/order-status` (`zap_key, order_id`). Admin me `/api/qr.php` & `/api/verify-order.php` galat paths the – isi wajah se "Connect nahi hua" tha. Ab auto-correct hai. |
| **Mivopay** | ❌ Koi docs / code nahi mila. Mujhe request/response format nahi pata, isliye **guess nahi kiya**. Admin me "API docs chahiye" dikhayega. |

### Mivopay chalane ke liye mujhe ye chahiye (gateway ki docs/support se)
1. Create-order: HTTP method (GET/POST), body type (JSON/form), API key kahan jaati hai (header ka naam / body field), required fields (amount, order id, name, phone, redirect…).
2. Create ka response: success ka sign (`status`/`code` kya), payment URL / QR ka field, order id ka field.
3. Verify: method, fields, aur payment-status ke possible values (paid/pending/expired…), amount ka field.
4. Webhook hai ya nahi.
Ye mil jaye to Admin → Mivopay → Edit → **Custom API format (JSON)** me bhar do (example field me diya hai) ya mujhe bhejo, main bhar dunga. Code badalne ki zaroorat nahi.

## ⚠ Security – zaroor padho
1. **`FF_PANEL_SELLING_BOT_FILE.py` me FamPay ki asli API key likhi hui hai.** Agar ye file kabhi share/upload hui hai to FamGateway dashboard se **key rotate (naya)** karo aur Render env / Admin me naya daalo. Bot me bhi key env variable se lo.
2. **User passwords Firebase me plain text me store hain** aur login browser me compare hota hai (Admin panel me bhi dikhte hain). Ye bada risk hai. Iska poora fix = Firebase Authentication par shift karna – isse users/balances ka structure badalna padega, isliye maine bina poochhe nahi kiya. Aage ka kaam batao to kar dunga.
3. User ka wallet balance Firebase rules ke hisaab se abhi bhi browser se likha ja sakta hai (kyunki users Firebase Auth use nahi karte). Payment credit ab secure hai, par ye rule-level risk upar wale point 2 ke fix ke saath hi band hoga.
4. Supplier API keys (`suppliers` node) bhi abhi browser me aati hain (purane design ki wajah se). Sirf payment gateways ko maine server-side secure kiya hai.

## Payment kaise kaam karta hai (short)
1. User amount dalta hai → browser `POST /api/pay/create` → server limits check karta hai, gateway ko call karta hai, order Firebase me `pending` save karta hai.
2. User ko Order ID + status + QR / "Open Payment Page" dikhta hai.
3. Server gateway se **khud verify** karta hai (order id + amount match). Tabhi `ETag` atomic transaction se wallet me ek baar paisa jaata hai. Browser ka "success" kuch nahi maana jaata.
4. User page band kar de tab bhi server har 20 sec pending orders check karke credit kar deta hai (1 ghante tak).
5. Amount mismatch ho to credit nahi hota, order "review" me jata hai (Admin → Payments tab me ⚠ dikhta hai).
6. Agar kabhi order `crediting` me atka dikhe (server crash jaisi rare halat) to wo double-credit se bachane ke liye jaan-boojh kar manual review ke liye rukta hai.

## Local test chalana (optional)
`npm test` (Node 18+ aur openssl chahiye). Browser tests ke liye Playwright: `node test/ui.js`, `node test/admin-ui.js`.

---

# 📢 Telegram Channel Alerts (v2.1) — Setup Guide

Deposit, key sale, naya reseller, referral aur signup ke premium alerts Telegram channel me automatic jate hain. **Sab kuch Admin Panel se set hota hai** (token, channel ID, channel link, website link, footer, buttons).

## Setup (5 minute)
1. Telegram me **@BotFather** → `/newbot` → **Bot token** copy karo.
2. Apna **Channel** banao → Settings → Administrators → **Bot ko Admin banao** (Post Messages ON).
3. Admin Panel → **Alerts & Channel** kholo:
   - **Bot token** paste karo
   - **Channel ID**: public channel ho to `@channelusername`, private ho to `-100xxxxxxxxxx`
   - **Channel link**: `https://t.me/yourchannel` (user panel me "Join Channel" button + alert ke neeche button)
   - **Website link**: `https://yourshop.com` (har alert ke neeche **🛒 Buy on My Website** button)
4. **Save settings** → **Test connection** → channel me sample alert aayega → **Alerts ON** karke Save.

## Firebase rules (zaroori)
`firebase-rules-addendum.json` ke naye nodes (`notify_secrets`, `notify_config`, `notify_state`, `notify_sent`, `notify_logs`) apne rules me add karo (read/write `false`). Bot token isi liye safe rehta hai.

## Kya-kya alert jata hai
| Event | Kab |
|---|---|
| 💰 Deposit | Payment verify hoke wallet credit hone par (bonus ke saath) |
| 🔑 Key sold | Key bikne par — **key hamesha hidden** (spoiler ●●●●) |
| 👑 New reseller | Upgrade / free referral reward / admin promote |
| 🤝 Referral + 🎁 Commission | Referral se member judne par / commission milne par |
| 🆕 Signup | Naya account |
Har alert me premium footer + **Buy on My Website** aur **Join Our Channel** buttons.

## Notes
- Pehli baar server start hone par purane orders ke alert nahi jate (sirf naye).
- Alert fail ho jaye (Telegram down) to payment/credit par koi asar nahi padta; Admin → Delivery log me error dikhta hai.
- Username default me masked (`ra*****r`) hota hai; Admin se Full/Hidden kar sakte ho.
