import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateRequest, AuthHttpError } from '../src/auth/authenticate.js';
import { canAccessBackoffice, canAccessMember } from '../src/rbac/roles.js';
import { createHandler as createMeHandler } from '../cloudflare/functions/me.js';
import { createHandler as createBackofficeHealthHandler } from '../cloudflare/functions/backoffice-health.js';

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

test('known invalid Firebase token fails closed with 401', async () => {
  const invalid = new Error('bad token');
  invalid.code = 'auth/invalid-id-token';
  await assert.rejects(
    authenticateRequest(eventWithToken(), { verifyIdToken: async () => { throw invalid; } }),
    (error) => error instanceof AuthHttpError && error.statusCode === 401 && error.code === 'invalid_or_expired_id_token',
  );
});

test('unknown Firebase Admin runtime error is reported as backend availability error', async () => {
  await assert.rejects(
    authenticateRequest(eventWithToken(), { verifyIdToken: async () => { throw new Error('edge runtime failure'); } }),
    (error) => error instanceof AuthHttpError && error.statusCode === 503 && error.code === 'auth_verifier_runtime_error',
  );
});

test('Firebase Admin project mismatch is reported as backend configuration error', async () => {
  const mismatch = new Error('project mismatch');
  mismatch.code = 'firebase_admin_project_mismatch';
  await assert.rejects(
    authenticateRequest(eventWithToken(), { verifyIdToken: async () => { throw mismatch; } }),
    (error) => error instanceof AuthHttpError && error.statusCode === 503 && error.code === 'auth_project_mismatch',
  );
});

test('device-session suffix does not alter the Firebase bearer token', async () => {
  let observed;
  const sessionId = 'a'.repeat(43);
  const actor = await authenticateRequest({
    headers: { Authorization: `Bearer firebase-token;BrandalSession=${sessionId}` },
  }, {
    verifyIdToken: async token => { observed = token; return { uid: 'member-1' }; },
  });
  assert.equal(observed, 'firebase-token');
  assert.equal(actor.uid, 'member-1');
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

test('backoffice health forwards request-scoped Cloudflare env to token verifier and CORS', async () => {
  const env = { ALLOWED_BACKOFFICE_ORIGINS: 'https://admin.example.test' };
  let observedEnv;
  const handler = createBackofficeHealthHandler({
    env,
    verifyIdToken: async (_token, receivedEnv) => {
      observedEnv = receivedEnv;
      return { uid: 'admin-1', role: 'superadmin', backoffice: true };
    },
  });
  const response = await handler({
    httpMethod: 'GET',
    headers: { Authorization: 'Bearer test-token', Origin: 'https://admin.example.test' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://admin.example.test');
  assert.equal(observedEnv, env);
});


test('member RBAC permits a new Firebase user without custom claims only in member scope', () => {
  assert.equal(canAccessMember({ uid: 'new-member' }), true);
  assert.equal(canAccessMember({ uid: 'new-member', role: null, backoffice: false }), true);
  assert.equal(canAccessMember({ uid: 'member-1', role: 'member', backoffice: false }), true);
  assert.equal(canAccessMember({ uid: 'operator-1', role: 'operator', backoffice: false }), false);
  assert.equal(canAccessMember({ uid: 'admin-1', role: 'admin', backoffice: false }), false);
  assert.equal(canAccessMember({ uid: 'admin-1', role: 'admin', backoffice: true }), false);
  assert.equal(canAccessMember({ uid: 'backoffice-1', role: 'superadmin', backoffice: true }), false);
  assert.equal(canAccessMember(null), false);
});

test('backoffice and member scopes remain mutually exclusive', () => {
  assert.equal(canAccessBackoffice({ role: 'superadmin', backoffice: true }), true);
  assert.equal(canAccessMember({ role: 'superadmin', backoffice: true }), false);
  assert.equal(canAccessBackoffice({ role: 'member', backoffice: false }), false);
});
