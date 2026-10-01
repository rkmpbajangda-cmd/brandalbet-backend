import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateRequest, AuthHttpError } from '../src/auth/authenticate.js';
import { canAccessBackoffice } from '../src/rbac/roles.js';
import { createHandler as createMeHandler } from '../netlify/functions/me.js';
import { createHandler as createBackofficeHealthHandler } from '../netlify/functions/backoffice-health.js';

const eventWithToken = (token = 'test-token') => ({
  httpMethod: 'GET',
  headers: { Authorization: `Bearer ${token}` },
});

test('missing bearer token fails closed with 401', async () => {
  await assert.rejects(
    authenticateRequest({ headers: {} }, { verifyIdToken: async () => ({ uid: 'ignored' }) }),
    (error) => error instanceof AuthHttpError && error.statusCode === 401 && error.code === 'missing_bearer_token',
  );
});

test('invalid token fails closed with 401', async () => {
  await assert.rejects(
    authenticateRequest(eventWithToken(), { verifyIdToken: async () => { throw new Error('bad token'); } }),
    (error) => error instanceof AuthHttpError && error.statusCode === 401 && error.code === 'invalid_or_expired_id_token',
  );
});

test('backoffice requires both claim and an allowed role', () => {
  assert.equal(canAccessBackoffice({ role: 'member', backoffice: true }), false);
  assert.equal(canAccessBackoffice({ role: 'admin', backoffice: false }), false);
  assert.equal(canAccessBackoffice({ role: 'unknown', backoffice: true }), false);
  assert.equal(canAccessBackoffice({ role: 'operator', backoffice: true }), true);
  assert.equal(canAccessBackoffice({ role: 'finance', backoffice: true }), true);
  assert.equal(canAccessBackoffice({ role: 'admin', backoffice: true }), true);
  assert.equal(canAccessBackoffice({ role: 'superadmin', backoffice: true }), true);
});

test('me endpoint returns only safe identity fields', async () => {
  const handler = createMeHandler({ verifyIdToken: async () => ({ uid: 'user-1', role: 'member', backoffice: false, email: 'hidden@example.invalid' }) });
  const response = await handler(eventWithToken());
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, uid: 'user-1', role: 'member', backoffice: false });
});

test('backoffice endpoint denies member and allows superadmin', async () => {
  const memberHandler = createBackofficeHealthHandler({ verifyIdToken: async () => ({ uid: 'member-1', role: 'member', backoffice: false }) });
  const memberResponse = await memberHandler(eventWithToken());
  assert.equal(memberResponse.statusCode, 403);

  const adminHandler = createBackofficeHealthHandler({ verifyIdToken: async () => ({ uid: 'admin-1', role: 'superadmin', backoffice: true }) });
  const adminResponse = await adminHandler(eventWithToken());
  assert.equal(adminResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(adminResponse.body), { ok: true, service: 'brandalbet-backend', scope: 'backoffice' });
});
