import { health } from '../server/src/core.js';
export default function handler(req, res) { res.status(200).json(health()); }
