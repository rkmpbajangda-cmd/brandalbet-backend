import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../netlify/functions/games.js';

const event = {
  httpMethod: 'GET',
  headers: { Origin: 'https://brandalbet.blogspot.com' },
};

const catalog = {
  provider: 'goldslotpalase',
  syncedAt: '2026-10-03T00:00:00.000Z',
  providers: [
    { providerId: 1, providerName: 'One', gameCount: 1 },
    { providerId: 2, providerName: 'Two', gameCount: 1 },
  ],
  games: [
    { providerId: 1, providerName: 'One', id: 'a', gameCode: 'a', name: 'A', active: true, launchEnabled: true },
    { providerId: 2, providerName: 'Two', id: 'b', gameCode: 'b', name: 'B', active: true, launchEnabled: true },
  ],
};

test('public games applies saved order and emits cache headers', async () => {
  const handler = createHandler({
    clientFactory: () => ({}),
    loadCatalog: async () => catalog,
    loadDisplay: async () => ({
      popular: ['1::a'], newest: ['2::b'], pinned: ['2::b'], hiddenGames: [], providerOrder: [2, 1], hiddenProviders: [], revision: 3,
    }),
  });
  const result = await handler(event);
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.deepEqual(body.games.map(game => game.gameCode), ['b', 'a']);
  assert.equal(body.games.find(game => game.gameCode === 'a').popular, true);
  assert.deepEqual(body.providers.map(provider => provider.providerId), [2, 1]);
  assert.equal(body.display.revision, 3);
  assert.match(result.headers['Cache-Control'], /max-age=120/);
});

test('public games fails open to provider catalog when curation store is unavailable', async () => {
  const handler = createHandler({
    clientFactory: () => ({}),
    loadCatalog: async () => catalog,
    loadDisplay: async () => { throw new Error('fixture settings outage'); },
  });
  const result = await handler(event);
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.games.length, 2);
  assert.equal(body.display.revision, 0);
});
