import { createHash, timingSafeEqual } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

function header(headers = {}, wanted) {
  const key = Object.keys(headers).find(item => item.toLowerCase() === wanted);
  return key ? headers[key] : undefined;
}

function sessionIdFromEvent(event) {
  const authorization = header(event?.headers ?? {}, 'authorization');
  if (typeof authorization !== 'string') return null;
  const match = authorization.match(/^Bearer\s+[^\s;]+;\s*BrandalSession=([A-Za-z0-9_-]{43,128})$/i);
  return match ? match[1] : null;
}

function normalizeSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new ServiceError('invalid_member_session', 400);
  }
  return value;
}

function sessionHash(sessionId) {
  return createHash('sha256').update(sessionId, 'utf8').digest('base64url');
}

function equalHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function memberSingleSessionEnabled(env = process.env) {
  if (env.MEMBER_SINGLE_SESSION_ENABLED === 'false') return false;
  return env.MEMBER_SINGLE_SESSION_ENABLED === 'true' || env.CONTEXT === 'production';
}

export async function registerMemberDeviceSession(actor, input, { db = getAdminDb() } = {}) {
  if (!actor?.uid) throw new ServiceError('invalid_member_session', 401);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid_member_session', 400);
  const sessionId = normalizeSessionId(input.sessionId);
  const replace = input.replace === true;
  const hash = sessionHash(sessionId);
  const ref = db.collection('memberSessions').doc(actor.uid);

  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const current = snapshot.exists ? snapshot.data() : null;

    if (current?.active === false && !replace) throw new ServiceError('member_session_required', 401);
    if (current?.active === true && !equalHash(current.sessionHash, hash) && !replace) {
      throw new ServiceError('member_session_replaced', 401);
    }

    const sameActiveSession = current?.active === true && equalHash(current.sessionHash, hash);
    const revision = Number.isSafeInteger(current?.revision)
      ? current.revision + (sameActiveSession ? 0 : 1)
      : 1;
    const timestamp = FieldValue.serverTimestamp();

    tx.set(ref, {
      uid: actor.uid,
      sessionHash: hash,
      active: true,
      revision,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });

    return { active: true, revision };
  });
}

export async function assertMemberDeviceSession(actor, event, { db = getAdminDb() } = {}) {
  if (!actor?.uid) throw new ServiceError('member_session_required', 401);
  const ref = db.collection('memberSessions').doc(actor.uid);
  const snapshot = await ref.get();

  // Migration path: accounts that have never registered a device session keep
  // working until the V53+ member UI claims the first active session.
  if (!snapshot.exists) return { legacy: true, active: true, revision: 0 };

  const current = snapshot.data() ?? {};
  if (current.active !== true) throw new ServiceError('member_session_required', 401);

  const raw = sessionIdFromEvent(event);
  if (!raw) throw new ServiceError('member_session_required', 401);
  const hash = sessionHash(normalizeSessionId(raw));
  if (!equalHash(current.sessionHash, hash)) throw new ServiceError('member_session_replaced', 401);

  return {
    active: true,
    revision: Number.isSafeInteger(current.revision) ? current.revision : 0,
  };
}

export async function endMemberDeviceSession(actor, event, { db = getAdminDb() } = {}) {
  if (!actor?.uid) return { ended: false };
  const raw = sessionIdFromEvent(event);
  if (!raw) return { ended: false };

  let hash;
  try { hash = sessionHash(normalizeSessionId(raw)); }
  catch { return { ended: false }; }

  const ref = db.collection('memberSessions').doc(actor.uid);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { ended: false };
    const current = snapshot.data() ?? {};
    if (current.active !== true || !equalHash(current.sessionHash, hash)) return { ended: false };

    tx.set(ref, {
      ...current,
      active: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ended: true };
  });
}
