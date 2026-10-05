const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const MAX_CACHE_SECONDS = 24 * 60 * 60;
const DEFAULT_CACHE_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 300;

let jwksCache = {
  expiresAtMs: 0,
  keysByKid: new Map(),
};

export class FirebaseIdTokenError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'FirebaseIdTokenError';
    this.code = code;
  }
}

function decodeBase64UrlBytes(input) {
  if (typeof input !== 'string' || !input) throw new FirebaseIdTokenError('auth/invalid-id-token');
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new FirebaseIdTokenError('auth/invalid-id-token');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeBase64UrlJson(input) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64UrlBytes(input)));
  } catch (error) {
    if (error instanceof FirebaseIdTokenError) throw error;
    throw new FirebaseIdTokenError('auth/invalid-id-token');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FirebaseIdTokenError('auth/invalid-id-token');
  }
  return parsed;
}

function parseCacheSeconds(cacheControl) {
  const match = typeof cacheControl === 'string' ? cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i) : null;
  if (!match) return DEFAULT_CACHE_SECONDS;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_SECONDS;
  return Math.min(parsed, MAX_CACHE_SECONDS);
}

async function fetchJwks(fetchImpl, nowMs) {
  let response;
  try {
    response = await fetchImpl(FIREBASE_JWKS_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new FirebaseIdTokenError('auth/key-fetch-failed');
  }
  if (!response?.ok) throw new FirebaseIdTokenError('auth/key-fetch-failed');

  let body;
  try {
    body = await response.json();
  } catch {
    throw new FirebaseIdTokenError('auth/key-fetch-failed');
  }
  if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new FirebaseIdTokenError('auth/key-fetch-failed');
  }

  const next = new Map();
  for (const jwk of body.keys) {
    if (!jwk || typeof jwk.kid !== 'string' || !jwk.kid || jwk.kty !== 'RSA') continue;
    next.set(jwk.kid, jwk);
  }
  if (next.size === 0) throw new FirebaseIdTokenError('auth/key-fetch-failed');

  const maxAge = parseCacheSeconds(response.headers?.get?.('cache-control'));
  jwksCache = {
    keysByKid: next,
    expiresAtMs: nowMs + maxAge * 1000,
  };
  return jwksCache;
}

async function resolveJwk(kid, { fetchImpl, nowMs }) {
  if (jwksCache.expiresAtMs <= nowMs || !jwksCache.keysByKid.size) {
    await fetchJwks(fetchImpl, nowMs);
  }
  let jwk = jwksCache.keysByKid.get(kid);
  if (!jwk) {
    // Key rotation can introduce a new kid before the current cache expires.
    await fetchJwks(fetchImpl, nowMs);
    jwk = jwksCache.keysByKid.get(kid);
  }
  if (!jwk) throw new FirebaseIdTokenError('auth/invalid-id-token');
  return jwk;
}

function assertFirebaseClaims(payload, projectId, nowSeconds) {
  const issuer = `https://securetoken.google.com/${projectId}`;
  if (payload.aud !== projectId) throw new FirebaseIdTokenError('auth/project-audience-mismatch');
  if (payload.iss !== issuer) throw new FirebaseIdTokenError('auth/project-issuer-mismatch');
  if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) {
    throw new FirebaseIdTokenError('auth/invalid-id-token');
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new FirebaseIdTokenError('auth/id-token-expired');
  }
  if (!Number.isFinite(payload.iat) || payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new FirebaseIdTokenError('auth/invalid-id-token');
  }
  if (!Number.isFinite(payload.auth_time) || payload.auth_time > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new FirebaseIdTokenError('auth/invalid-id-token');
  }
}

export async function verifyFirebaseIdToken(token, env = process.env, {
  fetchImpl = fetch,
  cryptoImpl = crypto,
  nowMs = Date.now(),
} = {}) {
  const projectId = typeof env?.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID.trim() : '';
  if (!projectId) throw new FirebaseIdTokenError('firebase_admin_unconfigured');

  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts.some(part => !part)) throw new FirebaseIdTokenError('auth/invalid-id-token');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeBase64UrlJson(encodedHeader);
  const payload = decodeBase64UrlJson(encodedPayload);

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new FirebaseIdTokenError('auth/invalid-id-token');
  }

  assertFirebaseClaims(payload, projectId, Math.floor(nowMs / 1000));

  const jwk = await resolveJwk(header.kid, { fetchImpl, nowMs });
  let publicKey;
  try {
    publicKey = await cryptoImpl.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    throw new FirebaseIdTokenError('auth/key-import-failed');
  }

  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = decodeBase64UrlBytes(encodedSignature);
  let valid;
  try {
    valid = await cryptoImpl.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      publicKey,
      signature,
      signingInput,
    );
  } catch {
    throw new FirebaseIdTokenError('auth/signature-verification-failed');
  }
  if (!valid) throw new FirebaseIdTokenError('auth/invalid-id-token');

  // Firebase custom claims are included at the top level of the ID-token payload.
  // Preserve them for the existing RBAC checks and expose Admin-SDK-compatible uid.
  return {
    ...payload,
    uid: payload.sub,
  };
}

export function resetFirebaseJwksCacheForTests() {
  jwksCache = { expiresAtMs: 0, keysByKid: new Map() };
}
