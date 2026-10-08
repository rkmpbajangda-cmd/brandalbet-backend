import crypto from 'node:crypto';
import {config} from './config.js';
function pe(code,status=502,extra={}){const e=new Error(code);e.code=code;e.status=status;Object.assign(e,extra);return e}
function activeFlag(value,fallback=true){if(value===undefined||value===null)return fallback;if(typeof value==='boolean')return value;return !['0','false','no','off','inactive'].includes(String(value).trim().toLowerCase())}
export class GoldslotPalaseClient{
 constructor(){this.base=config.providerBaseUrl;this.token=config.providerToken;this.timeout=config.providerTimeoutMs}
 get configured(){return Boolean(this.token)}
 async call(path,body={}){
  if(!this.configured)throw pe('provider_unconfigured',503);
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),this.timeout);
  try{
   const r=await fetch(this.base+path,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+this.token,Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body),signal:ac.signal});
   let p={};try{p=await r.json()}catch{}
   if(!r.ok)throw pe('provider_http_error',502,{providerStatus:r.status,payload:p});
   if(p&&Number(p.result||0)!==0){const m={1001:'provider_internal_error',1002:'provider_validation_error',1007:'provider_token_not_found',1009:'provider_token_invalid',1010:'provider_permission_error',1011:'provider_error',1012:'provider_parameters_invalid',1018:'provider_busy',2001:'provider_agent_not_found',2002:'provider_user_not_found',2003:'provider_game_not_found',2005:'provider_point_not_enough',2006:'provider_balance_not_enough',2007:'provider_not_found'};throw pe(m[Number(p.result)]||'provider_rejected',502,{providerCode:p.result,payload:p})}
   return p;
  }catch(e){if(e.name==='AbortError')throw pe('provider_timeout',504);if(e.code)throw e;throw pe('provider_unavailable',503,{cause:e.message})}finally{clearTimeout(timer)}
 }
 info(){return this.call('/v4/agent/info',{})} setRtp(rtp){return this.call('/v4/agent/rtp',{rtp})}
 createUser(name){return this.call('/v4/user/create',{name})} userInfo(user_code){return this.call('/v4/user/info',{user_code})}
 providers(body={}){return this.call('/v4/game/providers',{lang:9,...body})} games(body={}){return this.call('/v4/game/games',{lang:9,...body})} allGames(body={}){return this.call('/v4/game/all',body)}
 onlineGames(body={}){return this.call('/v4/game/online-games',body)} launch(body){return this.call('/v4/game/game-url',body)}
 transferDeposit(body){return this.call('/v4/wallet/deposit',body)} transferWithdraw(body){return this.call('/v4/wallet/withdraw',body)}
 transferWithdrawAll(body){return this.call('/v4/wallet/withdraw-all',body)} transactions(body){return this.call('/v4/game/transaction',body)}
 transactionId(body){return this.call('/v4/game/transaction-id',body)} roundDetails(body){return this.call('/v4/game/round-details',body)}
 statisticsUser(body){return this.call('/v4/statistics/user',body)} callbackTest(body={}){return this.call('/v4/agent/callback-test',body)}
 callConfig(body){return this.call('/v4/game/call_config',body)} callStart(body){return this.call('/v4/game/call_start',body)} callCancel(body){return this.call('/v4/game/call_cancel',body)}
 freeRoundCreate(body){return this.call('/v4/game/freeround/create',body)} freeRoundCancel(body){return this.call('/v4/game/freeround/cancel',body)}
}
export const provider=new GoldslotPalaseClient();
export function verifyProviderCallback(req){
 const expected=config.providerCallbackToken;if(!expected)throw pe('provider_callback_unconfigured',503);
 const actual=String(req.get('Callback-Token')||''),a=Buffer.from(actual),b=Buffer.from(expected);
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw pe('provider_callback_unauthorized',401);return true;
}
export function providerLedgerReference(command,transGuid,cancelGuid=''){return command==='cancel'?'GSP-REV-'+String(cancelGuid)+'-'+String(transGuid):'GSP-'+String(transGuid)}
export function normalizeProviderRecord(x){
 const v=x?.provider||x,providerId=v?.provider_id??v?.providerId??v?.id;
 const name=v?.provider_name??v?.providerName??v?.name??v?.title;
 if(providerId==null||!String(name||'').trim())return null;
 // Goldslot catalog responses may expose status=2 for maintenance; fail closed for launching it.
 const rawStatus=v?.status;
 const maintenance=rawStatus===2||String(rawStatus)==='2'||String(rawStatus).trim().toLowerCase()==='maintenance';
 const active=activeFlag(v?.is_active,activeFlag(v?.active,rawStatus===undefined?true:activeFlag(rawStatus,true)));
 return {id:String(providerId),code:'goldslotpalase:'+String(providerId),name:String(name).trim(),isActive:active&&!maintenance,sortOrder:Number.isFinite(Number(v?.sort_order??v?.sortOrder))?Number(v?.sort_order??v?.sortOrder):0,metadata:v};
}
export function normalizeProviderGame(x,providerCode='goldslotpalase'){
 const g=x?.game||x,providerId=g?.provider_id??g?.providerId??(typeof g?.provider==='object'?(g.provider.provider_id??g.provider.id):g?.provider),symbol=g?.game_symbol??g?.gameSymbol??g?.game_code??g?.gameCode??g?.symbol??g?.code,name=g?.locale_name??g?.name??g?.game_name??g?.gameName??symbol;
 if(providerId==null||!symbol||!name)return null;
 const rawLaunch=g?.launch_enable??g?.launch_enabled??g?.launchEnable;
 const launchEnabled=activeFlag(rawLaunch,activeFlag(g?.is_active,true));
 return {providerCode,providerId:String(providerId),gameCode:String(symbol),name:String(name),category:String(g?.category||'Slots'),imageUrl:String(g?.game_image_narrow||g?.game_image||g?.image||g?.image_url||g?.imageUrl||''),isActive:activeFlag(g?.is_active,true)&&launchEnabled,metadata:g};
}