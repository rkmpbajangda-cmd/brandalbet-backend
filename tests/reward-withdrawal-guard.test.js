import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDb } from './helpers/transaction-db.js';
import { assertRewardWithdrawalAllowed, rewardWithdrawableMinor } from '../src/rewards/withdrawal-guard.js';

const wallet = {
  uid: 'u1', currency: 'IDR', balanceMinor: 1_000_000, availableMinor: 600_000,
  rewardLockedMinor: 80_000, status: 'active',
};

test('withdrawable amount excludes cashback principal still under turnover', () => {
  assert.equal(rewardWithdrawableMinor(wallet), 520_000);
  assert.equal(rewardWithdrawableMinor({ ...wallet, availableMinor: 50_000 }), 0);
});

test('withdrawal guard allows own withdrawable funds and rejects locked cashback', async () => {
  const db = transactionDb({ 'wallets/u1': wallet });
  const allowed = await assertRewardWithdrawalAllowed('u1', 520_000, { db });
  assert.equal(allowed.withdrawableMinor, 520_000);
  await assert.rejects(
    assertRewardWithdrawalAllowed('u1', 520_001, { db }),
    { code: 'cashback_turnover_incomplete', statusCode: 409 },
  );
});
