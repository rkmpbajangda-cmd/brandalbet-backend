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

  const match = entry[1].match(/^Bearer\s+([^\s;]+)(?:;\s*BrandalSession=[A-Za-z0-9_-]{43,128})?$/i);
  if (!match) throw new AuthHttpError(401, 'invalid_authorization_header');
  return match[1];
}

async function defaultVerifyIdToken(token, env) {
  const { getAdminAuth } = await import('../firebase/admin.js');
  // Cloudflare bindings are request-scoped and are not guaranteed to be
  // mirrored into process.env. Always pass the Worker env explicitly so the
  // Firebase Admin verifier uses FIREBASE_SERVICE_ACCOUNT_JSON from Cloudflare.
  return getAdminAuth(env).verifyIdToken(token, true);
}

export async function authenticateRequest(event, {
  verifyIdToken = defaultVerifyIdToken,
  requireMemberSession = false,
  verifyMemberSession,
  env = process.env,
} = {}) {
  const token = extractBearerToken(event?.headers ?? {});
  let decoded;
  try {
    // Custom verifiers used by tests can ignore the second argument; the
    // production verifier consumes it to initialize Firebase Admin correctly.
    decoded = await verifyIdToken(token, env);
    if (!decoded || typeof decoded.uid !== 'string' || decoded.uid.length === 0) {
      throw new AuthHttpError(401, 'invalid_id_token');
    }
  } catch (error) {
    if (error instanceof AuthHttpError) throw error;
    const knownCodes = new Set([
      'firebase_admin_unconfigured', 'firebase_admin_project_mismatch',
      'app/invalid-credential', 'app/invalid-options',
      'auth/invalid-credential', 'auth/insufficient-permission', 'auth/internal-error',
      'auth/project-not-found', 'auth/argument-error', 'auth/invalid-id-token',
      'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled',
      'auth/user-not-found'
    ]);
    const sdkCode = knownCodes.has(error?.code) ? error.code : 'unknown';
    const message = typeof error?.message === 'string' ? error.message : '';
    const reason = error?.code === 'firebase_admin_project_mismatch' ? 'service_account_project_mismatch'
      : /incorrect.*aud|aud.*claim/i.test(message) ? 'project_audience_mismatch'
      : /incorrect.*iss|issuer.*claim/i.test(message) ? 'project_issuer_mismatch'
      : /private key|PEM|DECODER/i.test(message) ? 'private_key_format'
      : 'sdk_error';
    console.error(JSON.stringify({ event: 'firebase_token_verification_failed', sdkCode, reason }));
    if (error?.code === 'firebase_admin_project_mismatch') {
      throw new AuthHttpError(503, 'auth_project_mismatch');
    }
    if (error?.code === 'firebase_admin_unconfigured') {
      throw new AuthHttpError(503, 'auth_service_unconfigured');
    }
    if (['app/invalid-credential', 'app/invalid-options', 'auth/invalid-credential',
      'auth/insufficient-permission', 'auth/internal-error', 'auth/project-not-found'].includes(sdkCode)) {
      throw new AuthHttpError(503, 'auth_service_unavailable');
    }
    throw new AuthHttpError(401, 'invalid_or_expired_id_token');
  }

  if (requireMemberSession) {
    const { memberSingleSessionEnabled, assertMemberDeviceSession } = await import('./member-device-session.js');
    if (memberSingleSessionEnabled(env)) {
      const verify = verifyMemberSession ?? ((actor, request) => assertMemberDeviceSession(actor, request));
      await verify(decoded, event);
    }
  }

  return decoded;
}
