import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {normalizeReferralCode} from '../src/referral.js';

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));

test('game-launch audit metadata uses the validated game symbol', async () => {
  const source = await readFile(serverPath, 'utf8');
  assert.match(source, /audit\(req,'game\.launch','game',games\[0\]\.id,\{providerId,gameSymbol:symbol\}\)/);
  assert.doesNotMatch(source, /audit\(req,'game\.launch','game',games\[0\]\.id,\{providerId,gameSymbol\}\)/);
});

test('session refresh rotates the bearer token instead of only reporting validity', async () => {
  const source = await readFile(serverPath, 'utf8');
  assert.match(source, /app\.post\('\/api\/auth\/refresh',auth,async\(req,res,next\)/);
  assert.match(source, /UPDATE user_sessions SET token_hash=\?,expires_at=\? WHERE id=\? AND revoked_at IS NULL AND expires_at>NOW\(\)/);
  assert.match(source, /return ok\(res,\{token:raw,expiresAt:expires\.toISOString\(\),sessionValid:true\}\)/);
});

test('referral codes are normalized and validated consistently', () => {
  assert.equal(normalizeReferralCode(' abcd-1234 '), 'ABCD-1234');
  assert.equal(normalizeReferralCode(''), null);
  assert.throws(() => normalizeReferralCode('bad code'), {code: 'invalid_referral_code'});
  assert.throws(() => normalizeReferralCode('abc'), {code: 'invalid_referral_code'});
});

test('numeric MySQL boolean settings are respected for login and one-device sessions', async () => {
  const source = await readFile(serverPath, 'utf8');
  assert.match(source, /if\(security&&Number\(security\.login_enabled\)===0\)return fail\(res,403,'login_disabled'\)/);
  assert.match(source, /if\(type==='backoffice'\|\|Number\(security\?\.one_device_only\?\?1\)!==0\)await c\.query/);
  assert.doesNotMatch(source, /security\.login_enabled===false/);
  assert.doesNotMatch(source, /security\?\.one_device_only!==false/);
});

test('provider user mapping returns its code to game launch for both existing and newly created users', async () => {
  const source = await readFile(serverPath, 'utf8');
  assert.match(source, /if\(existing\[0\]\?\.provider_user_code\)return existing\[0\]\.provider_user_code/);
  assert.match(source, /await pool\.query\('INSERT INTO provider_users\(id,user_id,provider_code,provider_user_code\) VALUES\(\?,\?,\?,\?\)'[\s\S]*?return providerUser;/);
  assert.match(source, /const providerUser=await ensureProviderUser\(req\.user\.id,req\.user\.username\)/);
});


test('member catalog endpoint reads MySQL snapshot and applies short HTTP caching without provider calls', async () => {
  const source = await readFile(serverPath, 'utf8');
  const start = source.indexOf("app.get('/api/games'");
  const end = source.indexOf("app.get('/api/promotions'", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /FROM games g/);
  assert.match(route, /FROM providers p/);
  assert.doesNotMatch(route, /provider\.(providers|allGames|games)\s*\(/);
  assert.match(route, /Cache-Control/);
});

test('provider account creation is deferred until the member launches a game', async () => {
  const source = await readFile(serverPath, 'utf8');
  const loginStart = source.indexOf('async function login(');
  const launchStart = source.indexOf("app.post('/api/game-launch'");
  assert.ok(loginStart >= 0 && launchStart > loginStart);
  const loginRoute = source.slice(loginStart, launchStart);
  assert.doesNotMatch(loginRoute, /ensureProviderUser\s*\(/);
  const launchRoute = source.slice(launchStart, source.indexOf("app.post('/api/payment-deposit'", launchStart));
  assert.match(launchRoute, /ensureProviderUser\(req\.user\.id,req\.user\.username\)/);
  assert.match(launchRoute, /provider\.launch\(launchPayload\)/);
});

test('game launch rejects reused idempotency keys for a different game and unsafe URLs', async () => {
  const source = await readFile(serverPath, 'utf8');
  const launchStart = source.indexOf("app.post('/api/game-launch'");
  const launchEnd = source.indexOf("app.post('/api/payment-deposit'", launchStart);
  const route = source.slice(launchStart, launchEnd);
  assert.match(route, /idempotency_key_reused/);
  assert.match(route, /launch_request_expired/);
  assert.match(route, /parsedLaunchUrl\.protocol!=='https:'/);
  assert.match(route, /parsedLaunchUrl\.username\|\|parsedLaunchUrl\.password/);
  assert.match(route, /launchRequestId/);
});


test('MySQL numeric zero disables registration, wallet, deposits, withdrawals, and withdrawal password requirement correctly', async () => {
  const server = await readFile(serverPath, 'utf8');
  const payment = await readFile(new URL('../src/xendit-payment.js', import.meta.url), 'utf8');
  assert.match(server, /Number\(site\.registration_enabled\)===0/);
  assert.equal((payment.match(/Number\(site\.wallet_enabled\)===0/g)||[]).length, 2);
  assert.match(payment, /Number\(ps\.deposit_enabled\)===0/);
  assert.match(payment, /Number\(ps\.withdrawal_enabled\)===0/);
  assert.match(payment, /Number\(sec\?\.require_password_for_withdrawal\?\?1\)!==0/);
});

test('provider and game catalog normalization handles numeric inactive flags without requiring a database connection', async () => {
  const provider = await readFile(new URL('../src/provider.js', import.meta.url), 'utf8');
  assert.match(provider, /function activeFlag\(value,fallback=true\)/);
  assert.match(provider, /isActive:activeFlag\(v\?\.is_active,activeFlag\(v\?\.active\)\)/);
  assert.match(provider, /isActive:activeFlag\(g\?\.is_active\)&&activeFlag\(g\?\.launch_enabled\)/);
  assert.match(provider, /'0','false','no','off','inactive'/);
});
