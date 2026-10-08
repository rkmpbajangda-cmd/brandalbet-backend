import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import rateLimit from 'express-rate-limit';
import {config} from './config.js';
import {pool,pingDatabase,withTransaction,closeDatabase} from './db.js';
import {requestContext,timeout,notFound,errorHandler} from './middleware.js';
import {sendOk,sendError} from './http.js';
import {provider,verifyProviderCallback} from './provider.js';
import {creditWallet,debitWallet,id as newId,money} from './wallet.js';
import {encryptJson} from './vault.js';

const app=express();
app.set('trust proxy',config.trustProxy);app.disable('x-powered-by');
app.use(requestContext);app.use(helmet({contentSecurityPolicy:false}));
app.use(cors({origin:(o,cb)=>!o||config.corsOrigins.includes(o)?cb(null,true):cb(new Error('origin_not_allowed')),credentials:true}));
app.use(timeout(config.requestTimeoutMs));app.use(express.json({limit:config.bodyLimit,strict:true}));
app.use(rateLimit({windowMs:60000,limit:180,standardHeaders:true,legacyHeaders:false,skip:req=>req.path.startsWith('/webhooks/')||req.path.startsWith('/api/provider/callback')}));
const hash=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const token=()=>crypto.randomBytes(48).toString('base64url');
const ok=sendOk,fail=sendError;
const role=(...r)=>(req,res,next)=>r.includes(req.user?.role)?next():fail(res,403,'forbidden');

async function audit(req,action,targetType='',targetId='',meta={}){
 try{await pool.query('INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,request_id,ip,metadata) VALUES(?,?,?,?,?,?,?,?)',[newId(),req.user?.id||null,action,targetType,targetId,req.requestId,req.ip,JSON.stringify(meta)])}catch(e){console.error('audit_write_failed',e.message)}
}
async function auth(req,res,next){
 try{
  const h=req.get('authorization')||'';
  if(!h.startsWith('Bearer '))return fail(res,401,'unauthorized');
  const [rows]=await pool.query('SELECT u.*,s.id session_id,s.device_id,s.session_type FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>NOW() LIMIT 1',[hash(h.slice(7))]);
  if(!rows[0])return fail(res,401,'session_invalid');
  if(rows[0].status!=='active')return fail(res,403,'account_not_active');
  req.user=rows[0];next();
 }catch(e){next(e)}
}
async function memberAuth(req,res,next){await auth(req,res,()=>req.user?.role==='member'?next():fail(res,403,'member_only'))}
async function adminAuth(req,res,next){await auth(req,res,()=>role('operator','finance','admin','superadmin')(req,res,next))}
async function ensureProviderUser(userId,username){
 if(!provider.configured)return;
 try{
  const [existing]=await pool.query('SELECT provider_user_code FROM provider_users WHERE user_id=? AND provider_code="goldslotpalase" LIMIT 1',[userId]);
  const created=await provider.createUser(username);
  const providerUser=String(created?.data?.user_code??created?.user_code??'');
  if(!providerUser)return;
  if(existing[0])await pool.query('UPDATE provider_users SET provider_user_code=? WHERE user_id=? AND provider_code="goldslotpalase"',[providerUser,userId]);
  else await pool.query('INSERT INTO provider_users(id,user_id,provider_code,provider_user_code) VALUES(?,?,?,?)',[newId(),userId,'goldslotpalase',providerUser]);
 }catch(e){console.error('provider_user_sync_failed',e.code||e.message)}
}
async function completeOnboarding(userId,body){
 await pool.query('INSERT INTO member_profiles(user_id,language,timezone) VALUES(?,?,?) ON DUPLICATE KEY UPDATE language=VALUES(language),timezone=VALUES(timezone)',[userId,body.language||'id',body.timezone||'Asia/Jakarta']);
 if(body.displayName!==undefined||body.phone!==undefined)await pool.query('UPDATE users SET display_name=COALESCE(?,display_name),phone=COALESCE(?,phone) WHERE id=?',[body.displayName||null,body.phone||null,userId]);
 if(body.bankAccount?.provider&&body.bankAccount?.accountNumber&&body.bankAccount?.accountName){
  await pool.query('INSERT INTO bank_accounts(id,user_id,type,provider,account_number,account_name) VALUES(?,?,?,?,?,?)',[newId(),userId,body.bankAccount.type||'bank',body.bankAccount.provider,String(body.bankAccount.accountNumber).replace(/\D/g,''),body.bankAccount.accountName]);
 }
}
async function login(req,res,username,password,deviceId){
 if(!username||!password)return fail(res,400,'credentials_required');
 const [rows]=await pool.query('SELECT * FROM users WHERE (username=? OR email=?) AND status="active" LIMIT 1',[username,username]);
 if(!rows[0]||!(await argon2.verify(rows[0].password_hash,password)))return fail(res,401,'invalid_credentials');
 const u=rows[0],sid=newId(),raw=token(),expires=new Date(Date.now()+config.sessionTtlDays*86400000),type=u.role==='member'?'member':'backoffice';
 await withTransaction(async c=>{
  await c.query('UPDATE user_sessions SET revoked_at=NOW() WHERE user_id=? AND session_type=? AND revoked_at IS NULL',[u.id,type]);
  await c.query('INSERT INTO user_sessions(id,user_id,token_hash,device_id,session_type,ip,user_agent,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',[sid,u.id,hash(raw),deviceId||null,type,req.ip,req.get('user-agent')||null,expires]);
  await c.query('UPDATE users SET last_login_at=NOW() WHERE id=?',[u.id]);
 });
 await audit({...req,user:{id:u.id}},'auth.login','user',u.id,{sessionType:type});
 void ensureProviderUser(u.id,u.username);
 return ok(res,{token:raw,expiresAt:expires.toISOString(),user:{id:u.id,username:u.username,email:u.email,role:u.role,displayName:u.display_name}});
}

app.get('/api/health',async(_,res)=>{try{await pingDatabase();ok(res,{service:'brandalbet-backend-v2',database:'ok',version:'2.1.0'})}catch{fail(res,503,'database_unavailable')}});
app.get('/api/readiness',async(_,res)=>{try{await pingDatabase();ok(res,{ready:true,database:true,providerConfigured:provider.configured,paymentConfigured:Boolean(config.paymentBaseUrl&&config.paymentApiKey)})}catch{fail(res,503,'not_ready')}});
app.get('/api/me',auth,(req,res)=>ok(res,{user:{id:req.user.id,username:req.user.username,email:req.user.email,role:req.user.role,displayName:req.user.display_name,phone:req.user.phone}}));

app.post('/api/auth/register',async(req,res,next)=>{try{
 const b=req.body||{};if(!/^[a-zA-Z0-9_]{3,32}$/.test(String(b.username||'')))return fail(res,400,'invalid_username');
 if(!String(b.email||'').includes('@')||String(b.password||'').length<8)return fail(res,400,'invalid_registration');
 const [exists]=await pool.query('SELECT id FROM users WHERE username=? OR email=? LIMIT 1',[b.username,String(b.email).toLowerCase()]);if(exists[0])return fail(res,409,'account_exists');
 const uid=newId(),pw=await argon2.hash(b.password),ref=crypto.randomBytes(5).toString('hex').toUpperCase();
 await withTransaction(async c=>{
  await c.query('INSERT INTO users(id,username,email,password_hash,display_name,phone,referral_code,referred_by) VALUES(?,?,?,?,?,?,?,?)',[uid,b.username,String(b.email).toLowerCase(),pw,b.displayName||null,b.phone||null,ref,b.referralCode||null]);
  await c.query('INSERT INTO wallets(user_id,balance) VALUES(?,0)',[uid]);await c.query('INSERT INTO cashback_accounts(user_id,balance) VALUES(?,0)',[uid]);
  await c.query('INSERT INTO member_profiles(user_id) VALUES(?)',[uid]);
  if(b.bankAccount)await c.query('INSERT INTO bank_accounts(id,user_id,type,provider,account_number,account_name) VALUES(?,?,?,?,?,?)',[newId(),uid,b.bankAccount.type||'bank',b.bankAccount.provider||'',String(b.bankAccount.accountNumber||'').replace(/\D/g,''),b.bankAccount.accountName||'']);
  if(b.referralCode){const [rr]=await c.query('SELECT id FROM users WHERE referral_code=? LIMIT 1',[b.referralCode]);if(rr[0])await c.query('INSERT IGNORE INTO referrals(id,referrer_id,referred_id,code) VALUES(?,?,?,?)',[newId(),rr[0].id,uid,b.referralCode])}
 });
 return login(req,res,b.username,b.password,b.deviceId);
}catch(e){next(e)}});

app.post('/api/auth/login',async(req,res,next)=>{try{return login(req,res,req.body?.username,req.body?.password,req.body?.deviceId)}catch(e){next(e)}});
app.post('/api/auth/logout',auth,async(req,res,next)=>{try{await pool.query('UPDATE user_sessions SET revoked_at=NOW() WHERE id=?',[req.user.session_id]);await audit(req,'auth.logout','user',req.user.id);ok(res,{loggedOut:true})}catch(e){next(e)}});
app.post('/api/auth/refresh',auth,(req,res)=>ok(res,{sessionValid:true,expiresAt:req.user.expires_at}));
app.post('/api/member-session',memberAuth,(req,res)=>ok(res,{session:{userId:req.user.id,deviceId:req.user.device_id,expiresAt:req.user.expires_at}}));
app.post('/api/member-device-session',memberAuth,async(req,res,next)=>{try{if(req.body?.replace===true)await pool.query('UPDATE user_sessions SET revoked_at=NOW() WHERE user_id=? AND session_type="member" AND id<>? AND revoked_at IS NULL',[req.user.id,req.user.session_id]);ok(res,{claimed:true,deviceId:req.user.device_id})}catch(e){next(e)}});

app.get('/api/member/profile',memberAuth,async(req,res,next)=>{try{
 const [[u],[p],[b]] = await Promise.all([pool.query('SELECT id,username,email,display_name displayName,phone,referral_code referralCode FROM users WHERE id=?',[req.user.id]),pool.query('SELECT language,timezone,avatar_url avatarUrl FROM member_profiles WHERE user_id=?',[req.user.id]),pool.query('SELECT id,type,provider,account_number accountNumber,account_name accountName FROM bank_accounts WHERE user_id=? ORDER BY created_at DESC LIMIT 1',[req.user.id])]);
 const [[w]]=await pool.query('SELECT balance,locked FROM wallets WHERE user_id=?',[req.user.id]);
 ok(res,{profile:u[0]||null,bankAccount:b[0]||null,wallet:{availableMinor:Math.round(Number(w?.balance||0)*100),balance:Number(w?.balance||0),locked:Boolean(w?.locked)},preferences:p[0]||{language:'id',timezone:'Asia/Jakarta'}});
}catch(e){next(e)}});
app.put('/api/member-profile',memberAuth,async(req,res,next)=>{try{await completeOnboarding(req.user.id,req.body||{});await audit(req,'member.profile.update','user',req.user.id);const [r]=await pool.query('SELECT id,username,email,display_name displayName,phone,referral_code referralCode FROM users WHERE id=?',[req.user.id]);ok(res,{profile:r[0]})}catch(e){next(e)}});
app.get('/api/member-profile',memberAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT id,username,email,display_name displayName,phone,referral_code referralCode FROM users WHERE id=?',[req.user.id]);ok(res,{profile:r[0]||null})}catch(e){next(e)}});
app.post('/api/member-onboarding',memberAuth,async(req,res,next)=>{try{await completeOnboarding(req.user.id,req.body||{});await audit(req,'member.onboarding.complete','user',req.user.id);ok(res,{completed:true})}catch(e){next(e)}});
app.get('/api/member-bank-account',memberAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT id,type,provider,account_number accountNumber,account_name accountName FROM bank_accounts WHERE user_id=? ORDER BY created_at DESC LIMIT 1',[req.user.id]);ok(res,{bankAccount:r[0]||null})}catch(e){next(e)}});
app.put('/api/member-bank-account',memberAuth,async(req,res,next)=>{try{const b=req.body||{};if(!b.provider||!b.accountNumber||!b.accountName)return fail(res,400,'invalid_bank_account');const id=newId();await pool.query('INSERT INTO bank_accounts(id,user_id,type,provider,account_number,account_name) VALUES(?,?,?,?,?,?)',[id,req.user.id,b.type||'bank',b.provider,String(b.accountNumber).replace(/\D/g,''),b.accountName]);await audit(req,'member.bank.update','bank_account',id);const [r]=await pool.query('SELECT id,type,provider,account_number accountNumber,account_name accountName FROM bank_accounts WHERE id=?',[id]);ok(res,{bankAccount:r[0]})}catch(e){next(e)}});

app.get('/api/wallet',memberAuth,async(req,res,next)=>{try{const [[w]]=await pool.query('SELECT balance,locked FROM wallets WHERE user_id=?',[req.user.id]);ok(res,{balance:Number(w?.balance||0),availableMinor:Math.round(Number(w?.balance||0)*100),locked:Boolean(w?.locked)})}catch(e){next(e)}});
app.get('/api/transactions',memberAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT id,type,amount,status,reference,created_at createdAt FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 200',[req.user.id]);ok(res,{transactions:r})}catch(e){next(e)}});
app.get('/api/member-rewards',memberAuth,async(req,res,next)=>{try{const [[a]]=await pool.query('SELECT balance FROM cashback_accounts WHERE user_id=?',[req.user.id]);const [h]=await pool.query('SELECT id,amount,type,status,reference,created_at createdAt FROM cashback_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 200',[req.user.id]);ok(res,{balance:Number(a?.balance||0),history:h})}catch(e){next(e)}});
app.get('/api/member-config',async(_,res)=>ok(res,{minimumDeposit:config.minDeposit,minimumWithdrawal:config.minWithdrawal,maintenanceMode:false,gameLaunchEnabled:true,registrationEnabled:true,promotionsEnabled:true,memberWalletEnabled:true}));

app.get('/api/games',async(_,res,next)=>{try{const [r]=await pool.query('SELECT id,provider_code providerCode,provider_id providerId,game_code gameCode,name,category,image_url imageUrl,is_active isActive,is_popular isPopular,is_new isNew,sort_order sortOrder,metadata FROM games WHERE is_active=1 ORDER BY sort_order,id');ok(res,{games:r})}catch(e){next(e)}});
app.get('/api/promotions',async(_,res,next)=>{try{const [r]=await pool.query('SELECT id,title,description,image_url imageUrl,start_at startAt,end_at endAt FROM promotions WHERE is_active=1 AND (start_at IS NULL OR start_at<=NOW()) AND (end_at IS NULL OR end_at>=NOW()) ORDER BY sort_order,id');ok(res,{promotions:r})}catch(e){next(e)}});

app.post('/api/game-launch',memberAuth,async(req,res,next)=>{try{
 const b=req.body||{},requestId=String(b.launchRequestId||req.get('Idempotency-Key')||'').trim(),providerId=String(b.providerId||''),symbol=String(b.gameSymbol||'').trim();
 if(!requestId||!providerId||!symbol)return fail(res,400,'invalid_launch_request');
 const [games]=await pool.query('SELECT * FROM games WHERE provider_code="goldslotpalase" AND provider_id=? AND game_code=? AND is_active=1 LIMIT 1',[providerId,symbol]);
 if(!games[0])return fail(res,404,'game_not_found');
 const [pu]=await pool.query('SELECT provider_user_code FROM provider_users WHERE user_id=? AND provider_code="goldslotpalase"',[req.user.id]);
 let providerUser=pu[0]?.provider_user_code;
 if(!providerUser){const created=await provider.createUser(req.user.username);providerUser=String(created?.data?.user_code??created?.user_code??'');if(!providerUser)throw Object.assign(new Error('provider_user_create_invalid'),{code:'provider_invalid_response',status:502});await pool.query('INSERT INTO provider_users(id,user_id,provider_code,provider_user_code) VALUES(?,?,?,?)',[newId(),req.user.id,'goldslotpalase',providerUser])}
 const [[rtpPolicy]]=await pool.query('SELECT enabled,rtp FROM member_rtp_settings WHERE user_id=?',[req.user.id]);
 const launchPayload={user_code:Number(providerUser),provider_id:Number(providerId),game_symbol:symbol,lang:Number(req.body.lang??9),return_url:req.body.returnUrl||undefined,min_bet:req.body.minBet,max_bet:req.body.maxBet,round_max_win:req.body.roundMaxWin,rtp:rtpPolicy?.enabled&&rtpPolicy?.rtp!=null?Number(rtpPolicy.rtp):undefined,is_finish_jackpot:req.body.isFinishJackpot};
 Object.keys(launchPayload).forEach(k=>launchPayload[k]===undefined||launchPayload[k]===null||launchPayload[k]===''?delete launchPayload[k]:0);
 const launched=await provider.launch(launchPayload);
 const launchUrl=launched?.data?.game_url??launched?.data?.url??launched?.game_url??launched?.url;
 if(typeof launchUrl!=='string'||!/^https:\/\//i.test(launchUrl))return fail(res,502,'provider_invalid_launch_url');
 let exp=new Date(Date.now()+10*60*1000);await pool.query('INSERT INTO game_launches(id,user_id,game_id,provider,request_id,status,launch_url,expires_at) VALUES(?,?,?,?,?,?,?,?)',[newId(),req.user.id,games[0].id,'goldslotpalase',requestId,'issued',launchUrl,exp]);
 await audit(req,'game.launch','game',games[0].id,{providerId,gameSymbol});ok(res,{game:{launchUrl,expiresAt:exp.toISOString(),gameId:games[0].id}});
}catch(e){next(e)}});

app.post('/api/payment-deposit',memberAuth,async(req,res,next)=>{try{
 if(!config.paymentBaseUrl||!config.paymentApiKey)return fail(res,503,'payment_adapter_unavailable');
 const amount=money(req.body?.amountRupiah);if(amount<config.minDeposit)return fail(res,400,'minimum_deposit');
 return fail(res,503,'payment_adapter_not_implemented');
}catch(e){next(e)}});

app.post('/api/payment-withdraw',memberAuth,async(req,res,next)=>{try{
 const amount=money(req.body?.amountRupiah);if(amount<config.minWithdrawal)return fail(res,400,'minimum_withdrawal');
 if(!config.paymentBaseUrl||!config.paymentApiKey)return fail(res,503,'payment_adapter_unavailable');
 // Never hold/debit member funds until the real payment-gateway payout adapter has accepted the withdrawal.
 return fail(res,503,'payment_payout_adapter_not_implemented');
}catch(e){next(e)}});
 
app.post('/webhooks/v1/payments/:provider',async(req,res,next)=>{try{
 if(!config.paymentWebhookSecret)return fail(res,503,'payment_webhook_unconfigured');
 const supplied=String(req.get('X-Webhook-Secret')||req.get('X-Signature')||'');const a=Buffer.from(supplied),b=Buffer.from(config.paymentWebhookSecret);
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return fail(res,401,'webhook_unauthorized');
 const body=req.body||{},eventKey=String(body.eventId||body.id||body.reference||body.orderId||'').trim();if(!eventKey)return fail(res,400,'webhook_event_required');
 const amount=money(body.amount??body.amountRupiah??0),reference=String(body.reference||body.orderId||body.merchantReference||'').trim();
 const result=await withTransaction(async conn=>{
  const [existing]=await conn.query('SELECT processed_at,payload FROM webhook_events WHERE source=? AND event_key=? LIMIT 1 FOR UPDATE',[req.params.provider,eventKey]);
  if(existing[0]?.processed_at)return {received:true,idempotent:true};
  await conn.query('INSERT INTO webhook_events(id,source,event_key,signature_valid,amount,payload) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE amount=VALUES(amount),payload=VALUES(payload)',[newId(),req.params.provider,eventKey,true,amount,JSON.stringify(body)]);
  const status=String(body.status||'').toLowerCase();
  if(!['paid','success','completed'].includes(status)){await conn.query('UPDATE webhook_events SET processed_at=NOW() WHERE source=? AND event_key=?',[req.params.provider,eventKey]);return {received:true,ignored:true};}
  const [orders]=await conn.query('SELECT * FROM payment_orders WHERE reference=? FOR UPDATE',[reference]);if(!orders[0])throw Object.assign(new Error('payment_order_not_found'),{code:'payment_order_not_found',status:404});
  const order=orders[0];if(Number(order.amount)!==amount)throw Object.assign(new Error('payment_amount_mismatch'),{code:'payment_amount_mismatch',status:409});
  if(order.status==='paid'){await conn.query('UPDATE webhook_events SET processed_at=NOW() WHERE source=? AND event_key=?',[req.params.provider,eventKey]);return {received:true,idempotent:true};}
  const [[w]]=await conn.query('SELECT balance,locked FROM wallets WHERE user_id=? FOR UPDATE',[order.user_id]);if(!w||w.locked)throw Object.assign(new Error('wallet_locked'),{code:'wallet_locked',status:409});
  const before=Number(w.balance),after=before+amount,txId=newId(),ref='PAY-'+reference;
  await conn.query('UPDATE wallets SET balance=? WHERE user_id=?',[after,order.user_id]);
  await conn.query('INSERT INTO transactions(id,user_id,type,amount,status,reference,metadata) VALUES(?,?,?,?,?,?,?)',[txId,order.user_id,'payment_deposit',amount,'completed',ref,JSON.stringify({provider:req.params.provider,eventKey,reference})]);
  await conn.query('INSERT INTO wallet_ledger(id,user_id,transaction_id,reference,direction,amount,balance_before,balance_after,reason,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)',[newId(),order.user_id,txId,ref,'credit',amount,before,after,'payment_deposit',JSON.stringify({provider:req.params.provider,eventKey,reference})]);
  await conn.query('UPDATE payment_orders SET status="paid",provider_reference=? WHERE id=?',[String(body.transactionId||body.providerReference||eventKey),order.id]);
  await conn.query('INSERT INTO deposits(id,user_id,amount,status,gateway,gateway_reference,metadata) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),gateway_reference=VALUES(gateway_reference),metadata=VALUES(metadata)',[newId(),order.user_id,amount,'completed',req.params.provider,String(body.transactionId||body.providerReference||eventKey),JSON.stringify({paymentOrderId:order.id,reference})]);
  await conn.query('UPDATE webhook_events SET processed_at=NOW() WHERE source=? AND event_key=?',[req.params.provider,eventKey]);
  return {received:true,credited:true,balance:after};
 });
 ok(res,result);
}catch(e){next(e)}});

app.post('/api/provider/callback',async(req,res,next)=>{try{
 verifyProviderCallback(req);const b=req.body||{},command=String(b.command||'').toLowerCase(),d=b.data||{},account=String(d.account??'').trim();
 if(!['authenticate','balance','bet','win','cancel','status'].includes(command))return res.status(400).json({result:1012,status:'PARAMETERS_INVALID'});
 if(!account)return res.status(400).json({result:21,status:'USER_NOT_FOUND'});
 const [pu]=await pool.query('SELECT u.id,u.status,pu.provider_user_code FROM provider_users pu JOIN users u ON u.id=pu.user_id WHERE pu.provider_code="goldslotpalase" AND pu.provider_user_code=? LIMIT 1',[account]);
 if(!pu[0])return res.status(404).json({result:21,status:'USER_NOT_FOUND'});
 if(pu[0].status!=='active')return res.status(403).json({result:22,status:'USER_INACTIVE'});
 const userId=pu[0].id;
 const [[w]]=await pool.query('SELECT balance FROM wallets WHERE user_id=?',[userId]);const currentBalance=Number(w?.balance||0);
 if(command==='authenticate'||command==='balance')return res.json({result:0,status:'OK',data:{account,balance:currentBalance}});
 const transGuid=String(d.trans_guid??'').trim();if(!transGuid)return res.status(400).json({result:41,status:'TRANSACTION_INVALID'});
 if(command==='status'){
  const [tx]=await pool.query('SELECT status FROM provider_transactions WHERE provider_code="goldslotpalase" AND provider_transaction_id=? LIMIT 1',[transGuid]);
  return res.json({result:0,status:'OK',data:{account,trans_guid:transGuid,status:tx[0]?.status==='canceled'?'CANCELED':tx[0]?'OK':'CANCELED'}});
 }
 const cancelGuid=String(d.cancel_trans_guid??'').trim(),amount=money(d.amount??0),providerType=command==='bet'?'Bet':command==='win'?'Win':'Cancel';
 const response=await withTransaction(async conn=>{
  const lookupId=transGuid;
  const [existing]=await conn.query('SELECT response_json FROM provider_transactions WHERE provider_code="goldslotpalase" AND provider_transaction_id=? FOR UPDATE',[lookupId]);
  if(existing[0]?.response_json)return JSON.parse(existing[0].response_json);
  const [[wallet]]=await conn.query('SELECT balance,locked FROM wallets WHERE user_id=? FOR UPDATE',[userId]);
  if(!wallet)return {result:21,status:'USER_NOT_FOUND'};
  if(wallet.locked)return {result:22,status:'USER_INACTIVE'};
  let before=Number(wallet.balance),after=before,ledgerDirection=null,ledgerAmount=amount,reason='provider_'+command;
  if(command==='bet'){
   if(before<amount)return {result:31,status:'BALANCE_NOT_ENOUGH',data:{account,balance:before}};
   after=before-amount;ledgerDirection='debit';
  }else if(command==='win'){after=before+amount;ledgerDirection='credit';
  }else{
   if(!cancelGuid)return {result:43,status:'TRANSACTION_NOT_FOUND'};
   const [original]=await conn.query('SELECT * FROM provider_transactions WHERE provider_code="goldslotpalase" AND provider_transaction_id=? AND user_id=? LIMIT 1 FOR UPDATE',[cancelGuid,userId]);
   if(!original[0])return {result:43,status:'TRANSACTION_NOT_FOUND'};
   if(original[0].canceled_at)return {result:0,status:'OK',data:{account,balance:before}};
   const originalAmount=Number(original[0].amount||0);ledgerAmount=originalAmount;
   if(original[0].type==='Bet'){after=before+originalAmount;ledgerDirection='credit';reason='provider_bet_reversal';}
   else if(original[0].type==='Win'){if(before<originalAmount)return {result:31,status:'BALANCE_NOT_ENOUGH',data:{account,balance:before}};after=before-originalAmount;ledgerDirection='debit';reason='provider_win_reversal';}
   else return {result:43,status:'TRANSACTION_NOT_FOUND'};
   await conn.query('UPDATE provider_transactions SET canceled_at=NOW(),status="canceled" WHERE provider_code="goldslotpalase" AND provider_transaction_id=?',[cancelGuid]);
  }
  const txId=newId(),ref='GSP-'+(command==='cancel'&&cancelGuid?cancelGuid:transGuid);
  await conn.query('UPDATE wallets SET balance=? WHERE user_id=?',[after,userId]);
  await conn.query('INSERT INTO transactions(id,user_id,type,amount,status,reference,metadata) VALUES(?,?,?,?,?,?,?)',[txId,userId,command==='cancel'?'provider_reversal':'provider_'+command,ledgerAmount,'completed',ref,JSON.stringify({provider:'goldslotpalase',transGuid,cancelGuid,gplayId:d.gplay_id??null,roundId:d.round_id??null,providerId:d.provider_id??null,gameCode:d.game_code??null})]);
  await conn.query('INSERT INTO wallet_ledger(id,user_id,transaction_id,reference,direction,amount,balance_before,balance_after,reason,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)',[newId(),userId,txId,ref,ledgerDirection,ledgerAmount,before,after,reason,JSON.stringify({provider:'goldslotpalase',transGuid,cancelGuid})]);
  const out={result:0,status:'OK',data:{account,balance:after}};
  await conn.query('INSERT INTO provider_transactions(id,provider_code,provider_transaction_id,user_id,type,amount,status,raw_json,command,trans_guid,cancel_trans_guid,account,gplay_id,round_id,provider_id,game_code,balance_after,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[newId(),'goldslotpalase',lookupId,userId,providerType,ledgerAmount,'completed',JSON.stringify(b),command,transGuid,cancelGuid||null,account,String(d.gplay_id??''),String(d.round_id??''),String(d.provider_id??''),String(d.game_code??''),after,JSON.stringify(out)]);
  return out;
 });
 return res.json(response);
}catch(e){if(e.code==='provider_callback_unauthorized')return res.status(401).json({result:1009,status:'TOKEN_INVALID'});next(e)}});

app.get('/api/backoffice-health',adminAuth,(_,res)=>ok(res,{status:'ok'}));
app.get('/api/backoffice-readiness',adminAuth,async(_,res,next)=>{try{await pingDatabase();ok(res,{ready:true,database:true,providerConfigured:provider.configured,paymentConfigured:Boolean(config.paymentBaseUrl&&config.paymentApiKey),bootstrapEnabled:Boolean(config.masterBootstrapToken),configuration:[{name:'DATABASE_URL',present:true},{name:'GOLDSLOTPALASE_API_TOKEN',present:provider.configured},{name:'GOLDSLOTPALASE_CALLBACK_TOKEN',present:Boolean(config.providerCallbackToken)},{name:'PAYMENT_API_BASE',present:Boolean(config.paymentBaseUrl)},{name:'PAYMENT_API_KEY',present:Boolean(config.paymentApiKey)}]})}catch(e){next(e)}});
app.get('/api/backoffice-dashboard',adminAuth,async(req,res,next)=>{try{
 const [[m],[d],[w],[wd],[p]] = await Promise.all([pool.query('SELECT COUNT(*) count FROM users WHERE role="member"'),pool.query('SELECT COALESCE(SUM(amount),0) amount FROM deposits WHERE status="completed" AND created_at>=CURRENT_DATE'),pool.query('SELECT COALESCE(SUM(balance),0) balance FROM wallets'),pool.query('SELECT COALESCE(SUM(amount),0) amount FROM withdrawals WHERE status="completed" AND created_at>=CURRENT_DATE'),pool.query('SELECT COUNT(*) count FROM games WHERE is_active=1')]);
 ok(res,{members:Number(m[0].count),depositTotal:Number(d[0].amount),walletTotal:Number(w[0].balance),withdrawalTotal:Number(wd[0].amount),activeGames:Number(p[0].count),provider:{configured:provider.configured}});
}catch(e){next(e)}});
app.get('/api/backoffice-members',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT u.id,u.username,u.email,u.display_name displayName,u.phone,u.status,u.role,u.referral_code referralCode,u.created_at createdAt,u.last_login_at lastLoginAt,w.balance,w.locked FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE u.role="member" ORDER BY u.created_at DESC LIMIT 500');ok(res,{members:r,items:r})}catch(e){next(e)}});
app.get('/api/backoffice-finance',adminAuth,async(req,res,next)=>{try{const [d]=await pool.query('SELECT id,user_id userId,amount,status,gateway,gateway_reference gatewayReference,created_at createdAt FROM deposits ORDER BY created_at DESC LIMIT 200');const [w]=await pool.query('SELECT id,user_id userId,amount,status,bank_account_id bankAccountId,gateway_reference gatewayReference,reject_reason rejectReason,created_at createdAt FROM withdrawals ORDER BY created_at DESC LIMIT 200');ok(res,{deposits:d,withdrawals:w,reconciliation:[]})}catch(e){next(e)}});
app.get('/api/backoffice-ledger',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT l.*,u.username FROM wallet_ledger l JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 200');ok(res,{items:r,ledger:r})}catch(e){next(e)}});
app.get('/api/backoffice-game-catalog',adminAuth,async(req,res,next)=>{try{
 const [r]=await pool.query('SELECT * FROM games ORDER BY provider_code,sort_order,id');
 const [st]=await pool.query('SELECT value_json FROM system_settings WHERE setting_key="game_display"');
 const display=st[0]?JSON.parse(st[0].value_json):{revision:0,hiddenGames:[],popularOrder:[],newestOrder:[],pinnedOrder:[],providerOrder:[]};
 ok(res,{games:r,items:r,display});
}catch(e){next(e)}});
app.post('/api/backoffice-game-catalog',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const b=req.body||{};
 if(b.action==='sync'){
  const raw=await provider.allGames({}),list=Array.isArray(raw?.data?.games)?raw.data.games:Array.isArray(raw?.games)?raw.games:Array.isArray(raw?.data)?raw.data:[];
  let count=0;
  const {normalizeProviderGame}=await import('./provider.js');
  for(const x of list){const g=normalizeProviderGame(x);if(!g)continue;await pool.query('INSERT INTO games(id,provider_code,provider_id,game_code,name,category,image_url,is_active,metadata) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE provider_id=VALUES(provider_id),name=VALUES(name),category=VALUES(category),image_url=VALUES(image_url),is_active=VALUES(is_active),metadata=VALUES(metadata)',[newId(),g.providerCode,g.providerId,g.gameCode,g.name,g.category,g.imageUrl,g.isActive,JSON.stringify(g.metadata)]);count++}
  await audit(req,'catalog.sync','provider','goldslotpalase',{count});
  const [items]=await pool.query('SELECT * FROM games ORDER BY provider_code,sort_order,id');return ok(res,{items,games:items,display:{revision:0,hiddenGames:[],popularOrder:[],newestOrder:[],pinnedOrder:[],providerOrder:[]},count});
 }
 if(b.action==='save-display'){
  const display=b.display||{},revision=Number(display.revision||0)+1;display.revision=revision;
  await pool.query('INSERT INTO system_settings(setting_key,value_json,updated_by) VALUES("game_display",?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json),updated_by=VALUES(updated_by)',[JSON.stringify(display),req.user.id]);
  await audit(req,'catalog.display.update','system','game_display',{revision});return ok(res,{display});
 }
 const gid=b.id||newId();
 await pool.query('INSERT INTO games(id,provider_code,provider_id,game_code,name,category,image_url,is_active,is_popular,is_new,sort_order,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE provider_id=VALUES(provider_id),name=VALUES(name),category=VALUES(category),image_url=VALUES(image_url),is_active=VALUES(is_active),is_popular=VALUES(is_popular),is_new=VALUES(is_new),sort_order=VALUES(sort_order),metadata=VALUES(metadata)',[gid,b.providerCode||'goldslotpalase',b.providerId||null,b.gameCode,b.name,b.category||null,b.imageUrl||null,b.isActive!==false,b.isPopular===true,b.isNew===true,Number(b.sortOrder||0),JSON.stringify(b.metadata||{})]);
 await audit(req,'catalog.game.upsert','game',gid,{gameCode:b.gameCode});ok(res,{id:gid});
}catch(e){next(e)}});
app.get('/api/backoffice-rtp/:userId',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const [r]=await pool.query('SELECT user_id userId,enabled,rtp,min_rtp minRtp,max_rtp maxRtp,reason,updated_by updatedBy,updated_at updatedAt FROM member_rtp_settings WHERE user_id=?',[req.params.userId]);
 ok(res,{settings:r[0]||{userId:req.params.userId,enabled:false,rtp:null}}); 
}catch(e){next(e)}});
app.post('/api/backoffice-rtp/:userId',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const enabled=req.body?.enabled===true,rtp=req.body?.rtp==null||req.body?.rtp===''?null:Number(req.body.rtp),reason=String(req.body?.reason||'').slice(0,500);
 if(enabled&&(!Number.isFinite(rtp)||rtp<0||rtp>100))return fail(res,400,'invalid_rtp');
 const [[old]]=await pool.query('SELECT rtp FROM member_rtp_settings WHERE user_id=?',[req.params.userId]);
 await withTransaction(async conn=>{
  await conn.query('INSERT INTO member_rtp_settings(user_id,enabled,rtp,reason,updated_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),rtp=VALUES(rtp),reason=VALUES(reason),updated_by=VALUES(updated_by)',[req.params.userId,enabled,enabled?rtp:null,reason||null,req.user.id]);
  await conn.query('INSERT INTO rtp_audit_logs(id,user_id,old_rtp,new_rtp,enabled,actor_user_id,reason) VALUES(?,?,?,?,?,?,?)',[newId(),req.params.userId,old?.rtp??null,enabled?rtp:null,enabled,req.user.id,reason||null]);
 });
 await audit(req,'member.rtp.update','user',req.params.userId,{enabled,rtp,reason});
 ok(res,{userId:req.params.userId,enabled,rtp:enabled?rtp:null});
}catch(e){next(e)}});
app.post('/api/backoffice-provider',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const b=req.body||{},action=String(b.action||'check');
 if(action==='check'||action==='health'){const info=await provider.info();return ok(res,{status:'READY',message:'GoldslotPalase API dapat dihubungi.',provider:info,capabilities:{agentInfo:true,agentRtp:true,userCreate:true,userInfo:true,providerCatalog:true,gameCatalog:true,gameLaunch:true,userRtpAtLaunch:true,onlineGames:true,bonusCall:true,freeRound:true,transactions:true,roundDetails:true,statistics:true,transferWallet:true,callbackAuth:Boolean(config.providerCallbackToken)}})}
 if(action==='providers')return ok(res,{provider:await provider.providers()});
 if(action==='games')return ok(res,{provider:await provider.games(b.payload||{})});
 if(action==='all-games')return ok(res,{provider:await provider.allGames(b.payload||{})});
 if(action==='user-info')return ok(res,{provider:await provider.userInfo(Number(b.userCode))});
 if(action==='create-user'){const name=String(b.name||'').trim();if(!/^[_a-zA-Z0-9]{2,50}$/.test(name))return fail(res,400,'invalid_provider_username');return ok(res,{provider:await provider.createUser(name)})}
 if(action==='online-games')return ok(res,{provider:await provider.onlineGames(b.payload||{})});
 if(action==='sync'){
  const p=await provider.providers(),g=await provider.allGames({});const raw=g?.data?.games||g?.games||g?.data||[];const list=Array.isArray(raw)?raw:[];let count=0;const {normalizeProviderGame}=await import('./provider.js');
  for(const x of list){const game=normalizeProviderGame(x);if(!game)continue;await pool.query('INSERT INTO games(id,provider_code,provider_id,game_code,name,category,image_url,is_active,metadata) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE provider_id=VALUES(provider_id),name=VALUES(name),category=VALUES(category),image_url=VALUES(image_url),is_active=VALUES(is_active),metadata=VALUES(metadata)',[newId(),game.providerCode,game.providerId,game.gameCode,game.name,game.category,game.imageUrl,game.isActive,JSON.stringify(game.metadata)]);count++}
  await audit(req,'provider.catalog.sync','provider','goldslotpalase',{count});return ok(res,{count,provider:p,status:'READY'});
 }
 if(action==='get-user-rtp'){const userId=String(b.userId||'');if(!userId)return fail(res,400,'user_id_required');const [r]=await pool.query('SELECT user_id userId,enabled,rtp,min_rtp minRtp,max_rtp maxRtp,reason,updated_at updatedAt FROM member_rtp_settings WHERE user_id=?',[userId]);return ok(res,{settings:r[0]||{userId,enabled:false,rtp:null}});}
 if(action==='set-user-rtp'){const userId=String(b.userId||''),enabled=b.enabled!==false,rtp=Number(b.rtp);if(!userId||!Number.isFinite(rtp)||rtp<0||rtp>100)return fail(res,400,'invalid_user_rtp');const [[old]]=await pool.query('SELECT rtp FROM member_rtp_settings WHERE user_id=?',[userId]);await withTransaction(async conn=>{await conn.query('INSERT INTO member_rtp_settings(user_id,enabled,rtp,reason,updated_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),rtp=VALUES(rtp),reason=VALUES(reason),updated_by=VALUES(updated_by)',[userId,enabled,enabled?rtp:null,String(b.reason||'').slice(0,500)||null,req.user.id]);await conn.query('INSERT INTO rtp_audit_logs(id,user_id,old_rtp,new_rtp,enabled,actor_user_id,reason) VALUES(?,?,?,?,?,?,?)',[newId(),userId,old?.rtp??null,enabled?rtp:null,enabled,req.user.id,String(b.reason||'').slice(0,500)||null]);});await audit(req,'member.rtp.update','user',userId,{enabled,rtp});return ok(res,{userId,enabled,rtp:enabled?rtp:null});}
 if(action==='set-rtp'){const rtp=Number(b.rtp);if(!Number.isFinite(rtp)||rtp<0||rtp>100)return fail(res,400,'invalid_rtp');const out=await provider.setRtp(rtp);await audit(req,'provider.rtp.update','provider','goldslotpalase',{rtp});return ok(res,{provider:out,rtp})}
 if(action==='callback-test')return ok(res,{provider:await provider.callbackTest(b.payload||{})});
 if(action==='bonuscall-config')return ok(res,{provider:await provider.callConfig(b.payload||{})});
 if(action==='bonuscall-start')return ok(res,{provider:await provider.callStart(b.payload||{})});
 if(action==='bonuscall-cancel')return ok(res,{provider:await provider.callCancel(b.payload||{})});
 if(action==='freeround-create')return ok(res,{provider:await provider.freeRoundCreate(b.payload||{})});
 if(action==='freeround-cancel')return ok(res,{provider:await provider.freeRoundCancel(b.payload||{})});
 if(action==='transactions'){const out=await provider.transactions(b.payload||{});return ok(res,{provider:out})}
 if(action==='transaction-id'){const out=await provider.transactionId(b.payload||{});return ok(res,{provider:out})}
 if(action==='round-details')return ok(res,{provider:await provider.roundDetails(b.payload||{})});
 if(action==='statistics-user')return ok(res,{provider:await provider.statisticsUser(b.payload||{})});
 if(action==='transfer-deposit')return ok(res,{provider:await provider.transferDeposit(b.payload||{})});
 if(action==='transfer-withdraw')return ok(res,{provider:await provider.transferWithdraw(b.payload||{})});
 if(action==='transfer-withdraw-all')return ok(res,{provider:await provider.transferWithdrawAll(b.payload||{})});
 if(action==='sync-transactions'){
  const [[state]]=await pool.query('SELECT value_json FROM system_settings WHERE setting_key="provider_transaction_sync"');
  const st=state?JSON.parse(state.value_json):{lastId:null,lastRunAt:null};const now=Date.now();
  if(st.lastRunAt&&now-new Date(st.lastRunAt).getTime()<31000)return fail(res,429,'provider_transaction_sync_rate_limited',{retryAfterMs:31000-(now-new Date(st.lastRunAt).getTime())});
  const payload=b.payload||{};let out;
  if(payload.mode==='time')out=await provider.transactions(payload);else out=await provider.transactionId({...payload,last_id:payload.last_id??st.lastId});
  const raw=out?.data?.transactions||out?.data?.items||out?.transactions||out?.items||out?.data||[];const list=Array.isArray(raw)?raw:[];
  let saved=0,lastId=st.lastId;
  for(const x of list){const tid=String(x.trans_guid??x.transaction_id??x.id??'').trim();if(!tid)continue;lastId=String(x.id??x.transaction_id??x.trans_guid??lastId);await pool.query('INSERT INTO provider_transactions(id,provider_code,provider_transaction_id,user_id,type,amount,status,raw_json,command,trans_guid,account,gplay_id,round_id,provider_id,game_code,balance_after) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE raw_json=VALUES(raw_json),status=VALUES(status),amount=VALUES(amount)',[newId(),'goldslotpalase',tid,null,String(x.type??'unknown'),money(x.amount??0),'reconciled',JSON.stringify(x), 'reconciliation',tid,String(x.account??''),String(x.gplay_id??''),String(x.round_id??''),String(x.provider_id??''),String(x.game_code??''),null]);saved++}
  const newState={lastId,lastRunAt:new Date().toISOString(),saved};await pool.query('INSERT INTO system_settings(setting_key,value_json,updated_by) VALUES("provider_transaction_sync",?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json),updated_by=VALUES(updated_by)',[JSON.stringify(newState),req.user.id]);await audit(req,'provider.transaction.reconcile','provider','goldslotpalase',{saved,lastId});return ok(res,{saved,lastId,provider:out});
 }
 return fail(res,400,'unknown_provider_action');
}catch(e){next(e)}});
app.get('/api/backoffice-provider',adminAuth,async(req,res,next)=>{try{
 let info=null,status='UNCONFIGURED',message='Provider token belum dikonfigurasi.';
 if(provider.configured){try{info=await provider.info();status='READY';message='GoldslotPalase API dapat dihubungi.'}catch(e){status='ERROR';message=e.code||e.message}}
 ok(res,{configured:provider.configured,status,message,provider:info,capabilities:{catalogSync:provider.configured,gameLaunch:provider.configured,transactionIncrementalSync:provider.configured,transferWallet:provider.configured,callbackAuth:Boolean(config.providerCallbackToken)},lastSync:null});
}catch(e){next(e)}});
app.post('/api/backoffice-payment-connections',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const b=req.body||{},id=b.id||newId(),providerName=String(b.provider||'').trim().toLowerCase(),label=String(b.label||b.name||providerName||'Payment Gateway').trim(),mode=String(b.mode||'production');
 if(!providerName)return fail(res,400,'payment_provider_required');
 const credentials=b.credentials&&typeof b.credentials==='object'?b.credentials:{};
 const serialized=encryptJson(credentials);
 await pool.query('INSERT INTO payment_connections(id,name,provider,mode,encrypted_config,is_active) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),provider=VALUES(provider),mode=VALUES(mode),encrypted_config=VALUES(encrypted_config)',[id,label,providerName,mode,serialized,false]);
 await audit(req,'payment.connection.save','payment_connection',id,{provider:providerName,mode});
 ok(res,{id,saved:true,operational:false,status:'GATED',message:'Credential tersimpan, tetapi adapter payment belum diaktifkan sebelum kontrak provider resmi diverifikasi.'});
}catch(e){next(e)}});
app.get('/api/backoffice-payment-connections',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT id,name,provider,mode,is_active isActive,created_at createdAt FROM payment_connections ORDER BY created_at DESC');ok(res,{items:r,connections:r,configured:Boolean(config.paymentBaseUrl&&config.paymentApiKey),vaultConfigured:Boolean(config.paymentVaultKey)})}catch(e){next(e)}});
app.get('/api/backoffice-promotions',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT * FROM promotions ORDER BY sort_order,id');ok(res,{items:r,promotions:r})}catch(e){next(e)}});
app.post('/api/backoffice-promotions',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{const b=req.body||{},id=b.id||newId();await pool.query('INSERT INTO promotions(id,title,description,image_url,start_at,end_at,is_active,sort_order) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),description=VALUES(description),image_url=VALUES(image_url),start_at=VALUES(start_at),end_at=VALUES(end_at),is_active=VALUES(is_active),sort_order=VALUES(sort_order)',[id,b.title,b.description||null,b.imageUrl||null,b.startAt||null,b.endAt||null,b.isActive!==false,Number(b.sortOrder||0)]);await audit(req,'promotion.upsert','promotion',id);ok(res,{id})}catch(e){next(e)}});
app.get('/api/backoffice-rewards',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT c.user_id userId,u.username,c.balance FROM cashback_accounts c JOIN users u ON u.id=c.user_id ORDER BY c.balance DESC LIMIT 500');ok(res,{items:r})}catch(e){next(e)}});
app.get('/api/backoffice-reports',adminAuth,async(req,res,next)=>{try{const [[m],[d],[w],[g]] = await Promise.all([pool.query('SELECT COUNT(*) count FROM users WHERE role="member"'),pool.query('SELECT COALESCE(SUM(amount),0) amount FROM deposits WHERE status="completed"'),pool.query('SELECT COALESCE(SUM(amount),0) amount FROM withdrawals WHERE status="completed"'),pool.query('SELECT COUNT(*) count FROM games')]);ok(res,{members:m[0].count,deposits:d[0].amount,withdrawals:w[0].amount,games:g[0].count})}catch(e){next(e)}});
app.get('/api/backoffice-audit',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT a.*,u.username actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT 200');ok(res,{items:r,audit:r})}catch(e){next(e)}});
app.get('/api/backoffice-website-settings',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT setting_key,value_json FROM system_settings');const settings={};for(const x of r)settings[x.setting_key]=JSON.parse(x.value_json);ok(res,{settings})}catch(e){next(e)}});
app.post('/api/backoffice-website-settings',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{const section=req.body?.section||'general',settings=req.body?.settings||{};await pool.query('INSERT INTO system_settings(setting_key,value_json,updated_by) VALUES(?,?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json),updated_by=VALUES(updated_by)',[section,JSON.stringify(settings),req.user.id]);await audit(req,'website.settings.update','settings',section,{settings:Object.keys(settings)});ok(res,{saved:true})}catch(e){next(e)}});
app.get('/api/backoffice-master-control',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT setting_key,value_json,updated_at FROM system_settings WHERE setting_key="master"');const s=r[0]?JSON.parse(r[0].value_json):{};ok(res,{...s,revision:s.revision||0,updatedAt:r[0]?.updated_at||null,updatedBy:r[0]?req.user.username:null})}catch(e){next(e)}});
app.post('/api/backoffice-master-control',adminAuth,role('superadmin'),async(req,res,next)=>{try{const s=req.body?.settings||req.body||{};s.revision=Number(s.revision||0)+1;await pool.query('INSERT INTO system_settings(setting_key,value_json,updated_by) VALUES("master",?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json),updated_by=VALUES(updated_by)',[JSON.stringify(s),req.user.id]);await audit(req,'master_control.update','system','master',{revision:s.revision});ok(res,s)}catch(e){next(e)}});

app.post('/api/bootstrap-superadmin',async(req,res,next)=>{try{
 if(!config.masterBootstrapToken||String(req.get('X-Bootstrap-Token')||'')!==config.masterBootstrapToken)return fail(res,403,'bootstrap_forbidden');
 const b=req.body||{};if(!b.email||!b.password||String(b.password).length<12)return fail(res,400,'invalid_bootstrap');
 const [existing]=await pool.query('SELECT id FROM users WHERE role="superadmin" LIMIT 1');if(existing[0])return fail(res,409,'superadmin_exists');
 const uid=newId(),pw=await argon2.hash(b.password);await pool.query('INSERT INTO users(id,username,email,password_hash,role,status,display_name) VALUES(?,?,?,?,"superadmin","active",?)',[uid,b.username||'superadmin',String(b.email).toLowerCase(),pw,b.displayName||'Superadmin']);await pool.query('INSERT INTO wallets(user_id,balance) VALUES(?,0)',[uid]);await pool.query('INSERT INTO cashback_accounts(user_id,balance) VALUES(?,0)',[uid]);ok(res,{created:true,id:uid});
}catch(e){next(e)}});

app.post('/api/provider/callback-test',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{const r=await provider.callbackTest(req.body||{});ok(res,{provider:r})}catch(e){next(e)}});
app.post('/api/backoffice-ledger/adjust',adminAuth,role('finance','admin','superadmin'),async(req,res,next)=>{try{
 const userId=String(req.body?.userId||''),amount=money(req.body?.amount),direction=req.body?.direction,reason=String(req.body?.reason||'').trim();if(!userId||!reason||!['credit','debit'].includes(direction))return fail(res,400,'invalid_adjustment');
 const ref='ADJ-'+newId();const result=direction==='credit'?await creditWallet(userId,amount,'admin_adjustment',ref,{reason,actor:req.user.id}):await debitWallet(userId,amount,'admin_adjustment',ref,{reason,actor:req.user.id});await audit(req,'wallet.adjustment','user',userId,{amount,direction,reason,reference:ref});ok(res,{result});
}catch(e){next(e)}});

app.use(notFound);app.use(errorHandler);
const server=app.listen(config.port,()=>console.log('BrandalBet V2 listening on '+config.port));
async function shutdown(signal){console.log('Received '+signal);server.close(async()=>{try{await closeDatabase();process.exit(0)}catch{process.exit(1)}});setTimeout(()=>process.exit(1),10000).unref()}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));