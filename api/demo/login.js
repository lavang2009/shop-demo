import { getDoc, setDoc } from '../../server/src/core.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const userId = String(body.userId || 'demo-user');
    const user = await getDoc('users', userId) || { userId, name: 'Demo User', balance: 0 };
    await setDoc('users', userId, user);
    res.json(user);
  } catch (error) {
    res.status(error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500).json({ message: error.message || 'Server error', code: error.code });
  }
}
