import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REWARD_POLICY,
  calculateWeeklyRewards,
  applyTurnoverToObligations,
  rewardWeekKey,
  rewardWeekBounds,
  previousRewardWeekKey,
} from '../src/rewards/service.js';

const obligation = {
  id: 'a'.repeat(64),
  weekKey: '2026-09-28',
  principalMinor: 100_000,
  requiredTurnoverMinor: 1_000_000,
  remainingTurnoverMinor: 1_000_000,
};

test('reward policy keeps agreed rates and threshold', () => {
  assert.equal(REWARD_POLICY.cashbackRateBps, 1000);
  assert.equal(REWARD_POLICY.referralRateBps, 1500);
  assert.equal(REWARD_POLICY.cashbackMinimumNetLossMinor, 500_000);
  assert.equal(REWARD_POLICY.cashbackTurnoverMultiplier, 10);
});

test('weekly rewards only cashback at or above minimum net loss', () => {
  assert.deepEqual(calculateWeeklyRewards({
    betAmountMinor: 499_999,
    winAmountMinor: 0,
    promoterUid: 'promoter-1',
  }), {
    netLossMinor: 499_999,
    cashbackMinor: 0,
    referralCommissionMinor: 74_999,
  });

  assert.deepEqual(calculateWeeklyRewards({
    betAmountMinor: 1_000_000,
    winAmountMinor: 0,
    promoterUid: 'promoter-1',
  }), {
    netLossMinor: 1_000_000,
    cashbackMinor: 100_000,
    referralCommissionMinor: 150_000,
  });
});

test('negative net loss never produces rewards', () => {
  assert.deepEqual(calculateWeeklyRewards({
    betAmountMinor: 100_000,
    winAmountMinor: 200_000,
    promoterUid: 'promoter-1',
  }), {
    netLossMinor: 0,
    cashbackMinor: 0,
    referralCommissionMinor: 0,
  });
});

test('turnover is consumed in order and only pending principal stays locked', () => {
  const result = applyTurnoverToObligations([obligation], 250_000);
  assert.equal(result.appliedMinor, 250_000);
  assert.equal(result.pending[0].remainingTurnoverMinor, 750_000);
  assert.equal(result.lockedRewardMinor, 100_000);
  assert.equal(result.unusedBetMinor, 0);
});

test('completed turnover unlocks principal', () => {
  const result = applyTurnoverToObligations([obligation], 1_000_000);
  assert.equal(result.appliedMinor, 1_000_000);
  assert.equal(result.completed.length, 1);
  assert.equal(result.pending.length, 0);
  assert.equal(result.lockedRewardMinor, 0);
});

test('Jakarta reward week is Monday to Monday', () => {
  assert.equal(rewardWeekKey('2026-10-05T00:30:00+07:00'), '2026-10-05');
  assert.equal(rewardWeekKey('2026-10-04T23:59:59+07:00'), '2026-09-28');
  assert.equal(rewardWeekBounds('2026-10-05').endAt, '2026-10-11T17:00:00.000Z');
  assert.equal(previousRewardWeekKey(Date.parse('2026-10-05T12:00:00+07:00')), '2026-09-28');
});
