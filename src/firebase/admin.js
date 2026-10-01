import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export class FirebaseConfigError extends Error {
  constructor(missing) {
    super(`Firebase Admin configuration is incomplete: ${missing.join(', ')}`);
    this.name = 'FirebaseConfigError';
    this.code = 'firebase_admin_unconfigured';
  }
}

export function readFirebaseConfig(env = process.env) {
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
}

export function getAdminAuth(env = process.env) {
  ensureAdminApp(env);
  return getAuth();
}

export function getAdminDb(env = process.env) {
  ensureAdminApp(env);
  return getFirestore();
}
