import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase/admin.js';

const EDITABLE_FIELDS = Object.freeze({
  displayName: 80,
  phone: 32,
  language: 12,
  timezone: 64,
});

export class ProfileValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProfileValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

function cleanString(value, max, field) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new ProfileValidationError('invalid_' + field);
  const cleaned = value.trim();
  if (cleaned.length > max) throw new ProfileValidationError('invalid_' + field);
  return cleaned;
}

export function sanitizeProfilePatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProfileValidationError('invalid_profile_payload');
  }

  const output = {};
  for (const [field, max] of Object.entries(EDITABLE_FIELDS)) {
    const value = cleanString(input[field], max, field);
    if (value !== undefined) output[field] = value;
  }

  const unexpected = Object.keys(input).filter((key) => !(key in EDITABLE_FIELDS));
  if (unexpected.length) throw new ProfileValidationError('unsupported_profile_field');
  if (Object.keys(output).length === 0) throw new ProfileValidationError('empty_profile_patch');
  return output;
}

export function profileView(uid, data = {}) {
  return {
    uid,
    email: typeof data.email === 'string' ? data.email : null,
    username: typeof data.username === 'string' ? data.username : '',
    displayName: typeof data.displayName === 'string' ? data.displayName : '',
    phone: typeof data.phone === 'string' ? data.phone : '',
    language: typeof data.language === 'string' ? data.language : 'id',
    timezone: typeof data.timezone === 'string' ? data.timezone : 'Asia/Jakarta',
    onboardingCompleted: data.onboardingCompleted === true,
  };
}

export async function getOrCreateProfile(actor, { db = getAdminDb() } = {}) {
  const ref = db.collection('users').doc(actor.uid);
  const snapshot = await ref.get();
  if (snapshot.exists) return profileView(actor.uid, snapshot.data());

  const initial = {
    uid: actor.uid,
    email: typeof actor.email === 'string' ? actor.email : null,
    username: '',
    displayName: typeof actor.name === 'string' ? actor.name : '',
    phone: '',
    language: 'id',
    timezone: 'Asia/Jakarta',
    onboardingCompleted: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.create(initial);
  return profileView(actor.uid, initial);
}

export async function updateProfile(actor, patch, { db = getAdminDb() } = {}) {
  const safe = sanitizeProfilePatch(patch);
  const ref = db.collection('users').doc(actor.uid);
  await ref.set({
    uid: actor.uid,
    email: typeof actor.email === 'string' ? actor.email : null,
    ...safe,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  const snapshot = await ref.get();
  return profileView(actor.uid, snapshot.data());
}
