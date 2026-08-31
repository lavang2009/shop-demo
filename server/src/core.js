import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/* ======================================================
   FIREBASE
====================================================== */

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


/* ======================================================
   LOCAL JSON DATABASE
====================================================== */

export async function ensureLocalDb() {
  if (IS_VERCEL) {
    return;
  }

  await fs.mkdir(
    DATA_DIR,
    {
      recursive: true
    }
  );

  try {
    await fs.access(
      DB_FILE
    );
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


/* ======================================================
   GET DOCUMENT
====================================================== */

export async function getDoc(
  collection,
  id
) {
  const db =
    initFirestore();

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


/* ======================================================
   SET DOCUMENT
====================================================== */

export async function setDoc(
  collection,
  id,
  value
) {
  const db =
    initFirestore();

  if (db) {
    await db
      .collection(collection)
      .doc(id)
      .set(
        value,
        {
          merge: true
        }
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

  await writeLocalDb(
    local
  );
}


/* ======================================================
   FIND DEPOSIT BY PAYMENT CODE
====================================================== */

export async function findDepositByPaymentCode(
  paymentCode
) {
  const db =
    initFirestore();

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
    const storedCode =
      String(
        value.paymentCode || ''
      )
        .trim()
        .toUpperCase();

    if (
      storedCode ===
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


/* ======================================================
   NORMALIZE PAYMENT CODE
====================================================== */

/*
  Chấp nhận:

  NAPABC123456
  NAP_ABC123456
  NAP-ABC123456

  Chuẩn hóa về:

  NAPABC123456
*/

function normalizePaymentCode(
  value
) {
  if (!value) {
    return '';
  }

  let code =
    String(value)
      .trim()
      .toUpperCase();

  code =
    code.replace(
      /^NAP[_-]?/,
      'NAP'
    );

  const match =
    code.match(
      /^NAP[A-Z0-9]{6,}$/
    );

  return match
    ? match[0]
    : '';
}


/* ======================================================
   EXTRACT PAYMENT CODE
====================================================== */

function extractPaymentCode(
  payload
) {
  /*
    1. Ưu tiên payload.code
  */

  const fromCode =
    normalizePaymentCode(
      payload?.code
    );

  if (fromCode) {
    return fromCode;
  }


  /*
    2. Đọc payload.content
  */

  const content =
    String(
      payload?.content || ''
    )
      .trim()
      .toUpperCase();

  if (!content) {
    return '';
  }


  /*
    Hỗ trợ:

    NAPABC123456
    NAP_ABC123456
    NAP-ABC123456
  */

  const match =
    content.match(
      /NAP[_-]?[A-Z0-9]{6,}/i
    );

  if (!match) {
    return '';
  }

  return normalizePaymentCode(
    match[0]
  );
}


/* ======================================================
   CREATE DEPOSIT + VIETQR
====================================================== */

export async function createDeposit(
  userId,
  amount
) {
  const db =
    initFirestore();

  const acc =
    process.env.BANK_ACCOUNT?.trim();

  const bank =
    process.env.BANK_CODE?.trim() ||
    'MB';

  const bankName =
    process.env.BANK_NAME?.trim() ||
    'MBBank';

  if (!acc) {
    const error = new Error(
      'BANK_ACCOUNT chưa được cấu hình.'
    );

    error.code =
      'BANK_NOT_CONFIGURED';

    throw error;
  }


  /*
    Mã nạp:

    NAP + 10 ký tự HEX

    Ví dụ:

    NAPF41B097A3C
  */

  const paymentCode =
    `NAP${
      crypto
        .randomBytes(5)
        .toString('hex')
        .toUpperCase()
    }`;


  const depositId =
    crypto.randomUUID();


  const deposit = {
    id:
      depositId,

    userId:
      String(userId),

    amount:
      Number(amount),

    paymentCode,

    status:
      'pending',

    createdAt:
      new Date().toISOString()
  };


  /*
    Lưu deposit
  */

  if (db) {
    await db
      .collection('deposits')
      .doc(depositId)
      .set(deposit);
  } else {
    assertStorage();

    const local =
      await readLocalDb();

    local.deposits ??= {};

    local.deposits[
      depositId
    ] = deposit;

    await writeLocalDb(
      local
    );
  }


  /*
    VietQR trực tiếp.

    Không dùng QRCode.toDataURL().
  */

  const qrParams =
    new URLSearchParams({
      acc,
      bank,
      amount:
        String(amount),
      des:
        paymentCode
    });

  const qrUrl =
    `https://vietqr.app/img?${qrParams.toString()}`;


  return {
    ...deposit,

    qrUrl,

    qrDataUrl:
      qrUrl,

    qrImageUrl:
      qrUrl,

    bankName,

    bankAccount:
      acc
  };
}


/* ======================================================
   PROCESS SEPAY PAYMENT
====================================================== */

export async function processSePayPayload(
  payload
) {
  const transferType =
    String(
      payload?.transferType || ''
    )
      .trim()
      .toLowerCase();


  /*
    Chỉ xử lý tiền vào
  */

  if (
    transferType !==
    'in'
  ) {
    return {
      success: true,
      ignored: true,
      reason:
        'not_incoming'
    };
  }


  /*
    Transaction ID
  */

  const externalId =
    String(
      payload?.id ??
      payload?.referenceCode ??
      ''
    )
      .trim();


  if (!externalId) {
    return {
      success: false,
      status: 400,
      message:
        'Missing transaction id'
    };
  }


  /*
    Lấy payment code
  */

  const paymentCode =
    extractPaymentCode(
      payload
    );


  /*
    DEBUG
  */

  console.log(
    'SEPAY PAYMENT DATA',
    {
      externalId,

      code:
        payload?.code ??
        null,

      content:
        payload?.content ??
        null,

      paymentCode,

      amount:
        payload?.transferAmount ??
        null,

      accountNumber:
        payload?.accountNumber ??
        null
    }
  );


  /*
    Không tìm thấy mã
  */

  if (!paymentCode) {
    return {
      success: false,

      status: 422,

      message:
        'Không tìm thấy mã thanh toán NAP',

      reason:
        'payment_code_not_found',

      externalId,

      receivedCode:
        payload?.code ??
        null,

      receivedContent:
        payload?.content ??
        null
    };
  }


  const db =
    initFirestore();


  /* ====================================================
     CHỐNG XỬ LÝ TRÙNG
  ==================================================== */

  if (db) {
    const processedRef =
      db
        .collection(
          'processedTransactions'
        )
        .doc(
          externalId
        );

    const processedSnap =
      await processedRef.get();

    if (
      processedSnap.exists
    ) {
      return {
        success: true,
        duplicate: true,
        externalId
      };
    }
  } else {
    assertStorage();

    const local =
      await readLocalDb();

    if (
      local
        .processedTransactions?.[
          externalId
        ]
    ) {
      return {
        success: true,
        duplicate: true,
        externalId
      };
    }
  }


  /* ====================================================
     TÌM ĐƠN NẠP
  ==================================================== */

  let found =
    await findDepositByPaymentCode(
      paymentCode
    );


  /*
    Nếu database đang lưu mã có "_"
    thì thử thêm biến thể.
  */

  if (!found) {
    const variants = [
      paymentCode,

      paymentCode.replace(
        /^NAP/,
        'NAP_'
      ),

      paymentCode.replace(
        /^NAP/,
        'NAP-'
      )
    ];


    for (
      const variant of variants
    ) {
      if (
        variant ===
        paymentCode
      ) {
        continue;
      }

      found =
        await findDepositByPaymentCode(
          variant
        );

      if (found) {
        break;
      }
    }
  }


  if (!found) {
    console.error(
      'SEPAY DEPOSIT NOT FOUND',
      {
        externalId,
        paymentCode
      }
    );

    return {
      success: false,
      status: 422,

      message:
        'Không tìm thấy đơn nạp tương ứng',

      reason:
        'deposit_not_found',

      paymentCode,

      externalId
    };
  }


  const {
    id: depositId,
    data: deposit
  } =
    found;


  /*
    Đã thanh toán
  */

  if (
    deposit.status ===
    'paid'
  ) {
    return {
      success: true,
      duplicate: true,
      depositId,
      paymentCode,
      externalId
    };
  }


  /* ====================================================
     KIỂM TRA SỐ TIỀN
  ==================================================== */

  const receivedAmount =
    Number(
      payload?.transferAmount ||
      0
    );

  const expectedAmount =
    Number(
      deposit.amount
    );


  if (
    receivedAmount !==
    expectedAmount
  ) {
    console.error(
      'SEPAY AMOUNT MISMATCH',
      {
        externalId,

        paymentCode,

        received:
          receivedAmount,

        expected:
          expectedAmount
      }
    );

    return {
      success: false,

      status: 422,

      message:
        'Amount mismatch',

      receivedAmount,

      expectedAmount,

      paymentCode,

      externalId
    };
  }


  /* ====================================================
     KIỂM TRA TÀI KHOẢN
  ==================================================== */

  const expectedAccount =
    String(
      process.env.BANK_ACCOUNT ||
      ''
    ).trim();

  const receivedAccount =
    String(
      payload?.accountNumber ||
      ''
    ).trim();


  if (
    expectedAccount &&
    receivedAccount &&
    expectedAccount !==
      receivedAccount
  ) {
    console.error(
      'SEPAY ACCOUNT MISMATCH',
      {
        externalId,

        expectedAccount,

        receivedAccount
      }
    );

    return {
      success: false,

      status: 422,

      message:
        'Bank account mismatch',

      expectedAccount,

      receivedAccount,

      paymentCode
    };
  }


  const now =
    new Date().toISOString();


  /* ====================================================
     FIRESTORE
  ==================================================== */

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

    const processedRef =
      db
        .collection(
          'processedTransactions'
        )
        .doc(
          externalId
        );

    const transactionRef =
      db
        .collection('transactions')
        .doc(
          externalId
        );


    await db.runTransaction(
      async (transaction) => {

        const processedSnap =
          await transaction.get(
            processedRef
          );

        if (
          processedSnap.exists
        ) {
          return;
        }


        const depositSnap =
          await transaction.get(
            depositRef
          );

        if (
          !depositSnap.exists
        ) {
          throw new Error(
            'Deposit not found'
          );
        }


        const userSnap =
          await transaction.get(
            userRef
          );


        const currentDeposit =
          depositSnap.data();


        if (
          currentDeposit.status ===
          'paid'
        ) {

          /*
            Đã paid thì không cộng lần nữa.
          */

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

                name:
                  'User',

                balance:
                  0
              };


        const oldBalance =
          Number(
            currentUser.balance ||
            0
          );


        const newBalance =
          oldBalance +
          receivedAmount;


        /*
          CỘNG TIỀN
        */

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

            updatedAt:
              now
          },
          {
            merge: true
          }
        );


        /*
          PAID
        */

        transaction.set(
          depositRef,
          {
            ...currentDeposit,

            status:
              'paid',

            paidAt:
              now,

            transactionId:
              externalId,

            referenceCode:
              payload?.referenceCode ||
              null,

            gateway:
              payload?.gateway ||
              null,

            bankAccount:
              payload?.accountNumber ||
              null
          },
          {
            merge: true
          }
        );


        /*
          Đánh dấu processed
        */

        transaction.create(
          processedRef,
          {
            transactionId:
              externalId,

            depositId,

            processedAt:
              now
          }
        );


        /*
          Lưu lịch sử giao dịch
        */

        transaction.set(
          transactionRef,
          {
            userId:
              String(
                deposit.userId
              ),

            type:
              'deposit',

            amount:
              receivedAmount,

            balanceBefore:
              oldBalance,

            balanceAfter:
              newBalance,

            status:
              'completed',

            paymentCode,

            referenceCode:
              payload?.referenceCode ||
              null,

            gateway:
              payload?.gateway ||
              null,

            bankAccount:
              payload?.accountNumber ||
              null,

            createdAt:
              now
          },
          {
            merge: true
          }
        );
      }
    );
  }


  /* ====================================================
     LOCAL JSON
  ==================================================== */

  else {
    assertStorage();

    const local =
      await readLocalDb();


    local.users ??= {};
    local.deposits ??= {};
    local.processedTransactions ??= {};
    local.transactions ??= {};


    /*
      Duplicate
    */

    if (
      local.processedTransactions[
        externalId
      ]
    ) {
      return {
        success: true,
        duplicate: true,
        externalId
      };
    }


    const currentDeposit =
      local.deposits[
        depositId
      ];


    if (!currentDeposit) {
      return {
        success: false,
        status: 422,

        message:
          'Không tìm thấy đơn nạp',

        reason:
          'deposit_not_found'
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

        name:
          'User',

        balance:
          0
      };


    const oldBalance =
      Number(
        user.balance ||
        0
      );


    const newBalance =
      oldBalance +
      receivedAmount;


    /*
      CỘNG TIỀN
    */

    local.users[
      deposit.userId
    ] = {
      ...user,

      balance:
        newBalance,

      updatedAt:
        now
    };


    /*
      PAID
    */

    local.deposits[
      depositId
    ] = {
      ...currentDeposit,

      status:
        'paid',

      paidAt:
        now,

      transactionId:
        externalId,

      referenceCode:
        payload?.referenceCode ||
        null,

      gateway:
        payload?.gateway ||
        null,

      bankAccount:
        payload?.accountNumber ||
        null
    };


    /*
      PROCESSED
    */

    local.processedTransactions[
      externalId
    ] = {
      transactionId:
        externalId,

      depositId,

      processedAt:
        now
    };


    /*
      TRANSACTION
    */

    local.transactions[
      externalId
    ] = {
      userId:
        deposit.userId,

      type:
        'deposit',

      amount:
        receivedAmount,

      balanceBefore:
        oldBalance,

      balanceAfter:
        newBalance,

      status:
        'completed',

      paymentCode,

      referenceCode:
        payload?.referenceCode ||
        null,

      gateway:
        payload?.gateway ||
        null,

      bankAccount:
        payload?.accountNumber ||
        null,

      createdAt:
        now
    };


    await writeLocalDb(
      local
    );
  }


  /* ====================================================
     SUCCESS
  ==================================================== */

  console.log(
    'SEPAY CREDITED SUCCESSFULLY',
    {
      externalId,

      paymentCode,

      depositId,

      userId:
        deposit.userId,

      amount:
        receivedAmount
    }
  );


  return {
    success: true,

    credited:
      receivedAmount,

    paymentCode,

    depositId,

    transactionId:
      externalId
  };
}


/* ======================================================
   SEPAY HMAC-SHA256
====================================================== */

export function verifySePaySignature(
  rawBody,
  headers
) {
  const secret =
    process.env.SEPAY_WEBHOOK_SECRET?.trim();


  /*
    Không có secret:
    cho phép development.
  */

  if (!secret) {
    return {
      ok: true,
      skipped: true
    };
  }


  const sig =
    String(
      headers?.['x-sepay-signature'] ||
      headers?.['X-SePay-Signature'] ||
      ''
    ).trim();


  const ts =
    String(
      headers?.['x-sepay-timestamp'] ||
      headers?.['X-SePay-Timestamp'] ||
      ''
    ).trim();


  if (
    !sig ||
    !ts
  ) {
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


  const receivedBuffer =
    Buffer.from(
      sig
    );

  const expectedBuffer =
    Buffer.from(
      expected
    );


  if (
    receivedBuffer.length !==
    expectedBuffer.length
  ) {
    return {
      ok: false,

      message:
        'Invalid signature'
    };
  }


  const valid =
    crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    );


  return {
    ok:
      valid,

    message:
      valid
        ? undefined
        : 'Invalid signature'
  };
}


/* ======================================================
   HEALTH
====================================================== */

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
