import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoldslotClient } from '../src/game/goldslotpalase.js';
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
