import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

const MAX_META_KEYS = 30;
const MAX_TEXT = 500;

function text(value, max = MAX_TEXT) {
  if (value == null) return null;
  const out = String(value).trim();
  return out ? out.slice(0, max) : null;
}

function safeMeta(value, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeMeta(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_META_KEYS)) {
      if (/token|secret|password|private.?key|authorization|cookie|account.?number/i.test(key)) continue;
      out[text(key, 80)] = safeMeta(item, depth + 1);
    }
    return out;
  }
  return null;
}

export function makeAuditEvent(input = {}) {
  const actorUid = text(input.actorUid, 128);
  const action = text(input.action, 160);
  if (!actorUid || !action) throw new Error('audit_actor_and_action_required');
  const targetId = text(input.targetId ?? input.resource, 180);
  const requestId = text(input.requestId, 180);
  const outcome = text(input.outcome ?? input.result ?? 'success', 40) || 'success';
  const event = {
    actorUid,
    action,
    targetId,
    outcome,
    requestId,
    metadata: safeMeta(input.metadata),
    createdAt: input.createdAt ?? FieldValue.serverTimestamp(),
    schemaVersion: 1,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify({
    actorUid, action, targetId, outcome, requestId, metadata: event.metadata,
  })).digest('hex');
  return { ...event, fingerprint };
}

export function auditDocId({ action, requestId, actorUid, targetId } = {}) {
  return createHash('sha256').update(JSON.stringify([
    text(action, 160), text(requestId, 180), text(actorUid, 128), text(targetId, 180),
  ])).digest('hex');
}
