import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function csv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL'),
  databaseConnectionLimit: Math.max(2, Number(process.env.DATABASE_CONNECTION_LIMIT || 10)),
  sessionTtlDays: Math.max(1, Number(process.env.SESSION_TTL_DAYS || 30)),
  corsOrigins: csv(process.env.CORS_ORIGINS),
  bodyLimit: process.env.BODY_LIMIT || '128kb',
  requestTimeoutMs: Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS || 15000)),
  trustProxy: process.env.TRUST_PROXY === 'true',
});

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}
