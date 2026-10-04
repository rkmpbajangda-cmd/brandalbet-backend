import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));

if (config.main !== 'cloudflare-worker.js') {
  throw new Error(`Unexpected Cloudflare entrypoint: ${config.main ?? 'missing'}`);
}
if (config.name !== 'brandalbet-backend') {
  throw new Error(`Unexpected Cloudflare Worker name: ${config.name ?? 'missing'}`);
}
if (config.keep_vars !== true) {
  throw new Error('Cloudflare keep_vars must remain true so dashboard-managed secrets are not dropped by deploys.');
}

const compatibilityDate = String(config.compatibility_date ?? '');
if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate) || compatibilityDate < '2026-08-04') {
  throw new Error('Cloudflare compatibility_date must be 2026-08-04 or later for the required Node.js compatibility defaults.');
}

const vars = config.vars ?? {};
const forbiddenPlaintextSecrets = [
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  'GOLDSLOTPALASE_API_TOKEN',
  'PAYMENT_CONFIG_ENCRYPTION_KEY',
  'BOOTSTRAP_SUPERADMIN_UID',
];
for (const name of forbiddenPlaintextSecrets) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) {
    throw new Error(`${name} must be a Cloudflare secret, not a plaintext wrangler var.`);
  }
}

const requiredSecrets = new Set(config.secrets?.required ?? []);
for (const name of ['FIREBASE_SERVICE_ACCOUNT_JSON', 'GOLDSLOTPALASE_API_TOKEN']) {
  if (!requiredSecrets.has(name)) {
    throw new Error(`${name} must be declared in wrangler secrets.required.`);
  }
}
for (const name of requiredSecrets) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) {
    throw new Error(`${name} cannot be declared as both a secret and a plaintext var.`);
  }
}

const requiredSafeVars = {
  FIREBASE_PROJECT_ID: 'brandal-bet',
  ALLOWED_MEMBER_ORIGINS: 'https://brandalbet.blogspot.com',
  ALLOWED_BACKOFFICE_ORIGINS: 'https://backoffic.blogspot.com',
  MEMBER_SINGLE_SESSION_ENABLED: 'true',
  BOOTSTRAP_ENABLED: 'false',
  GOLDSLOTPALASE_API_URL: 'https://agent.goldslotpalase.com',
  GOLDSLOTPALASE_TRANSFER_ENABLED: 'false',
  GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED: 'false',
};
for (const [name, expected] of Object.entries(requiredSafeVars)) {
  if (vars[name] !== expected) {
    throw new Error(`Unsafe or unexpected ${name}: expected ${JSON.stringify(expected)}.`);
  }
}

const firebaseAdminSource = await readFile('src/firebase/admin.js', 'utf8');
if (!/initializeFirestore\s*\([^)]*,\s*\{\s*preferRest\s*:\s*true\s*\}/s.test(firebaseAdminSource)) {
  throw new Error('Cloudflare Firestore must use initializeFirestore(..., { preferRest: true }) to avoid gRPC transport.');
}

for (const file of ['cloudflare-worker.js', 'deno-server.js', 'src/firebase/admin.js']) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}

console.log('Cloudflare build validation passed: entrypoint, adapter, compatibility date, required secrets, Firestore REST transport, secret boundaries, and fail-safe production gates are valid.');
