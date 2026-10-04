import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDb } from './helpers/transaction-db.js';
import { completeMemberOnboarding } from '../src/member/onboarding.js';

const bankAccount = {
  type: 'bank', provider: 'BCA', accountNumber: '1234567890', accountName: 'Member Test',
};

function payload(referralCode) {
  return {
    username: 'member001',
    displayName: 'Member Test',
    phone: '081234567890',
    referralCode,
    bankAccount,
  };
}

test('valid referral code binds member permanently to promoter during onboarding', async () => {
  const db = transactionDb({
    'referralCodes/PROMO15': { code: 'PROMO15', promoterUid: 'promoter-1', active: true },
    'referralCodes/OTHER15': { code: 'OTHER15', promoterUid: 'promoter-2', active: true },
  });
  const actor = { uid: 'member-1', email: 'member@example.invalid' };
  await completeMemberOnboarding(actor, payload('promo15'), { db });

  assert.equal(db.read('users/member-1').referralCode, 'PROMO15');
  assert.equal(db.read('users/member-1').referralPromoterUid, 'promoter-1');
  assert.deepEqual(
    {
      memberUid: db.read('referrals/member-1').memberUid,
      promoterUid: db.read('referrals/member-1').promoterUid,
      referralCode: db.read('referrals/member-1').referralCode,
    },
    { memberUid: 'member-1', promoterUid: 'promoter-1', referralCode: 'PROMO15' },
  );
  assert.equal(db.read('wallets/member-1').rewardLockedMinor, 0);

  await assert.rejects(
    completeMemberOnboarding(actor, payload('OTHER15'), { db }),
    { code: 'referral_locked', statusCode: 409 },
  );
  assert.equal(db.read('users/member-1').referralPromoterUid, 'promoter-1');
});

test('unknown, inactive and self referral codes fail closed', async () => {
  const base = {
    'referralCodes/INACTIVE': { code: 'INACTIVE', promoterUid: 'promoter-1', active: false },
    'referralCodes/SELF01': { code: 'SELF01', promoterUid: 'member-1', active: true },
  };
  for (const [code, expected] of [['MISSING', 'invalid_referral_code'], ['INACTIVE', 'invalid_referral_code'], ['SELF01', 'self_referral_not_allowed']]) {
    const db = transactionDb(base);
    await assert.rejects(
      completeMemberOnboarding({ uid: 'member-1' }, payload(code), { db }),
      { code: expected },
    );
    assert.equal(db.read('users/member-1'), undefined);
    assert.equal(db.read('wallets/member-1'), undefined);
  }
});
