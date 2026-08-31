import { getDoc } from '../../server/src/core.js';
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  try {
    const id = String(req.query?.id || req.params?.id || '').trim();
    const deposit = await getDoc('deposits', id);
    if (!deposit) return res.status(404).json({ message: 'Không tìm thấy đơn' });
    res.json(deposit);
  } catch (error) {
    res.status(error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500).json({ message: error.message || 'Server error', code: error.code });
  }
}
