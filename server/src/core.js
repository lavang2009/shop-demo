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


/* ======================================================
   LOCAL DB
====================================================== */

export async function ensureLocalDb() {

  // Vercel không dùng db.json
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


async function writeLocalDb(
  db
) {

  if (IS_VERCEL) {

    const error =
      new Error(
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

    const error =
      new Error(
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
        .collection(
          collection
        )
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
      .collection(
        collection
      )
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
        .collection(
          'deposits'
        )
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
      id:
        snapshot.docs[0].id,

      data:
        snapshot.docs[0].data()
    };
  }

  assertStorage();

  const local =
    await readLocalDb();

  for (
    const [
      id,
      value
    ]
    of Object.entries(
      local.deposits || {}
    )
  ) {

    if (
      String(
        value.paymentCode
      ).trim().toUpperCase()
      ===
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

  /*
    MBBank:
    BANK_CODE=MB
  */

  const bank =
    process.env.BANK_CODE?.trim() ||
    'MB';

  const bankName =
    process.env.BANK_NAME?.trim() ||
    'MBBank';


  if (!acc) {

    const error =
      new Error(
        'BANK_ACCOUNT chưa được cấu hình.'
      );

    error.code =
      'BANK_NOT_CONFIGURED';

    throw error;
  }


  /* --------------------------------------------------
     Tạo mã thanh toán duy nhất
  -------------------------------------------------- */

  const paymentCode =
    `NAP_${
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


  /* --------------------------------------------------
     Lưu deposit
  -------------------------------------------------- */

  if (db) {

    await db
      .collection(
        'deposits'
      )
      .doc(
        depositId
      )
      .set(
        deposit
      );

  } else {

    assertStorage();

    const local =
      await readLocalDb();

    local.deposits ??= {};

    local.deposits[
      depositId
    ] =
      deposit;

    await writeLocalDb(
      local
    );
  }


  /* ==================================================
     VIETQR TRỰC TIẾP
     
     QUAN TRỌNG:
     KHÔNG dùng QRCode.toDataURL()
     
     qrUrl chính là URL ảnh QR.
  ================================================== */

  const qrUrl =
    'https://vietqr.app/img?' +
    'acc=' +
    encodeURIComponent(
      acc
    ) +
    '&bank=' +
    encodeURIComponent(
      bank
    ) +
    '&amount=' +
    encodeURIComponent(
      amount
    ) +
    '&des=' +
    encodeURIComponent(
      paymentCode
    );


  return {

    ...deposit,

    qrUrl,

    // Tương thích với frontend cũ
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
      .toLowerCase()
      .trim();


  /* --------------------------------------------------
     Chỉ xử lý tiền vào
  -------------------------------------------------- */

  if (
    transferType !== 'in'
  ) {

    return {
      success: true,
      ignored: true,
      reason:
        'not_incoming'
    };
  }


  /* --------------------------------------------------
     Transaction ID
  -------------------------------------------------- */

  const externalId =
    String(
      payload?.id ??
      payload?.referenceCode ??
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


  /* ==================================================
     LẤY MÃ NẠP TIỀN
     
     Ưu tiên:
     payload.code
     
     Sau đó:
     payload.content
  ================================================== */

  let paymentCode =
    '';


  const sepayCode =
    String(
      payload?.code || ''
    )
      .trim()
      .toUpperCase();


  if (
    sepayCode.startsWith(
      'NAP_'
    )
  ) {

    paymentCode =
      sepayCode;

  } else {

    const content =
      String(
        payload?.content || ''
      );


    const match =
      content.match(
        /(NAP_[A-Z0-9-]{6,})/i
      );


    if (match) {

      paymentCode =
        match[1]
          .toUpperCase();

    }

  }


  /* --------------------------------------------------
     Không tìm được mã
  -------------------------------------------------- */

  if (!paymentCode) {

    console.log(
      'SePay ignored: payment code not found',
      {
        id:
          externalId,

        code:
          payload?.code || null,

        content:
          payload?.content || '',

        amount:
          payload?.transferAmount || null
      }
    );

    return {

      success: true,

      ignored: true,

      reason:
        'payment_code_not_found',

      externalId

    };
  }


  const db =
    initFirestore();


  /* ==================================================
     KIỂM TRA GIAO DỊCH ĐÃ XỬ LÝ
  ================================================== */

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
      local.processedTransactions?.[
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


  /* ==================================================
     TÌM DEPOSIT
  ================================================== */

  const found =
    await findDepositByPaymentCode(
      paymentCode
    );


  if (!found) {

    console.log(
      'SePay ignored: deposit not found',
      {
        externalId,
        paymentCode
      }
    );

    return {

      success: true,

      ignored: true,

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


  /* ==================================================
     ĐƠN ĐÃ THANH TOÁN
  ================================================== */

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


  /* ==================================================
     KIỂM TRA SỐ TIỀN
  ================================================== */

  const amount =
    Number(
      payload?.transferAmount ||
      0
    );


  const expectedAmount =
    Number(
      deposit.amount
    );


  if (
    amount !==
    expectedAmount
  ) {

    console.log(
      'SePay amount mismatch',
      {
        externalId,

        paymentCode,

        received:
          amount,

        expected:
          expectedAmount
      }
    );

    return {

      success: false,

      status: 422,

      message:
        'Amount mismatch',

      receivedAmount:
        amount,

      expectedAmount:
        expectedAmount

    };
  }


  /* ==================================================
     KIỂM TRA TÀI KHOẢN NHẬN
  ================================================== */

  const expectedAccount =
    String(
      process.env.BANK_ACCOUNT || ''
    ).trim();


  const receivedAccount =
    String(
      payload?.accountNumber || ''
    ).trim();


  if (
    expectedAccount &&
    receivedAccount &&
    expectedAccount !==
      receivedAccount
  ) {

    console.log(
      'SePay account mismatch',
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
        'Bank account mismatch'

    };
  }


  const now =
    new Date().toISOString();


  /* ==================================================
     FIRESTORE
     
     Dùng transaction để chống cộng tiền 2 lần.
  ================================================== */

  if (db) {

    const depositRef =
      db
        .collection(
          'deposits'
        )
        .doc(
          depositId
        );


    const userRef =
      db
        .collection(
          'users'
        )
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
        .collection(
          'transactions'
        )
        .doc(
          externalId
        );


    await db.runTransaction(
      async (transaction) => {

        /* ---------------------------------------------
           Kiểm tra giao dịch trùng lần nữa
        --------------------------------------------- */

        const processedSnap =
          await transaction.get(
            processedRef
          );


        if (
          processedSnap.exists
        ) {

          return;
        }


        /* ---------------------------------------------
           Đọc deposit
        --------------------------------------------- */

        const depositSnap =
          await transaction.get(
            depositRef
          );


        /* ---------------------------------------------
           Đọc user
        --------------------------------------------- */

        const userSnap =
          await transaction.get(
            userRef
          );


        if (
          !depositSnap.exists
        ) {

          throw new Error(
            'Deposit not found'
          );
        }


        const currentDeposit =
          depositSnap.data();


        /* ---------------------------------------------
           Đã thanh toán
        --------------------------------------------- */

        if (
          currentDeposit.status ===
          'paid'
        ) {

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

          return;
        }


        /* ---------------------------------------------
           User hiện tại
        --------------------------------------------- */

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
          amount;


        /* ---------------------------------------------
           CỘNG TIỀN
        --------------------------------------------- */

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

            merge:
              true

          }

        );


        /* ---------------------------------------------
           Đánh dấu deposit PAID
        --------------------------------------------- */

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

            merge:
              true

          }

        );


        /* ---------------------------------------------
           Đánh dấu transaction đã xử lý
        --------------------------------------------- */

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


        /* ---------------------------------------------
           Lưu lịch sử
        --------------------------------------------- */

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
              amount,

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

            merge:
              true

          }

        );

      }
    );


  }

  /* ==================================================
     LOCAL JSON
  ================================================== */

  else {

    assertStorage();

    const local =
      await readLocalDb();


    local.users ??= {};

    local.deposits ??= {};

    local.processedTransactions ??= {};

    local.transactions ??= {};


    /* -----------------------------------------------
       Chống duplicate
    ----------------------------------------------- */

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


    if (
      !currentDeposit
    ) {

      return {

        success: true,

        ignored: true,

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
      ] ||

      {

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
      amount;


    /* -----------------------------------------------
       CỘNG TIỀN
    ----------------------------------------------- */

    local.users[
      deposit.userId
    ] = {

      ...user,

      balance:
        newBalance,

      updatedAt:
        now

    };


    /* -----------------------------------------------
       PAID
    ----------------------------------------------- */

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
        null

    };


    /* -----------------------------------------------
       Processed
    ----------------------------------------------- */

    local.processedTransactions[
      externalId
    ] = {

      transactionId:
        externalId,

      depositId,

      processedAt:
        now

    };


    /* -----------------------------------------------
       Transaction history
    ----------------------------------------------- */

    local.transactions[
      externalId
    ] = {

      userId:
        deposit.userId,

      type:
        'deposit',

      amount:
        amount,

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


  /* ==================================================
     SUCCESS
  ================================================== */

  console.log(
    'SePay credited successfully',
    {

      externalId,

      paymentCode,

      depositId,

      userId:
        deposit.userId,

      amount

    }
  );


  return {

    success:
      true,

    credited:
      amount,

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
    Chưa có secret:
    cho phép local development.
  */

  if (!secret) {

    return {

      ok:
        true,

      skipped:
        true

    };
  }


  const sig =
    String(

      headers?.['x-sepay-signature'] ||

      headers?.['X-SePay-Signature'] ||

      ''

    );


  const ts =
    String(

      headers?.['x-sepay-timestamp'] ||

      headers?.['X-SePay-Timestamp'] ||

      ''

    );


  if (
    !sig ||
    !ts
  ) {

    return {

      ok:
        false,

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


  /*
    timingSafeEqual yêu cầu
    hai Buffer có cùng độ dài.
  */

  if (
    receivedBuffer.length !==
    expectedBuffer.length
  ) {

    return {

      ok:
        false,

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

    ok:
      true,

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
