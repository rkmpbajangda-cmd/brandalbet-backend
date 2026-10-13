import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDb } from './helpers/transaction-db.js';
import {
  REWARD_POLICY,
  applyTurnoverToObligations,
  calculateWeeklyRewards,
  creditReferralCommission,
  creditWeeklyCashback,
  ingestSettledGameRound,
  rewardWeekKey,
  weeklyAggregateId,
} from '../src/rewards/service.js';

const wallet = (uid, amount = 1_000_000) => ({
  uid,
  currency: 'IDR',
  balanceMinor: amount,
  availableMinor: amount,
  status: 'active',
});

test('reward policy is fixed at 10% cashback, 500k threshold, 10x turnover and 15% referral', () => {
  assert.equal(REWARD_POLICY.cashbackRateBps, 1000);
  assert.equal(REWARD_POLICY.cashbackMinimumNetLossMinor, 500_000);
  assert.equal(REWARD_POLICY.cashbackTurnoverMultiplier, 10);
  assert.equal(REWARD_POLICY.referralRateBps, 1500);

  assert.deepEqual(calculateWeeklyRewards({ betAmountMinor: 1_000_000, winAmountMinor: 200_000, promoterUid: 'promoter-1' }), {
    netLossMinor: 800_000,
    cashbackMinor: 80_000,
    referralCommissionMinor: 120_000,
  });
  assert.equal(calculateWeeklyRewards({ betAmountMinor: 499_999, winAmountMinor: 0 }).cashbackMinor, 0);
  assert.equal(calculateWeeklyRewards({ betAmountMinor: 500_000, winAmountMinor: 0 }).cashbackMinor, 50_000);
});

test('reward weeks change at Monday 00:00 Asia/Jakarta', () => {
  assert.equal(rewardWeekKey('2026-10-04T16:59:59.999Z'), '2026-09-28');
  assert.equal(rewardWeekKey('2026-10-04T17:00:00.000Z'), '2026-10-05');
});

test('turnover consumes obligations FIFO and unlocks cashback principal only after completion', () => {
  const first = {
    id: 'a'.repeat(64), weekKey: '2026-09-28', principalMinor: 50_000,
    requiredTurnoverMinor: 500_000, remainingTurnoverMinor: 100_000,
  };
  const second = {
    id: 'b'.repeat(64), weekKey: '2026-10-05', principalMinor: 80_000,
    requiredTurnoverMinor: 800_000, remainingTurnoverMinor: 800_000,
  };
  const result = applyTurnoverToObligations([first, second], 250_000);
  assert.equal(result.appliedMinor, 250_000);
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].id, first.id);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].remainingTurnoverMinor, 650_000);
  assert.equal(result.lockedRewardMinor, 80_000);
});

test('weekly cashback credit is idempotent and creates one 10x turnover obligation', async () => {
  const db = transactionDb({ 'wallets/u1': wallet('u1') });
  const input = { uid: 'u1', weekKey: '2026-09-28', amountMinor: 80_000, basisNetLossMinor: 800_000 };
  const first = await creditWeeklyCashback(input, { db });
  const replay = await creditWeeklyCashback(input, { db });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(db.read('wallets/u1').balanceMinor, 1_080_000);
  assert.equal(db.read('wallets/u1').availableMinor, 1_080_000);
  assert.equal(db.read('wallets/u1').rewardLockedMinor, 80_000);
  const turnover = db.read('rewardTurnover/u1');
  assert.equal(turnover.obligations.length, 1);
  assert.equal(turnover.obligations[0].requiredTurnoverMinor, 800_000);
  assert.equal(db.entries().filter(([path]) => path.startsWith('rewardPayouts/')).length, 1);
  assert.equal(db.entries().filter(([path]) => path.startsWith('ledger/')).length, 1);
});

test('referral commission credits promoter once and is independent from member cashback', async () => {
  const db = transactionDb({ 'wallets/promoter-1': wallet('promoter-1', 0) });
  const input = {
    promoterUid: 'promoter-1', sourceMemberUid: 'member-1', weekKey: '2026-09-28',
    amountMinor: 150_000, basisNetLossMinor: 1_000_000,
  };
  const first = await creditReferralCommission(input, { db });
  const replay = await creditReferralCommission(input, { db });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(db.read('wallets/promoter-1').balanceMinor, 150_000);
  assert.equal(db.read('wallets/promoter-1').availableMinor, 150_000);
  assert.equal(db.read('wallets/promoter-1').rewardLockedMinor, undefined);
});

test('legacy users referral field cannot create commission without immutable referral binding', async () => {
  const db = transactionDb({
    'users/u-legacy': { uid: 'u-legacy', referralPromoterUid: 'promoter-legacy' },
    'wallets/u-legacy': wallet('u-legacy'),
    'wallets/promoter-legacy': wallet('promoter-legacy'),
  });
  const round = {
    provider: 'goldslotpalase',
    uid: 'u-legacy',
    roundId: 'legacy-referral-round',
    betAmountMinor: 600_000,
    winAmountMinor: 0,
    settledAt: '2026-10-01T12:00:00.000Z',
  };
  await ingestSettledGameRound(round, { db, now: Date.parse('2026-10-02T00:00:00Z') });
  const aggregatePath = 'rewardWeeklyMembers/' + weeklyAggregateId('2026-09-28', 'u-legacy');
  const aggregate = db.read(aggregatePath);
  assert.equal(aggregate.promoterUid, null);
});

test('settled game round is replay-safe, aggregates valid bet/win and advances turnover once', async () => {
  const obligation = {
    id: 'c'.repeat(64), weekKey: '2026-09-28', principalMinor: 50_000,
    requiredTurnoverMinor: 500_000, remainingTurnoverMinor: 500_000,
  };
  const db = transactionDb({
    'users/u1': { uid: 'u1', referralPromoterUid: 'promoter-1' },
    'referrals/u1': { memberUid: 'u1', promoterUid: 'promoter-1', referralCode: 'BRTEST123' },
    'wallets/u1': { ...wallet('u1'), rewardLockedMinor: 50_000 },
    'rewardTurnover/u1': { uid: 'u1', obligations: [obligation], pendingTurnoverMinor: 500_000 },
  });
  const round = {
    provider: 'goldslotpalase',
    uid: 'u1',
    roundId: 'provider-round-001',
    betAmountMinor: 300_000,
    winAmountMinor: 50_000,
    settledAt: '2026-10-01T12:00:00.000Z',
    providerId: 10,
    gameSymbol: 'slot-test',
  };
  const first = await ingestSettledGameRound(round, { db, now: Date.parse('2026-10-02T00:00:00Z') });
  const replay = await ingestSettledGameRound(round, { db, now: Date.parse('2026-10-02T00:00:00Z') });
  assert.equal(first.duplicate, false);
  assert.equal(first.turnoverAppliedMinor, 300_000);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.turnoverAppliedMinor, 0);

  const weekKey = '2026-09-28';
  const aggregate = db.read(`rewardWeeklyMembers/${weeklyAggregateId(weekKey, 'u1')}`);
  assert.equal(aggregate.betAmountMinor, 300_000);
  assert.equal(aggregate.winAmountMinor, 50_000);
  assert.equal(aggregate.roundCount, 1);
  assert.equal(aggregate.promoterUid, 'promoter-1');
  assert.equal(db.read('rewardTurnover/u1').obligations[0].remainingTurnoverMinor, 200_000);
  assert.equal(db.read('wallets/u1').rewardLockedMinor, 50_000);
  assert.equal(db.entries().filter(([path]) => path.startsWith('settledGameRounds/')).length, 1);
});

test('a replayed provider round with changed money values is rejected', async () => {
  const db = transactionDb({
    'users/u1': { uid: 'u1' },
    'wallets/u1': wallet('u1'),
  });
  const base = {
    uid: 'u1', roundId: 'provider-round-002', betAmountMinor: 100_000, winAmountMinor: 10_000,
    settledAt: '2026-10-01T12:00:00.000Z',
  };
  await ingestSettledGameRound(base, { db, now: Date.parse('2026-10-02T00:00:00Z') });
  await assert.rejects(
    ingestSettledGameRound({ ...base, winAmountMinor: 20_000 }, { db, now: Date.parse('2026-10-02T00:00:00Z') }),
    { code: 'round_idempotency_conflict' },
  );
});
