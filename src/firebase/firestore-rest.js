class FirebaseConfigError extends Error {
  constructor(missing) {
    super(`Firebase REST configuration is incomplete: ${missing.join(', ')}`);
    this.name = 'FirebaseConfigError';
    this.code = 'firebase_rest_unconfigured';
  }
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const TOKEN_TTL_SECONDS = 300;

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeText(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function pemToArrayBuffer(pem) {
  const clean = String(pem).replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function readServiceAccount(env) {
  const raw = env?.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new FirebaseConfigError(['FIREBASE_SERVICE_ACCOUNT_JSON']);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FirebaseConfigError(['FIREBASE_SERVICE_ACCOUNT_JSON_INVALID_JSON']);
  }
  const projectId = typeof parsed?.project_id === 'string' ? parsed.project_id.trim() : '';
  const clientEmail = typeof parsed?.client_email === 'string' ? parsed.client_email.trim() : '';
  const privateKey = typeof parsed?.private_key === 'string' ? parsed.private_key.replace(/\\n/g, '\n') : '';
  const expectedProjectId = typeof env?.FIREBASE_PROJECT_ID === 'string' ? env.FIREBASE_PROJECT_ID.trim() : '';
  const missing = [];
  if (!projectId) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON.project_id');
  if (!clientEmail) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON.client_email');
  if (!privateKey) missing.push('FIREBASE_SERVICE_ACCOUNT_JSON.private_key');
  if (missing.length) throw new FirebaseConfigError(missing);
  if (expectedProjectId && projectId !== expectedProjectId) {
    const error = new Error('Firebase Admin service account project does not match FIREBASE_PROJECT_ID');
    error.code = 'firebase_admin_project_mismatch';
    throw error;
  }
  return { projectId, clientEmail, privateKey };
}

let tokenCache = null;
let signingKeyPromise = null;

async function getSigningKey(privateKey) {
  if (!signingKeyPromise) {
    signingKeyPromise = crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(privateKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  return signingKeyPromise;
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt > now + 30) return tokenCache.value;

  const account = readServiceAccount(env);
  const header = base64UrlEncodeText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncodeText(JSON.stringify({
    iss: account.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  }));
  const unsigned = header + '.' + payload;
  const key = await getSigningKey(account.privateKey);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + '.' + base64UrlEncodeBytes(new Uint8Array(signature));

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    const error = new Error('firebase_service_account_token_failed');
    error.code = 'firebase_service_account_token_failed';
    error.detail = detail;
    throw error;
  }
  const data = await response.json();
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    const error = new Error('firebase_service_account_token_missing');
    error.code = 'firebase_service_account_token_missing';
    throw error;
  }
  tokenCache = {
    value: data.access_token,
    expiresAt: now + Math.min(Number(data.expires_in) || TOKEN_TTL_SECONDS, TOKEN_TTL_SECONDS),
  };
  return tokenCache.value;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

function documentUrl(projectId, path) {
  const segments = String(path).split('/').filter(Boolean);
  if (!segments.length) throw new Error('invalid_firestore_document_path');
  return FIRESTORE_BASE + '/projects/' + encodePathSegment(projectId) + '/databases/(default)/documents/' + segments.map(encodePathSegment).join('/');
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return new Date(value.timestampValue);
  if ('stringValue' in value) return value.stringValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields ?? {});
  return null;
}

function decodeFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[key] = decodeValue(value);
  return out;
}

function documentFromRest(document) {
  if (!document) return null;
  return {
    exists: true,
    id: String(document.name || '').split('/').pop() || null,
    ref: null,
    data: () => decodeFields(document.fields ?? {}),
  };
}

async function firestoreFetch(env, url, init = {}) {
  const token = await getAccessToken(env);
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  return response;
}

export function createFirestoreRestDb(env) {
  const account = readServiceAccount(env);
  const projectId = account.projectId;

  const makeRef = path => {
    const ref = {
      path,
      get: async () => {
        const response = await firestoreFetch(env, documentUrl(projectId, path));
        if (response.status === 404) return { exists: false, id: path.split('/').pop(), data: () => ({}) };
        if (!response.ok) {
          const error = new Error('firestore_rest_read_failed');
          error.code = 'firestore_rest_read_failed';
          error.statusCode = response.status >= 500 ? 503 : 502;
          throw error;
        }
        return documentFromRest(await response.json());
      },
      collection: collectionId => makeCollection(path + '/' + encodeURIComponent(collectionId)),
    };
    return ref;
  };

  const makeCollection = path => ({
    path,
    doc: id => makeRef(path + '/' + encodeURIComponent(id)),
  });

  function encodeFirestoreValue(value) {
    if (value === null) return { nullValue: null };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('firestore_rest_invalid_number');
      if (Number.isSafeInteger(value)) return { integerValue: String(value) };
      return { doubleValue: value };
    }
    if (value instanceof Date) return { timestampValue: value.toISOString() };
    if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeFirestoreValue) } };
    if (typeof value === 'object') {
      const fields = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        fields[key] = encodeFirestoreValue(item);
      }
      return { mapValue: { fields } };
    }
    throw new Error('firestore_rest_unsupported_value');
  }

  function encodeFirestoreFields(data = {}) {
    const fields = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      fields[key] = encodeFirestoreValue(value);
    }
    return fields;
  }

  async function commitWrites(writes) {
    if (!Array.isArray(writes) || !writes.length) return;
    const url = FIRESTORE_BASE + '/projects/' + encodePathSegment(projectId) + '/databases/(default)/documents:commit';
    const response = await firestoreFetch(env, url, {
      method: 'POST',
      body: JSON.stringify({ writes }),
    });
    if (!response.ok) {
      const error = new Error('firestore_rest_commit_failed');
      error.code = 'firestore_rest_commit_failed';
      error.statusCode = response.status >= 500 ? 503 : 502;
      throw error;
    }
  }

  return {
    collection: collectionId => makeCollection(encodeURIComponent(collectionId)),
    batch: () => {
      const writes = [];
      const add = write => writes.push(write);
      return {
        set: (ref, data) => {
          add({
            update: {
              name: 'projects/' + encodePathSegment(projectId) + '/databases/(default)/documents/' + ref.path,
              fields: encodeFirestoreFields(data),
            },
          });
        },
        delete: ref => {
          add({
            delete: 'projects/' + encodePathSegment(projectId) + '/databases/(default)/documents/' + ref.path,
          });
        },
        commit: () => commitWrites(writes),
      };
    },
    getAll: async (...refs) => {
      if (!refs.length) return [];
      const names = refs.map(ref => 'projects/' + encodePathSegment(projectId) + '/databases/(default)/documents/' + ref.path);
      const url = FIRESTORE_BASE + '/projects/' + encodePathSegment(projectId) + '/databases/(default)/documents:batchGet';
      const response = await firestoreFetch(env, url, {
        method: 'POST',
        body: JSON.stringify({ documents: names }),
      });
      if (!response.ok) {
        const error = new Error('firestore_rest_batch_read_failed');
        error.code = 'firestore_rest_batch_read_failed';
        error.statusCode = response.status >= 500 ? 503 : 502;
        throw error;
      }
      const text = await response.text();
      const rows = text.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
      const found = new Map();
      for (const row of rows) {
        if (row?.found?.name) found.set(row.found.name, documentFromRest(row.found));
        else if (row?.missing) found.set(row.missing, { exists: false, id: row.missing.split('/').pop(), data: () => ({}) });
      }
      return refs.map(ref => found.get('projects/' + projectId + '/databases/(default)/documents/' + ref.path)
        ?? { exists: false, id: ref.path.split('/').pop(), data: () => ({}) });
    },
  };
}

export function clearFirestoreRestTokenCache() {
  tokenCache = null;
  signingKeyPromise = null;
}
