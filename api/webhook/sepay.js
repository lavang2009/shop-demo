import { readRawBody } from '../../server/src/http.js';
import { processSePayPayload, verifySePaySignature } from '../../server/src/core.js';
export const config = { api: { bodyParser: false } };
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  try {
    const raw = await readRawBody(req);
    const check = verifySePaySignature(raw, req.headers || {});
    if (!check.ok) return res.status(401).json({ success: false, message: check.message || 'Invalid signature' });
    let payload;
    try { payload = JSON.parse(raw || '{}'); } catch { return res.status(400).json({ success: false, message: 'Invalid JSON' }); }
    const result = await processSePayPayload(payload);
    return res.status(result.status || (result.success ? 200 : 400)).json(result);
  } catch (error) {
    console.error(error);
    return res.status(error.code === 'FIREBASE_NOT_CONFIGURED' ? 503 : 500).json({ success: false, message: error.message || 'Webhook error', code: error.code });
  }
}
