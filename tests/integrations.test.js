import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoldslotClient } from '../src/game/goldslotpalase.js';
import { normalizeGoldslotGames, normalizeGoldslotProviders, loadPublicGameCatalog, clearCatalogCacheForTest } from '../src/game/catalog.js';
import { providerUsernameForUid } from '../src/game/player.js';
import { launchGoldslotGame } from '../src/game/launch.js';
import { executeGoldslotTransfer, reconcileGoldslotTransfer, getActiveGoldslotTransfer } from '../src/game/transfer.js';
import { transactionDb } from './helpers/transaction-db.js';
import { configurationReadiness } from '../src/config/readiness.js';
import { createHandler as readinessHandler } from '../netlify/functions/backoffice-readiness.js';
import { createHandler as transactionsHandler } from '../netlify/functions/transactions.js';
import { parseJsonBody } from '../src/utils/body.js';
const env = { GOLDSLOTPALASE_API_TOKEN: 'fixture-not-a-real-secret', GOLDSLOTPALASE_API_URL: 'https://agent.goldslotpalase.com' };
const event = { httpMethod: 'GET', headers: { Authorization: 'Bearer test' }, queryStringParameters: { uid: 'victim' } };

test('Goldslot client uses configured API URL, documented request and server-only token', async () => {
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
test('Goldslot client normalizes an API URL ending in /v4', async () => {
  let observedUrl;
  const client = createGoldslotClient({ env: { ...env, GOLDSLOTPALASE_API_URL: 'https://agent.goldslotpalase.com/v4/' }, fetchImpl: async url => { observedUrl = url; return new Response(JSON.stringify({ result: 0, data: {} })); } });
  await client.agentInfo();
  assert.equal(observedUrl, 'https://agent.goldslotpalase.com/v4/agent/info');
});
test('Goldslot client requires an HTTPS API URL', () => {
  assert.throws(() => createGoldslotClient({ env: { GOLDSLOTPALASE_API_TOKEN: 'fixture' } }), { code: 'provider_unconfigured' });
  assert.throws(() => createGoldslotClient({ env: { ...env, GOLDSLOTPALASE_API_URL: 'http://agent.goldslotpalase.com' } }), { code: 'provider_invalid_base_url' });
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


const transferEnv = {
  GOLDSLOTPALASE_TRANSFER_ENABLED: 'true',
  GOLDSLOTPALASE_IDR_SCALE: '1',
  GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED: 'true',
};

function transferDb({ balance = 1000, available = balance, providerBalance = 0 } = {}) {
  return transactionDb({
    'wallets/u1': { uid: 'u1', currency: 'IDR', balanceMinor: balance, availableMinor: available, status: 'active' },
    'providerPlayers/u1': { uid: 'u1', provider: 'goldslotpalase', providerUsername: 'bb_fixture', userCode: 77, activeTransferId: null },
  });
}

const transferActor = { uid: 'u1', email: 'member@example.invalid' };
const ensureFixturePlayer = async () => ({ provider: 'goldslotpalase', providerUsername: 'bb_fixture', userCode: 77 });

test('game transfer-in reserves then settles internal wallet exactly once', async () => {
  const db = transferDb();
  let deposits = 0;
  const client = {
    userInfo: async () => ({ balance: 0 }),
    walletDeposit: async ({ userCode, amount }) => {
      deposits++;
      assert.equal(userCode, 77);
      assert.equal(amount, 400);
      return { balance: 400, amount: 400 };
    },
  };
  const input = { direction: 'in', requestId: 'req-in-0001', amountMinor: 400 };
  const first = await executeGoldslotTransfer(transferActor, input, {
    env: transferEnv, db, client, ensurePlayer: ensureFixturePlayer,
  });
  assert.equal(first.status, 'succeeded');
  assert.equal(db.read('wallets/u1').balanceMinor, 600);
  assert.equal(db.read('wallets/u1').availableMinor, 600);
  assert.equal(db.read('providerPlayers/u1').activeTransferId, null);
  assert.equal(db.entries().filter(([path, row]) => path.startsWith('ledger/') && row.source === 'game_transfer_in').length, 1);

  const duplicate = await executeGoldslotTransfer(transferActor, input, {
    env: transferEnv, db, client, ensurePlayer: ensureFixturePlayer,
  });
  assert.equal(duplicate.status, 'succeeded');
  assert.equal(deposits, 1);
  assert.equal(db.read('wallets/u1').balanceMinor, 600);
});

test('game withdraw-all credits provider balance back to internal wallet once', async () => {
  const db = transferDb({ balance: 600, available: 600 });
  let withdrawals = 0;
  const client = {
    userInfo: async () => ({ balance: 500 }),
    walletWithdrawAll: async ({ userCode }) => {
      withdrawals++;
      assert.equal(userCode, 77);
      return { balance: 0, amount: 500 };
    },
  };
  const result = await executeGoldslotTransfer(transferActor, {
    direction: 'out_all', requestId: 'req-outall-0001',
  }, { env: transferEnv, db, client, ensurePlayer: ensureFixturePlayer });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.providerAmount, 500);
  assert.equal(db.read('wallets/u1').balanceMinor, 1100);
  assert.equal(db.read('wallets/u1').availableMinor, 1100);
  assert.equal(db.read('providerPlayers/u1').activeTransferId, null);
  assert.equal(withdrawals, 1);
});

test('ambiguous provider deposit keeps funds held until balance reconciliation proves success', async () => {
  const db = transferDb();
  const ambiguous = Object.assign(new Error('redacted'), { code: 'provider_unavailable', ambiguous: true });
  const client = {
    userInfo: async () => ({ balance: 0 }),
    walletDeposit: async () => { throw ambiguous; },
  };
  const pending = await executeGoldslotTransfer(transferActor, {
    direction: 'in', requestId: 'req-in-ambiguous-0001', amountMinor: 400,
  }, { env: transferEnv, db, client, ensurePlayer: ensureFixturePlayer });

  assert.equal(pending.status, 'ambiguous');
  assert.equal(db.read('wallets/u1').balanceMinor, 1000);
  assert.equal(db.read('wallets/u1').availableMinor, 600);
  assert.equal(db.read('providerPlayers/u1').activeTransferId, pending.id);

  const reconciled = await reconcileGoldslotTransfer(transferActor, { transferId: pending.id }, {
    env: transferEnv,
    db,
    client: { userInfo: async () => ({ balance: 400 }) },
  });
  assert.equal(reconciled.status, 'succeeded');
  assert.equal(db.read('wallets/u1').balanceMinor, 600);
  assert.equal(db.read('wallets/u1').availableMinor, 600);
  assert.equal(db.read('providerPlayers/u1').activeTransferId, null);
});

test('explicit provider rejection releases transfer-in hold without debiting balance', async () => {
  const db = transferDb();
  const rejected = Object.assign(new Error('provider_rejected'), { code: 'provider_rejected', ambiguous: false });
  const result = await executeGoldslotTransfer(transferActor, {
    direction: 'in', requestId: 'req-in-reject-0001', amountMinor: 400,
  }, {
    env: transferEnv,
    db,
    client: {
      userInfo: async () => ({ balance: 0 }),
      walletDeposit: async () => { throw rejected; },
    },
    ensurePlayer: ensureFixturePlayer,
  });
  assert.equal(result.status, 'failed');
  assert.equal(db.read('wallets/u1').balanceMinor, 1000);
  assert.equal(db.read('wallets/u1').availableMinor, 1000);
  assert.equal(db.read('providerPlayers/u1').activeTransferId, null);
});

test('local settlement failure after provider success never releases reserved funds', async () => {
  const db = transferDb();
  const result = await executeGoldslotTransfer(transferActor, {
    direction: 'in', requestId: 'req-in-badsettle-0001', amountMinor: 400,
  }, {
    env: transferEnv,
    db,
    client: {
      userInfo: async () => ({ balance: 0 }),
      walletDeposit: async () => ({ balance: 400, amount: 399 }),
    },
    ensurePlayer: ensureFixturePlayer,
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(db.read('wallets/u1').balanceMinor, 1000);
  assert.equal(db.read('wallets/u1').availableMinor, 600);
});


test('ambiguous balance-only reconciliation stays disabled unless explicitly staging-approved', async () => {
  const db = transferDb();
  await assert.rejects(reconcileGoldslotTransfer(transferActor, {
    transferId: 'a'.repeat(64),
  }, {
    env: { GOLDSLOTPALASE_TRANSFER_ENABLED: 'true', GOLDSLOTPALASE_IDR_SCALE: '1' },
    db,
    client: { userInfo: async () => ({ balance: 0 }) },
  }), { code: 'game_transfer_manual_reconciliation_required' });
});


test('active game transfer can be recovered after browser reload', async () => {
  const activeId = 'b'.repeat(64);
  const db = transactionDb({
    'providerPlayers/u1': { uid: 'u1', provider: 'goldslotpalase', userCode: 77, activeTransferId: activeId },
    ['providerTransfers/' + activeId]: {
      uid: 'u1', provider: 'goldslotpalase', direction: 'in', status: 'ambiguous',
      amountMinor: 400, providerBalanceBefore: 0, providerAmount: null, providerBalanceAfter: null,
    },
  });
  const result = await getActiveGoldslotTransfer({ uid: 'u1' }, { db });
  assert.equal(result.activeTransfer.id, activeId);
  assert.equal(result.activeTransfer.status, 'ambiguous');
  assert.equal(result.activeTransfer.reconciliationRequired, true);
});

test('game transfer recovery returns null when member has no active transfer', async () => {
  const db = transactionDb({
    'providerPlayers/u1': { uid: 'u1', provider: 'goldslotpalase', userCode: 77, activeTransferId: null },
  });
  const result = await getActiveGoldslotTransfer({ uid: 'u1' }, { db });
  assert.deepEqual(result, { activeTransfer: null });
});
