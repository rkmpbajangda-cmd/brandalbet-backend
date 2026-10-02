import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';
import { ServiceError } from '../utils/errors.js';
import { PAYMENT_ADAPTERS, connectionReadiness } from './registry.js';
import { FIELD_PRESETS, DEFAULT_CREDENTIAL_SCHEMA, validateCredentialSchema, validateCredentialValues } from './fields.js';
import { sealCredentials, openCredentials, vaultConfigured } from './vault.js';

export function requirePaymentAdmin(actor, { write = false, now = Date.now() } = {}) {
  if (actor?.backoffice !== true || !['admin', 'superadmin'].includes(actor.role)) throw new ServiceError('forbidden', 403);
  if (write && (!Number.isInteger(actor.auth_time) || actor.auth_time * 1000 > now + 60000 || now - actor.auth_time * 1000 > 600000)) {
    throw new ServiceError('recent_login_required', 401);
  }
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ServiceError('invalid_payment_connection');
  const { id, label, provider, mode, expectedRevision, credentials = {} } = input;
  const allowed = new Set(['id', 'label', 'provider', 'mode', 'expectedRevision', 'credentials', 'credentialSchema']);
  if (Object.keys(input).some(k => !allowed.has(k))) throw new ServiceError('unsupported_payment_field');
  if (id !== undefined && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw new ServiceError('invalid_connection_id');
  if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new ServiceError('invalid_connection_label');
  if (typeof provider !== 'string' || !/^[a-z][a-z0-9_-]{1,49}$/.test(provider)) throw new ServiceError('invalid_payment_provider');
  if (!['sandbox', 'production'].includes(mode)) throw new ServiceError('invalid_payment_mode');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ServiceError('expected_revision_required', 409);
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new ServiceError('invalid_payment_credentials');
  const schema = input.credentialSchema === undefined ? undefined : validateCredentialSchema(input.credentialSchema);
  const safe = {};
  for (const [field, value] of Object.entries(credentials)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(field) || ['constructor','prototype','__proto__'].includes(field.toLowerCase()) || typeof value !== 'string' || value.length > 12000) throw new ServiceError('invalid_payment_credentials');
    // Empty fields mean preserve the existing encrypted value, never erase it accidentally.
    if (value.trim()) safe[field] = value;
  }
  return { id, label: label.trim(), provider, mode, expectedRevision, credentials: safe, credentialSchema: schema };
}
export function connectionView(id, record, adapters = PAYMENT_ADAPTERS) {
  const schema = validateCredentialSchema(record.credentialSchema ?? DEFAULT_CREDENTIAL_SCHEMA);
  return { id, label: record.label, provider: record.provider, mode: record.mode, revision: record.revision,
    credentialSchema: schema, credentialFields: schema.map(f=>f.id).filter(f => record.credentialFields?.includes(f)),
    ...connectionReadiness(record, adapters) };
}
export async function listConnections(actor, { db = getAdminDb(), env = process.env, adapters = PAYMENT_ADAPTERS } = {}) {
  requirePaymentAdmin(actor);
  const result = await db.collection('paymentConnections').orderBy('createdAt', 'desc').limit(100).get();
  return { connections: result.docs.map(d => connectionView(d.id, d.data(), adapters)),
    vaultConfigured: vaultConfigured(env), limit: 100, fieldPresets: FIELD_PRESETS, defaultCredentialSchema: DEFAULT_CREDENTIAL_SCHEMA,
    supportedProviders: Object.entries(adapters).map(([id, a]) => ({ id, label: a.label, requiredCredentials: a.requiredCredentials, available: a.productionApproved === true })) };
}
export async function saveConnection(actor, input, { db = getAdminDb(), env = process.env, adapters = PAYMENT_ADAPTERS, now = Date.now() } = {}) {
  requirePaymentAdmin(actor, { write: true, now });
  const safe = validate(input);
  if (!vaultConfigured(env)) throw new ServiceError('payment_vault_unconfigured', 503);
  const id = safe.id || randomUUID();
  const ref = db.collection('paymentConnections').doc(id);
  const auditRef = db.collection('auditEvents').doc();
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const current = snapshot.exists ? snapshot.data() : null;
    if ((safe.id && !current) || (!safe.id && safe.expectedRevision !== 0)) throw new ServiceError('connection_not_found', 404);
    if ((current?.revision ?? 0) !== safe.expectedRevision) throw new ServiceError('payment_revision_conflict', 409);
    if (current && (current.provider !== safe.provider || current.mode !== safe.mode)) throw new ServiceError('create_separate_connection_for_provider_or_mode', 409);
    const old = current ? openCredentials(id, current.credentials, env) : {};
    const schema = validateCredentialSchema(safe.credentialSchema ?? current?.credentialSchema ?? DEFAULT_CREDENTIAL_SCHEMA);
    if (Object.keys(old).some(id=>!schema.some(field=>field.id===id))) throw new ServiceError('credential_field_in_use', 409);
    const merged = { ...old, ...safe.credentials };
    validateCredentialValues(merged, schema);
    const timestamp = FieldValue.serverTimestamp();
    const record = { label: safe.label, provider: safe.provider, mode: safe.mode,
      credentials: sealCredentials(id, merged, env), credentialSchema: schema, credentialFields: schema.map(f=>f.id).filter(f => Boolean(merged[f])),
      revision: safe.expectedRevision + 1, createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp,
      updatedBy: actor.uid, enabled: false };
    tx.set(ref, record);
    tx.create(auditRef, { action: current ? 'payment.connection.update' : 'payment.connection.create', actorUid: actor.uid,
      targetId: id, revision: record.revision, changedCredentialFields: Object.keys(safe.credentials), createdAt: timestamp });
    return connectionView(id, record, adapters);
  });
}
