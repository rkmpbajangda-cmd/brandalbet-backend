import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDb } from './helpers/transaction-db.js';
import {
  registerMemberDeviceSession,
  assertMemberDeviceSession,
  endMemberDeviceSession,
  memberSingleSessionEnabled,
} from '../src/auth/member-device-session.js';

const actor = { uid: 'member-1' };
const one = 'a'.repeat(43);
const two = 'b'.repeat(43);
const event = sessionId => ({ headers: sessionId ? { 'x-brandal-session': sessionId } : {} });

test('single-session enforcement is automatically enabled in production', () => {
  assert.equal(memberSingleSessionEnabled({ CONTEXT: 'production' }), true);
  assert.equal(memberSingleSessionEnabled({ CONTEXT: 'production', MEMBER_SINGLE_SESSION_ENABLED: 'false' }), false);
  assert.equal(memberSingleSessionEnabled({}), false);
});

test('first device can claim session and same device can restore it', async () => {
  const db = transactionDb();
  const first = await registerMemberDeviceSession(actor, { sessionId: one, replace: false }, { db });
  assert.equal(first.active, true);
  assert.equal((await assertMemberDeviceSession(actor, event(one), { db })).active, true);
  const restored = await registerMemberDeviceSession(actor, { sessionId: one, replace: false }, { db });
  assert.equal(restored.revision, first.revision);
});

test('second interactive login replaces first device session', async () => {
  const db = transactionDb();
  await registerMemberDeviceSession(actor, { sessionId: one, replace: false }, { db });
  await registerMemberDeviceSession(actor, { sessionId: two, replace: true }, { db });
  await assert.rejects(assertMemberDeviceSession(actor, event(one), { db }), { code: 'member_session_replaced', statusCode: 401 });
  assert.equal((await assertMemberDeviceSession(actor, event(two), { db })).active, true);
});

test('background restore cannot steal an active session from another device', async () => {
  const db = transactionDb();
  await registerMemberDeviceSession(actor, { sessionId: one, replace: false }, { db });
  await assert.rejects(registerMemberDeviceSession(actor, { sessionId: two, replace: false }, { db }), { code: 'member_session_replaced', statusCode: 401 });
});

test('logout ends only the matching active device session', async () => {
  const db = transactionDb();
  await registerMemberDeviceSession(actor, { sessionId: one, replace: false }, { db });
  assert.deepEqual(await endMemberDeviceSession(actor, event(two), { db }), { ended: false });
  assert.deepEqual(await endMemberDeviceSession(actor, event(one), { db }), { ended: true });
  await assert.rejects(assertMemberDeviceSession(actor, event(one), { db }), { code: 'member_session_required', statusCode: 401 });
});
