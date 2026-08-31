import { getDoc } from '../../server/src/core.js';
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  try {
    const userId = String(req.query?.userId || req.params?.userId || '').trim();
    const user = await getDoc('users', userId) || { userId, balance: 0 };
    res.json(user);
  } catch (error) {
    res.status(error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500).json({ message: error.message || 'Server error', code: error.code });
  }
}
