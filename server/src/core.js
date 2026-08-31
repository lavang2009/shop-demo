import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const IS_VERCEL = process.env.VERCEL === '1';

let firestore = null;

function initFirestore() {
  if (firestore) return firestore;
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();
  if (!projectId || !clientEmail || !privateKey) return null;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n')
      })
    });
  }
  firestore = admin.firestore();
  return firestore;
}

export function getFirestore() {
  return initFirestore();
}

export async function ensureLocalDb() {
  if (IS_VERCEL) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, JSON.stringify({ users: {}, deposits: {}, processedTransactions: {}, transactions: {} }, null, 2));
  }
}

async function readLocalDb() {
  await ensureLocalDb();
  try {
    return JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch {
    return { users: {}, deposits: {}, processedTransactions: {}, transactions: {} };
  }
}

async function writeLocalDb(db) {
  if (IS_VERCEL) throw new Error('Local JSON storage is disabled on Vercel. Configure Firebase Firestore.');
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function assertStorage() {
  if (IS_VERCEL && !initFirestore()) {
    const err = new Error('Firebase Firestore is not configured on Vercel.');
    err.code = 'FIREBASE_NOT_CONFIGURED';
    throw err;
  }
}

export async function getDoc(collection, id) {
  const db = initFirestore();
  if (db) {
    const snap = await db.collection(collection).doc(id).get();
    return snap.exists ? snap.data() : null;
  }
  const local = await readLocalDb();
  return local[collection]?.[id] ?? null;
}

export async function setDoc(collection, id, value) {
  const db = initFirestore();
  if (db) {
    await db.collection(collection).doc(id).set(value, { merge: true });
    return;
  }
  assertStorage();
  const local = await readLocalDb();
  local[collection] ??= {};
  local[collection][id] = { ...(local[collection][id] || {}), ...value };
  await writeLocalDb(local);
}

export async function findDepositByPaymentCode(paymentCode) {
  const db = initFirestore();
  if (db) {
    const qs = await db.collection('deposits').where('paymentCode', '==', paymentCode).limit(1).get();
    if (qs.empty) return null;
    return { id: qs.docs[0].id, data: qs.docs[0].data() };
  }
  const local = await readLocalDb();
  for (const [id, value] of Object.entries(local.deposits || {})) {
    if (String(value.paymentCode).toUpperCase() === paymentCode) return { id, data: value };
  }
  return null;
}

export async function createDeposit(userId, amount) {
  const db = initFirestore();
  const depositId = uuidv4();
  const paymentCode = `NAP_${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const deposit = {
    id: depositId,
    userId,
    amount,
    paymentCode,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  if (db) await db.collection('deposits').doc(depositId).set(deposit);
  else {
    assertStorage();
    const local = await readLocalDb();
    local.deposits[depositId] = deposit;
    await writeLocalDb(local);
  }

  const acc = process.env.BANK_ACCOUNT || '';
  const bank = process.env.BANK_CODE || '';
  if (!acc || !bank) {
    const err = new Error('BANK_ACCOUNT/BANK_CODE chưa được cấu hình.');
    err.code = 'BANK_NOT_CONFIGURED';
    throw err;
  }

  const qrTarget = `https://vietqr.app/img?acc=${encodeURIComponent(acc)}&bank=${encodeURIComponent(bank)}&amount=${amount}&des=${encodeURIComponent(paymentCode)}`;
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(qrTarget, { width: 360, margin: 2 });
  } catch (error) {
    console.error('QR generation failed:', error);
  }

  return { ...deposit, qrUrl: qrTarget, qrDataUrl, bankName: process.env.BANK_NAME || '' };
}

export async function processSePayPayload(payload) {
  const transferType = String(payload?.transferType || '').toLowerCase();
  if (transferType !== 'in') return { success: true, ignored: true };

  const externalId = String(payload.id ?? payload.referenceCode ?? '').trim();
  if (!externalId) return { success: false, status: 400, message: 'Missing transaction id' };

  const content = String(payload.content || '');
  const match = content.match(/(NAP_[A-Z0-9-]{6,})/i);
  if (!match) return { success: true, ignored: true };
  const paymentCode = match[1].toUpperCase();

  const db = initFirestore();
  if (db) {
    const txRef = db.collection('processedTransactions').doc(externalId);
    const txSnap = await txRef.get();
    if (txSnap.exists) return { success: true, duplicate: true };
  } else {
    assertStorage();
    const local = await readLocalDb();
    if (local.processedTransactions?.[externalId]) return { success: true, duplicate: true };
  }

  const found = await findDepositByPaymentCode(paymentCode);
  if (!found) return { success: true, ignored: true };
  const { id: depositId, data: deposit } = found;
  const amount = Number(payload.transferAmount || 0);
  if (amount !== Number(deposit.amount)) {
    return { success: false, status: 422, message: 'Amount mismatch' };
  }

  const now = new Date().toISOString();

  if (db) {
    const depositRef = db.collection('deposits').doc(depositId);
    const userRef = db.collection('users').doc(String(deposit.userId));
    const txRef = db.collection('processedTransactions').doc(externalId);
    const transactionRef = db.collection('transactions').doc(externalId);

    await db.runTransaction(async (tx) => {
      const [txSnap, depositSnap, userSnap] = await Promise.all([
        tx.get(txRef),
        tx.get(depositRef),
        tx.get(userRef)
      ]);
      if (txSnap.exists) return;
      if (!depositSnap.exists) throw new Error('Deposit not found');
      const currentDeposit = depositSnap.data();
      if (currentDeposit.status === 'paid') {
        tx.set(txRef, { transactionId: externalId, depositId, processedAt: now });
        return;
      }

      const currentUser = userSnap.exists ? userSnap.data() : { userId: String(deposit.userId), name: 'User', balance: 0 };
      const newBalance = Number(currentUser.balance || 0) + amount;

      tx.set(userRef, { ...currentUser, userId: String(deposit.userId), balance: newBalance, updatedAt: now }, { merge: true });
      tx.set(depositRef, { ...currentDeposit, status: 'paid', paidAt: now, transactionId: externalId, referenceCode: payload.referenceCode || null }, { merge: true });
      tx.create(txRef, { transactionId: externalId, depositId, processedAt: now });
      tx.set(transactionRef, { userId: String(deposit.userId), type: 'deposit', amount, status: 'completed', paymentCode, referenceCode: payload.referenceCode || null, createdAt: now }, { merge: true });
    });
  } else {
    const local = await readLocalDb();
    if (local.processedTransactions?.[externalId]) return { success: true, duplicate: true };
    const user = local.users?.[deposit.userId] || { userId: deposit.userId, name: 'User', balance: 0 };
    const currentDeposit = local.deposits?.[depositId];
    if (!currentDeposit || currentDeposit.status === 'paid') return { success: true, duplicate: true };
    local.users[deposit.userId] = { ...user, balance: Number(user.balance || 0) + amount, updatedAt: now };
    local.deposits[depositId] = { ...currentDeposit, status: 'paid', paidAt: now, transactionId: externalId, referenceCode: payload.referenceCode || null };
    local.processedTransactions[externalId] = { transactionId: externalId, depositId, processedAt: now };
    local.transactions ??= {};
    local.transactions[externalId] = { userId: deposit.userId, type: 'deposit', amount, status: 'completed', paymentCode, referenceCode: payload.referenceCode || null, createdAt: now };
    await writeLocalDb(local);
  }

  return { success: true, credited: amount, paymentCode, depositId, transactionId: externalId };
}

export function verifySePaySignature(rawBody, headers) {
  const secret = process.env.SEPAY_WEBHOOK_SECRET?.trim();
  if (!secret) return { ok: true, skipped: true };
  const sig = String(headers['x-sepay-signature'] || headers['X-SePay-Signature'] || '');
  const ts = String(headers['x-sepay-timestamp'] || headers['X-SePay-Timestamp'] || '');
  if (!sig || !ts) return { ok: false, message: 'Missing webhook signature headers' };
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return { ok: a.length === b.length && crypto.timingSafeEqual(a, b) };
}

export function health() {
  return {
    ok: true,
    storage: initFirestore() ? 'firestore' : (IS_VERCEL ? 'not-configured' : 'local-json'),
    sepaySecretConfigured: Boolean(process.env.SEPAY_WEBHOOK_SECRET?.trim()),
    vercel: IS_VERCEL
  };
}
