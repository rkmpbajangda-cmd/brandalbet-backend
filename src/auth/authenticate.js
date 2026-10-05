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
  // Cloudflare-native verification avoids the Firebase Admin Auth verifier path
  // that has repeatedly failed at runtime on Workers. The verifier still checks
  // the Google/Firebase RS256 signature, project audience, issuer, expiration,
  // issued-at/authentication time, subject/uid, and preserves custom claims.
  const { verifyFirebaseIdToken } = await import('./firebase-id-token.js');
  return verifyFirebaseIdToken(token, env);
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
    decoded = await verifyIdToken(token, env);
    if (!decoded || typeof decoded.uid !== 'string' || decoded.uid.length === 0) {
      throw new AuthHttpError(401, 'invalid_id_token');
    }
  } catch (error) {
    if (error instanceof AuthHttpError) throw error;

    const code = typeof error?.code === 'string' ? error.code : 'unknown';
    const runtimeCodes = new Set([
      'auth/key-fetch-failed',
      'auth/key-import-failed',
      'auth/signature-verification-failed',
      'app/invalid-credential',
      'app/invalid-options',
      'auth/invalid-credential',
      'auth/insufficient-permission',
      'auth/internal-error',
      'auth/project-not-found',
    ]);
    const invalidTokenCodes = new Set([
      'auth/argument-error',
      'auth/invalid-id-token',
      'auth/id-token-expired',
      'auth/id-token-revoked',
      'auth/user-disabled',
      'auth/user-not-found',
      'auth/project-audience-mismatch',
      'auth/project-issuer-mismatch',
    ]);

    const reason = code === 'firebase_admin_project_mismatch' ? 'service_account_project_mismatch'
      : code === 'auth/project-audience-mismatch' ? 'project_audience_mismatch'
      : code === 'auth/project-issuer-mismatch' ? 'project_issuer_mismatch'
      : code === 'auth/key-fetch-failed' ? 'google_signing_key_fetch_failed'
      : code === 'auth/key-import-failed' ? 'google_signing_key_import_failed'
      : code === 'auth/signature-verification-failed' ? 'webcrypto_signature_runtime'
      : code === 'firebase_admin_unconfigured' ? 'firebase_project_unconfigured'
      : invalidTokenCodes.has(code) ? 'invalid_firebase_id_token'
      : 'verifier_runtime_error';

    console.error(JSON.stringify({
      event: 'firebase_token_verification_failed',
      sdkCode: code,
      reason,
      errorName: typeof error?.name === 'string' ? error.name : 'unknown',
    }));

    if (code === 'firebase_admin_project_mismatch') {
      throw new AuthHttpError(503, 'auth_project_mismatch');
    }
    if (code === 'firebase_admin_unconfigured') {
      throw new AuthHttpError(503, 'auth_service_unconfigured');
    }
    if (runtimeCodes.has(code) || code === 'unknown') {
      throw new AuthHttpError(503, 'auth_verifier_runtime_error');
    }
    if (invalidTokenCodes.has(code)) {
      throw new AuthHttpError(401, 'invalid_or_expired_id_token');
    }
    throw new AuthHttpError(503, 'auth_verifier_runtime_error');
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
