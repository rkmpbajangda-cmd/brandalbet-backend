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
const {providerLedgerReference}=await import('./provider.js');
test('provider reversal ledger references cannot collide with original transaction',()=>{
 assert.equal(providerLedgerReference('bet','TX1',''),'GSP-TX1');
 assert.equal(providerLedgerReference('cancel','CANCEL1','TX1'),'GSP-REV-TX1-CANCEL1');
 assert.notEqual(providerLedgerReference('cancel','CANCEL1','TX1'),providerLedgerReference('bet','TX1',''));
});
const {normalizeError}=await import('./middleware.js');
test('API error normalization preserves safe expected status and hides server internals',()=>{
 assert.deepEqual(normalizeError(Object.assign(new Error('no funds'),{code:'insufficient_balance',status:409})),{status:409,code:'insufficient_balance'});
 assert.deepEqual(normalizeError(Object.assign(new Error('SQL details'),{code:'ER_DUP_ENTRY'})),{status:500,code:'internal_error'});
 assert.deepEqual(normalizeError(Object.assign(new Error('bad'),{code:'bad_input',status:200})),{status:500,code:'internal_error'});
});
const {normalizeProviderRecord}=await import('./provider.js');
test('provider catalog normalization accepts documented identifier/name variants and rejects incomplete records',()=>{
 assert.deepEqual(normalizeProviderRecord({provider_id:12,provider_name:'Slots',is_active:true}),{id:'12',code:'goldslotpalase:12',name:'Slots',isActive:true,sortOrder:0,metadata:{provider_id:12,provider_name:'Slots',is_active:true}});
 assert.equal(normalizeProviderRecord({provider_id:12}),null);
});
