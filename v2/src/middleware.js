import crypto from 'node:crypto';
import { sendError } from './http.js';

export function requestContext(req, res, next) {
  const id = req.get('x-request-id') || crypto.randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}

export function timeout(ms) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) sendError(res, 503, 'request_timeout');
    }, ms);
    res.on('finish', () => clearTimeout(timer));
    next();
  };
}

export function notFound(req, res) {
  sendError(res, 404, 'not_found');
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const requestId = req.requestId || 'unknown';
  console.error(JSON.stringify({
    level: 'error',
    requestId,
    method: req.method,
    path: req.originalUrl,
    message: err?.message || String(err),
    stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack,
  }));
  res.setHeader('x-request-id', requestId);
  sendError(res, 500, 'internal_error');
}
