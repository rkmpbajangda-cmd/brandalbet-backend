import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';
const FIELDS = { title: 100, badge: 40, summary: 240, metaTitle: 100, metaDescription: 160, imageUrl: 2000, ctaLabel: 40, detailIntro: 500 };
const ROUTES = ['route-bonus', 'route-cashback', 'route-vip', 'route-referral', 'route-tournament', 'route-home'];
function text(value, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new ServiceError('invalid_promotion_text');
  return value.trim();
}
export function sanitizePromotion(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid_promotion');
  const result = {};
  for (const [name, max] of Object.entries(FIELDS)) result[name] = text(input[name], max, name === 'title');
  if (!['member', 'reward', 'vip', 'tournament', 'general'].includes(input.category)) throw new ServiceError('invalid_category');
  if (typeof input.active !== 'boolean' || !Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 9999) throw new ServiceError('invalid_promotion_state');
  if (!ROUTES.includes(input.ctaRoute)) throw new ServiceError('invalid_cta_route');
  if (result.imageUrl) {
    let url; try { url = new URL(result.imageUrl); } catch { throw new ServiceError('invalid_image_url'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new ServiceError('invalid_image_url');
  }
  for (const field of ['startAt', 'endAt']) {
    const val = input[field];
    if (val == null || val === '') result[field] = null;
    else if (typeof val !== 'string' || !Number.isFinite(Date.parse(val))) throw new ServiceError('invalid_promotion_period');
    else result[field] = new Date(val).toISOString();
  }
  if (result.startAt && result.endAt && result.endAt <= result.startAt) throw new ServiceError('invalid_promotion_period');
  if (!Array.isArray(input.sections) || input.sections.length > 5) throw new ServiceError('invalid_sections');
  result.sections = input.sections.map(s => ({ title: text(s?.title, 80, true), body: text(s?.body, 1500, true) }));
  return { ...result, category: input.category, active: input.active, sortOrder: input.sortOrder, ctaRoute: input.ctaRoute };
}
function idValue(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new ServiceError('invalid_promotion_id');
  return id;
}
export function promotionView(id, data) {
  const p = sanitizePromotion(data);
  return { id, ...p, revision: data.revision ?? 0 };
}
export async function listPromotions({ publicOnly = false, db = getAdminDb(), now = Date.now() } = {}) {
  const snapshot = await db.collection('promotions').orderBy('sortOrder', 'asc').limit(200).get();
  return snapshot.docs.filter(d => {
    const p = d.data();
    return !p.deleted && (!publicOnly || (p.active === true && (!p.startAt || Date.parse(p.startAt) <= now) && (!p.endAt || Date.parse(p.endAt) > now)));
  }).map(d => promotionView(d.id, d.data()));
}
export async function mutatePromotion(actor, input, { db = getAdminDb() } = {}) {
  if (actor?.backoffice !== true || !['operator', 'admin', 'superadmin'].includes(actor.role)) throw new ServiceError('forbidden', 403);
  if (!['upsert', 'delete'].includes(input?.action)) throw new ServiceError('invalid_promotion_action');
  const p = input.action === 'upsert' ? sanitizePromotion(input.promotion) : null;
  const suppliedId = input.action === 'delete' ? input.id : input.promotion?.id;
  const id = suppliedId ? idValue(suppliedId) : randomUUID();
  const expected = input.expectedRevision;
  if (!Number.isInteger(expected) || expected < 0) throw new ServiceError('expected_revision_required', 409);
  const ref = db.collection('promotions').doc(id);
  const auditRef = db.collection('auditEvents').doc();
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : null;
    if (input.action === 'delete' && (!current || current.deleted)) throw new ServiceError('promotion_not_found', 404);
    if ((current?.revision ?? 0) !== expected || current?.deleted) throw new ServiceError('promotion_revision_conflict', 409);
    const revision = expected + 1;
    const now = FieldValue.serverTimestamp();
    if (p) tx.set(ref, { ...p, revision, updatedAt: now, updatedBy: actor.uid, createdAt: current?.createdAt ?? now });
    else tx.update(ref, { active: false, deleted: true, revision, updatedAt: now, updatedBy: actor.uid });
    tx.create(auditRef, { action: 'promotion.' + input.action, actorUid: actor.uid, targetId: id, revision, createdAt: now });
    return { id, revision };
  });
}
