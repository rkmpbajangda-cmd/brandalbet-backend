import test from 'node:test';
import assert from 'node:assert/strict';
import { auditDocId, makeAuditEvent } from '../src/audit/service.js';

test('audit event strips credential-like metadata and is deterministic', () => {
  const event = makeAuditEvent({
    actorUid: 'admin-1', action: 'member.update', targetId: 'member-1', requestId: 'req-1',
    metadata: { status: 'active', token: 'secret', password: 'secret', nested: { ok: true } },
  });
  assert.equal(event.actorUid, 'admin-1');
  assert.equal(event.action, 'member.update');
  assert.equal(event.metadata.status, 'active');
  assert.equal(event.metadata.token, undefined);
  assert.equal(event.metadata.password, undefined);
  assert.match(event.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(auditDocId({ action: 'x', requestId: 'r', actorUid: 'a', targetId: 't' }), auditDocId({ action: 'x', requestId: 'r', actorUid: 'a', targetId: 't' }));
});

test('audit requires actor and action', () => {
  assert.throws(() => makeAuditEvent({ action: 'x' }), /audit_actor_and_action_required/);
});
