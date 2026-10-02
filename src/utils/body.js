import { ServiceError } from './errors.js';
export function parseJsonBody(event, limit = 16384) {
  const type = Object.entries(event.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  if (!/^application\/json(?:;|$)/i.test(type)) throw new ServiceError('json_content_type_required', 415);
  if (typeof event.body !== 'string' || event.body.length > limit * 2) throw new ServiceError('payload_too_large', 413);
  const bytes = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  if (bytes.length > limit) throw new ServiceError('payload_too_large', 413);
  let body;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new ServiceError('invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError('invalid_payload');
  return body;
}
