import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';

const PROVIDER = 'goldslotpalase';

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

export async function ensureGoldslotPlayer(actor, { client, db = getAdminDb() } = {}) {
  if (!actor?.uid) throw new ServiceError('invalid_actor', 401);
  if (!client?.createUser) throw new ServiceError('provider_unconfigured', 503);

  const providerUsername = providerUsernameForUid(actor.uid);
  // Provider documents that creating the same name returns the existing player.
  // Re-resolving before launch also recovers from Transfer/Seamless mode migrations.
  const upstream = await client.createUser(providerUsername);
  const userCode = userCodeFromResponse(upstream);
  const ref = db.collection('providerPlayers').doc(actor.uid);
  const now = FieldValue.serverTimestamp();

  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const record = {
      uid: actor.uid,
      provider: PROVIDER,
      providerUsername,
      userCode,
      verifiedAt: now,
      updatedAt: now,
    };
    if (!snapshot.exists) record.createdAt = now;
    tx.set(ref, record, { merge: true });
  });

  return Object.freeze({ provider: PROVIDER, providerUsername, userCode });
}

export async function getGoldslotPlayer(uid, { db = getAdminDb() } = {}) {
  const snapshot = await db.collection('providerPlayers').doc(uid).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (data?.uid !== uid || data?.provider !== PROVIDER || !Number.isSafeInteger(data?.userCode) || data.userCode <= 0) {
    throw new ServiceError('provider_player_integrity_error', 503);
  }
  return Object.freeze({
    provider: PROVIDER,
    providerUsername: typeof data.providerUsername === 'string' ? data.providerUsername : providerUsernameForUid(uid),
    userCode: data.userCode,
  });
}
