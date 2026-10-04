import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';
import {
  backofficeRewardOverview,
  finalizeRewardWeekBatch,
  rewardWeekBounds,
} from './service.js';

const PROVIDER_SYNC_STATE_ID = 'goldslotpalase-transactions';
const SETTLEMENT_LAG_MS = 15 * 60 * 1000;

export async function assertVerifiedRewardSource(weekKey, {
  env = process.env,
  db = getAdminDb(env),
} = {}) {
  const bounds = rewardWeekBounds(weekKey);
  if (env.REWARDS_PAYOUT_ENABLED !== 'true') {
    throw new ServiceError('reward_payout_disabled', 409);
  }
  if (env.GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED !== 'true') {
    throw new ServiceError('reward_source_disabled', 409);
  }

  const [integritySnapshot, sourceSnapshot] = await Promise.all([
    db.collection('rewardWeekIntegrity').doc(weekKey).get(),
    db.collection('providerSyncStates').doc(PROVIDER_SYNC_STATE_ID).get(),
  ]);

  const integrity = integritySnapshot.exists ? integritySnapshot.data() : null;
  if (integrity?.status === 'blocked') {
    throw new ServiceError('reward_week_integrity_blocked', 409);
  }

  const source = sourceSnapshot.exists ? sourceSnapshot.data() : null;
  const requiredSuccessAtMs = bounds.endMs + SETTLEMENT_LAG_MS;
  const sourceReady = source?.status === 'ready'
    && Number.isSafeInteger(source?.lastSuccessAtMs)
    && source.lastSuccessAtMs >= requiredSuccessAtMs
    && source?.hasMore !== true;

  if (!sourceReady) throw new ServiceError('reward_source_not_ready', 409);

  return Object.freeze({
    bounds,
    integrity: integrity ?? { weekKey, status: 'clear' },
    source,
    requiredSuccessAtMs,
  });
}

export async function finalizeVerifiedRewardWeekBatch(weekKey, {
  env = process.env,
  db = getAdminDb(env),
  ...options
} = {}) {
  await assertVerifiedRewardSource(weekKey, { env, db });
  return finalizeRewardWeekBatch(weekKey, { db, ...options });
}

export async function verifiedBackofficeRewardOverview(actor, event, {
  env = process.env,
  db = getAdminDb(env),
  now = Date.now(),
} = {}) {
  const base = await backofficeRewardOverview(actor, event, { db, now });
  const weekKey = base.week.weekKey;
  const [integritySnapshot, sourceSnapshot] = await Promise.all([
    db.collection('rewardWeekIntegrity').doc(weekKey).get(),
    db.collection('providerSyncStates').doc(PROVIDER_SYNC_STATE_ID).get(),
  ]);
  const integrity = integritySnapshot.exists ? integritySnapshot.data() : { weekKey, status: 'clear' };
  const source = sourceSnapshot.exists ? sourceSnapshot.data() : { status: 'not_initialized' };
  const requiredSuccessAtMs = base.week.endMs + SETTLEMENT_LAG_MS;
  const sourceReady = env.GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED === 'true'
    && source?.status === 'ready'
    && Number.isSafeInteger(source?.lastSuccessAtMs)
    && source.lastSuccessAtMs >= requiredSuccessAtMs
    && source?.hasMore !== true
    && integrity?.status !== 'blocked';

  return {
    ...base,
    payoutEnabled: env.REWARDS_PAYOUT_ENABLED === 'true',
    transactionSyncEnabled: env.GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED === 'true',
    sourceReady,
    sourceReadyAfter: new Date(requiredSuccessAtMs).toISOString(),
    source,
    integrity,
  };
}
