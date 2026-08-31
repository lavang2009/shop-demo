import { app } from '../server/src/server.js';

export default function handler(req, res) {
  return app(req, res);
}
