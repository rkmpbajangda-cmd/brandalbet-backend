import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));

if (config.main !== 'cloudflare-worker.js') throw new Error(`Unexpected Cloudflare entrypoint: ${config.main ?? 'missing'}`);
if (config.name !== 'brandalbet-backend') throw new Error(`Unexpected Cloudflare Worker name: ${config.name ?? 'missing'}`);
if (config.keep_vars !== true) throw new Error('Cloudflare keep_vars must remain true so dashboard-managed secrets and verified runtime vars are not dropped by deploys.');

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
  'GOLDSLOTPALASE_CALLBACK_TOKEN',
  'PAYMENT_CONFIG_ENCRYPTION_KEY',
  'BOOTSTRAP_SUPERADMIN_UID',
];
for (const name of forbiddenPlaintextSecrets) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`${name} must be a Cloudflare secret, not a plaintext wrangler var.`);
}

const requiredSecrets = new Set(config.secrets?.required ?? []);
for (const name of [
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'GOLDSLOTPALASE_API_TOKEN',
  'BOOTSTRAP_SUPERADMIN_UID',
  'PAYMENT_CONFIG_ENCRYPTION_KEY',
]) {
  if (!requiredSecrets.has(name)) throw new Error(`${name} must be declared in wrangler secrets.required.`);
}
for (const name of requiredSecrets) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`${name} cannot be declared as both a secret and a plaintext var.`);
}

const requiredSafeVars = {
  FIREBASE_PROJECT_ID: 'brandal-bet',
  ALLOWED_MEMBER_ORIGINS: 'https://brandalbet.blogspot.com',
  ALLOWED_BACKOFFICE_ORIGINS: 'https://backoffic.blogspot.com',
  MEMBER_SINGLE_SESSION_ENABLED: 'true',
  BOOTSTRAP_ENABLED: 'false',
  GOLDSLOTPALASE_API_URL: 'https://agent.goldslotpalase.com',
  GOLDSLOTPALASE_IDR_SCALE: '0',
  GOLDSLOTPALASE_TRANSFER_ENABLED: 'false',
  GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED: 'false',
  GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED: 'false',
  REWARDS_PAYOUT_ENABLED: 'false',
  REWARDS_MANUAL_INGEST_ENABLED: 'false',
};
for (const [name, expected] of Object.entries(requiredSafeVars)) {
  if (vars[name] !== expected) throw new Error(`Unsafe or unexpected ${name}: expected ${JSON.stringify(expected)}.`);
}

for (const forbiddenPath of ['netlify.toml', 'deno.json', 'deno-server.js', 'netlify']) {
  try {
    await access(forbiddenPath);
    throw new Error(`Legacy runtime artifact must be removed: ${forbiddenPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

if (!Array.isArray(config.assets?.run_worker_first) || config.assets.run_worker_first.includes('/.netlify/functions/*')) {
  throw new Error('Legacy Netlify public route must not be exposed by Cloudflare assets routing.');
}
if (!config.assets.run_worker_first.includes('/api/*') || !config.assets.run_worker_first.includes('/health')) {
  throw new Error('Cloudflare API and health routes must run Worker-first.');
}

const crons = new Set(config.triggers?.crons ?? []);
for (const cron of ['5 * * * *', '15,45 * * * *', '35 */6 * * *']) {
  if (!crons.has(cron)) throw new Error(`Cloudflare scheduled task is missing: ${cron}`);
}
if (crons.size > 5) throw new Error('Cloudflare Free supports at most five cron triggers; keep the backend within that budget.');
if (crons.has('15 */6 * * *') || crons.has('5 */6 * * *')) {
  throw new Error('Legacy combined or six-hour provider sync cron must be removed.');
}

const workerSource = await readFile('cloudflare-worker.js', 'utf8');
if (!workerSource.includes("import('./src/rewards/verified-finalization.js')") || !workerSource.includes('finalizeVerifiedRewardWeekBatch')) {
  throw new Error('Cloudflare reward cron must use verified reward finalization and cannot bypass provider-source integrity gates.');
}
for (const dispatch of ["cron === '5 * * * *'", "cron === '15,45 * * * *'", "cron === '35 */6 * * *'"]) {
  if (!workerSource.includes(dispatch)) throw new Error(`Cloudflare Worker cron dispatch missing: ${dispatch}`);
}
if (!workerSource.includes('finalizeReadyGoldslotRounds')) throw new Error('Compact provider round finalizer must run independently from provider API sync.');

const ledgerSource = await readFile('src/game/provider-ledger.js', 'utf8');
if (ledgerSource.includes("collection('providerTransactions')")) throw new Error('Raw provider transactions must not be persisted in free-tier mode.');
if (!ledgerSource.includes('rawTransactionsPersisted: false')) throw new Error('Provider storage policy must explicitly prohibit raw transaction persistence.');
if (!ledgerSource.includes('tx.delete(roundSnapshot.ref)')) throw new Error('Completed temporary provider rounds must be deleted after aggregation.');

const indexes = JSON.parse(await readFile('firestore.indexes.json', 'utf8'));
const eventDigestOverride = indexes.fieldOverrides?.find(item => item.collectionGroup === 'providerGameRounds' && item.fieldPath === 'eventDigests');
if (!eventDigestOverride || !Array.isArray(eventDigestOverride.indexes) || eventDigestOverride.indexes.length !== 0) {
  throw new Error('eventDigests must be exempt from Firestore indexing to avoid index-storage amplification.');
}
const obligationOverride = indexes.fieldOverrides?.find(item => item.collectionGroup === 'rewardTurnover' && item.fieldPath === 'obligations');
if (!obligationOverride || !Array.isArray(obligationOverride.indexes) || obligationOverride.indexes.length !== 0) {
  throw new Error('rewardTurnover.obligations must be exempt from Firestore indexing.');
}

const routerSource = await readFile('cloudflare-router.js', 'utf8');
if (routerSource.includes('/.netlify/functions/') || routerSource.includes('./netlify/functions/')) {
  throw new Error('Cloudflare router must not expose or import Netlify function paths.');
}

const packageConfig = JSON.parse(await readFile('package.json', 'utf8'));
if (packageConfig.scripts?.['build:netlify'] || /netlify/i.test(String(packageConfig.scripts?.dev ?? ''))) {
  throw new Error('Netlify build/dev scripts must be removed from the Cloudflare-only backend.');
}

const firebaseAdminSource = await readFile('src/firebase/admin.js', 'utf8');
if (!/initializeFirestore\s*\([^)]*,\s*\{\s*preferRest\s*:\s*true\s*\}/s.test(firebaseAdminSource)) {
  throw new Error('Cloudflare Firestore must use initializeFirestore(..., { preferRest: true }) to avoid gRPC transport.');
}
if (!firebaseAdminSource.includes('firebase_admin_project_mismatch')) {
  throw new Error('Firebase Admin must fail closed when service-account project_id does not match FIREBASE_PROJECT_ID.');
}

for (const file of [
  'cloudflare-worker.js',
  'cloudflare-router.js',
  'src/firebase/admin.js',
  'src/config/readiness.js',
  'src/game/goldslotpalase.js',
  'src/game/player.js',
  'src/game/provider-ledger.js',
  'src/rewards/service.js',
  'src/rewards/verified-finalization.js',
]) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}

console.log('Cloudflare build validation passed: complete backend config contract, Firebase project guard, compact provider ledger, bounded cron/subrequest design, verified reward payout gates, index exemptions, secrets, Firestore REST transport, and Cloudflare-only runtime are valid.');
