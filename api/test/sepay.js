import { getDoc, processSePayPayload } from '../../server/src/core.js';
export default async function handler(req, res) {
  if (process.env.NODE_ENV === 'production') return res.status(404).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const deposit = await getDoc('deposits', String(body.depositId || ''));
    if (!deposit) return res.status(404).json({ message: 'Deposit not found' });
    const fake = { id: `TEST_${Date.now()}`, transferType: 'in', transferAmount: deposit.amount, content: deposit.paymentCode, referenceCode: `TESTREF_${Date.now()}` };
    const result = await processSePayPayload(fake);
    res.json({ ...result, fake });
  } catch (error) {
    res.status(error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500).json({ message: error.message || 'Server error', code: error.code });
  }
}
