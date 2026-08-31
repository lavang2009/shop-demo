import express from 'express';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import admin from 'firebase-admin';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
await fs.mkdir(DATA_DIR, { recursive: true });

let firestore = null;
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    }) });
  }
  firestore = admin.firestore();
}

async function readDb() {
  try { return JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
  catch { return { users: {}, deposits: {}, processedTransactions: {} }; }
}
async function writeDb(db) { await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2)); }
async function save(collection, id, value) {
  if (firestore) await firestore.collection(collection).doc(id).set(value, { merge: true });
  else { const db = await readDb(); db[collection][id] = value; await writeDb(db); }
}
async function get(collection, id) {
  if (firestore) { const d = await firestore.collection(collection).doc(id).get(); return d.exists ? d.data() : null; }
  const db = await readDb(); return db[collection][id] || null;
}

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
// Keep raw body for HMAC verification on the SePay webhook.
app.post(['/webhook/sepay', '/api/webhook/sepay'], express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const secret = process.env.SEPAY_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.get('X-SePay-Signature') || '';
      const ts = req.get('X-SePay-Timestamp') || '';
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody.toString('utf8')}`).digest('hex');
      if (!sig || !ts || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.status(401).json({ success: false, message: 'Invalid signature' });
    }
    const payload = JSON.parse(rawBody.toString('utf8'));
    if (payload.transferType !== 'in') return res.json({ success: true, ignored: true });

    const externalId = String(payload.id ?? payload.referenceCode ?? '');
    if (!externalId) return res.status(400).json({ success: false, message: 'Missing transaction id' });

    if (firestore) {
      const txRef = firestore.collection('processedTransactions').doc(externalId);
      const txDoc = await txRef.get();
      if (txDoc.exists) return res.json({ success: true, duplicate: true });
    } else {
      const db = await readDb();
      if (db.processedTransactions[externalId]) return res.json({ success: true, duplicate: true });
    }

    const content = String(payload.content || '');
    const match = content.match(/(NAP_[A-Z0-9-]{6,})/i);
    if (!match) return res.json({ success: true, ignored: true });
    const paymentCode = match[1].toUpperCase();

    const dbDeposit = firestore ? null : await readDb();
    let deposit = null;
    let depositId = null;
    if (firestore) {
      const qs = await firestore.collection('deposits').where('paymentCode', '==', paymentCode).limit(1).get();
      if (!qs.empty) { depositId = qs.docs[0].id; deposit = qs.docs[0].data(); }
    } else {
      for (const [id, d] of Object.entries(dbDeposit.deposits)) if (d.paymentCode === paymentCode) { depositId = id; deposit = d; break; }
    }
    if (!deposit) return res.json({ success: true, ignored: true });
    if (deposit.status === 'paid') return res.json({ success: true, duplicate: true });
    const amount = Number(payload.transferAmount || 0);
    if (amount !== Number(deposit.amount)) return res.status(422).json({ success: false, message: 'Amount mismatch' });

    const user = await get('users', deposit.userId) || { balance: 0 };
    const newBalance = Number(user.balance || 0) + amount;
    await save('users', deposit.userId, { ...user, balance: newBalance, updatedAt: new Date().toISOString() });
    await save('deposits', depositId, { ...deposit, status: 'paid', paidAt: new Date().toISOString(), transactionId: externalId, referenceCode: payload.referenceCode || null });
    await save('processedTransactions', externalId, { transactionId: externalId, depositId, processedAt: new Date().toISOString() });
    await save('transactions', externalId, { userId: deposit.userId, type: 'deposit', amount, status: 'completed', paymentCode, referenceCode: payload.referenceCode || null, createdAt: new Date().toISOString() });
    return res.json({ success: true, credited: amount });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, message: 'Webhook error' });
  }
});

app.use(express.json({ limit: '1mb' }));

app.post('/api/demo/login', async (req, res) => {
  const userId = String(req.body.userId || 'demo-user');
  const user = await get('users', userId) || { userId, name: 'Demo User', balance: 0 };
  await save('users', userId, user);
  res.json(user);
});

app.get('/api/balance/:userId', async (req, res) => {
  const user = await get('users', req.params.userId) || { userId: req.params.userId, balance: 0 };
  res.json(user);
});

app.post('/api/deposits', async (req, res) => {
  const userId = String(req.body.userId || '').trim();
  const amount = Number(req.body.amount);
  if (!userId) return res.status(400).json({ message: 'Thiếu userId' });
  if (!Number.isInteger(amount) || amount < 10000 || amount > 50000000) return res.status(400).json({ message: 'Số tiền phải từ 10.000đ đến 50.000.000đ' });
  const paymentCode = `NAP_${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const depositId = uuidv4();
  const deposit = { id: depositId, userId, amount, paymentCode, status: 'pending', createdAt: new Date().toISOString() };
  await save('deposits', depositId, deposit);
  const acc = process.env.BANK_ACCOUNT || 'YOUR_ACCOUNT_NUMBER';
  const bank = process.env.BANK_CODE || 'VCB';
  const qrUrl = `https://vietqr.app/img?acc=${encodeURIComponent(acc)}&bank=${encodeURIComponent(bank)}&amount=${amount}&des=${encodeURIComponent(paymentCode)}`;
  let qrDataUrl = null;
  try { qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 360, margin: 2 }); } catch {}
  res.json({ ...deposit, qrUrl, qrDataUrl, bankName: process.env.BANK_NAME || '' });
});

app.get('/api/deposits/:id', async (req, res) => {
  const d = await get('deposits', req.params.id);
  if (!d) return res.status(404).json({ message: 'Không tìm thấy đơn' });
  res.json(d);
});

app.post('/api/test/sepay', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).end();
  const deposit = await get('deposits', req.body.depositId);
  if (!deposit) return res.status(404).json({ message: 'Deposit not found' });
  const fake = { id: `TEST_${Date.now()}`, gateway: 'TEST_BANK', transactionDate: new Date().toISOString(), accountNumber: process.env.BANK_ACCOUNT || 'TEST', code: deposit.paymentCode, content: deposit.paymentCode, transferType: 'in', transferAmount: deposit.amount, referenceCode: `TESTREF_${Date.now()}` };
  const raw = Buffer.from(JSON.stringify(fake));
  const headers = {};
  if (process.env.SEPAY_WEBHOOK_SECRET) {
    const ts = Math.floor(Date.now()/1000).toString();
    headers.timestamp = ts;
    headers.signature = 'sha256=' + crypto.createHmac('sha256', process.env.SEPAY_WEBHOOK_SECRET).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
  }
  // Directly invoke the same business path through HTTP is intentionally omitted; this endpoint is only a local helper.
  const user = await get('users', deposit.userId) || { userId: deposit.userId, balance: 0 };
  const newBalance = Number(user.balance || 0) + deposit.amount;
  await save('users', deposit.userId, { ...user, balance: newBalance, updatedAt: new Date().toISOString() });
  await save('deposits', deposit.id, { ...deposit, status: 'paid', paidAt: new Date().toISOString(), transactionId: fake.id, referenceCode: fake.referenceCode });
  await save('processedTransactions', fake.id, { transactionId: fake.id, depositId: deposit.id, processedAt: new Date().toISOString() });
  await save('transactions', fake.id, { userId: deposit.userId, type: 'deposit', amount: deposit.amount, status: 'completed', paymentCode: deposit.paymentCode, referenceCode: fake.referenceCode, createdAt: new Date().toISOString() });
  res.json({ success: true, fake });
});

app.get('/api/health', (req, res) => res.json({ ok: true, storage: firestore ? 'firestore' : 'local-json', sepaySecretConfigured: Boolean(process.env.SEPAY_WEBHOOK_SECRET) }));
app.use((req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
const port = Number(process.env.PORT || 3000);
export { app };

if (process.env.VERCEL !== '1') {
  app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}
