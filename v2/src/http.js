import crypto from 'node:crypto';

export function requestId() {
  return crypto.randomUUID();
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function sendOk(res, data = {}) {
  return res.json({ ok: true, ...data });
}

export function sendError(res, status, error, details) {
  const body = { ok: false, error };
  if (details && process.env.NODE_ENV !== 'production') body.details = details;
  return res.status(status).json(body);
}
