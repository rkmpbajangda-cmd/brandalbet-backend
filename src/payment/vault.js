import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ServiceError } from '../utils/errors.js';

function key(env) {
  const raw = env.PAYMENT_CONFIG_ENCRYPTION_KEY;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new ServiceError('payment_vault_unconfigured', 503);
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== raw) throw new ServiceError('payment_vault_unconfigured', 503);
  return bytes;
}
export function vaultConfigured(env = process.env) {
  try { key(env); return true; } catch { return false; }
}
export function sealCredentials(connectionId, credentials, env = process.env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(env), iv);
  cipher.setAAD(Buffer.from('payment-connection:v1:' + connectionId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}
export function openCredentials(connectionId, envelope, env = process.env) {
  const secret = key(env);
  try {
    if (envelope?.version !== 1) throw new Error('version');
    const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from('payment-connection:v1:' + connectionId));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw new ServiceError('payment_credentials_unreadable', 503); }
}
