import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFirebaseIdToken, resetFirebaseJwksCacheForTests } from '../src/auth/firebase-id-token.js';

function base64Url(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  let binary = '';
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createSigner(kid = 'test-kid') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  async function sign(payload, header = { alg: 'RS256', kid, typ: 'JWT' }) {
    const encodedHeader = base64Url(JSON.stringify(header));
    const encodedPayload = base64Url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      pair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  }

  return { publicJwk, sign };
}

function fakeJwksFetch(publicJwk) {
  return async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
  });
}

function validPayload(overrides = {}) {
  const now = 1_800_000_000;
  return {
    aud: 'brandal-bet',
    iss: 'https://securetoken.google.com/brandal-bet',
    sub: 'firebase-user-123',
    user_id: 'firebase-user-123',
    iat: now - 10,
    exp: now + 3600,
    auth_time: now - 20,
    email: 'admin@example.invalid',
    backoffice: true,
    role: 'superadmin',
    firebase: { sign_in_provider: 'password' },
    ...overrides,
  };
}

test('Cloudflare-native verifier validates Firebase JWT and preserves custom claims', async () => {
  resetFirebaseJwksCacheForTests();
  const { publicJwk, sign } = await createSigner();
  const token = await sign(validPayload());
  const decoded = await verifyFirebaseIdToken(token, { FIREBASE_PROJECT_ID: 'brandal-bet' }, {
    fetchImpl: fakeJwksFetch(publicJwk),
    cryptoImpl: crypto,
    nowMs: 1_800_000_000_000,
  });
  assert.equal(decoded.uid, 'firebase-user-123');
  assert.equal(decoded.backoffice, true);
  assert.equal(decoded.role, 'superadmin');
});

test('Cloudflare-native verifier rejects token from another Firebase project', async () => {
  resetFirebaseJwksCacheForTests();
  const { publicJwk, sign } = await createSigner();
  const token = await sign(validPayload({ aud: 'other-project' }));
  await assert.rejects(
    verifyFirebaseIdToken(token, { FIREBASE_PROJECT_ID: 'brandal-bet' }, {
      fetchImpl: fakeJwksFetch(publicJwk),
      cryptoImpl: crypto,
      nowMs: 1_800_000_000_000,
    }),
    error => error?.code === 'auth/project-audience-mismatch',
  );
});

test('Cloudflare-native verifier rejects tampered Firebase JWT signature', async () => {
  resetFirebaseJwksCacheForTests();
  const { publicJwk, sign } = await createSigner();
  const token = await sign(validPayload());
  const [header, payload] = token.split('.');
  const tamperedPayload = base64Url(JSON.stringify(validPayload({ role: 'superadmin', backoffice: true, email: 'tampered@example.invalid' })));
  const tampered = `${header}.${tamperedPayload}.${token.split('.')[2]}`;
  await assert.rejects(
    verifyFirebaseIdToken(tampered, { FIREBASE_PROJECT_ID: 'brandal-bet' }, {
      fetchImpl: fakeJwksFetch(publicJwk),
      cryptoImpl: crypto,
      nowMs: 1_800_000_000_000,
    }),
    error => error?.code === 'auth/invalid-id-token',
  );
  assert.notEqual(payload, tamperedPayload);
});

test('Cloudflare-native verifier reports signing-key fetch failure as runtime error', async () => {
  resetFirebaseJwksCacheForTests();
  const { sign } = await createSigner();
  const token = await sign(validPayload());
  await assert.rejects(
    verifyFirebaseIdToken(token, { FIREBASE_PROJECT_ID: 'brandal-bet' }, {
      fetchImpl: async () => new Response('upstream unavailable', { status: 503 }),
      cryptoImpl: crypto,
      nowMs: 1_800_000_000_000,
    }),
    error => error?.code === 'auth/key-fetch-failed',
  );
});
