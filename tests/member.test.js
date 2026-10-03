import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as createSessionHandler } from '../netlify/functions/member-session.js';
import { createHandler as createWalletHandler } from '../netlify/functions/wallet.js';
import { createHandler as createProfileHandler } from '../netlify/functions/member-profile.js';
import { createHandler as createBankHandler } from '../netlify/functions/member-bank-account.js';
import { createHandler as createOnboardingHandler } from '../netlify/functions/member-onboarding.js';
import { validateBankAccount } from '../src/member/bank.js';
import { validateOnboardingPayload, OnboardingValidationError } from '../src/member/onboarding.js';

const actor = { uid: 'user-1', email: 'member@example.invalid' };
const verify = async () => actor;
const event = (method = 'GET', body) => ({
  httpMethod: method,
  headers: { Authorization: 'Bearer test', 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
  queryStringParameters: {},
});

test('member session returns profile, masked bank and wallet', async () => {
  const handler = createSessionHandler({
    verifyIdToken: verify,
    loadProfile: async () => ({ uid: actor.uid, username: 'member', displayName: 'Member', onboardingCompleted: true }),
    loadBank: async () => ({ provider: 'BCA', accountName: 'MEMBER', maskedAccount: '******7890' }),
    loadWallet: async () => ({ currency: 'IDR', balanceMinor: 1000, availableMinor: 1000, status: 'active' }),
  });
  const response = await handler(event());
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.profile.username, 'member');
  assert.equal(body.bankAccount.maskedAccount, '******7890');
  assert.equal(body.wallet.balanceMinor, 1000);
});

test('wallet endpoint is read-only for member clients', async () => {
  const handler = createWalletHandler({ verifyIdToken: verify, loadWallet: async () => ({ balanceMinor: 10 }) });
  assert.equal((await handler(event('GET'))).statusCode, 200);
  assert.equal((await handler(event('POST', { balanceMinor: 999999 }))).statusCode, 405);
});

test('profile update permits only safe editable fields', async () => {
  let seen;
  const handler = createProfileHandler({
    verifyIdToken: verify,
    loadProfile: async () => ({ uid: actor.uid, username: 'member', displayName: 'Old' }),
    updateProfile: async (_actor, input) => { seen = input; return { uid: actor.uid, ...input }; },
  });
  const response = await handler(event('POST', { displayName: 'New Name', phone: '08123456789' }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, { displayName: 'New Name', phone: '08123456789' });
});

test('profile handler rejects privilege fields before storage', async () => {
  let called = false;
  const handler = createProfileHandler({
    verifyIdToken: verify,
    updateProfile: async () => { called = true; return {}; },
  });
  const response = await handler(event('POST', { role: 'superadmin' }));
  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
});

test('bank account validation accepts known provider and masks output', () => {
  const safe = validateBankAccount({
    type: 'bank', provider: 'BCA', accountNumber: '1234567890', accountName: 'Member Test',
  });
  assert.equal(safe.provider, 'BCA');
  assert.equal(safe.maskedAccount, '******7890');
});

test('bank endpoint never returns raw account number', async () => {
  const handler = createBankHandler({
    verifyIdToken: verify,
    load: async () => ({ provider: 'BCA', accountName: 'MEMBER', maskedAccount: '******7890' }),
    update: async () => ({ provider: 'BCA', accountName: 'MEMBER', maskedAccount: '******7890' }),
  });
  const response = await handler(event('GET'));
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes('1234567890'));
});

test('onboarding payload validates account, username and bank data', () => {
  const safe = validateOnboardingPayload({
    username: 'Brandal.123',
    displayName: 'Member Test',
    phone: '+628123456789',
    referralCode: 'REF_01',
    bankAccount: { type: 'ewallet', provider: 'DANA', accountNumber: '081234567890', accountName: 'Member Test' },
  });
  assert.equal(safe.usernameNormalized, 'brandal.123');
  assert.equal(safe.bankAccount.provider, 'DANA');
});

test('onboarding handler maps username conflict to 409', async () => {
  const handler = createOnboardingHandler({
    verifyIdToken: verify,
    loadControl: async () => ({ maintenanceMode: false, registrationEnabled: true }),
    onboard: async () => { throw new OnboardingValidationError('username_taken', 409); },
  });
  const response = await handler(event('POST', {
    username: 'member123', displayName: 'Member', phone: '08123456789',
    bankAccount: { type: 'bank', provider: 'BCA', accountNumber: '123456789', accountName: 'Member' },
  }));
  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'username_taken' });
});
