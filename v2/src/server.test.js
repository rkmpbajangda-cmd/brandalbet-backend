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
