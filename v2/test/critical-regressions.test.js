import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {normalizeReferralCode} from '../src/referral.js';
import {normalizeProviderGame, normalizeProviderRecord, canonicalJson} from '../src/provider.js';

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

test('GoldslotPalase user mapping is resolved at member login and rechecked before game launch', async () => {
  const source = await readFile(serverPath, 'utf8');
  const loginStart = source.indexOf('async function login(');
  const launchStart = source.indexOf("app.post('/api/game-launch'");
  assert.ok(loginStart >= 0 && launchStart > loginStart);
  const loginRoute = source.slice(loginStart, launchStart);
  assert.match(loginRoute, /type==='member'&&provider\.configured/);
  assert.match(loginRoute, /ensureProviderUser\(u\.id,u\.username\)/);
  assert.match(loginRoute, /provider_user_unavailable/);
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
  assert.match(route, /launch_url_already_issued/);
  assert.doesNotMatch(route, /launchUrl:previous\.launch_url/);
  assert.match(route, /parsedLaunchUrl\.protocol!=='https:'/);
  assert.match(route, /parsedLaunchUrl\.username\|\|parsedLaunchUrl\.password/);
  assert.match(route, /launchRequestId/);
});


test('GoldslotPalase losing rounds may send a zero-amount Win callback', async () => {
  const source = await readFile(serverPath, 'utf8');
  assert.match(source, /rawAmount<0\|\|\(command==='bet'&&rawAmount<=0\)/);
  assert.doesNotMatch(source, /\['bet','win'\]\.includes\(command\)&&rawAmount<=0/);
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


test('catalog synchronization has one canonical persistence endpoint', async () => {
  const source = await readFile(serverPath, 'utf8');
  const providerRouteStart = source.indexOf("app.post('/api/backoffice-provider'");
  const providerRouteEnd = source.indexOf("app.post('/api/backoffice-payment-connections'", providerRouteStart);
  const providerRoute = source.slice(providerRouteStart, providerRouteEnd);
  assert.match(providerRoute, /action==='sync'\)return fail\(res,409,'use_backoffice_game_catalog_sync'\)/);
  const catalogRouteStart = source.indexOf("app.post('/api/backoffice-game-catalog'");
  const catalogRouteEnd = source.indexOf("app.get('/api/backoffice-rtp", catalogRouteStart);
  const catalogRoute = source.slice(catalogRouteStart, catalogRouteEnd);
  assert.match(catalogRoute, /b\.action==='sync'/);
  assert.match(catalogRoute, /provider\.providers\(\)/);
  assert.match(catalogRoute, /provider\.allGames\(\)/);
});


test('Goldslot documented catalog field names are normalized without dropping game images or launch flags', () => {
  const provider = normalizeProviderRecord({provider_id: 7, provider_name: 'Example Provider', status: 1});
  const maintenanceProvider = normalizeProviderRecord({provider_id: 8, provider_name: 'Maintenance Provider', status: 2});
  const game = normalizeProviderGame({
    provider_id: 7,
    game_code: 'slot-1',
    game_name: 'Slot One',
    locale_name: 'Slot Satu',
    game_image_narrow: 'https://cdn.example.test/slot-narrow.png',
    game_image: 'https://cdn.example.test/slot.png',
    launch_enable: 1,
    category: 'Slots'
  });
  assert.equal(provider.isActive, true);
  assert.equal(maintenanceProvider.isActive, false);
  assert.equal(game.providerId, '7');
  assert.equal(game.gameCode, 'slot-1');
  assert.equal(game.name, 'Slot Satu');
  assert.equal(game.imageUrl, 'https://cdn.example.test/slot-narrow.png');
  assert.equal(game.isActive, true);
  assert.equal(normalizeProviderGame({provider_id: 7, game_code: 'disabled', game_name: 'Disabled', launch_enable: 0}).isActive, false);
});

test('game launch validates numeric provider/user codes and excludes inactive providers', async () => {
  const source = await readFile(serverPath, 'utf8');
  const launchStart = source.indexOf("app.post('/api/game-launch'");
  const launchEnd = source.indexOf("app.post('/api/payment-deposit'", launchStart);
  const route = source.slice(launchStart, launchEnd);
  assert.match(route, /Number\.isSafeInteger\(numericProviderId\)/);
  assert.match(route, /JOIN providers p ON p\.id=g\.provider_id AND p\.is_active=1/);
  assert.match(route, /Number\.isSafeInteger\(numericUserCode\)/);
  assert.match(route, /lang:9/);
  assert.doesNotMatch(route, /lang:Number\(req\.body\.lang/);
});

test('Goldslot launch reserves the idempotency key before the provider call and does not override RTP', async () => {
  const source = await readFile(serverPath, 'utf8');
  const launchStart = source.indexOf("app.post('/api/game-launch'");
  const launchEnd = source.indexOf("app.post('/api/payment-deposit'", launchStart);
  const route = source.slice(launchStart, launchEnd);
  assert.ok(route.indexOf("'pending'") >= 0 && route.indexOf("'pending'") < route.indexOf('provider.launch(launchPayload)'));
  assert.match(route, /launch_request_in_progress/);
  assert.match(route, /status="failed"/);
  assert.doesNotMatch(route, /rtp\s*:\s*0/);
  assert.match(route, /idempotency_key_reused/);
  assert.match(route, /parsedLaunchUrl\.protocol!=='https:'/);
});

test('provider callback payload fingerprints are stable when object key order changes', () => {
  assert.equal(canonicalJson({command:'bet',data:{amount:10,account:'123'}}), canonicalJson({data:{account:'123',amount:10},command:'bet'}));
  assert.notEqual(canonicalJson({command:'bet',data:{amount:10}}), canonicalJson({command:'bet',data:{amount:11}}));
});

test('callback processing rejects changed payload for the same event key and command reuse for transaction IDs', async () => {
  const source = await readFile(serverPath, 'utf8');
  assert.match(source, /eventRows\[0\]\?\.payload_hash&&eventRows\[0\]\.payload_hash!==payloadHash/);
  assert.match(source, /existing\[0\]\?\.command&&existing\[0\]\.command!==command/);
});
