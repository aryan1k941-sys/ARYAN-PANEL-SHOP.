# ADMIN SECURITY GUIDE (v3) — 5 step me poora lock

## Ye kya karta hai
| Feature | Kaam |
|---|---|
| **Single-device lock** | Admin ek device se login hai to doosra koi bhi (sahi password ke saath bhi) login nahi kar sakta. Server mana kar deta hai. |
| **Device list** | Admin > **Security Center**: kaun sa device/browser/OS, IP, kab login, kab active. |
| **Kick / Logout all / PANIC** | Kisi bhi device ko turant bahar. PANIC = sab jagah se logout. |
| **Idle auto-logout** | 10–120 min inactive rehne par session khatam. |
| **Strict IP** (optional) | IP badalte hi session kill. |
| **Intruder auto-ban** | Koi non-admin (Google/Firebase se login karke bhi) Admin panel ya admin API chhuta to: **uska account Banned + Firebase login disable + IP 24h block + log**. Real admin kabhi ban nahi hota. |
| **Security log** | Har login, block, kick, password change, intruder — time + device + IP ke saath. |
| **Admin password change** | Security Center se. Badalte hi baaki devices logout. |
| **Login throttle** | 5 galat password = 5 min lock. Server par bhi rate-limit. |

## Setup (Render > Environment)
1. `ADMIN_EMAILS` = sirf aapka Gmail (already zaroori hai).
2. `ADMIN_RECOVERY_CODE` = 20+ character ka lamba random text (e.g. `k9X-...`). Ye sirf tab kaam aata hai jab aap khud lock ho jao (phone kho gaya / browser data clear). Kahin safe likh lo, kisi ko mat do.
3. Deploy karo. Pehli baar Admin.html se login karo — aapka device "THIS DEVICE" ban jayega.
4. **Firebase rules lock (bahut zaroori):**
   `node tools/make-rules.js aapka@gmail.com` → `firebase-rules-admin-lock.json` banta hai → Firebase Console > Realtime Database > Rules me un nodes ko **merge** karo. Isse site/product/payment/supplier settings sirf aapka Gmail likh sakta hai — chahe koi website ke andar se ya console se try kare.
5. Firebase Console > Authentication > Settings me "Create (sign-up)" band rakho agar sirf admin Firebase Auth use karta hai (user panel ke Google login ke liye alag se dekh lo).

## Agar aap khud lock ho gaye
Admin login page par "doosre device" wala message aayega aur **Recovery Code** ka box khulega. Code daalo → login → purana device automatic bahar.
Ya 20 min idle wait karo (default) — purana session apne aap expire ho jata hai.

## Honest limits (padh lena)
- **Firebase rules ke bina** koi expert direct database se likh sakta hai — server us write ko rok nahi sakta. Isliye step 4 skip mat karna.
- **User panel ka login abhi custom hai**: password check browser me hota hai aur `users` node browser se padha ja sakta hai. Ye purana design hai. Asli fix = users ko Firebase Authentication par move karna (bada kaam, alag se karna padega).
- `supplier_settings` ko user panel padhta hai (supplier API key leak ka risk). Ise server-side proxy par shift karna chahiye.
- Auto-ban sirf unpar lagta hai jo Firebase se login karke admin API chhuein. Database ko direct hit karne wale ko rules rokte hain, ban nahi.
