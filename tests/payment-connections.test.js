import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionDb } from './helpers/transaction-db.js';
import { sealCredentials, openCredentials } from '../src/payment/vault.js';
import { saveConnection, connectionView, listConnections } from '../src/payment/connections.js';
import { createHandler } from '../netlify/functions/backoffice-payment-connections.js';
const now=Date.now();
const admin={uid:'admin',role:'superadmin',backoffice:true,auth_time:Math.floor(now/1000)};
const env={PAYMENT_CONFIG_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')};
const fixture={merchantId:'test-merchant',privateKey:'test-private-value'};
const input={label:'Primary',provider:'test-gateway',mode:'sandbox',expectedRevision:0,credentials:fixture};

test('vault encrypts and authenticates credentials bound to one connection',()=>{
 const sealed=sealCredentials('one',fixture,env);
 assert.deepEqual(openCredentials('one',sealed,env),fixture);
 assert.ok(!JSON.stringify(sealed).includes('test-private-value'));
 assert.notEqual(sealCredentials('one',fixture,env).iv,sealed.iv);
 assert.throws(()=>openCredentials('two',sealed,env),{code:'payment_credentials_unreadable'});
 assert.throws(()=>openCredentials('one',{...sealed,data:Buffer.from('tampered').toString('base64')},env),{code:'payment_credentials_unreadable'});
 assert.throws(()=>openCredentials('one',sealed,{PAYMENT_CONFIG_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')}),{code:'payment_credentials_unreadable'});
});
test('multiple gateways and merchants remain isolated, redacted and disabled',async()=>{
 const db=transactionDb();
 const a=await saveConnection(admin,input,{db,env,now});
 const b=await saveConnection(admin,{...input,label:'Other',provider:'another-gateway',credentials:{merchantId:'other'}},{db,env,now});
 assert.notEqual(a.id,b.id);
 assert.deepEqual(a.credentialFields,['merchantId','privateKey']);
 assert.equal(a.status,'adapter_unavailable');assert.equal(a.operational,false);
 for(const connection of [a,b]){
  const stored=db.read('paymentConnections/'+connection.id);
  assert.equal(stored.enabled,false);
  assert.ok(!JSON.stringify(connection).includes('test-private-value'));
  assert.ok(!JSON.stringify(stored).includes('test-private-value'));
 }
 const all=db.entries().map(([path,value])=>({id:path.split('/')[1],value})).filter(x=>x.value.credentials);
 const query={orderBy:()=>query,limit:()=>query,get:async()=>({docs:all.map(x=>({id:x.id,data:()=>x.value}))})};
 const result=await listConnections(admin,{db:{collection:()=>query},env});
 assert.equal(result.connections.length,2);
 assert.equal(result.vaultConfigured,true);
 assert.ok(!JSON.stringify(result).includes('test-private-value'));
 assert.ok(!JSON.stringify(result).includes('"credentials":'));
});
test('blank credentials preserve keys, stale edits fail, rotation remains encrypted',async()=>{
 const db=transactionDb();const a=await saveConnection(admin,input,{db,env,now});
 const second=await saveConnection(admin,{...input,id:a.id,expectedRevision:1,credentials:{privateKey:''}},{db,env,now});
 assert.equal(second.revision,2);
 assert.deepEqual(openCredentials(a.id,db.read('paymentConnections/'+a.id).credentials,env),fixture);
 await assert.rejects(saveConnection(admin,{...input,id:a.id,expectedRevision:1},{db,env,now}),{code:'payment_revision_conflict'});
 await saveConnection(admin,{...input,id:a.id,expectedRevision:2,credentials:{privateKey:'replacement-fixture'}},{db,env,now});
 assert.equal(openCredentials(a.id,db.read('paymentConnections/'+a.id).credentials,env).privateKey,'replacement-fixture');
 assert.ok(!JSON.stringify(db.entries().filter(([p])=>p.startsWith('auditEvents/'))).includes('replacement-fixture'));
});
test('mode/provider changes require a separate connection, avoiding credential cross-use',async()=>{
 const db=transactionDb();const a=await saveConnection(admin,input,{db,env,now});
 for(const patch of [{provider:'different'},{mode:'production'}])await assert.rejects(saveConnection(admin,{...input,id:a.id,expectedRevision:1,...patch},{db,env,now}),{code:'create_separate_connection_for_provider_or_mode'});
});
test('payment settings require admin, recent login and configured encryption key',async()=>{
 const db=transactionDb();
 for(const role of ['member','operator','finance'])await assert.rejects(saveConnection({...admin,role},input,{db,env,now}),{statusCode:403});
 await assert.rejects(saveConnection({...admin,auth_time:Math.floor(now/1000)-601},input,{db,env,now}),{code:'recent_login_required'});
 await assert.rejects(saveConnection(admin,input,{db,env:{},now}),{code:'payment_vault_unconfigured'});
 assert.equal(db.entries().length,0);
});
test('payment credential schema blocks arbitrary fields and overlarge input',async()=>{
 const db=transactionDb();
 for(const patch of [{enabled:true},{credentials:{unexpected:'x'}},{credentials:{privateKey:'x'.repeat(12001)}},{provider:'https://attacker.invalid'}])await assert.rejects(saveConnection(admin,{...input,...patch},{db,env,now}));
 assert.equal(db.entries().length,0);
});
test('audit commit failure rolls back credentials and configuration together',async()=>{
 const db=transactionDb();db.failCommit=true;
 await assert.rejects(saveConnection(admin,input,{db,env,now}),/commit_failure/);
 assert.equal(db.entries().length,0);
});
test('registered adapter still cannot become operational from credentials alone',()=>{
 const adapters={'test-gateway':{productionApproved:true,requiredCredentials:['merchantId','privateKey']}};
 const base={label:'x',provider:'test-gateway',mode:'production',revision:1,credentialFields:['merchantId']};
 assert.deepEqual(connectionView('x',base,adapters).missingCredentials,['privateKey']);
 const complete=connectionView('x',{...base,credentialFields:['merchantId','privateKey']},adapters);
 assert.equal(complete.status,'configured_not_verified');assert.equal(complete.operational,false);
});
test('endpoint denies financial role before storage and enforces recent authentication',async()=>{
 let called=false;
 const event={httpMethod:'POST',headers:{Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify(input)};
 for(const actor of [{...admin,role:'finance'},{...admin,auth_time:1}]){
  const handler=createHandler({verifyIdToken:async()=>actor,save:async()=>{called=true;}});
  assert.ok([401,403].includes((await handler(event)).statusCode));
 }
 assert.equal(called,false);
});
