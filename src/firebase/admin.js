import { cert, getApps, getApp, initializeApp } from '@ljoukov/firebase-admin-cloudflare/app';
import { getFirestore } from '@ljoukov/firebase-admin-cloudflare/firestore';
import { getGoogleAccessToken } from './firestore-rest.js';

export class FirebaseConfigError extends Error {
  constructor(missing) {
    super(`Firebase configuration is incomplete: ${missing.join(', ')}`);
    this.name = 'FirebaseConfigError';
    this.code = 'firebase_admin_unconfigured';
  }
}

export class FirebaseProjectMismatchError extends Error {
  constructor(expectedProjectId, actualProjectId) {
    super('Firebase service account project does not match FIREBASE_PROJECT_ID');
    this.name = 'FirebaseProjectMismatchError';
    this.code = 'firebase_admin_project_mismatch';
    this.expectedProjectId = expectedProjectId;
    this.actualProjectId = actualProjectId;
  }
}

function readServiceAccountJson(env = {}) {
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

  const expectedProjectId = typeof env.FIREBASE_PROJECT_ID === 'string'
    ? env.FIREBASE_PROJECT_ID.trim()
    : '';
  if (expectedProjectId && projectId !== expectedProjectId) {
    throw new FirebaseProjectMismatchError(expectedProjectId, projectId);
  }

  return {
    projectId,
    clientEmail,
    privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
  };
}

export function readFirebaseConfig(env = process.env) {
  const bundled = readServiceAccountJson(env);
  if (bundled) return bundled;

  const projectId = typeof env.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID.trim() : '';
  const clientEmail = typeof env.FIREBASE_CLIENT_EMAIL === 'string' ? env.FIREBASE_CLIENT_EMAIL.trim() : '';
  const privateKeyRaw = env.FIREBASE_PRIVATE_KEY;
  const missing = [];
  if (!projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (typeof privateKeyRaw !== 'string' || !privateKeyRaw.trim()) missing.push('FIREBASE_PRIVATE_KEY');
  if (missing.length) throw new FirebaseConfigError(missing);

  return {
    projectId,
    clientEmail,
    privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
  };
}

export function ensureAdminApp(env = process.env) {
  const existing = getApps();
  if (existing.length > 0) {
    const app = getApp();
    const expectedProjectId = typeof env.FIREBASE_PROJECT_ID === 'string'
      ? env.FIREBASE_PROJECT_ID.trim()
      : '';
    const actualProjectId = app.options?.projectId || app.options?.credential?.getServiceAccount?.().projectId;
    if (expectedProjectId && actualProjectId && actualProjectId !== expectedProjectId) {
      throw new FirebaseProjectMismatchError(expectedProjectId, actualProjectId);
    }
    return app;
  }

  const { projectId, clientEmail, privateKey } = readFirebaseConfig(env);
  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    projectId,
  });
}

let firestoreInstance = null;

export function getAdminAuth(env = process.env) {
  const { projectId } = readFirebaseConfig(env);
  const identityScope = 'https://www.googleapis.com/auth/identitytoolkit';

  async function requestIdentityToolkit(action, body) {
    const accessToken = await getGoogleAccessToken(env, identityScope);
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts:${action}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const error = new Error(
        response.status === 404 ? 'auth/user-not-found'
          : response.status === 401 || response.status === 403 ? 'firebase_auth_admin_permission_denied'
            : 'firebase_auth_admin_request_failed',
      );
      error.code = response.status === 404 ? 'auth/user-not-found'
        : response.status === 401 || response.status === 403 ? 'firebase_auth_admin_permission_denied'
          : 'firebase_auth_admin_request_failed';
      error.statusCode = response.status >= 500 ? 503 : response.status === 404 ? 404 : 502;
      throw error;
    }

    return response.json();
  }

  return {
    async getUser(uid) {
      if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
        const error = new Error('auth/invalid-uid');
        error.code = 'auth/invalid-uid';
        throw error;
      }
      const result = await requestIdentityToolkit('lookup', { localId: [uid] });
      const user = Array.isArray(result.users) ? result.users.find(item => item.localId === uid) : null;
      if (!user) {
        const error = new Error('auth/user-not-found');
        error.code = 'auth/user-not-found';
        throw error;
      }

      let customClaims = {};
      if (typeof user.customAttributes === 'string' && user.customAttributes.trim()) {
        try {
          const parsed = JSON.parse(user.customAttributes);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) customClaims = parsed;
        } catch {
          const error = new Error('firebase_auth_custom_claims_invalid');
          error.code = 'firebase_auth_custom_claims_invalid';
          throw error;
        }
      }
      return { ...user, uid: user.localId, customClaims };
    },

    async setCustomUserClaims(uid, claims) {
      if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
        const error = new Error('auth/invalid-uid');
        error.code = 'auth/invalid-uid';
        throw error;
      }
      if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
        const error = new Error('auth/invalid-claims');
        error.code = 'auth/invalid-claims';
        throw error;
      }
      let customAttributes;
      try {
        customAttributes = JSON.stringify(claims);
      } catch {
        const error = new Error('auth/invalid-claims');
        error.code = 'auth/invalid-claims';
        throw error;
      }
      if (new TextEncoder().encode(customAttributes).byteLength > 1000) {
        const error = new Error('auth/claims-too-large');
        error.code = 'auth/claims-too-large';
        throw error;
      }
      await requestIdentityToolkit('update', { localId: uid, customAttributes });
    },
  };
}

export function getAdminDb(env = process.env) {
  const app = ensureAdminApp(env);
  if (!firestoreInstance) firestoreInstance = getFirestore(app);
  return firestoreInstance;
}
