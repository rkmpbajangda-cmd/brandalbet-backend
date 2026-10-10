import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '../src/utils/errors.js';
import { diagnosticFor } from '../src/utils/diagnostics.js';

test('diagnostic exposes safe member session context without secrets', () => {
  const error = new ServiceError('member_session_required', 401);
  const diagnostic = diagnosticFor(error, {
    event: {
      path: '/api/member-session',
      headers: { 'x-request-id': 'BB-REQ-12345678' },
    },
    scope: 'member',
    actor: { uid: 'uid-example', email: 'member@example.invalid' },
    operation: 'member-session',
  });

  assert.equal(diagnostic.code, 'member_session_required');
  assert.equal(diagnostic.httpStatus, 401);
  assert.equal(diagnostic.stage, 'MEMBER_DEVICE_SESSION');
  assert.equal(diagnostic.component, 'Cloudflare Worker + Firestore');
  assert.equal(diagnostic.requestId, 'BB-REQ-12345678');
  assert.equal(diagnostic.safeContext.uid, 'uid-example');
  assert.equal(diagnostic.safeContext.firebaseAuthenticated, true);
  assert.equal(diagnostic.safeContext.memberSession, 'required');
  assert.equal('email' in diagnostic.safeContext, false);
});

test('unknown errors are represented without exposing stack or message', () => {
  const error = new Error('secret internal implementation detail');
  const diagnostic = diagnosticFor(error, {
    event: { path: '/api/backoffice-members', headers: {} },
    scope: 'backoffice',
    operation: 'backoffice-members',
  });

  assert.equal(diagnostic.code, 'internal_error');
  assert.equal(diagnostic.stage, 'BACKOFFICE_API');
  assert.equal(diagnostic.component, 'Cloudflare Worker');
  assert.equal(typeof diagnostic.requestId, 'string');
  assert.equal(diagnostic.message, 'Terjadi error internal yang tidak aman untuk ditampilkan sebagai stack trace.');
  assert.equal(diagnostic.message.includes('secret internal'), false);
});
