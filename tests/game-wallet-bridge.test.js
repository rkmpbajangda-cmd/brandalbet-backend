import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePlayableGoldslotBalance } from '../src/game/wallet-bridge.js';
import { getGoldslotWalletStatus } from '../src/game/wallet-status.js';
import { launchGoldslotGame } from '../src/game/launch.js';

const actor = { uid: 'u1', email: 'member@example.invalid' };
const player = { provider: 'goldslotpalase', providerUsername: 'bb_fixture', userCode: 77 };
const wallet = { uid: 'u1', currency: 'IDR', balanceMinor: 1000, availableMinor: 1000, status: 'active' };
const transferEnv = { GOLDSLOTPALASE_TRANSFER_ENABLED: 'true', GOLDSLOTPALASE_IDR_SCALE: '1' };
const noActive = async () => ({ activeTransfer: null });

test('wallet bridge transfers all available internal funds before launch', async () => {
  let transferInput;
  const result = await ensurePlayableGoldslotBalance(actor, {
    wallet,
    player,
    env: transferEnv,
    launchRequestId: 'launch-request-001',
    client: { userInfo: async () => ({ balance: 0 }) },
    loadActiveTransfer: noActive,
    executeTransfer: async (_actor, input) => {
      transferInput = input;
      return { status: 'succeeded', providerBalanceAfter: 1000 };
    },
  });
  assert.equal(transferInput.direction, 'in');
  assert.equal(transferInput.amountMinor, 1000);
  assert.equal(transferInput.requestId, 'launch-launch-request-001');
  assert.equal(result.providerBalanceMinor, 1000);
  assert.equal(result.transferredMinor, 1000);
});

test('wallet bridge never transfers reward-locked cashback into Goldslot', async () => {
  let transferInput = null;
  const result = await ensurePlayableGoldslotBalance(actor, {
    wallet: { ...wallet, balanceMinor: 1000, availableMinor: 1000, rewardLockedMinor: 300 },
    player,
    env: transferEnv,
    launchRequestId: 'launch-request-locked',
    client: { userInfo: async () => ({ balance: 0 }) },
    loadActiveTransfer: noActive,
    executeTransfer: async (_actor, input) => {
      transferInput = input;
      return { status: 'succeeded', providerBalanceAfter: 700 };
    },
  });
  assert.equal(transferInput.amountMinor, 700);
  assert.equal(result.transferredMinor, 700);
  assert.equal(result.internalAvailableMinor, 300);
  assert.equal(result.providerBalanceMinor, 700);
});

test('wallet bridge fails closed instead of moving positive internal funds while disabled', async () => {
  await assert.rejects(ensurePlayableGoldslotBalance(actor, {
    wallet,
    player,
    env: {},
    client: { userInfo: async () => ({ balance: 0 }) },
    loadActiveTransfer: noActive,
  }), { code: 'game_wallet_bridge_disabled' });
});

test('wallet bridge allows already funded provider balance when internal available is zero', async () => {
  const result = await ensurePlayableGoldslotBalance(actor, {
    wallet: { ...wallet, balanceMinor: 0, availableMinor: 0 },
    player,
    env: {},
    client: { userInfo: async () => ({ balance: 2500 }) },
    loadActiveTransfer: noActive,
  });
  assert.equal(result.providerBalanceMinor, 2500);
  assert.equal(result.transferredMinor, 0);
});

test('zero internal and provider balance may open game without performing a transfer', async () => {
  let transferCalled = false;
  const result = await ensurePlayableGoldslotBalance(actor, {
    wallet: { ...wallet, balanceMinor: 0, availableMinor: 0 },
    player,
    env: {},
    client: { userInfo: async () => ({ balance: 0 }) },
    loadActiveTransfer: noActive,
    executeTransfer: async () => {
      transferCalled = true;
      throw new Error('unexpected transfer');
    },
  });
  assert.equal(result.providerBalanceMinor, 0);
  assert.equal(result.transferredMinor, 0);
  assert.equal(result.internalAvailableMinor, 0);
  assert.equal(transferCalled, false);
});

test('wallet bridge blocks launch while a financial transfer is unresolved', async () => {
  await assert.rejects(ensurePlayableGoldslotBalance(actor, {
    wallet,
    player,
    env: transferEnv,
    client: { userInfo: async () => ({ balance: 0 }) },
    loadActiveTransfer: async () => ({ activeTransfer: { status: 'ambiguous' } }),
  }), { code: 'game_wallet_transfer_pending' });
});

test('game launch prepares provider balance before requesting one-time URL', async () => {
  const order = [];
  const result = await launchGoldslotGame(actor, {
    providerId: 9,
    gameSymbol: 'slot_x',
    launchRequestId: 'launch-request-002',
  }, {
    env: transferEnv,
    client: {
      userInfo: async () => ({ balance: 0 }),
      launch: async () => {
        order.push('launch');
        return { game_url: 'https://games.example.test/play?token=opaque' };
      },
    },
    loadProfile: async () => ({ uid: 'u1', username: 'member', onboardingCompleted: true }),
    loadWallet: async () => wallet,
    ensurePlayer: async () => player,
    loadCatalog: async () => ({ games: [{ providerId: 9, gameSymbol: 'slot_x', launchEnabled: true }], providers: [] }),
    prepareBalance: async (_actor, input) => {
      order.push('bridge');
      assert.equal(input.launchRequestId, 'launch-request-002');
      return { mode: 'transfer', providerBalanceMinor: 1000, transferredMinor: 1000, internalAvailableMinor: 0 };
    },
  });
  assert.deepEqual(order, ['bridge', 'launch']);
  assert.equal(result.walletBridge.providerBalanceMinor, 1000);
  assert.equal(result.launchUrl, 'https://games.example.test/play?token=opaque');
});

test('combined game wallet status includes provider funds without hiding internal funds', async () => {
  const status = await getGoldslotWalletStatus(actor, {
    env: transferEnv,
    client: { userInfo: async () => ({ balance: 700 }) },
    loadWallet: async () => ({ ...wallet, balanceMinor: 300, availableMinor: 300 }),
    loadPlayer: async () => player,
    loadActiveTransfer: noActive,
  });
  assert.equal(status.internalAvailableMinor, 300);
  assert.equal(status.providerBalanceMinor, 700);
  assert.equal(status.totalAvailableMinor, 1000);
  assert.equal(status.totalBalanceMinor, 1000);
  assert.equal(status.syncPending, false);
});

test('combined status marks total balance uncertain while an ambiguous transfer exists', async () => {
  const status = await getGoldslotWalletStatus(actor, {
    env: transferEnv,
    client: { userInfo: async () => ({ balance: 700 }) },
    loadWallet: async () => ({ ...wallet, balanceMinor: 1000, availableMinor: 300 }),
    loadPlayer: async () => player,
    loadActiveTransfer: async () => ({ activeTransfer: { status: 'ambiguous', direction: 'in' } }),
  });
  assert.equal(status.totalAvailableMinor, 1000);
  assert.equal(status.totalBalanceMinor, null);
  assert.equal(status.syncPending, true);
});
