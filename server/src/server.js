import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLocalDb, getDoc, setDoc, createDeposit, processSePayPayload, verifySePaySignature, health } from './core.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// Chỉ khởi tạo db.json khi chạy local; trên Vercel dữ liệu dùng Firestore.
await ensureLocalDb();
const app = express();
app.use(express.static(path.join(ROOT, 'public')));

// SePay: giữ raw body để HMAC xác thực chính xác.
app.post('/webhook/sepay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    const check = verifySePaySignature(raw, req.headers);
    if (!check.ok) return res.status(401).json({ success: false, message: check.message || 'Invalid signature' });
    const result = await processSePayPayload(JSON.parse(raw || '{}'));
    return res.status(result.status || (result.success ? 200 : 400)).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: error.message || 'Webhook error' });
  }
});

app.use(express.json({ limit: '1mb' }));

app.post('/api/demo/login', async (req, res) => {
  try {
    const userId = String(req.body?.userId || 'demo-user');
    const user = await getDoc('users', userId) || { userId, name: 'Demo User', balance: 0 };
    await setDoc('users', userId, user);
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message || 'Server error' });
  }
});

app.get('/api/balance/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const user = await getDoc('users', userId) || { userId, balance: 0 };
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message || 'Server error' });
  }
});

app.post('/api/deposits', async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const amount = Number(req.body?.amount);
    if (!userId) return res.status(400).json({ message: 'Thiếu userId' });
    if (!Number.isInteger(amount) || amount < 10000 || amount > 50000000) {
      return res.status(400).json({ message: 'Số tiền phải từ 10.000đ đến 50.000.000đ' });
    }
    res.json(await createDeposit(userId, amount));
  } catch (error) {
    const code = error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500;
    res.status(code).json({ message: error.message || 'Server error', code: error.code });
  }
});

app.get('/api/deposits/:id', async (req, res) => {
  try {
    const deposit = await getDoc('deposits', String(req.params.id));
    if (!deposit) return res.status(404).json({ message: 'Không tìm thấy đơn' });
    res.json(deposit);
  } catch (error) {
    res.status(500).json({ message: error.message || 'Server error' });
  }
});

app.post('/api/test/sepay', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') return res.status(404).end();
    const deposit = await getDoc('deposits', String(req.body?.depositId || ''));
    if (!deposit) return res.status(404).json({ message: 'Deposit not found' });
    const fake = {
      id: `TEST_${Date.now()}`,
      transferType: 'in',
      transferAmount: deposit.amount,
      content: deposit.paymentCode,
      referenceCode: `TESTREF_${Date.now()}`
    };
    const result = await processSePayPayload(fake);
    res.json({ ...result, fake });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Server error' });
  }
});

app.get('/api/health', (req, res) => res.json(health()));
app.use((req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

const port = Number(process.env.PORT || 3000);
if (process.env.VERCEL !== '1') app.listen(port, () => console.log(`Server running at http://localhost:${port}`));

export { app };
