import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWallet, walletView } from '../src/wallet/service.js';

test('wallet accepts a valid active IDR wallet', () => {
  const wallet = validateWallet('u1', {
    uid: 'u1',
    currency: 'IDR',
    balanceMinor: 1_000_000,
    availableMinor: 800_000,
    rewardLockedMinor: 200_000,
    status: 'active',
  });
  assert.equal(wallet.rewardLockedMinor, 200_000);
});

test('wallet defaults missing reward lock to zero for legacy wallets', () => {
  const wallet = validateWallet('u1', {
    uid: 'u1',
    currency: 'IDR',
    balanceMinor: 100_000,
    availableMinor: 100_000,
    status: 'active',
  });
  assert.equal(wallet.rewardLockedMinor, 0);
});

test('wallet rejects reward lock above available funds', () => {
  assert.throws(() => validateWallet('u1', {
    uid: 'u1',
    currency: 'IDR',
    balanceMinor: 100_000,
    availableMinor: 50_000,
    rewardLockedMinor: 60_000,
    status: 'active',
  }), /wallet_integrity_error/);
});

test('wallet view exposes only canonical wallet fields', () => {
  assert.deepEqual(walletView('u1', {
    uid: 'u1',
    currency: 'IDR',
    balanceMinor: 100_000,
    availableMinor: 100_000,
    rewardLockedMinor: 0,
    status: 'active',
    internalSecret: 'must-not-leak',
  }), {
    uid: 'u1',
    currency: 'IDR',
    balanceMinor: 100_000,
    availableMinor: 100_000,
    status: 'active',
  });
});
