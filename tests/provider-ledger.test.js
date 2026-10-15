import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDb } from './helpers/transaction-db.js';
import {
  GOLDSLOT_TRANSACTION_TYPES,
  PROVIDER_LEDGER_STORAGE_POLICY,
  applyGoldslotTransactionToRound,
  finalizeReadyGoldslotRounds,
  goldslotMoneyToMinor,
  ingestGoldslotProviderTransaction,
  ingestGoldslotProviderTransactionBatch,
  normalizeGoldslotTransaction,
  syncGoldslotProviderTransactions,
} from '../src/game/provider-ledger.js';

const env = { GOLDSLOTPALASE_IDR_SCALE: '1', GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED: 'false' };

function rawTransaction(overrides = {}) {
  return {
    trans_id: 1001,
    user_code: 501,
    round_id: 'round-001',
    trans_type: 1,
    provider_id: 10,
    provider_name: 'Provider Test',
    game_code: 'slot-test',
    game_name: 'Slot Test',
    category: 'slot',
    prebalance: 1000000,
    trans_amount: 100000,
    balance: 900000,
    time_stamp: 1791000000,
    ...overrides,
  };
}

test('free-tier storage policy never persists raw provider transaction history', () => {
  assert.equal(PROVIDER_LEDGER_STORAGE_POLICY.rawTransactionsPersisted, false);
  assert.equal(PROVIDER_LEDGER_STORAGE_POLICY.pendingRoundsOnly, true);
  assert.equal(PROVIDER_LEDGER_STORAGE_POLICY.completedRoundsDeletedAfterAggregation, true);
});

test('provider money conversion is exact and requires an explicitly verified scale', () => {
  assert.equal(goldslotMoneyToMinor('125.50', { GOLDSLOTPALASE_IDR_SCALE: '100' }), 12550);
  assert.equal(goldslotMoneyToMinor(100000, env), 100000);
  assert.throws(() => goldslotMoneyToMinor('0.001', { GOLDSLOTPALASE_IDR_SCALE: '100' }), { code: 'provider_money_precision_unverified' });
  assert.throws(() => goldslotMoneyToMinor(100, {}), { code: 'provider_money_scale_unconfigured' });
});

test('Goldslot transaction normalization preserves provider identifiers and canonical money', () => {
  const row = normalizeGoldslotTransaction(rawTransaction(), { env });
  assert.equal(row.transId, 1001);
  assert.equal(row.userCode, 501);
  assert.equal(row.roundId, 'round-001');
  assert.equal(row.transType, GOLDSLOT_TRANSACTION_TYPES.BET);
  assert.equal(row.amountMinor, 100000);
  assert.equal(row.balanceMinor, 900000);
  assert.match(row.providerAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('round accumulator treats BetCancel as reversal and BonusCall as win', () => {
  const bet = normalizeGoldslotTransaction(rawTransaction(), { env });
  let round = applyGoldslotTransactionToRound(null, bet, 'member-1');
  assert.equal(round.betAmountMinor, 100000);
  assert.equal(round.effectiveBetMinor, 100000);
  assert.equal(round.hasSettlement, false);

  const cancel = normalizeGoldslotTransaction(rawTransaction({
    trans_id: 1002,
    trans_type: GOLDSLOT_TRANSACTION_TYPES.BET_CANCEL,
    trans_amount: 25000,
  }), { env });
  round = applyGoldslotTransactionToRound(round, cancel, 'member-1');
  assert.equal(round.cancelAmountMinor, 25000);
  assert.equal(round.effectiveBetMinor, 75000);

  const bonusWin = normalizeGoldslotTransaction(rawTransaction({
    trans_id: 1003,
    trans_type: GOLDSLOT_TRANSACTION_TYPES.BONUS_CALL,
    trans_amount: 30000,
  }), { env });
  round = applyGoldslotTransactionToRound(round, bonusWin, 'member-1');
  assert.equal(round.winAmountMinor, 30000);
  assert.equal(round.hasSettlement, true);
  assert.equal(round.status, 'pending');
});

test('single transaction ingestion is replay-safe without a raw transaction document', async () => {
  const db = transactionDb();
  const resolveUid = async () => 'member-1';
  const bet = rawTransaction();
  const first = await ingestGoldslotProviderTransaction(bet, { db, env, resolveUid });
  const replay = await ingestGoldslotProviderTransaction(bet, { db, env, resolveUid });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);

  assert.equal(db.entries().filter(([path]) => path.startsWith('providerTransactions/')).length, 0);
  const providerRounds = db.entries().filter(([path]) => path.startsWith('providerGameRounds/'));
  assert.equal(providerRounds.length, 1);
  assert.equal(providerRounds[0][1].effectiveBetMinor, 100000);
  assert.equal(Object.keys(providerRounds[0][1].eventDigests).length, 1);

  await assert.rejects(
    ingestGoldslotProviderTransaction({ ...bet, trans_amount: 120000 }, { db, env, resolveUid }),
    { code: 'provider_transaction_idempotency_conflict' },
  );
});

test('Bet and Win from one sync page compact into one pending round write', async () => {
  const db = transactionDb();
  const resolveUid = async () => 'member-1';
  const result = await ingestGoldslotProviderTransactionBatch([
    rawTransaction({ trans_id: 3001, trans_type: GOLDSLOT_TRANSACTION_TYPES.BET, trans_amount: 100000 }),
    rawTransaction({ trans_id: 3002, trans_type: GOLDSLOT_TRANSACTION_TYPES.WIN, trans_amount: 60000, balance: 960000 }),
  ], { db, env, resolveUid });

  assert.equal(result.consumed, 2);
  assert.equal(result.roundWrites, 1);
  assert.equal(result.ignoredNonGame, 0);
  const rounds = db.entries().filter(([path]) => path.startsWith('providerGameRounds/'));
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0][1].effectiveBetMinor, 100000);
  assert.equal(rounds[0][1].winAmountMinor, 60000);
  assert.equal(rounds[0][1].hasSettlement, true);
  assert.equal(Object.keys(rounds[0][1].eventDigests).length, 2);
});

test('deposit and withdraw provider events are ignored for rewards and consume zero durable storage', async () => {
  const db = transactionDb();
  const resolveUid = async () => 'member-1';
  const deposit = rawTransaction({
    trans_id: 2001,
    round_id: null,
    trans_type: GOLDSLOT_TRANSACTION_TYPES.DEPOSIT,
    trans_amount: 500000,
  });
  const result = await ingestGoldslotProviderTransaction(deposit, { db, env, resolveUid });
  assert.equal(result.ignoredForRewards, true);
  assert.equal(result.persisted, false);
  assert.equal(db.entries().filter(([path]) => path.startsWith('providerTransactions/')).length, 0);
  assert.equal(db.entries().filter(([path]) => path.startsWith('providerGameRounds/')).length, 0);
});

test('round finalizer aggregates multiple settled rounds once and deletes temporary round documents', async () => {
  const now = Date.parse('2026-10-05T01:00:00.000Z');
  const old = now - 60 * 60 * 1000;
  const db = transactionDb({
    'providerSyncStates/goldslotpalase-transactions': {
      provider: 'goldslotpalase', status: 'ready', lastId: 5000, lastSuccessAtMs: now, hasMore: false,
    },
    'users/member-1': { uid: 'member-1' },
    'wallets/member-1': { uid: 'member-1', currency: 'IDR', balanceMinor: 1000000, availableMinor: 1000000, rewardLockedMinor: 0, status: 'active' },
    'providerGameRounds/r1': {
      provider: 'goldslotpalase', uid: 'member-1', userCode: 501, roundId: 'r1', providerId: 10,
      gameSymbol: 'slot-test', effectiveBetMinor: 100000, winAmountMinor: 60000,
      status: 'pending', hasSettlement: true, anomaly: false, lastProviderAtMs: old, maxTransId: 4001,
    },
    'providerGameRounds/r2': {
      provider: 'goldslotpalase', uid: 'member-1', userCode: 501, roundId: 'r2', providerId: 10,
      gameSymbol: 'slot-test', effectiveBetMinor: 200000, winAmountMinor: 50000,
      status: 'pending', hasSettlement: true, anomaly: false, lastProviderAtMs: old + 1000, maxTransId: 4002,
    },
  });

  const result = await finalizeReadyGoldslotRounds({ db, now });
  assert.equal(result.finalized, 2);
  assert.equal(result.memberBatches, 1);
  assert.equal(db.read('providerGameRounds/r1'), undefined);
  assert.equal(db.read('providerGameRounds/r2'), undefined);
  const aggregates = db.entries().filter(([path]) => path.startsWith('rewardWeeklyMembers/'));
  assert.equal(aggregates.length, 1);
  assert.equal(aggregates[0][1].betAmountMinor, 300000);
  assert.equal(aggregates[0][1].winAmountMinor, 110000);
  assert.equal(aggregates[0][1].roundCount, 2);
  assert.equal(db.entries().filter(([path]) => path.startsWith('settledGameRounds/')).length, 0);
});

test('round finalizer applies valid betting turnover before releasing reward lock', async () => {
  const now = Date.parse('2026-10-05T01:00:00.000Z');
  const old = now - 60 * 60 * 1000;
  const db = transactionDb({
    'providerSyncStates/goldslotpalase-transactions': {
      provider: 'goldslotpalase', status: 'ready', lastId: 5000, lastSuccessAtMs: now, hasMore: false,
    },
    'users/member-1': { uid: 'member-1' },
    'wallets/member-1': {
      uid: 'member-1', currency: 'IDR', balanceMinor: 1000000,
      availableMinor: 1000000, rewardLockedMinor: 300000, status: 'active',
    },
    'rewardTurnover/member-1': {
      uid: 'member-1',
      obligations: [{
        id: 'd'.repeat(64), weekKey: '2026-09-28', principalMinor: 300000,
        requiredTurnoverMinor: 3000000, remainingTurnoverMinor: 3000000,
      }],
      pendingTurnoverMinor: 3000000,
    },
    'providerGameRounds/r1': {
      provider: 'goldslotpalase', uid: 'member-1', userCode: 501, roundId: 'r1', providerId: 10,
      gameSymbol: 'slot-test', effectiveBetMinor: 1000000, winAmountMinor: 600000,
      status: 'pending', hasSettlement: true, anomaly: false, lastProviderAtMs: old, maxTransId: 4001,
    },
  });

  const result = await finalizeReadyGoldslotRounds({ db, now });
  assert.equal(result.finalized, 1);
  assert.equal(db.read('wallets/member-1').rewardLockedMinor, 300000);
  assert.equal(db.read('rewardTurnover/member-1').pendingTurnoverMinor, 2000000);
});

test('scheduled provider sync is fail-closed while transaction sync is disabled', async () => {
  let called = false;
  const result = await syncGoldslotProviderTransactions({
    env,
    db: transactionDb(),
    clientFactory: () => { called = true; return {}; },
  });
  assert.equal(result.status, 'disabled');
  assert.equal(result.processed, 0);
  assert.equal(called, false);
});
