import { createDeposit } from '../../server/src/core.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const userId = String(body.userId || '').trim();
    const amount = Number(body.amount);
    if (!userId) return res.status(400).json({ message: 'Thiếu userId' });
    if (!Number.isInteger(amount) || amount < 10000 || amount > 50000000) {
      return res.status(400).json({ message: 'Số tiền phải từ 10.000đ đến 50.000.000đ' });
    }
    res.json(await createDeposit(userId, amount));
  } catch (error) {
    res.status(error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500).json({ message: error.message || 'Server error', code: error.code });
  }
}
