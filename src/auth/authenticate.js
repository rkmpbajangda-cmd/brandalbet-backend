export class AuthHttpError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.name = 'AuthHttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function extractBearerToken(headers = {}) {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization');
  if (!entry || typeof entry[1] !== 'string') {
    throw new AuthHttpError(401, 'missing_bearer_token');
  }

  const match = entry[1].match(/^Bearer\s+([^\s]+)$/i);
  if (!match) throw new AuthHttpError(401, 'invalid_authorization_header');
  return match[1];
}

async function defaultVerifyIdToken(token) {
  const { getAdminAuth } = await import('../firebase/admin.js');
  return getAdminAuth().verifyIdToken(token, true);
}

export async function authenticateRequest(event, { verifyIdToken = defaultVerifyIdToken } = {}) {
  const token = extractBearerToken(event?.headers ?? {});
  try {
    const decoded = await verifyIdToken(token);
    if (!decoded || typeof decoded.uid !== 'string' || decoded.uid.length === 0) {
      throw new AuthHttpError(401, 'invalid_id_token');
    }
    return decoded;
  } catch (error) {
    if (error instanceof AuthHttpError) throw error;
    if (error?.code === 'firebase_admin_unconfigured') {
      throw new AuthHttpError(503, 'auth_service_unconfigured');
    }
    throw new AuthHttpError(401, 'invalid_or_expired_id_token');
  }
}
