import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';

const ADMINS = new Set(['admin', 'superadmin']);
const DOC_COLLECTION = 'systemSettings';
const DOC_ID = 'masterControl';
const DEFAULTS = Object.freeze({
  maintenanceMode: false,
  gameLaunchEnabled: true,
  registrationEnabled: true,
  promotionsEnabled: true,
  memberWalletEnabled: true,
  maintenanceMessage: '',
});
const TTL_MS = 60_000;
let cache = null;

function requireAdmin(actor) {
  if (actor?.backoffice !== true || !ADMINS.has(actor.role)) throw new ServiceError('forbidden', 403);
}

function safeMessage(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ServiceError('invalid_master_control');
  const clean = value.trim();
  if (clean.length > 240) throw new ServiceError('invalid_master_control');
  return clean;
}

function normalize(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid_master_control');
  const out = {};
  for (const key of ['maintenanceMode', 'gameLaunchEnabled', 'registrationEnabled', 'promotionsEnabled', 'memberWalletEnabled']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new ServiceError('invalid_master_control');
      out[key] = input[key];
    }
  }
  const message = safeMessage(input.maintenanceMessage);
  if (message !== undefined) out.maintenanceMessage = message;
  return out;
}

function view(data = {}) {
  return Object.freeze({
    ...DEFAULTS,
    ...normalize(data),
    revision: Number.isSafeInteger(data.revision) && data.revision >= 0 ? data.revision : 0,
    updatedAt: typeof data.updatedAt?.toDate === 'function' ? data.updatedAt.toDate().toISOString() : null,
    updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : null,
  });
}

export function clearMasterControlCache() { cache = null; }

export async function loadMasterControl({ db = getAdminDb(), now = Date.now, ttlMs = TTL_MS } = {}) {
  const current = now();
  if (cache && current < cache.expiresAt) return cache.value;
  const snapshot = await db.collection(DOC_COLLECTION).doc(DOC_ID).get();
  const value = view(snapshot.exists ? snapshot.data() : {});
  cache = { value, expiresAt: current + ttlMs };
  return value;
}

export async function updateMasterControl(actor, input, { db = getAdminDb() } = {}) {
  requireAdmin(actor);
  if (!input || input.action !== 'update') throw new ServiceError('invalid_master_control_action');
  const changes = normalize(input.settings);
  const expectedRevision = Number(input.expectedRevision ?? 0);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ServiceError('invalid_master_control_revision');

  const ref = db.collection(DOC_COLLECTION).doc(DOC_ID);
  const auditRef = db.collection('auditEvents').doc();
  const stamp = FieldValue.serverTimestamp();
  let nextRevision = expectedRevision + 1;

  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const current = snapshot.exists ? snapshot.data() ?? {} : {};
    const currentRevision = Number.isSafeInteger(current.revision) ? current.revision : 0;
    if (currentRevision !== expectedRevision) throw new ServiceError('master_control_revision_conflict', 409);
    nextRevision = currentRevision + 1;
    tx.set(ref, {
      ...DEFAULTS,
      ...current,
      ...changes,
      revision: nextRevision,
      updatedAt: stamp,
      updatedBy: actor.uid,
    }, { merge: false });
    tx.create(auditRef, {
      action: 'system.master_control.update',
      actorUid: actor.uid,
      targetId: DOC_ID,
      revision: nextRevision,
      createdAt: stamp,
    });
  });

  clearMasterControlCache();
  const snapshot = await ref.get();
  return view(snapshot.data() ?? {});
}

export function publicMasterControl(control) {
  const c = control ?? DEFAULTS;
  return Object.freeze({
    maintenanceMode: c.maintenanceMode === true,
    gameLaunchEnabled: c.gameLaunchEnabled !== false,
    registrationEnabled: c.registrationEnabled !== false,
    promotionsEnabled: c.promotionsEnabled !== false,
    memberWalletEnabled: c.memberWalletEnabled !== false,
    maintenanceMessage: typeof c.maintenanceMessage === 'string' ? c.maintenanceMessage : '',
    revision: Number.isSafeInteger(c.revision) ? c.revision : 0,
  });
}
