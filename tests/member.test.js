import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as createSessionHandler } from '../netlify/functions/member-session.js';
import { createHandler as createProfileHandler } from '../netlify/functions/member-profile.js';
import { createHandler as createWalletHandler } from '../netlify/functions/wallet.js';
import { sanitizeProfilePatch, ProfileValidationError } from '../src/member/profile.js';

const event = (method = 'GET', body) => ({
  httpMethod: method,
  headers: { Authorization: 'Bearer test-token' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const verify = async () => ({ uid: 'user-1', email: 'member@example.invalid', role: 'member' });

test('member session returns profile and wallet from server-authoritative loaders', async () => {
  const handler = createSessionHandler({
    verifyIdToken: verify,
    loadProfile: async (actor) => ({ uid: actor.uid, email: actor.email }),
    loadWallet: async (uid) => ({ uid, currency: 'IDR', balanceMinor: 0, availableMinor: 0, status: 'active' }),
  });
  const response = await handler(event());
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    profile: { uid: 'user-1', email: 'member@example.invalid' },
    wallet: { uid: 'user-1', currency: 'IDR', balanceMinor: 0, availableMinor: 0, status: 'active' },
  });
});

test('wallet endpoint is read-only for member clients', async () => {
  const handler = createWalletHandler({
    verifyIdToken: verify,
    loadWallet: async (uid) => ({ uid, currency: 'IDR', balanceMinor: 1000, availableMinor: 1000, status: 'active' }),
  });
  const getResponse = await handler(event('GET'));
  assert.equal(getResponse.statusCode, 200);
  const postResponse = await handler(event('POST'));
  assert.equal(postResponse.statusCode, 405);
});

test('profile update permits only safe editable fields', () => {
  assert.deepEqual(
    sanitizeProfilePatch({ displayName: ' Member ', phone: '08123', language: 'id', timezone: 'Asia/Jakarta' }),
    { displayName: 'Member', phone: '08123', language: 'id', timezone: 'Asia/Jakarta' },
  );
  assert.throws(
    () => sanitizeProfilePatch({ role: 'superadmin' }),
    (error) => error instanceof ProfileValidationError && error.code === 'unsupported_profile_field',
  );
});

test('profile handler rejects privilege fields before storage', async () => {
  const handler = createProfileHandler({
    verifyIdToken: verify,
    loadProfile: async (actor) => ({ uid: actor.uid }),
    saveProfile: async (_actor, patch) => sanitizeProfilePatch(patch),
  });
  const response = await handler(event('PUT', { balanceMinor: 999999 }));
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'unsupported_profile_field' });
});
