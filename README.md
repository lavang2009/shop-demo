# SePay Auto Topup - Vercel + Express + Firebase

## Local
npm install
copy .env.example .env
npm start

Open http://localhost:3000

Local mode uses data/db.json when Firebase variables are empty.

## Vercel
Vercel exposes real Functions:
- /api/health
- /api/demo/login
- /api/balance/:userId
- /api/deposits
- /api/deposits/:id
- /api/webhook/sepay
- /api/test/sepay

On Vercel, configure Firebase Firestore in Environment Variables. Local JSON is intentionally disabled on Vercel.

SePay webhook URL:
https://YOUR-DOMAIN.vercel.app/api/webhook/sepay

Use HTTPS, JSON, transaction type = Money In. HMAC-SHA256 is supported via SEPAY_WEBHOOK_SECRET.
