# SePay Auto Topup Demo

Bộ mẫu Node.js + Express có thể chạy local và deploy Vercel. Không chứa khóa SePay/Firebase thật.

## 1) Cài và chạy

Yêu cầu Node.js 18+.

```bash
npm install
cp .env.example .env
npm start
```

Mở `http://localhost:3000`.

Chọn số tiền → Tạo QR → nút **Test webhook** mô phỏng giao dịch và cộng số dư.

## 2) Chạy với Firestore

Điền vào `.env`:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

Nếu để trống, app dùng `data/db.json` khi chạy local. Trên Vercel, filesystem không phải nơi lưu trữ bền vững, vì vậy production phải dùng Firestore.

## 3) Deploy Vercel và dùng SePay thật

1. Liên kết tài khoản ngân hàng với SePay.
2. Deploy project lên Vercel.
3. Đặt các biến môi trường Firebase + SePay + ngân hàng trên Vercel.
4. Trong SePay Dashboard → Integrations → Webhooks → Add webhook.
5. URL: `https://YOUR_DOMAIN/api/webhook/sepay`
5. Event: tiền vào; Content-Type: JSON.
6. Chọn **HMAC-SHA256** và copy Secret Key vào `SEPAY_WEBHOOK_SECRET`.
7. Điền `BANK_ACCOUNT`, `BANK_CODE`, `BANK_NAME` trong `.env`.
8. Tắt/không sử dụng endpoint test `/api/test/sepay` trong production; có thể bảo vệ hoặc xóa route này trước khi deploy.

### HMAC

Webhook route dùng raw JSON body và kiểm tra `X-SePay-Signature` + `X-SePay-Timestamp` theo công thức SePay hiện tại. Không đặt secret ở frontend.

### Idempotency

Giao dịch SePay được khóa bằng `payload.id` trong `processedTransactions` để tránh cộng tiền lặp lại.

## 4) Production checklist

- HTTPS bắt buộc cho webhook production.
- Dùng HMAC-SHA256.
- Dùng Firestore transaction/batch hoặc cơ chế idempotency mạnh hơn nếu lượng giao dịch cao.
- Không cho client sửa `balance`.
- Giới hạn quyền Firestore và dùng Firebase Admin SDK từ backend.
- Log webhook và kiểm tra các trường hợp số tiền/mã thanh toán không khớp.
- Xóa endpoint test trước khi công khai.
