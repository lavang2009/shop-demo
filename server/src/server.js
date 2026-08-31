import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureLocalDb,
  getDoc,
  setDoc,
  createDeposit,
  processSePayPayload,
  verifySePaySignature,
  health
} from './core.js';

dotenv.config({
  path: path.resolve(process.cwd(), '.env')
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// Chỉ dùng db.json khi chạy local.
// Khi chạy Vercel, dữ liệu phải dùng Firestore.
await ensureLocalDb();

const app = express();

// Public frontend
app.use(express.static(path.join(ROOT, 'public')));

// ======================================================
// SEPAY WEBHOOK - LOCAL
// ======================================================

app.post(
  ['/webhook/sepay', '/api/webhook/sepay'],
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const raw = Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : String(req.body || '');

      // Kiểm tra chữ ký HMAC
      const check = verifySePaySignature(raw, req.headers || {});

      if (!check.ok) {
        return res.status(401).json({
          success: false,
          message: check.message || 'Invalid signature'
        });
      }

      let payload;

      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return res.status(400).json({
          success: false,
          message: 'Invalid JSON'
        });
      }

      const result = await processSePayPayload(payload);

      return res
        .status(result.status || (result.success ? 200 : 400))
        .json(result);

    } catch (error) {
      console.error('SePay webhook error:', error);

      return res.status(500).json({
        success: false,
        message: error.message || 'Webhook error'
      });
    }
  }
);

// ======================================================
// JSON API
// ======================================================

app.use(express.json({ limit: '1mb' }));

// ======================================================
// DEMO LOGIN
// ======================================================

app.post('/api/demo/login', async (req, res) => {
  try {
    const userId = String(
      req.body?.userId || 'demo-user'
    ).trim();

    const user =
      await getDoc('users', userId) ||
      {
        userId,
        name: 'Demo User',
        balance: 0
      };

    await setDoc('users', userId, user);

    return res.json(user);

  } catch (error) {
    console.error('Login error:', error);

    return res.status(
      error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500
    ).json({
      message: error.message || 'Server error',
      code: error.code
    });
  }
});

// ======================================================
// BALANCE
// ======================================================

app.get('/api/balance/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();

    if (!userId) {
      return res.status(400).json({
        message: 'Thiếu userId'
      });
    }

    const user =
      await getDoc('users', userId) ||
      {
        userId,
        balance: 0
      };

    return res.json(user);

  } catch (error) {
    console.error('Balance error:', error);

    return res.status(
      error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500
    ).json({
      message: error.message || 'Server error',
      code: error.code
    });
  }
});

// ======================================================
// CREATE DEPOSIT
// ======================================================

app.post('/api/deposits', async (req, res) => {
  try {
    const userId = String(
      req.body?.userId || ''
    ).trim();

    const amount = Number(req.body?.amount);

    if (!userId) {
      return res.status(400).json({
        message: 'Thiếu userId'
      });
    }

    if (
      !Number.isInteger(amount) ||
      amount < 10000 ||
      amount > 50000000
    ) {
      return res.status(400).json({
        message:
          'Số tiền phải từ 10.000đ đến 50.000.000đ'
      });
    }

    const deposit = await createDeposit(
      userId,
      amount
    );

    return res.json(deposit);

  } catch (error) {
    console.error('Create deposit error:', error);

    return res.status(
      error.code === 'FIREBASE_NOT_CONFIGURED'
        ? 503
        : error.code === 'BANK_NOT_CONFIGURED'
          ? 500
          : 500
    ).json({
      message: error.message || 'Server error',
      code: error.code
    });
  }
});

// ======================================================
// GET DEPOSIT
// ======================================================

app.get('/api/deposits/:id', async (req, res) => {
  try {
    const id = String(
      req.params.id || ''
    ).trim();

    const deposit = await getDoc(
      'deposits',
      id
    );

    if (!deposit) {
      return res.status(404).json({
        message: 'Không tìm thấy đơn'
      });
    }

    return res.json(deposit);

  } catch (error) {
    console.error('Deposit lookup error:', error);

    return res.status(
      error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500
    ).json({
      message: error.message || 'Server error',
      code: error.code
    });
  }
});

// ======================================================
// TEST SEPAY
// ======================================================

app.post('/api/test/sepay', async (req, res) => {
  try {
    // Chỉ cho phép khi chạy local/development
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).end();
    }

    const depositId = String(
      req.body?.depositId || ''
    ).trim();

    const deposit = await getDoc(
      'deposits',
      depositId
    );

    if (!deposit) {
      return res.status(404).json({
        message: 'Deposit not found'
      });
    }

    const fake = {
      id: `TEST_${Date.now()}`,
      transferType: 'in',
      transferAmount: deposit.amount,
      content: deposit.paymentCode,
      referenceCode: `TESTREF_${Date.now()}`
    };

    const result =
      await processSePayPayload(fake);

    return res.json({
      ...result,
      fake
    });

  } catch (error) {
    console.error('Test SePay error:', error);

    return res.status(
      error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500
    ).json({
      message: error.message || 'Server error',
      code: error.code
    });
  }
});

// ======================================================
// HEALTH
// ======================================================

app.get('/api/health', (req, res) => {
  return res.json(health());
});

// ======================================================
// FRONTEND FALLBACK
// ======================================================

app.use((req, res) => {
  return res.sendFile(
    path.join(ROOT, 'public', 'index.html')
  );
});

// ======================================================
// LOCAL SERVER
// ======================================================

const port = Number(
  process.env.PORT || 3000
);

if (process.env.VERCEL !== '1') {
  app.listen(port, () => {
    console.log(
      `Server running at http://localhost:${port}`
    );
  });
}

export { app };
