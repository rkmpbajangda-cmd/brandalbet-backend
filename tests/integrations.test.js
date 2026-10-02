import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoldslotClient } from '../src/game/goldslotpalase.js';
import { normalizeGoldslotGames, normalizeGoldslotProviders, loadPublicGameCatalog, clearCatalogCacheForTest } from '../src/game/catalog.js';
import { providerUsernameForUid } from '../src/game/player.js';
import { launchGoldslotGame } from '../src/game/launch.js';
import { configurationReadiness } from '../src/config/readiness.js';
import { createHandler as readinessHandler } from '../netlify/functions/backoffice-readiness.js';
import { createHandler as transactionsHandler } from '../netlify/functions/transactions.js';
import { parseJsonBody } from '../src/utils/body.js';
const env = { GOLDSLOTPALASE_API_TOKEN: 'fixture-not-a-real-secret' };
const event = { httpMethod: 'GET', headers: { Authorization: 'Bearer test' }, queryStringParameters: { uid: 'victim' } };

test('Goldslot client uses fixed host, documented request and server-only token', async () => {
  let observed;
  const client = createGoldslotClient({ env, fetchImpl: async (url, options) => {
    observed = { url, options }; return new Response(JSON.stringify({ result: 0, data: { user_code: 123 } }));
  } });
  assert.deepEqual(await client.createUser('member_123'), { user_code: 123 });
  assert.equal(observed.url, 'https://agent.goldslotpalase.com/v4/user/create');
  assert.deepEqual(JSON.parse(observed.options.body), { name: 'member_123' });
  assert.equal(observed.options.redirect, 'error');
  assert.equal(observed.options.headers.Authorization, 'Bearer ' + env.GOLDSLOTPALASE_API_TOKEN);
});
test('provider errors are redacted and never automatically retried', async () => {
  let calls = 0;
  const client = createGoldslotClient({ env, fetchImpl: async () => { calls++; throw new Error(env.GOLDSLOTPALASE_API_TOKEN); } });
  await assert.rejects(client.launch({ userCode: 1, providerId: 2, gameSymbol: 'sample' }), e => {
    assert.equal(e.code, 'provider_unavailable'); assert.equal(e.ambiguous, true);
    assert.ok(!String(e).includes(env.GOLDSLOTPALASE_API_TOKEN)); return true;
  });
  assert.equal(calls, 1);
});
test('provider missing result and maintenance cannot become success', async () => {
  for (const data of [{ data: {} }, { result: 1, data: {} }, { result: '0', data: {} }]) {
    const client = createGoldslotClient({ env, fetchImpl: async () => new Response(JSON.stringify(data)) });
    await assert.rejects(client.agentInfo());
  }
});
test('provider timeout aborts the request', async () => {
  const client = createGoldslotClient({ env, timeoutMs: 5, fetchImpl: (_u, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(client.agentInfo(), { code: 'provider_unavailable' });
});
test('launch excludes RTP fields and uses Indonesian language code', async () => {
  let body;
  const client = createGoldslotClient({ env, fetchImpl: async (_u, o) => { body = JSON.parse(o.body); return new Response('{"result":0,"data":{}}'); } });
  await client.launch({ userCode: 1, providerId: 2, gameSymbol: 'sample', rtp: 99 });
  assert.deepEqual(body, { user_code: 1, provider_id: 2, game_symbol: 'sample', lang: 9 });
});
test('readiness reveals no secret values and never asserts production readiness', async () => {
  const data = configurationReadiness({ ...env, FIREBASE_PRIVATE_KEY: 'private-fixture' });
  assert.equal(data.readyForRealMoney, false);
  assert.equal(data.integrations.gameProvider, 'goldslotpalase');
  assert.ok(!JSON.stringify(data).includes('private-fixture'));
  for (const role of ['member', 'operator', 'finance']) {
    const handler = readinessHandler({ env, verifyIdToken: async () => ({ uid: 'u1', role, backoffice: true }) });
    assert.equal((await handler(event)).statusCode, 403);
  }
  const handler = readinessHandler({ env, verifyIdToken: async () => ({ uid: 'admin', role: 'superadmin', backoffice: true }) });
  assert.equal((await handler(event)).statusCode, 200);
});
test('transaction history cannot read another user via query parameters', async () => {
  let uid;
  const handler = transactionsHandler({ verifyIdToken: async () => ({ uid: 'actual-user' }), list: async value => { uid = value; return []; } });
  assert.equal((await handler(event)).statusCode, 200); assert.equal(uid, 'actual-user');
});
test('new JSON handlers reject bad content types, large bodies and malformed JSON', () => {
  assert.throws(() => parseJsonBody({ headers: {}, body: '{}' }), { statusCode: 415 });
  assert.throws(() => parseJsonBody({ headers: { 'content-type': 'application/json' }, body: 'a'.repeat(40000) }), { statusCode: 413 });
  assert.throws(() => parseJsonBody({ headers: { 'content-type': 'application/json' }, body: '[' }), { code: 'invalid_json' });
  assert.deepEqual(parseJsonBody({ headers: { 'Content-Type': 'application/json' }, body: 'e30=', isBase64Encoded: true }), {});
});


test('Goldslot client accepts documented code envelope and exact transfer/catalog payloads', async () => {
  const seen = [];
  const client = createGoldslotClient({ env, fetchImpl: async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ code: 0, message: 'OK', data: { balance: 900, amount: 100 } }));
  } });
  await client.games({ providerId: 7, language: 9 });
  await client.walletDeposit({ userCode: 123, amount: 100 });
  await client.walletWithdraw({ userCode: 123, amount: 50 });
  await client.walletWithdrawAll({ userCode: 123 });
  assert.deepEqual(seen.map(x => [x.url.split('.com')[1], x.body]), [
    ['/v4/game/games', { provider_id: 7, lang: 9 }],
    ['/v4/wallet/deposit', { user_code: 123, amount: 100 }],
    ['/v4/wallet/withdraw', { user_code: 123, amount: 50 }],
    ['/v4/wallet/withdraw-all', { user_code: 123 }],
  ]);
});

test('conflicting provider result/code envelope fails closed', async () => {
  const client = createGoldslotClient({ env, fetchImpl: async () => new Response(JSON.stringify({ result: 0, code: 1, data: {} })) });
  await assert.rejects(client.agentInfo(), { code: 'provider_invalid_response' });
});

test('catalog sanitizes documented game fields and attaches safe provider labels', async () => {
  const providers = normalizeGoldslotProviders([{ provider_id: 7, provider_name: 'Example Provider', status: 1 }]);
  const games = normalizeGoldslotGames([{
    provider_id: 7,
    game_code: 'slot-1',
    game_name: 'Slot One',
    locale_name: 'Slot Satu',
    game_image: 'https://cdn.example.test/slot.png',
    launch_enable: 1,
    category: 'Slots',
    reg_date: '2026-10-02',
  }], new Map(providers.map(x => [x.providerId, x.providerName])));
  assert.equal(games.length, 1);
  assert.equal(games[0].providerName, 'Example Provider');
  assert.equal(games[0].name, 'Slot Satu');
  assert.equal(games[0].active, true);
  assert.equal(games[0].image, 'https://cdn.example.test/slot.png');
});

test('public catalog uses provider + all-games APIs and caches normalized result', async () => {
  clearCatalogCacheForTest();
  let providerCalls = 0;
  let gameCalls = 0;
  const client = {
    providers: async () => { providerCalls++; return [{ provider_id: 2, name: 'Provider Two', status: 1 }]; },
    allGames: async () => { gameCalls++; return [{ provider_id: 2, game_code: 'g1', game_name: 'Game 1', launch_enable: 1 }]; },
  };
  const first = await loadPublicGameCatalog({ client, now: () => 1000, ttlMs: 60000 });
  const second = await loadPublicGameCatalog({ client, now: () => 2000, ttlMs: 60000 });
  assert.equal(first.games[0].providerName, 'Provider Two');
  assert.equal(second.games.length, 1);
  assert.equal(providerCalls, 1);
  assert.equal(gameCalls, 1);
  clearCatalogCacheForTest();
});

test('provider player username is deterministic and provider-safe', () => {
  const a = providerUsernameForUid('firebase-user-1');
  const b = providerUsernameForUid('firebase-user-1');
  assert.equal(a, b);
  assert.match(a, /^bb_[a-f0-9]{32}$/);
});

test('launch service returns only validated HTTPS one-time launch URL', async () => {
  const actor = { uid: 'u1', email: 'member@example.invalid' };
  const result = await launchGoldslotGame(actor, { providerId: 9, gameSymbol: 'slot_x' }, {
    client: { launch: async input => {
      assert.deepEqual(input, { userCode: 77, providerId: 9, gameSymbol: 'slot_x', language: 9 });
      return { game_url: 'https://games.example.test/play?token=opaque' };
    } },
    loadProfile: async () => ({ uid: 'u1', username: 'member', onboardingCompleted: true }),
    loadWallet: async () => ({ uid: 'u1', currency: 'IDR', balanceMinor: 1000, availableMinor: 1000, status: 'active' }),
    ensurePlayer: async () => ({ userCode: 77 }),
  });
  assert.equal(result.launchUrl, 'https://games.example.test/play?token=opaque');
  assert.equal(result.oneTimeUse, true);
  assert.equal(result.expiresInSeconds, 600);
});

test('launch service rejects unsafe provider launch URL', async () => {
  await assert.rejects(launchGoldslotGame({ uid: 'u1' }, { providerId: 1, gameSymbol: 'slot' }, {
    client: { launch: async () => ({ game_url: 'http://unsafe.example.test/play' }) },
    loadProfile: async () => ({ username: 'member', onboardingCompleted: true }),
    loadWallet: async () => ({ status: 'active' }),
    ensurePlayer: async () => ({ userCode: 1 }),
  }), { code: 'provider_invalid_launch_url' });
});
