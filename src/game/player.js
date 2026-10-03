import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';

const PROVIDER = 'goldslotpalase';
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;
const MEMORY_TTL_MS = 15 * 60 * 1000;
const MAX_MEMORY_ENTRIES = 1000;
const memoryCache = new Map();

export function providerUsernameForUid(uid) {
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/')) {
    throw new ServiceError('invalid_uid');
  }
  return 'bb_' + createHash('sha256').update(uid).digest('hex').slice(0, 32);
}

function userCodeFromResponse(data) {
  const value = data?.user_code;
  if (!Number.isSafeInteger(value) || value <= 0) throw new ServiceError('provider_invalid_user_mapping', 503);
  return value;
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function playerFromRow(uid, data) {
  if (!data) return null;
  if (data.uid !== uid || data.provider !== PROVIDER || !Number.isSafeInteger(data.userCode) || data.userCode <= 0) {
    throw new ServiceError('provider_player_integrity_error', 503);
  }
  return Object.freeze({
    provider: PROVIDER,
    providerUsername: typeof data.providerUsername === 'string' && data.providerUsername
      ? data.providerUsername
      : providerUsernameForUid(uid),
    userCode: data.userCode,
    verifiedAtMs: timestampMs(data.verifiedAt),
  });
}

function memoryGet(uid, current) {
  const item = memoryCache.get(uid);
  if (!item || current >= item.expiresAt) {
    if (item) memoryCache.delete(uid);
    return null;
  }
  return item.player;
}

function memoryPut(uid, player, current) {
  if (memoryCache.size >= MAX_MEMORY_ENTRIES && !memoryCache.has(uid)) {
    const first = memoryCache.keys().next().value;
    if (first) memoryCache.delete(first);
  }
  memoryCache.set(uid, { player, expiresAt: current + MEMORY_TTL_MS });
}

export function clearGoldslotPlayerCacheForTest() {
  memoryCache.clear();
}

export async function ensureGoldslotPlayer(actor, {
  client,
  db = getAdminDb(),
  now = Date.now,
  refreshMs = DEFAULT_REFRESH_MS,
} = {}) {
  if (!actor?.uid) throw new ServiceError('invalid_actor', 401);
  if (!client?.createUser) throw new ServiceError('provider_unconfigured', 503);
  if (!Number.isSafeInteger(refreshMs) || refreshMs < 60_000 || refreshMs > 7 * 24 * 60 * 60 * 1000) {
    throw new ServiceError('invalid_provider_player_refresh');
  }

  const current = now();
  const warm = memoryGet(actor.uid, current);
  if (warm) return warm;

  const ref = db.collection('providerPlayers').doc(actor.uid);
  const existingSnapshot = await ref.get();
  if (existingSnapshot.exists) {
    const existing = playerFromRow(actor.uid, existingSnapshot.data());
    if (existing && existing.verifiedAtMs > 0 && current - existing.verifiedAtMs < refreshMs) {
      const stable = Object.freeze({
        provider: existing.provider,
        providerUsername: existing.providerUsername,
        userCode: existing.userCode,
      });
      memoryPut(actor.uid, stable, current);
      return stable;
    }
  }

  const providerUsername = providerUsernameForUid(actor.uid);
  // The provider documents createUser(name) as idempotent for an existing name.
  // Revalidation is periodic instead of happening on every game click.
  const upstream = await client.createUser(providerUsername);
  const userCode = userCodeFromResponse(upstream);
  const serverNow = FieldValue.serverTimestamp();

  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const record = {
      uid: actor.uid,
      provider: PROVIDER,
      providerUsername,
      userCode,
      verifiedAt: serverNow,
      updatedAt: serverNow,
    };
    if (!snapshot.exists) record.createdAt = serverNow;
    tx.set(ref, record, { merge: true });
  });

  const player = Object.freeze({ provider: PROVIDER, providerUsername, userCode });
  memoryPut(actor.uid, player, current);
  return player;
}

export async function getGoldslotPlayer(uid, { db = getAdminDb(), now = Date.now } = {}) {
  const current = now();
  const warm = memoryGet(uid, current);
  if (warm) return warm;

  const snapshot = await db.collection('providerPlayers').doc(uid).get();
  if (!snapshot.exists) return null;
  const row = playerFromRow(uid, snapshot.data());
  const player = Object.freeze({
    provider: row.provider,
    providerUsername: row.providerUsername,
    userCode: row.userCode,
  });
  memoryPut(uid, player, current);
  return player;
}
