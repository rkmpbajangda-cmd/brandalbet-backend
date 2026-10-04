import { cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { initializeFirestore } from 'firebase-admin/firestore';

export class FirebaseConfigError extends Error {
  constructor(missing) {
    super(`Firebase Admin configuration is incomplete: ${missing.join(', ')}`);
    this.name = 'FirebaseConfigError';
    this.code = 'firebase_admin_unconfigured';
  }
}

function readServiceAccountJson(env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (typeof raw !== 'string' || !raw.trim()) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FirebaseConfigError(['FIREBASE_SERVICE_ACCOUNT_JSON_INVALID_JSON']);
  }

  const projectId = typeof parsed?.project_id === 'string' ? parsed.project_id.trim() : '';
  const clientEmail = typeof parsed?.client_email === 'string' ? parsed.client_email.trim() : '';
  const privateKeyRaw = typeof parsed?.private_key === 'string' ? parsed.private_key : '';
  const missing = [];

  if (!projectId) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON.project_id');
  if (!clientEmail) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON.client_email');
  if (!privateKeyRaw) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON.private_key');
  if (missing.length) throw new FirebaseConfigError(missing);

  return {
    projectId,
    clientEmail,
    privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
  };
}

export function readFirebaseConfig(env = process.env) {
  const bundled = readServiceAccountJson(env);
  if (bundled) return bundled;

  const projectId = env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKeyRaw = env.FIREBASE_PRIVATE_KEY;
  const missing = [];

  if (!projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!privateKeyRaw) missing.push('FIREBASE_PRIVATE_KEY');
  if (missing.length) throw new FirebaseConfigError(missing);

  return {
    projectId,
    clientEmail,
    privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
  };
}

export function ensureAdminApp(env = process.env) {
  if (getApps().length === 0) {
    const { projectId, clientEmail, privateKey } = readFirebaseConfig(env);
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      projectId,
    });
  }
  return getApp();
}

let firestoreInstance = null;

export function getAdminAuth(env = process.env) {
  return getAuth(ensureAdminApp(env));
}

export function getAdminDb(env = process.env) {
  const app = ensureAdminApp(env);
  if (!firestoreInstance) {
    // Force HTTP/1.1 REST transport. This avoids gRPC transport assumptions and
    // is the safer server SDK mode for Cloudflare Workers / edge runtimes.
    firestoreInstance = initializeFirestore(app, { preferRest: true });
  }
  return firestoreInstance;
}
