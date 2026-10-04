import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDb } from './helpers/transaction-db.js';
import {
  GOLDSLOT_TRANSACTION_TYPES,
  applyGoldslotTransactionToRound,
  goldslotMoneyToMinor,
  ingestGoldslotProviderTransaction,
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

test('provider transaction ingestion is idempotent and builds one immutable round aggregate', async () => {
  const db = transactionDb();
  const resolveUid = async () => 'member-1';
  const bet = rawTransaction();
  const first = await ingestGoldslotProviderTransaction(bet, { db, env, resolveUid });
  const replay = await ingestGoldslotProviderTransaction(bet, { db, env, resolveUid });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);

  const providerTransactions = db.entries().filter(([path]) => path.startsWith('providerTransactions/'));
  const providerRounds = db.entries().filter(([path]) => path.startsWith('providerGameRounds/'));
  assert.equal(providerTransactions.length, 1);
  assert.equal(providerRounds.length, 1);
  assert.equal(providerRounds[0][1].effectiveBetMinor, 100000);

  await assert.rejects(
    ingestGoldslotProviderTransaction({ ...bet, trans_amount: 120000 }, { db, env, resolveUid }),
    { code: 'provider_transaction_idempotency_conflict' },
  );
});

test('deposit and withdraw history are retained but never marked reward eligible', async () => {
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
  const rows = db.entries().filter(([path]) => path.startsWith('providerTransactions/'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1].rewardEligibleType, false);
  assert.equal(db.entries().filter(([path]) => path.startsWith('providerGameRounds/')).length, 0);
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
