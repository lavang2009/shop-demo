# SePay Auto Topup - Vercel corrected build

This build keeps the Express app for local development and exposes it as a Vercel Node Function through `api/[...path].js`.

## Local
npm install
npm start

Open http://localhost:3000

## Vercel
Deploy the project root (the folder containing `api`, `server`, `public`, `package.json`, `vercel.json`).

Webhook URL:
https://YOUR-DOMAIN.vercel.app/api/webhook/sepay

For real money, configure Firebase Firestore service-account environment variables on Vercel. Do not rely on local JSON persistence in Vercel.
