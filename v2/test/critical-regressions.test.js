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
