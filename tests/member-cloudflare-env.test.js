import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler as createSessionHandler } from '../cloudflare/functions/member-session.js';
import { createHandler as createProfileHandler } from '../cloudflare/functions/member-profile.js';
import { createHandler as createBankHandler } from '../cloudflare/functions/member-bank-account.js';
import { createHandler as createWalletHandler } from '../cloudflare/functions/wallet.js';
import { createHandler as createTransactionsHandler } from '../cloudflare/functions/transactions.js';

const ORIGIN = 'https://member.example.com';
const env = {
  ALLOWED_MEMBER_ORIGINS: ORIGIN,
  MEMBER_SINGLE_SESSION_ENABLED: 'false',
};

const verify = async () => ({
  uid: 'member-1',
  email: 'member@example.invalid',
  role: 'member',
});

function event(method = 'GET') {
  return {
    httpMethod: method,
    headers: {
      Authorization: 'Bearer test-token',
      Origin: ORIGIN,
    },
  };
}

function assertAllowed(response) {
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Access-Control-Allow-Origin'], ORIGIN);
}

test('member session uses the Cloudflare request env for CORS', async () => {
  const handler = createSessionHandler({
    verifyIdToken: verify,
    env,
    loadProfile: async actor => ({ uid: actor.uid, onboardingCompleted: true }),
    loadBankAccount: async uid => ({ uid, provider: 'BCA', last4: '1234' }),
    loadWallet: async uid => ({ uid, currency: 'IDR', balanceMinor: 0, availableMinor: 0, status: 'active' }),
  });
  assertAllowed(await handler(event()));
});

test('member profile uses the Cloudflare request env for CORS', async () => {
  const handler = createProfileHandler({
    verifyIdToken: verify,
    env,
    loadProfile: async actor => ({ uid: actor.uid }),
  });
  assertAllowed(await handler(event()));
});

test('member bank account uses the Cloudflare request env for CORS', async () => {
  const handler = createBankHandler({
    verifyIdToken: verify,
    env,
    loadBankAccount: async uid => ({ uid, provider: 'BCA', last4: '1234' }),
  });
  assertAllowed(await handler(event()));
});

test('member wallet uses the Cloudflare request env for CORS', async () => {
  const handler = createWalletHandler({
    verifyIdToken: verify,
    env,
    loadWallet: async uid => ({ uid, currency: 'IDR', balanceMinor: 0, availableMinor: 0, status: 'active' }),
  });
  assertAllowed(await handler(event()));
});

test('member transactions pass the Cloudflare request env into protectedHandler', async () => {
  const handler = createTransactionsHandler({
    verifyIdToken: verify,
    env,
    list: async () => [],
  });
  assertAllowed(await handler(event()));
});
