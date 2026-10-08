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
