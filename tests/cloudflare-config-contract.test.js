import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configurationReadiness } from '../src/config/readiness.js';

test('wrangler declares all server-side secrets required by the current backend contract', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const required = new Set(config.secrets?.required ?? []);
  for (const name of [
    'FIREBASE_SERVICE_ACCOUNT_JSON',
    'GOLDSLOTPALASE_API_TOKEN',
    'BOOTSTRAP_SUPERADMIN_UID',
    'PAYMENT_CONFIG_ENCRYPTION_KEY',
  ]) {
    assert.equal(required.has(name), true, `${name} must remain a Cloudflare secret`);
    assert.equal(Object.prototype.hasOwnProperty.call(config.vars ?? {}, name), false, `${name} must not be plaintext`);
  }
  assert.equal(config.vars.FIREBASE_PROJECT_ID, 'brandal-bet');
  assert.equal(config.vars.BOOTSTRAP_ENABLED, 'false');
  assert.equal(config.vars.GOLDSLOTPALASE_IDR_SCALE, '0');
});

test('readiness reports Firebase project match and bootstrap target without exposing values', () => {
  const readiness = configurationReadiness({
    FIREBASE_PROJECT_ID: 'brandal-bet',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'brandal-bet', client_email: 'svc@example.invalid', private_key: 'hidden' }),
    BOOTSTRAP_SUPERADMIN_UID: 'admin-target-uid',
    ALLOWED_MEMBER_ORIGINS: 'https://brandalbet.blogspot.com',
    ALLOWED_BACKOFFICE_ORIGINS: 'https://backoffic.blogspot.com',
    GOLDSLOTPALASE_API_TOKEN: 'hidden-provider-token',
    GOLDSLOTPALASE_API_URL: 'https://agent.goldslotpalase.com',
    GOLDSLOTPALASE_IDR_SCALE: '0',
    GOLDSLOTPALASE_TRANSFER_ENABLED: 'false',
    GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED: 'false',
    PAYMENT_CONFIG_ENCRYPTION_KEY: 'hidden-payment-key',
    BOOTSTRAP_ENABLED: 'false',
  });

  assert.equal(readiness.integrations.firebase.credentialsConfigured, true);
  assert.equal(readiness.integrations.firebase.projectMatches, true);
  assert.equal(readiness.integrations.firebase.projectId, 'brandal-bet');
  assert.equal(readiness.bootstrapTargetConfigured, true);
  assert.equal(readiness.bootstrapEnabled, false);
  assert.equal(readiness.integrations.paymentVaultConfigured, true);
  assert.equal(readiness.integrations.providerTransfer.enabled, false);
  assert.equal(readiness.integrations.providerTransfer.idrScaleVerified, false);
  assert.equal(JSON.stringify(readiness).includes('admin-target-uid'), false);
  assert.equal(JSON.stringify(readiness).includes('hidden-provider-token'), false);
  assert.equal(JSON.stringify(readiness).includes('hidden-payment-key'), false);
});

test('readiness fails Firebase project match when service account belongs to another project', () => {
  const readiness = configurationReadiness({
    FIREBASE_PROJECT_ID: 'brandal-bet',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'other-project' }),
  });
  assert.equal(readiness.integrations.firebase.credentialsConfigured, true);
  assert.equal(readiness.integrations.firebase.projectMatches, false);
});
