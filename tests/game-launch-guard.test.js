import test from 'node:test';
import assert from 'node:assert/strict';
import { launchGoldslotGame, clearLaunchGuardForTest } from '../src/game/launch.js';
import { transactionDb } from './helpers/transaction-db.js';

const actor = { uid: 'guard-user', email: 'member@example.invalid' };
const catalog = {
  games: [
    { providerId: 9, gameSymbol: 'slot_guard', launchEnabled: true },
    { providerId: 9, gameSymbol: 'slot_distributed_guard', launchEnabled: true },
    { providerId: 10, gameSymbol: 'another_game', launchEnabled: true },
    { providerId: 9, gameSymbol: 'slot_retry', launchEnabled: true },
  ],
  providers: [
    { providerId: 9, status: 'normal' },
    { providerId: 10, status: 'normal' },
  ],
};

const common = {
  loadProfile: async () => ({ uid: actor.uid, username: 'member', onboardingCompleted: true }),
  loadWallet: async () => ({ uid: actor.uid, currency: 'IDR', balanceMinor: 0, availableMinor: 0, status: 'active' }),
  ensurePlayer: async () => ({ userCode: 77 }),
  loadCatalog: async () => catalog,
};

function launchClient(counter, implementation) {
  return {
    launch: async () => {
      counter.calls += 1;
      if (implementation) return implementation(counter.calls);
      return { game_url: 'https://games.example.test/play?token=opaque' };
    },
  };
}

test('duplicate launch for the same member/game is rejected before a second provider call', async () => {
  clearLaunchGuardForTest();
  const counter = { calls: 0 };
  const client = launchClient(counter);

  const input = { providerId: 9, gameSymbol: 'slot_guard', launchRequestId: 'launch-guard-0001' };
  const first = await launchGoldslotGame(actor, input, { client, ...common });
  assert.equal(first.oneTimeUse, true);
  assert.equal(counter.calls, 1);

  await assert.rejects(
    launchGoldslotGame(actor, { ...input, launchRequestId: 'launch-guard-0002' }, { client, ...common }),
    error => error?.code === 'game_launch_rate_limited' && error?.statusCode === 429,
  );
  assert.equal(counter.calls, 1);
  clearLaunchGuardForTest();
});

test('Firestore guard blocks duplicate launch after process-local cache is lost', async () => {
  clearLaunchGuardForTest();
  const db = transactionDb();
  const counter = { calls: 0 };
  const client = launchClient(counter);

  await launchGoldslotGame(actor, {
    providerId: 9,
    gameSymbol: 'slot_distributed_guard',
    launchRequestId: 'distributed-guard-0001',
  }, { client, db, ...common });
  assert.equal(counter.calls, 1);

  // Simulate a second serverless isolate with an empty process-local cache.
  clearLaunchGuardForTest();
  await assert.rejects(
    launchGoldslotGame(actor, {
      providerId: 10,
      gameSymbol: 'another_game',
      launchRequestId: 'distributed-guard-0002',
    }, { client, db, ...common }),
    error => error?.code === 'game_launch_rate_limited' && error?.statusCode === 429,
  );
  assert.equal(counter.calls, 1);
  clearLaunchGuardForTest();
});

test('non-ambiguous launch failure releases distributed guard for a deliberate retry', async () => {
  clearLaunchGuardForTest();
  const db = transactionDb();
  const counter = { calls: 0 };
  const client = launchClient(counter, calls => {
    if (calls === 1) throw Object.assign(new Error('fixture rejection'), { ambiguous: false });
    return { game_url: 'https://games.example.test/play?token=retry' };
  });

  const firstInput = { providerId: 9, gameSymbol: 'slot_retry', launchRequestId: 'launch-retry-0001' };
  await assert.rejects(launchGoldslotGame(actor, firstInput, { client, db, ...common }));
  const second = await launchGoldslotGame(actor, {
    ...firstInput,
    launchRequestId: 'launch-retry-0002',
  }, { client, db, ...common });

  assert.equal(second.oneTimeUse, true);
  assert.equal(counter.calls, 2);
  clearLaunchGuardForTest();
});
