import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as createDashboardHandler } from '../netlify/functions/backoffice-dashboard.js';
import {
  jakartaDayKey,
  listMembers,
  listLedger,
  listAudit,
  providerStatus,
  report,
  websiteSettings,
} from '../src/backoffice/service.js';

const member = { uid: 'member-1', role: 'member', backoffice: false };
const operator = { uid: 'operator-1', role: 'operator', backoffice: true };
const finance = { uid: 'finance-1', role: 'finance', backoffice: true };
const admin = { uid: 'admin-1', role: 'admin', backoffice: true };

const getEvent = {
  httpMethod: 'GET',
  headers: { Authorization: 'Bearer test' },
  queryStringParameters: {},
};

test('backoffice dashboard rejects member tokens before business logic', async () => {
  let called = false;
  const handler = createDashboardHandler({
    verifyIdToken: async () => member,
    run: async () => { called = true; return {}; },
  });
  const result = await handler(getEvent);
  assert.equal(result.statusCode, 403);
  assert.equal(called, false);
});

test('backoffice dashboard accepts a valid backoffice finance token', async () => {
  let called = false;
  const handler = createDashboardHandler({
    verifyIdToken: async () => finance,
    run: async actor => { called = true; assert.equal(actor.uid, finance.uid); return { members: 0 }; },
  });
  const result = await handler(getEvent);
  assert.equal(result.statusCode, 200);
  assert.equal(called, true);
  assert.equal(JSON.parse(result.body).members, 0);
});

test('module-level RBAC separates operations, finance and admin scopes', async () => {
  await assert.rejects(listMembers(finance, getEvent, { db: {} }), { statusCode: 403 });
  await assert.rejects(listLedger(operator, getEvent, { db: {} }), { statusCode: 403 });
  await assert.rejects(listAudit(operator, getEvent, { db: {} }), { statusCode: 403 });
  await assert.rejects(report(operator, { action: 'export', type: 'finance' }, { db: {} }), { statusCode: 403 });
  await assert.rejects(report(finance, { action: 'export', type: 'member' }, { db: {} }), { statusCode: 403 });
  await assert.rejects(
    websiteSettings(operator, { httpMethod: 'POST' }, { action: 'update', section: 'general', settings: {} }, {
      db: { collection: () => ({ doc: () => ({}) }) },
    }),
    { statusCode: 403 },
  );
});

test('GoldslotPalase capability response exposes documented RTP controls only', async () => {
  const result = await providerStatus(operator, getEvent, {
    env: {
      GOLDSLOTPALASE_TRANSFER_ENABLED: 'false',
      GOLDSLOTPALASE_IDR_SCALE: '1',
      GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED: 'false',
    },
    clientFactory: () => ({}),
    loadCatalog: async () => ({ games: [{ id: 'g1' }], syncedAt: '2026-10-03T00:00:00.000Z' }),
  });
  assert.equal(result.provider, 'goldslotpalase');
  assert.equal(result.status, 'healthy');
  assert.equal(result.capabilities.rtpGlobal, true);
  assert.equal(result.capabilities.rtpPerGame, false);
  assert.equal(result.capabilities.rtpPerUser, true);
  assert.equal(result.capabilities.scatterControl, false);
  assert.equal(result.capabilities.walletTransfer, false);
});

test('daily finance keys follow Asia/Jakarta rather than UTC midnight', () => {
  assert.equal(jakartaDayKey('2026-10-02T16:59:59.000Z'), '2026-10-02');
  assert.equal(jakartaDayKey('2026-10-02T17:00:00.000Z'), '2026-10-03');
  assert.equal(jakartaDayKey('2026-10-03T00:30:00+07:00'), '2026-10-03');
});

test('admin role remains eligible for operations and settings scope', async () => {
  const result = await providerStatus(admin, getEvent, {
    env: {},
    clientFactory: () => ({}),
    loadCatalog: async () => ({ games: [], syncedAt: '2026-10-03T00:00:00.000Z' }),
  });
  assert.equal(result.gamesCount, 0);
});
