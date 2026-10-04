import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDb } from './helpers/transaction-db.js';
import { finalizeRewardWeekBatch } from '../src/rewards/service.js';

const closedNow = Date.parse('2026-10-05T01:00:00.000Z');
const weekKey = '2026-09-28';

test('reward payout cannot finalize while payout gate is disabled', async () => {
  const db = transactionDb();
  await assert.rejects(
    finalizeRewardWeekBatch(weekKey, {
      db,
      now: closedNow,
      env: {
        REWARDS_PAYOUT_ENABLED: 'false',
        GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED: 'true',
      },
    }),
    { code: 'reward_payout_disabled' },
  );
});

test('reward payout cannot finalize without a verified provider transaction source', async () => {
  const db = transactionDb();
  await assert.rejects(
    finalizeRewardWeekBatch(weekKey, {
      db,
      now: closedNow,
      env: {
        REWARDS_PAYOUT_ENABLED: 'true',
        GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED: 'false',
      },
    }),
    { code: 'reward_source_disabled' },
  );
});

test('reward payout cannot finalize when provider sync has not completed after week close', async () => {
  const db = transactionDb({
    'providerSyncStates/goldslotpalase-transactions': {
      provider: 'goldslotpalase',
      status: 'ready',
      lastId: 123,
      lastSuccessAtMs: Date.parse('2026-10-04T17:05:00.000Z'),
      hasMore: false,
    },
  });
  await assert.rejects(
    finalizeRewardWeekBatch(weekKey, {
      db,
      now: closedNow,
      env: {
        REWARDS_PAYOUT_ENABLED: 'true',
        GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED: 'true',
      },
    }),
    { code: 'reward_source_not_ready' },
  );
});

test('reward payout cannot finalize a week with reconciliation integrity block', async () => {
  const db = transactionDb({
    'rewardWeekIntegrity/2026-09-28': {
      weekKey: '2026-09-28',
      status: 'blocked',
      reason: 'late_round_mutation',
    },
    'providerSyncStates/goldslotpalase-transactions': {
      provider: 'goldslotpalase',
      status: 'ready',
      lastId: 123,
      lastSuccessAtMs: Date.parse('2026-10-05T00:00:00.000Z'),
      hasMore: false,
    },
  });
  await assert.rejects(
    finalizeRewardWeekBatch(weekKey, {
      db,
      now: closedNow,
      env: {
        REWARDS_PAYOUT_ENABLED: 'true',
        GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED: 'true',
      },
    }),
    { code: 'reward_week_integrity_blocked' },
  );
});
