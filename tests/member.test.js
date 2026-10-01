import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as createSessionHandler } from '../netlify/functions/member-session.js';
import { createHandler as createProfileHandler } from '../netlify/functions/member-profile.js';
import { createHandler as createWalletHandler } from '../netlify/functions/wallet.js';
import { createHandler as createOnboardingHandler } from '../netlify/functions/member-onboarding.js';
import { createHandler as createBankHandler } from '../netlify/functions/member-bank-account.js';
import { sanitizeProfilePatch, ProfileValidationError } from '../src/member/profile.js';
import { sanitizeBankAccount, maskAccountNumber, BankAccountValidationError } from '../src/member/bank-account.js';
import { sanitizeOnboardingPayload, OnboardingValidationError } from '../src/member/onboarding.js';

const event = (method = 'GET', body) => ({
  httpMethod: method,
  headers: { Authorization: 'Bearer test-token' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const verify = async () => ({ uid: 'user-1', email: 'member@example.invalid', role: 'member' });

test('member session returns profile, masked bank and wallet', async () => {
  const handler = createSessionHandler({
    verifyIdToken: verify,
    loadProfile: async (actor) => ({ uid: actor.uid, email: actor.email, onboardingCompleted: true }),
    loadBankAccount: async (uid) => ({ uid, provider: 'BCA', maskedAccountNumber: '•••• 1234', last4: '1234' }),
    loadWallet: async (uid) => ({ uid, currency: 'IDR', balanceMinor: 0, availableMinor: 0, status: 'active' }),
  });
  const response = await handler(event());
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    profile: { uid: 'user-1', email: 'member@example.invalid', onboardingCompleted: true },
    bankAccount: { uid: 'user-1', provider: 'BCA', maskedAccountNumber: '•••• 1234', last4: '1234' },
    wallet: { uid: 'user-1', currency: 'IDR', balanceMinor: 0, availableMinor: 0, status: 'active' },
  });
});

test('wallet endpoint is read-only for member clients', async () => {
  const handler = createWalletHandler({
    verifyIdToken: verify,
    loadWallet: async (uid) => ({ uid, currency: 'IDR', balanceMinor: 1000, availableMinor: 1000, status: 'active' }),
  });
  assert.equal((await handler(event('GET'))).statusCode, 200);
  assert.equal((await handler(event('POST'))).statusCode, 405);
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

test('bank account validation accepts known provider and masks output', () => {
  assert.deepEqual(sanitizeBankAccount({ type: 'bank', provider: 'BCA', accountNumber: '0012-3456-7890', accountName: 'Member' }), {
    type: 'bank', provider: 'BCA', accountNumber: '001234567890', accountName: 'Member',
  });
  assert.equal(maskAccountNumber('001234567890'), '•••• 7890');
  assert.throws(
    () => sanitizeBankAccount({ type: 'bank', provider: 'FAKEBANK', accountNumber: '123456', accountName: 'Member' }),
    (error) => error instanceof BankAccountValidationError && error.code === 'unsupported_payment_provider',
  );
});

test('bank endpoint never returns raw account number', async () => {
  const handler = createBankHandler({
    verifyIdToken: verify,
    loadBankAccount: async (uid) => ({ uid, type: 'bank', provider: 'BCA', accountName: 'Member', maskedAccountNumber: '•••• 7890', last4: '7890' }),
    saveMemberBankAccount: async (uid) => ({ uid, type: 'bank', provider: 'BCA', accountName: 'Member', maskedAccountNumber: '•••• 7890', last4: '7890' }),
  });
  const getResponse = await handler(event('GET'));
  assert.equal(getResponse.statusCode, 200);
  assert.equal(JSON.parse(getResponse.body).bankAccount.accountNumber, undefined);
  const putResponse = await handler(event('PUT', { type: 'bank', provider: 'BCA', accountNumber: '001234567890', accountName: 'Member' }));
  assert.equal(putResponse.statusCode, 200);
  assert.equal(JSON.parse(putResponse.body).bankAccount.accountNumber, undefined);
});

test('onboarding payload validates account, username and bank data', () => {
  const safe = sanitizeOnboardingPayload({
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
    onboard: async () => { throw new OnboardingValidationError('username_taken', 409); },
  });
  const response = await handler(event('POST', {
    username: 'member123', displayName: 'Member', phone: '08123456789',
    bankAccount: { type: 'bank', provider: 'BCA', accountNumber: '123456789', accountName: 'Member' },
  }));
  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'username_taken' });
});
