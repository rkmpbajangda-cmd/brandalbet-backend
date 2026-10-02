import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const xml=readFileSync(new URL('../templates/backoffice.xml',import.meta.url),'utf8');
const accessCode=xml.slice(xml.indexOf('    function isCurrent('),xml.indexOf('    async function loadReadiness'));
function harness(fetch){
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id)){const classes=new Set();nodes.set(id,{textContent:'',classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)}})}return nodes.get(id)};
  const current={getIdToken:async()=> 'test-token',getIdTokenResult:async()=>({claims:{role:'admin'}})};
  const context=vm.createContext({fetch,AbortController,setTimeout,clearTimeout,API_BASE:'https://example.test',user:current,auth:{currentUser:current},authRevision:1,$:node,busy:()=>{},notice:()=>{},signOut:async()=>{context.auth.currentUser=null;context.user=null;context.authRevision++}});
  vm.runInContext(accessCode,context);
  return {context,current,node};
}
test('backoffice stays hidden when logout occurs during authorization',async()=>{
  let release;const h=harness(()=>new Promise(r=>release=r));
  const pending=h.context.enter(h.current,1);await new Promise(setImmediate);
  h.context.user=null;h.context.auth.currentUser=null;h.context.authRevision++;
  release({ok:true,json:async()=>({ok:true})});await pending;
  assert.equal(h.node('#adminShell').classList.contains('hidden'),true);
});
test('backoffice rejects malformed success response',async()=>{
  const h=harness(async()=>({ok:true,json:async()=>({})}));
  await h.context.enter(h.current,1);
  assert.equal(h.node('#adminShell').classList.contains('hidden'),true);
  assert.equal(h.context.auth.currentUser,null);
});
test('backoffice opens only after backend and current account verification',async()=>{
  let options;const h=harness(async(_url,opt)=>{options=opt;return {ok:true,json:async()=>({ok:true})}});
  await h.context.enter(h.current,1);
  assert.equal(h.node('#adminShell').classList.contains('hidden'),false);
  assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');
});
test('old authorization failure cannot sign out a newer account',async()=>{
  let release;const h=harness(()=>new Promise(r=>release=r));
  const pending=h.context.enter(h.current,1);await new Promise(setImmediate);
  const next={};h.context.user=next;h.context.auth.currentUser=next;h.context.authRevision++;
  release({ok:false,status:401,json:async()=>({error:'expired'})});await pending;
  assert.equal(h.context.auth.currentUser,next);
});
