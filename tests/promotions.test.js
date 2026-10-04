import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDb } from './helpers/transaction-db.js';
import { sanitizePromotion, mutatePromotion, listPromotions } from '../src/promotion/service.js';
import { createHandler } from '../cloudflare/functions/backoffice-promotions.js';
const p = { title: 'Promo', category: 'general', active: true, sortOrder: 1, ctaRoute: 'route-home', sections: [], imageUrl: 'https://example.invalid/banner.png' };
const admin = { uid: 'admin', role: 'admin', backoffice: true };

test('promotions deny financial role mutation and unsafe URLs or dates', async () => {
  await assert.rejects(mutatePromotion({ ...admin, role: 'finance' }, { action: 'upsert', promotion: p }, { db: transactionDb() }), { statusCode: 403 });
  for (const imageUrl of ['javascript:alert(1)', 'http://example.invalid/a', 'https://user:password@example.invalid/a']) assert.throws(() => sanitizePromotion({ ...p, imageUrl }));
  assert.throws(() => sanitizePromotion({ ...p, startAt: '2026-10-02T00:00:00Z', endAt: '2026-10-01T00:00:00Z' }));
});
test('promo edits are versioned and audited atomically; stale editor fails', async () => {
  const db = transactionDb();
  const first = await mutatePromotion(admin, { action: 'upsert', expectedRevision: 0, promotion: p }, { db });
  assert.equal(first.revision, 1);
  await assert.rejects(mutatePromotion(admin, { action: 'upsert', expectedRevision: 0, promotion: { ...p, id: first.id } }, { db }), { code: 'promotion_revision_conflict' });
  assert.equal(db.entries().filter(([k]) => k.startsWith('auditEvents/')).length, 1);
  await mutatePromotion(admin, { action: 'delete', id: first.id, expectedRevision: 1 }, { db });
  assert.equal(db.read('promotions/' + first.id).deleted, true);
  assert.equal(db.entries().filter(([k]) => k.startsWith('auditEvents/')).length, 2);
});
test('public promotions exclude unpublished, expired, future and deleted items', async () => {
  const values = [{ ...p, id: 'valid' }, { ...p, id: 'inactive', active: false }, { ...p, id: 'deleted', deleted: true },
    { ...p, id: 'future', startAt: '2099-01-01T00:00:00Z' }, { ...p, id: 'expired', endAt: '2000-01-01T00:00:00Z' }];
  const query = { orderBy: () => query, limit: () => query, get: async () => ({ docs: values.map(v => ({ id: v.id, data: () => v })) }) };
  assert.deepEqual((await listPromotions({ publicOnly: true, db: { collection: () => query } })).map(p => p.id), ['valid']);
});
test('member token cannot access backoffice promotions even with a forged body role', async () => {
  let called = false;
  const handler = createHandler({ verifyIdToken: async () => ({ uid: 'u', role: 'member' }), mutate: async () => { called = true; } });
  const result = await handler({ httpMethod: 'POST', headers: { Authorization: 'Bearer test', 'content-type': 'application/json' }, body: '{"role":"superadmin"}' });
  assert.equal(result.statusCode, 403); assert.equal(called, false);
});
