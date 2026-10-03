import test from 'node:test';
import assert from 'node:assert/strict';
import { launchGoldslotGame, clearLaunchGuardForTest } from '../src/game/launch.js';

const actor = { uid: 'guard-user', email: 'member@example.invalid' };
const common = {
  loadProfile: async () => ({ uid: actor.uid, username: 'member', onboardingCompleted: true }),
  loadWallet: async () => ({ uid: actor.uid, currency: 'IDR', balanceMinor: 0, availableMinor: 0, status: 'active' }),
  ensurePlayer: async () => ({ userCode: 77 }),
};

test('duplicate launch for the same member/game is rejected before a second provider call', async () => {
  clearLaunchGuardForTest();
  let calls = 0;
  const client = {
    launch: async () => {
      calls += 1;
      return { game_url: 'https://games.example.test/play?token=opaque' };
    },
  };

  const input = { providerId: 9, gameSymbol: 'slot_guard', launchRequestId: 'launch-guard-0001' };
  const first = await launchGoldslotGame(actor, input, { client, ...common });
  assert.equal(first.oneTimeUse, true);
  assert.equal(calls, 1);

  await assert.rejects(
    launchGoldslotGame(actor, { ...input, launchRequestId: 'launch-guard-0002' }, { client, ...common }),
    error => error?.code === 'game_launch_rate_limited' && error?.statusCode === 429,
  );
  assert.equal(calls, 1);
  clearLaunchGuardForTest();
});
