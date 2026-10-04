import test from 'node:test';
import assert from 'node:assert/strict';
import { readFirebaseConfig, FirebaseProjectMismatchError } from '../src/firebase/admin.js';

test('bundled Firebase service account must match FIREBASE_PROJECT_ID', () => {
  const env = {
    FIREBASE_PROJECT_ID: 'brandal-bet',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: 'wrong-project',
      client_email: 'firebase-adminsdk@example.invalid',
      private_key: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n',
    }),
  };

  assert.throws(
    () => readFirebaseConfig(env),
    (error) => error instanceof FirebaseProjectMismatchError
      && error.code === 'firebase_admin_project_mismatch'
      && error.expectedProjectId === 'brandal-bet'
      && error.actualProjectId === 'wrong-project',
  );
});

test('bundled Firebase service account is accepted when project matches', () => {
  const env = {
    FIREBASE_PROJECT_ID: 'brandal-bet',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: 'brandal-bet',
      client_email: 'firebase-adminsdk@brandal-bet.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n',
    }),
  };

  const config = readFirebaseConfig(env);
  assert.equal(config.projectId, 'brandal-bet');
  assert.equal(config.clientEmail, 'firebase-adminsdk@brandal-bet.iam.gserviceaccount.com');
});
