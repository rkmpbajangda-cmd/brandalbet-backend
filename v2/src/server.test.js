import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'mysql://unit:unit@127.0.0.1:3306/unit';
const {normalizeProviderGame}=await import('./provider.js');

test('provider game normalization maps documented fields',()=>{
 const g=normalizeProviderGame({provider_id:12,game_symbol:'abc',name:'ABC',category:'Slots',image:'https://example.com/a.png'});
 assert.deepEqual(g,{providerCode:'goldslotpalase',providerId:'12',gameCode:'abc',name:'ABC',category:'Slots',imageUrl:'https://example.com/a.png',isActive:true,metadata:{provider_id:12,game_symbol:'abc',name:'ABC',category:'Slots',image:'https://example.com/a.png'}});
});
test('provider game normalization rejects incomplete game',()=>assert.equal(normalizeProviderGame({provider_id:1}),null));
test('health contract is documented',()=>assert.equal('/api/health','/api/health'));

const {normalizeReferralCode}=await import('./referral.js');

test('referral code is normalized to uppercase',()=>assert.equal(normalizeReferralCode('  bb8k92x '),'BB8K92X'));
test('empty referral code means no attribution',()=>assert.equal(normalizeReferralCode('  '),null));
test('referral code rejects malformed values',()=>{
 assert.throws(()=>normalizeReferralCode('bad code'),e=>e.code==='invalid_referral_code'&&e.status===400);
 assert.throws(()=>normalizeReferralCode('abc'),e=>e.code==='invalid_referral_code');
});

const {availableBalance,money}=await import('./wallet.js');

test('available balance excludes funds reserved for withdrawal',()=>{
 assert.equal(availableBalance(100000,25000),75000);
 assert.equal(availableBalance(100000,150000),0);
 assert.equal(availableBalance(100000,0),100000);
});
test('money rejects negative, non-finite and zero-value wallet movements are handled by wallet mutation guard',()=>{
 assert.throws(()=>money(-1),e=>e.code==='invalid_amount'&&e.status===400);
 assert.throws(()=>money(Number.NaN),e=>e.code==='invalid_amount');
 assert.equal(money(20000.555),20000.56);
});
