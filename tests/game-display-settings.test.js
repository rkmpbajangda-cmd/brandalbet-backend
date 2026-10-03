import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGameDisplaySettings, gameKey, normalizeGameDisplaySettings } from '../src/game/display-settings.js';

const catalog = {
  provider: 'goldslotpalase',
  syncedAt: '2026-10-03T00:00:00.000Z',
  providers: [
    { providerId: 10, providerName: 'Provider A', status: 'normal', gameCount: 2 },
    { providerId: 20, providerName: 'Provider B', status: 'normal', gameCount: 2 },
  ],
  games: [
    { providerId: 10, providerName: 'Provider A', gameCode: 'a1', id: 'a1', name: 'A1', active: true },
    { providerId: 10, providerName: 'Provider A', gameCode: 'a2', id: 'a2', name: 'A2', active: true },
    { providerId: 20, providerName: 'Provider B', gameCode: 'b1', id: 'b1', name: 'B1', active: true },
    { providerId: 20, providerName: 'Provider B', gameCode: 'b2', id: 'b2', name: 'B2', active: true },
  ],
};

test('game display settings normalize ordered unique values', () => {
  const settings = normalizeGameDisplaySettings({
    popular: ['10::a1', '10::a1', '20::b1'],
    newest: [],
    pinned: ['20::b2'],
    hiddenGames: [],
    providerOrder: [20, 20, 10],
    hiddenProviders: [],
  });
  assert.deepEqual(settings.popular, ['10::a1', '20::b1']);
  assert.deepEqual(settings.providerOrder, [20, 10]);
});

test('curation applies provider order, pinned order, flags and visibility', () => {
  const view = applyGameDisplaySettings(catalog, {
    popular: [gameKey(10, 'a1')],
    newest: [gameKey(20, 'b1')],
    pinned: [gameKey(10, 'a2')],
    hiddenGames: [gameKey(20, 'b2')],
    providerOrder: [20, 10],
    hiddenProviders: [],
    revision: 4,
  });

  assert.equal(view.display.revision, 4);
  assert.equal(view.games[0].gameCode, 'a2');
  assert.equal(view.games.find(game => game.gameCode === 'a1').popular, true);
  assert.equal(view.games.find(game => game.gameCode === 'b1').isNew, true);
  assert.equal(view.games.some(game => game.gameCode === 'b2'), false);
  assert.deepEqual(view.providers.map(provider => provider.providerId), [20, 10]);
});

test('hidden provider removes its games and provider card', () => {
  const view = applyGameDisplaySettings(catalog, {
    popular: [], newest: [], pinned: [], hiddenGames: [], providerOrder: [], hiddenProviders: [10],
  });
  assert.deepEqual(view.providers.map(provider => provider.providerId), [20]);
  assert.equal(view.games.every(game => game.providerId === 20), true);
});
