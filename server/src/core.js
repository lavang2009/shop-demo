import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import admin from 'firebase-admin';

const __dirname = path.dirname(
  fileURLToPath(import.meta.url)
);

const ROOT = path.resolve(
  __dirname,
  '../..'
);

const DATA_DIR = path.join(
  ROOT,
  'data'
);

const DB_FILE = path.join(
  DATA_DIR,
  'db.json'
);

const IS_VERCEL =
  process.env.VERCEL === '1';

let firestore = null;

// ======================================================
// FIREBASE
// ======================================================

function initFirestore() {
  if (firestore) {
    return firestore;
  }

  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim();

  const clientEmail =
    process.env.FIREBASE_CLIENT_EMAIL?.trim();

  const privateKey =
    process.env.FIREBASE_PRIVATE_KEY?.trim();

  // Chưa cấu hình Firebase
  if (
    !projectId ||
    !clientEmail ||
    !privateKey
  ) {
    return null;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(
          /\\n/g,
          '\n'
        )
      })
    });
  }

  firestore = admin.firestore();

  return firestore;
}

export function getFirestore() {
  return initFirestore();
}

// ======================================================
// LOCAL DB
// ======================================================

export async function ensureLocalDb() {
  // Vercel không dùng db.json
  if (IS_VERCEL) {
    return;
  }

  await fs.mkdir(
    DATA_DIR,
    { recursive: true }
  );

  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(
      DB_FILE,
      JSON.stringify(
        {
          users: {},
          deposits: {},
          processedTransactions: {},
          transactions: {}
        },
        null,
        2
      )
    );
  }
}

async function readLocalDb() {
  await ensureLocalDb();

  try {
    return JSON.parse(
      await fs.readFile(
        DB_FILE,
        'utf8'
      )
    );
  } catch {
    return {
      users: {},
      deposits: {},
      processedTransactions: {},
      transactions: {}
    };
  }
}

async function writeLocalDb(db) {
  if (IS_VERCEL) {
    const error = new Error(
      'Local JSON storage is disabled on Vercel. Configure Firebase Firestore.'
    );

    error.code =
      'FIREBASE_NOT_CONFIGURED';

    throw error;
  }

  await fs.writeFile(
    DB_FILE,
    JSON.stringify(
      db,
      null,
      2
    )
  );
}

function assertStorage() {
  if (
    IS_VERCEL &&
    !initFirestore()
  ) {
    const error = new Error(
      'Firebase Firestore is not configured on Vercel.'
    );

    error.code =
      'FIREBASE_NOT_CONFIGURED';

    throw error;
  }
}

// ======================================================
// GET DOCUMENT
// ======================================================

export async function getDoc(
  collection,
  id
) {
  const db = initFirestore();

  if (db) {
    const snapshot =
      await db
        .collection(collection)
        .doc(id)
        .get();

    return snapshot.exists
      ? snapshot.data()
      : null;
  }

  assertStorage();

  const local =
    await readLocalDb();

  return (
    local[collection]?.[id] ??
    null
  );
}

// ======================================================
// SET DOCUMENT
// ======================================================

export async function setDoc(
  collection,
  id,
  value
) {
  const db = initFirestore();

  if (db) {
    await db
      .collection(collection)
      .doc(id)
      .set(
        value,
        { merge: true }
      );

    return;
  }

  assertStorage();

  const local =
    await readLocalDb();

  local[collection] ??= {};

  local[collection][id] = {
    ...(local[collection][id] || {}),
    ...value
  };

  await writeLocalDb(local);
}

// ======================================================
// FIND DEPOSIT
// ======================================================

export async function findDepositByPaymentCode(
  paymentCode
) {
  const db = initFirestore();

  if (db) {
    const snapshot =
      await db
        .collection('deposits')
        .where(
          'paymentCode',
          '==',
          paymentCode
        )
        .limit(1)
        .get();

    if (snapshot.empty) {
      return null;
    }

    return {
      id: snapshot.docs[0].id,
      data: snapshot.docs[0].data()
    };
  }

  assertStorage();

  const local =
    await readLocalDb();

  for (
    const [id, value]
    of Object.entries(
      local.deposits || {}
    )
  ) {
    if (
      String(
        value.paymentCode
      ).toUpperCase() ===
      paymentCode
    ) {
      return {
        id,
        data: value
      };
    }
  }

  return null;
}

// ======================================================
// CREATE DEPOSIT + VIETQR
// ======================================================

export async function createDeposit(
  userId,
  amount
) {
  const db = initFirestore();

  const acc =
    process.env.BANK_ACCOUNT?.trim();

  const bank =
    process.env.BANK_CODE?.trim();

  const bankName =
    process.env.BANK_NAME?.trim() ||
    '';

  if (!acc || !bank) {
    const error = new Error(
      'BANK_ACCOUNT/BANK_CODE chưa được cấu hình.'
    );

    error.code =
      'BANK_NOT_CONFIGURED';

    throw error;
  }

  // Tạo mã thanh toán riêng
  const paymentCode =
    `NAP_${crypto
      .randomBytes(5)
      .toString('hex')
      .toUpperCase()}`;

  const depositId =
    uuidv4();

  const deposit = {
    id: depositId,
    userId,
    amount,
    paymentCode,
    status: 'pending',
    createdAt:
      new Date().toISOString()
  };

  // Lưu đơn
  if (db) {
    await db
      .collection('deposits')
      .doc(depositId)
      .set(deposit);
  } else {
    assertStorage();

    const local =
      await readLocalDb();

    local.deposits[depositId] =
      deposit;

    await writeLocalDb(local);
  }

  // ====================================================
  // QUAN TRỌNG:
  // Tạo URL VietQR trực tiếp.
  // Không dùng QRCode.toDataURL(qrUrl)
  // để tránh tạo "QR chứa URL".
  // ====================================================

  const qrUrl =
    'https://vietqr.app/img?' +
    'acc=' +
    encodeURIComponent(acc) +
    '&bank=' +
    encodeURIComponent(bank) +
    '&amount=' +
    encodeURIComponent(amount) +
    '&des=' +
    encodeURIComponent(paymentCode);

  return {
    ...deposit,

    // URL ảnh QR trực tiếp
    qrUrl,

    // Giữ cả 2 tên để frontend cũ vẫn tương thích
    qrDataUrl: qrUrl,
    qrImageUrl: qrUrl,

    bankName
  };
}

// ======================================================
// PROCESS SEPAY PAYMENT
// ======================================================

export async function processSePayPayload(
  payload
) {
  const transferType =
    String(
      payload?.transferType || ''
    ).toLowerCase();

  // Chỉ xử lý tiền vào
  if (
    transferType !== 'in'
  ) {
    return {
      success: true,
      ignored: true
    };
  }

  const externalId =
    String(
      payload.id ??
      payload.referenceCode ??
      ''
    ).trim();

  if (!externalId) {
    return {
      success: false,
      status: 400,
      message:
        'Missing transaction id'
    };
  }

  // ====================================================
  // LẤY PAYMENT CODE
  // ====================================================

  const content =
    String(
      payload.content || ''
    );

  const match =
    content.match(
      /(NAP_[A-Z0-9-]{6,})/i
    );

  if (!match) {
    return {
      success: true,
      ignored: true
    };
  }

  const paymentCode =
    match[1].toUpperCase();

  const db =
    initFirestore();

  // ====================================================
  // FIRESTORE
  // ====================================================

  if (db) {
    const txRef =
      db
        .collection(
          'processedTransactions'
        )
        .doc(externalId);

    const txSnap =
      await txRef.get();

    if (txSnap.exists) {
      return {
        success: true,
        duplicate: true
      };
    }
  } else {
    assertStorage();

    const local =
      await readLocalDb();

    if (
      local.processedTransactions?.[
        externalId
      ]
    ) {
      return {
        success: true,
        duplicate: true
      };
    }
  }

  // ====================================================
  // TÌM ĐƠN NẠP
  // ====================================================

  const found =
    await findDepositByPaymentCode(
      paymentCode
    );

  if (!found) {
    return {
      success: true,
      ignored: true
    };
  }

  const {
    id: depositId,
    data: deposit
  } = found;

  // ====================================================
  // KIỂM TRA SỐ TIỀN
  // ====================================================

  const amount =
    Number(
      payload.transferAmount || 0
    );

  if (
    amount !==
    Number(deposit.amount)
  ) {
    return {
      success: false,
      status: 422,
      message:
        'Amount mismatch'
    };
  }

  const now =
    new Date().toISOString();

  // ====================================================
  // FIRESTORE TRANSACTION
  // ====================================================

  if (db) {
    const depositRef =
      db
        .collection('deposits')
        .doc(depositId);

    const userRef =
      db
        .collection('users')
        .doc(
          String(
            deposit.userId
          )
        );

    const txRef =
      db
        .collection(
          'processedTransactions'
        )
        .doc(externalId);

    const transactionRef =
      db
        .collection('transactions')
        .doc(externalId);

    await db.runTransaction(
      async (transaction) => {
        const txSnap =
          await transaction.get(
            txRef
          );

        if (txSnap.exists) {
          return;
        }

        const depositSnap =
          await transaction.get(
            depositRef
          );

        const userSnap =
          await transaction.get(
            userRef
          );

        if (!depositSnap.exists) {
          throw new Error(
            'Deposit not found'
          );
        }

        const currentDeposit =
          depositSnap.data();

        // Đã thanh toán rồi
        if (
          currentDeposit.status ===
          'paid'
        ) {
          transaction.set(
            txRef,
            {
              transactionId:
                externalId,
              depositId,
              processedAt: now
            }
          );

          return;
        }

        const currentUser =
          userSnap.exists
            ? userSnap.data()
            : {
                userId:
                  String(
                    deposit.userId
                  ),
                name: 'User',
                balance: 0
              };

        const newBalance =
          Number(
            currentUser.balance || 0
          ) + amount;

        // Cộng số dư
        transaction.set(
          userRef,
          {
            ...currentUser,
            userId:
              String(
                deposit.userId
              ),
            balance:
              newBalance,
            updatedAt: now
          },
          {
            merge: true
          }
        );

        // Đánh dấu đơn đã trả
        transaction.set(
          depositRef,
          {
            ...currentDeposit,
            status: 'paid',
            paidAt: now,
            transactionId:
              externalId,
            referenceCode:
              payload.referenceCode ||
              null
          },
          {
            merge: true
          }
        );

        // Đánh dấu giao dịch đã xử lý
        transaction.create(
          txRef,
          {
            transactionId:
              externalId,
            depositId,
            processedAt: now
          }
        );

        // Lịch sử giao dịch
        transaction.set(
          transactionRef,
          {
            userId:
              String(
                deposit.userId
              ),
            type: 'deposit',
            amount,
            status:
              'completed',
            paymentCode,
            referenceCode:
              payload.referenceCode ||
              null,
            createdAt: now
          },
          {
            merge: true
          }
        );
      }
    );
  }

  // ====================================================
  // LOCAL DB
  // ====================================================

  else {
    const local =
      await readLocalDb();

    local.users ??= {};
    local.deposits ??= {};
    local.processedTransactions ??= {};
    local.transactions ??= {};

    if (
      local.processedTransactions[
        externalId
      ]
    ) {
      return {
        success: true,
        duplicate: true
      };
    }

    const currentDeposit =
      local.deposits[
        depositId
      ];

    if (
      !currentDeposit
    ) {
      return {
        success: true,
        ignored: true
      };
    }

    if (
      currentDeposit.status ===
      'paid'
    ) {
      return {
        success: true,
        duplicate: true
      };
    }

    const user =
      local.users[
        deposit.userId
      ] || {
        userId:
          deposit.userId,
        name: 'User',
        balance: 0
      };

    local.users[
      deposit.userId
    ] = {
      ...user,
      balance:
        Number(
          user.balance || 0
        ) + amount,
      updatedAt: now
    };

    local.deposits[
      depositId
    ] = {
      ...currentDeposit,
      status: 'paid',
      paidAt: now,
      transactionId:
        externalId,
      referenceCode:
        payload.referenceCode ||
        null
    };

    local.processedTransactions[
      externalId
    ] = {
      transactionId:
        externalId,
      depositId,
      processedAt: now
    };

    local.transactions[
      externalId
    ] = {
      userId:
        deposit.userId,
      type: 'deposit',
      amount,
      status:
        'completed',
      paymentCode,
      referenceCode:
        payload.referenceCode ||
        null,
      createdAt: now
    };

    await writeLocalDb(local);
  }

  return {
    success: true,
    credited: amount,
    paymentCode,
    depositId,
    transactionId:
      externalId
  };
}

// ======================================================
// SEPAY HMAC
// ======================================================

export function verifySePaySignature(
  rawBody,
  headers
) {
  const secret =
    process.env.SEPAY_WEBHOOK_SECRET?.trim();

  // Chưa có secret:
  // cho phép local test.
  if (!secret) {
    return {
      ok: true,
      skipped: true
    };
  }

  const sig =
    String(
      headers['x-sepay-signature'] ||
      headers['X-SePay-Signature'] ||
      ''
    );

  const ts =
    String(
      headers['x-sepay-timestamp'] ||
      headers['X-SePay-Timestamp'] ||
      ''
    );

  if (!sig || !ts) {
    return {
      ok: false,
      message:
        'Missing webhook signature headers'
    };
  }

  const expected =
    'sha256=' +
    crypto
      .createHmac(
        'sha256',
        secret
      )
      .update(
        `${ts}.${rawBody}`
      )
      .digest('hex');

  const a =
    Buffer.from(sig);

  const b =
    Buffer.from(expected);

  if (
    a.length !==
    b.length
  ) {
    return {
      ok: false,
      message:
        'Invalid signature'
    };
  }

  return {
    ok:
      crypto.timingSafeEqual(
        a,
        b
      ),
    message:
      crypto.timingSafeEqual(
        a,
        b
      )
        ? undefined
        : 'Invalid signature'
  };
}

// ======================================================
// HEALTH
// ======================================================

export function health() {
  const db =
    initFirestore();

  return {
    ok: true,

    storage:
      db
        ? 'firestore'
        : (
            IS_VERCEL
              ? 'not-configured'
              : 'local-json'
          ),

    sepaySecretConfigured:
      Boolean(
        process.env.SEPAY_WEBHOOK_SECRET?.trim()
      ),

    vercel:
      IS_VERCEL
  };
}
