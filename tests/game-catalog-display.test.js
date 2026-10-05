import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGoldslotGames, normalizeGoldslotProviders } from '../src/game/catalog.js';
import { applyGameDisplaySettings } from '../src/game/display-settings.js';

test('Goldslot catalog accepts numeric-string IDs and enabled launch flags', () => {
  const providers = normalizeGoldslotProviders({
    result: '0',
    data: { providers: [{ provider_id: '7', provider_name: 'PG' }] },
  });
  const games = normalizeGoldslotGames({
    code: '0',
    data: { games: [{
      provider_id: '7',
      game_code: 'GAME01',
      game_name: 'Game 01',
      launch_enable: '1',
      game_image: 'https://cdn.example.test/game.webp',
    }] },
  }, new Map(providers.map(p => [p.providerId, p.providerName])));

  assert.equal(providers[0].providerId, 7);
  assert.equal(games[0].providerId, 7);
  assert.equal(games[0].active, true);
  assert.equal(games[0].launchEnabled, true);
});

test('display settings never expose inactive or hidden games', () => {
  const view = applyGameDisplaySettings({
    provider: 'goldslotpalase',
    providers: [
      { providerId: 7, providerName: 'PG', status: 'normal' },
      { providerId: 8, providerName: 'Other', status: 'normal' },
    ],
    games: [
      { providerId: 7, gameCode: 'A', id: 'A', name: 'A', active: true },
      { providerId: 7, gameCode: 'B', id: 'B', name: 'B', active: false },
      { providerId: 8, gameCode: 'C', id: 'C', name: 'C', active: true },
    ],
    syncedAt: '2026-10-05T00:00:00.000Z',
  }, {
    hiddenGames: ['7::A'],
    hiddenProviders: [],
    popular: [],
    newest: [],
    pinned: [],
    providerOrder: [],
  });

  assert.deepEqual(view.games.map(g => g.gameCode), ['C']);
  assert.equal(view.providers.length, 1);
  assert.equal(view.providers[0].providerId, 8);
});
