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
import {provider,verifyProviderCallback,providerLedgerReference} from './provider.js';
import {creditWallet,debitWallet,id as newId,money,availableBalance as getAvailableBalance} from './wallet.js';
import {encryptJson} from './vault.js';
import {normalizeReferralCode} from './referral.js';
import {xendit,createDeposit,createWithdrawal,handleXenditPaymentWebhook,handleXenditPayoutWebhook} from './xendit-payment.js';

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
  const [rows]=await pool.query('SELECT u.*,s.id session_id,s.device_id,s.session_type,s.expires_at FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>NOW() LIMIT 1',[hash(h.slice(7))]);
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
  if(existing[0]?.provider_user_code)return; // Never create a second provider account for an existing member mapping.
  const created=await provider.createUser(username);
  const providerUser=String(created?.data?.user_code??created?.user_code??'');
  if(!providerUser)return;
  await pool.query('INSERT INTO provider_users(id,user_id,provider_code,provider_user_code) VALUES(?,?,?,?)',[newId(),userId,'goldslotpalase',providerUser]);
 }catch(e){console.error('provider_user_sync_failed',e.code||e.message)}
}
async function completeOnboarding(userId,body){
 const b=body||{};
 await withTransaction(async c=>{
  await c.query('INSERT INTO member_profiles(user_id,language,timezone) VALUES(?,?,?) ON DUPLICATE KEY UPDATE language=VALUES(language),timezone=VALUES(timezone)',[userId,b.language||'id',b.timezone||'Asia/Jakarta']);
  if(b.displayName!==undefined||b.phone!==undefined){
   await c.query('UPDATE users SET display_name=COALESCE(?,display_name),phone=COALESCE(?,phone) WHERE id=?',[b.displayName||null,b.phone||null,userId]);
  }
  if(b.bankAccount?.provider&&b.bankAccount?.accountNumber&&b.bankAccount?.accountName){
   const accountNumber=String(b.bankAccount.accountNumber).replace(/\D/g,'');
   const [existing]=await c.query('SELECT id FROM bank_accounts WHERE user_id=? ORDER BY created_at DESC LIMIT 1 FOR UPDATE',[userId]);
   if(existing[0]){
    await c.query('UPDATE bank_accounts SET type=?,provider=?,account_number=?,account_name=?,routing_type=?,routing_value=? WHERE id=?',[b.bankAccount.type||'bank',b.bankAccount.provider,accountNumber,b.bankAccount.accountName,b.bankAccount.routingType||null,b.bankAccount.routingValue||null,existing[0].id]);
   }else{
    await c.query('INSERT INTO bank_accounts(id,user_id,type,provider,account_number,account_name,routing_type,routing_value) VALUES(?,?,?,?,?,?,?,?)',[newId(),userId,b.bankAccount.type||'bank',b.bankAccount.provider,accountNumber,b.bankAccount.accountName,b.bankAccount.routingType||null,b.bankAccount.routingValue||null]);
   }
  }
 });
}
async function login(req,res,username,password,deviceId){
 if(!username||!password)return fail(res,400,'credentials_required');
 const [rows]=await pool.query('SELECT * FROM users WHERE (username=? OR email=?) AND status="active" LIMIT 1',[username,username]);
 if(!rows[0]||!(await argon2.verify(rows[0].password_hash,password)))return fail(res,401,'invalid_credentials');
 const u=rows[0],sid=newId(),raw=token(),expires=new Date(Date.now()+config.sessionTtlDays*86400000),type=u.role==='member'?'member':'backoffice';
 const [[security]]=u.role==='member'?await pool.query('SELECT login_enabled,one_device_only FROM member_security_settings WHERE user_id=?',[u.id]):[[null]];
 if(security&&security.login_enabled===false)return fail(res,403,'login_disabled');
 await withTransaction(async c=>{
  if(type==='backoffice'||security?.one_device_only!==false)await c.query('UPDATE user_sessions SET revoked_at=NOW() WHERE user_id=? AND session_type=? AND revoked_at IS NULL',[u.id,type]);
  await c.query('INSERT INTO user_sessions(id,user_id,token_hash,device_id,session_type,ip,user_agent,expires_at) VALUES(?,?,?,?,?,?,?,?)',[sid,u.id,hash(raw),deviceId||null,type,req.ip,req.get('user-agent')||null,expires]);
  await c.query('UPDATE users SET last_login_at=NOW() WHERE id=?',[u.id]);
 });
 await audit({...req,user:{id:u.id}},'auth.login','user',u.id,{sessionType:type});
 void ensureProviderUser(u.id,u.username);
 return ok(res,{token:raw,expiresAt:expires.toISOString(),user:{id:u.id,username:u.username,email:u.email,role:u.role,displayName:u.display_name}});
}

app.get('/api/health',async(_,res)=>{try{await pingDatabase();ok(res,{service:'brandalbet-backend-v2',database:'ok',version:'2.1.0'})}catch{fail(res,503,'database_unavailable')}});
app.get('/api/readiness',async(_,res)=>{try{await pingDatabase();ok(res,{ready:true,database:true,providerConfigured:provider.configured,paymentConfigured:xendit.configured})}catch{fail(res,503,'not_ready')}});
app.get('/api/me',auth,(req,res)=>ok(res,{user:{id:req.user.id,username:req.user.username,email:req.user.email,role:req.user.role,displayName:req.user.display_name,phone:req.user.phone}}));

app.post('/api/auth/register',async(req,res,next)=>{try{
 const [[site]] = await pool.query('SELECT registration_enabled,maintenance_mode FROM website_settings WHERE id=1');
 if(site?.maintenance_mode) return fail(res,503,'maintenance_mode');
 if(site?.registration_enabled===false) return fail(res,403,'registration_disabled');
 const b=req.body||{};if(!/^[a-zA-Z0-9_]{3,32}$/.test(String(b.username||'')))return fail(res,400,'invalid_username');
 if(!String(b.email||'').includes('@')||String(b.password||'').length<8)return fail(res,400,'invalid_registration');
 const [exists]=await pool.query('SELECT id FROM users WHERE username=? OR email=? LIMIT 1',[b.username,String(b.email).toLowerCase()]);if(exists[0])return fail(res,409,'account_exists');
 let referralCode;
 try{referralCode=normalizeReferralCode(b.referralCode)}catch(e){return fail(res,400,'invalid_referral_code')}
 let referralOwner=null;
 if(referralCode){
  const [owners]=await pool.query('SELECT id,referral_code,status,role FROM users WHERE referral_code=? LIMIT 1',[referralCode]);
  referralOwner=owners[0]||null;
  if(!referralOwner||referralOwner.status!=='active'||referralOwner.role!=='member')return fail(res,400,'referral_code_unavailable');
 }
 const uid=newId(),pw=await argon2.hash(b.password),ref=crypto.randomBytes(5).toString('hex').toUpperCase();
 await withTransaction(async c=>{
  await c.query('INSERT INTO users(id,username,email,password_hash,display_name,phone,referral_code,referred_by) VALUES(?,?,?,?,?,?,?,?)',[uid,b.username,String(b.email).toLowerCase(),pw,b.displayName||null,b.phone||null,ref,referralOwner?.referral_code||null]);
  await c.query('INSERT INTO wallets(user_id,balance) VALUES(?,0)',[uid]);await c.query('INSERT INTO cashback_accounts(user_id,balance) VALUES(?,0)',[uid]);
  await c.query('INSERT INTO member_profiles(user_id) VALUES(?)',[uid]);
  await c.query('INSERT INTO member_security_settings(user_id,one_device_only,login_enabled,require_password_for_withdrawal) VALUES(?,1,1,1)',[uid]);
  if(b.bankAccount)await c.query('INSERT INTO bank_accounts(id,user_id,type,provider,account_number,account_name,routing_type,routing_value) VALUES(?,?,?,?,?,?,?,?)',[newId(),uid,b.bankAccount.type||'bank',b.bankAccount.provider||'',String(b.bankAccount.accountNumber||'').replace(/\D/g,''),b.bankAccount.accountName||'',b.bankAccount.routingType||null,b.bankAccount.routingValue||null]);
  if(referralOwner)await c.query('INSERT INTO referrals(id,referrer_id,referred_id,code) VALUES(?,?,?,?)',[newId(),referralOwner.id,uid,referralOwner.referral_code]);
 });
 return login(req,res,b.username,b.password,b.deviceId);
}catch(e){next(e)}});

app.post('/api/auth/login',async(req,res,next)=>{try{return login(req,res,req.body?.username,req.body?.password,req.body?.deviceId)}catch(e){next(e)}});
app.post('/api/auth/logout',auth,async(req,res,next)=>{try{await pool.query('UPDATE user_sessions SET revoked_at=NOW() WHERE id=?',[req.user.session_id]);await audit(req,'auth.logout','user',req.user.id);ok(res,{loggedOut:true})}catch(e){next(e)}});
app.post('/api/auth/refresh',auth,(req,res)=>ok(res,{sessionValid:true,expiresAt:req.user.expires_at}));
async function memberSessionResponse(req,res,next){
 try{
  const [[u],[p],[b],[w]] = await Promise.all([
   pool.query('SELECT id,username,email,display_name displayName,phone,referral_code referralCode FROM users WHERE id=?',[req.user.id]),
   pool.query('SELECT language,timezone,avatar_url avatarUrl FROM member_profiles WHERE user_id=?',[req.user.id]),
   pool.query('SELECT id,type,provider,account_number accountNumber,account_name accountName,routing_type routingType,routing_value routingValue,is_primary isPrimary,verified_at verifiedAt FROM bank_accounts WHERE user_id=? ORDER BY created_at DESC LIMIT 1',[req.user.id]),
   pool.query('SELECT balance,locked,locked_balance FROM wallets WHERE user_id=?',[req.user.id])
  ]);
  const profile=u[0]||null;
  ok(res,{
   session:{userId:req.user.id,deviceId:req.user.device_id,expiresAt:req.user.expires_at,sessionType:req.user.session_type},
   profile:profile?{...profile,onboardingCompleted:Boolean(b[0])&&Boolean(profile.username&&profile.displayName&&profile.phone&&b[0].accountNumber&&b[0].accountName)}:null,
   bankAccount:b[0]||null,
   wallet:{balance:Number(w[0]?.balance||0),lockedBalance:Number(w[0]?.locked_balance||0),availableBalance:Math.max(0,Number(w[0]?.balance||0)-Number(w[0]?.locked_balance||0)),locked:Boolean(w[0]?.locked)},
   preferences:p[0]||{language:'id',timezone:'Asia/Jakarta'}
  });
 }catch(e){next(e)}
}
app.get('/api/member-session',memberAuth,memberSessionResponse);
app.post('/api/member-session',memberAuth,memberSessionResponse);
app.post('/api/member-device-session',memberAuth,async(req,res,next)=>{try{
 if(req.body?.action==='end'){await pool.query('UPDATE user_sessions SET revoked_at=NOW() WHERE id=?',[req.user.session_id]);return ok(res,{ended:true})}
 if(req.body?.replace===true)await pool.query('UPDATE user_sessions SET revoked_at=NOW() WHERE user_id=? AND session_type="member" AND id<>? AND revoked_at IS NULL',[req.user.id,req.user.session_id]);
 ok(res,{claimed:true,deviceId:req.user.device_id})
}catch(e){next(e)}});

app.get('/api/member/profile',memberAuth,async(req,res,next)=>{try{
 const [[u],[p],[b]] = await Promise.all([pool.query('SELECT id,username,email,display_name displayName,phone,referral_code referralCode FROM users WHERE id=?',[req.user.id]),pool.query('SELECT language,timezone,avatar_url avatarUrl FROM member_profiles WHERE user_id=?',[req.user.id]),pool.query('SELECT id,type,provider,account_number accountNumber,account_name accountName,routing_type routingType,routing_value routingValue,is_primary isPrimary,verified_at verifiedAt FROM bank_accounts WHERE user_id=? ORDER BY created_at DESC LIMIT 1',[req.user.id])]);
 const [[w]]=await pool.query('SELECT balance,locked_balance,locked FROM wallets WHERE user_id=?',[req.user.id]);
 const balance=Number(w?.balance||0),available=getAvailableBalance(balance,w?.locked_balance||0);
 ok(res,{profile:u[0]||null,bankAccount:b[0]||null,wallet:{availableMinor:Math.round(available*100),balance,availableBalance:available,locked:Boolean(w?.locked)},preferences:p[0]||{language:'id',timezone:'Asia/Jakarta'}});
}catch(e){next(e)}});
app.put('/api/member-profile',memberAuth,async(req,res,next)=>{try{await completeOnboarding(req.user.id,req.body||{});await audit(req,'member.profile.update','user',req.user.id);const [r]=await pool.query('SELECT id,username,email,display_name displayName,phone,referral_code referralCode FROM users WHERE id=?',[req.user.id]);ok(res,{profile:r[0]})}catch(e){next(e)}});
app.get('/api/member-profile',memberAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT id,username,email,display_name displayName,phone,referral_code referralCode FROM users WHERE id=?',[req.user.id]);ok(res,{profile:r[0]||null})}catch(e){next(e)}});
app.post('/api/member-onboarding',memberAuth,async(req,res,next)=>{try{await completeOnboarding(req.user.id,req.body||{});await audit(req,'member.onboarding.complete','user',req.user.id);ok(res,{completed:true})}catch(e){next(e)}});
app.get('/api/member-bank-account',memberAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT id,type,provider,account_number accountNumber,account_name accountName FROM bank_accounts WHERE user_id=? ORDER BY created_at DESC LIMIT 1',[req.user.id]);ok(res,{bankAccount:r[0]||null})}catch(e){next(e)}});
app.put('/api/member-bank-account',memberAuth,async(req,res,next)=>{try{const b=req.body||{};if(!b.provider||!b.accountNumber||!b.accountName)return fail(res,400,'invalid_bank_account');const id=newId();await pool.query('INSERT INTO bank_accounts(id,user_id,type,provider,account_number,account_name,routing_type,routing_value) VALUES(?,?,?,?,?,?,?,?)',[id,req.user.id,b.type||'bank',b.provider,String(b.accountNumber).replace(/\D/g,''),b.accountName,b.routingType||null,b.routingValue||null]);await audit(req,'member.bank.update','bank_account',id);const [r]=await pool.query('SELECT id,type,provider,account_number accountNumber,account_name accountName FROM bank_accounts WHERE id=?',[id]);ok(res,{bankAccount:r[0]})}catch(e){next(e)}});

app.get('/api/wallet',memberAuth,async(req,res,next)=>{try{const [[w]]=await pool.query('SELECT balance,locked_balance,locked FROM wallets WHERE user_id=?',[req.user.id]);const balance=Number(w?.balance||0),lockedBalance=Number(w?.locked_balance||0);ok(res,{balance,lockedBalance,availableBalance:Math.max(0,balance-lockedBalance),availableMinor:Math.round(Math.max(0,balance-lockedBalance)*100),locked:Boolean(w?.locked)})}catch(e){next(e)}});
app.get('/api/transactions',memberAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT id,type,amount,status,reference,created_at createdAt FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 200',[req.user.id]);ok(res,{transactions:r})}catch(e){next(e)}});
app.get('/api/member-rewards',memberAuth,async(req,res,next)=>{try{const [[a]]=await pool.query('SELECT balance FROM cashback_accounts WHERE user_id=?',[req.user.id]);const [h]=await pool.query('SELECT id,amount,type,status,reference,created_at createdAt FROM cashback_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 200',[req.user.id]);ok(res,{balance:Number(a?.balance||0),history:h})}catch(e){next(e)}});
app.get('/api/member-config',async(_,res,next)=>{try{
 const [[site]]=await pool.query('SELECT site_name siteName,logo_url logoUrl,favicon_url faviconUrl,primary_color primaryColor,secondary_color secondaryColor,maintenance_mode maintenanceMode,registration_enabled registrationEnabled,game_launch_enabled gameLaunchEnabled,wallet_enabled walletEnabled,seo_title seoTitle,seo_description seoDescription,hero_config heroConfig,navigation_config navigationConfig,footer_config footerConfig,extra_config extraConfig FROM website_settings WHERE id=1');
 const [[pay]]=await pool.query('SELECT deposit_enabled depositEnabled,withdrawal_enabled withdrawalEnabled,min_deposit minDeposit,max_deposit maxDeposit,min_withdrawal minWithdrawal,max_withdrawal maxWithdrawal,deposit_fee depositFee,withdrawal_fee withdrawalFee,channels FROM payment_settings WHERE id=1');
 const [[reward]]=await pool.query('SELECT cashback_enabled cashbackEnabled,referral_enabled referralEnabled,rules,extra_config extraConfig FROM reward_settings WHERE id=1');
 const j=v=>v==null?null:(typeof v==='string'?JSON.parse(v):v);
 ok(res,{minimumDeposit:Number(pay?.minDeposit??config.minDeposit),minimumWithdrawal:Number(pay?.minWithdrawal??config.minWithdrawal),maxDeposit:pay?.maxDeposit==null?null:Number(pay.maxDeposit),maxWithdrawal:pay?.maxWithdrawal==null?null:Number(pay.maxWithdrawal),depositEnabled:Boolean(pay?.depositEnabled??true),withdrawalEnabled:Boolean(pay?.withdrawalEnabled??true),depositFee:Number(pay?.depositFee||0),withdrawalFee:Number(pay?.withdrawalFee||0),maintenanceMode:Boolean(site?.maintenanceMode),gameLaunchEnabled:Boolean(site?.gameLaunchEnabled),registrationEnabled:Boolean(site?.registrationEnabled),promotionsEnabled:true,memberWalletEnabled:Boolean(site?.walletEnabled),site:{...site,heroConfig:j(site?.heroConfig),navigationConfig:j(site?.navigationConfig),footerConfig:j(site?.footerConfig),extraConfig:j(site?.extraConfig)},rewards:{...reward,rules:j(reward?.rules),extraConfig:j(reward?.extraConfig)}})
 }catch(e){next(e)}});

app.get('/api/games',async(_,res,next)=>{try{
 const [r]=await pool.query(`SELECT g.id,g.provider_code providerCode,g.provider_id providerId,g.game_code gameCode,g.name,g.category,g.image_url imageUrl,g.is_active isActive,
   CASE WHEN EXISTS(SELECT 1 FROM game_display_settings d WHERE d.game_id=g.id AND d.section='popular' AND d.is_visible=1) THEN 1 ELSE g.is_popular END isPopular,
   CASE WHEN EXISTS(SELECT 1 FROM game_display_settings d WHERE d.game_id=g.id AND d.section='terbaru' AND d.is_visible=1) THEN 1 ELSE g.is_new END isNew,
   COALESCE((SELECT MIN(d.display_order) FROM game_display_settings d WHERE d.game_id=g.id AND d.section='all' AND d.is_visible=1),g.sort_order) sortOrder,g.metadata
   FROM games g WHERE g.is_active=1 AND NOT EXISTS(SELECT 1 FROM game_display_settings h WHERE h.game_id=g.id AND h.section='all' AND h.is_visible=0)
   ORDER BY sortOrder,g.id`);
 ok(res,{games:r})}catch(e){next(e)}});
app.get('/api/promotions',async(_,res,next)=>{try{const [r]=await pool.query('SELECT id,title,description,image_url imageUrl,start_at startAt,end_at endAt FROM promotions WHERE is_active=1 AND (start_at IS NULL OR start_at<=NOW()) AND (end_at IS NULL OR end_at>=NOW()) ORDER BY sort_order,id');ok(res,{promotions:r})}catch(e){next(e)}});

app.post('/api/game-launch',memberAuth,async(req,res,next)=>{try{
 const [[site]] = await pool.query('SELECT maintenance_mode,game_launch_enabled FROM website_settings WHERE id=1');
 if(site?.maintenance_mode) return fail(res,503,'maintenance_mode');
 if(site?.game_launch_enabled===false) return fail(res,403,'game_launch_disabled');
 const b=req.body||{},requestId=String(b.launchRequestId||req.get('Idempotency-Key')||'').trim(),providerId=String(b.providerId||''),symbol=String(b.gameSymbol||'').trim();
 if(!requestId||!providerId||!symbol)return fail(res,400,'invalid_launch_request');
 const [previousLaunch]=await pool.query('SELECT game_id,launch_url,expires_at,status FROM game_launches WHERE user_id=? AND request_id=? LIMIT 1',[req.user.id,requestId]);
 if(previousLaunch[0]) return ok(res,{game:{launchUrl:previousLaunch[0].launch_url,expiresAt:previousLaunch[0].expires_at,status:previousLaunch[0].status,gameId:previousLaunch[0].game_id},idempotent:true});
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

app.post('/api/payment-deposit',memberAuth,async(req,res,next)=>{try{const out=await createDeposit(req.user,req.body||{});await audit(req,'payment.deposit.create','payment_order',out.reference,{amount:req.body?.amountRupiah,provider:'xendit'});ok(res,out)}catch(e){next(e)}});

app.post('/api/payment-withdraw',memberAuth,async(req,res,next)=>{try{const out=await createWithdrawal(req.user,req.body||{});await audit(req,'payment.withdraw.create','withdrawal',out.withdrawalId,{amount:req.body?.amountRupiah,provider:'xendit',payoutId:out.payoutId,status:out.status});ok(res,out)}catch(e){next(e)}});

app.post('/webhooks/xendit/payment',async(req,res,next)=>{try{ok(res,await handleXenditPaymentWebhook(req))}catch(e){next(e)}});

app.post('/webhooks/xendit/payout',async(req,res,next)=>{try{ok(res,await handleXenditPayoutWebhook(req))}catch(e){next(e)}});

app.post('/webhooks/v1/payments/:provider',async(req,res,next)=>{try{if(String(req.params.provider).toLowerCase()==='xendit')return ok(res,await handleXenditPaymentWebhook(req));
 if(!config.paymentWebhookSecret)return fail(res,503,'payment_webhook_unconfigured');return fail(res,503,'legacy_payment_webhook_disabled')}catch(e){next(e)}});
app.post('/api/provider/callback',async(req,res,next)=>{try{
 verifyProviderCallback(req);const b=req.body||{},command=String(b.command||'').toLowerCase(),d=b.data||{},account=String(d.account??'').trim();
 if(!['authenticate','balance','bet','win','cancel','status'].includes(command))return res.status(400).json({result:1012,status:'PARAMETERS_INVALID'});
 if(!account)return res.status(400).json({result:21,status:'USER_NOT_FOUND'});
 const [pu]=await pool.query('SELECT u.id,u.status,pu.provider_user_code FROM provider_users pu JOIN users u ON u.id=pu.user_id WHERE pu.provider_code="goldslotpalase" AND pu.provider_user_code=? LIMIT 1',[account]);
 if(!pu[0])return res.status(404).json({result:21,status:'USER_NOT_FOUND'});
 if(pu[0].status!=='active')return res.status(403).json({result:22,status:'USER_INACTIVE'});
 const userId=pu[0].id;
 const [[w]]=await pool.query('SELECT balance,locked_balance FROM wallets WHERE user_id=?',[userId]);const currentBalance=Number(w?.balance||0);const availableBalance=getAvailableBalance(currentBalance,w?.locked_balance||0);
 if(command==='authenticate'||command==='balance')return res.json({result:0,status:'OK',data:{account,balance:availableBalance}});
 const transGuid=String(d.trans_guid??'').trim();if(!transGuid)return res.status(400).json({result:41,status:'TRANSACTION_INVALID'});
 if(command==='status'){
  const [tx]=await pool.query('SELECT status FROM provider_transactions WHERE provider_code="goldslotpalase" AND provider_transaction_id=? LIMIT 1',[transGuid]);
  if(!tx[0]) return res.status(404).json({result:42,status:'TRANSACTION_NOT_FOUND',data:{account,trans_guid:transGuid}});
  return res.json({result:0,status:'OK',data:{account,trans_guid:transGuid,status:tx[0].status==='canceled'?'CANCELED':'OK'}});
 }
 const cancelGuid=String(d.cancel_trans_guid??'').trim(),rawAmount=Number(d.amount??0);if(!Number.isFinite(rawAmount)||rawAmount<0||(['bet','win'].includes(command)&&rawAmount<=0))return res.status(400).json({result:1012,status:'PARAMETERS_INVALID'});const amount=money(rawAmount),providerType=command==='bet'?'Bet':command==='win'?'Win':'Cancel';
 const eventKey=command+':'+transGuid+':'+cancelGuid;
 const payloadHash=hash(JSON.stringify(b));
 const response=await withTransaction(async conn=>{
  await conn.query('INSERT IGNORE INTO provider_events(id,provider_code,event_key,command,raw_json,payload_hash,processing_status) VALUES(?,?,?,?,?,?,?)',[newId(),'goldslotpalase',eventKey,command,JSON.stringify(b),payloadHash,'processing']);
  const [eventRows]=await conn.query('SELECT response_json,processing_status FROM provider_events WHERE provider_code="goldslotpalase" AND event_key=? FOR UPDATE',[eventKey]);
  if(eventRows[0]?.response_json)return JSON.parse(eventRows[0].response_json);
  const lookupId=transGuid;
  const [existing]=await conn.query('SELECT response_json FROM provider_transactions WHERE provider_code="goldslotpalase" AND provider_transaction_id=? FOR UPDATE',[lookupId]);
  if(existing[0]?.response_json)return JSON.parse(existing[0].response_json);
  const [[wallet]]=await conn.query('SELECT balance,locked,locked_balance FROM wallets WHERE user_id=? FOR UPDATE',[userId]);
  if(!wallet)return {result:21,status:'USER_NOT_FOUND'};
  if(wallet.locked)return {result:22,status:'USER_INACTIVE'};
  let before=Number(wallet.balance),after=before,ledgerDirection=null,ledgerAmount=amount,reason='provider_'+command;
  if(command==='bet'){
   if(getAvailableBalance(before,wallet.locked_balance||0)<amount)return {result:31,status:'BALANCE_NOT_ENOUGH',data:{account,balance:before}};
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
  const txId=newId(),ref=providerLedgerReference(command,transGuid,cancelGuid);
  await conn.query('UPDATE wallets SET balance=? WHERE user_id=?',[after,userId]);
  await conn.query('INSERT INTO transactions(id,user_id,type,amount,status,reference,metadata) VALUES(?,?,?,?,?,?,?)',[txId,userId,command==='cancel'?'provider_reversal':'provider_'+command,ledgerAmount,'completed',ref,JSON.stringify({provider:'goldslotpalase',transGuid,cancelGuid,gplayId:d.gplay_id??null,roundId:d.round_id??null,providerId:d.provider_id??null,gameCode:d.game_code??null})]);
  await conn.query('INSERT INTO wallet_ledger(id,user_id,transaction_id,reference,direction,amount,balance_before,balance_after,reason,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)',[newId(),userId,txId,ref,ledgerDirection,ledgerAmount,before,after,reason,JSON.stringify({provider:'goldslotpalase',transGuid,cancelGuid})]);
  const out={result:0,status:'OK',data:{account,balance:after}};
  await conn.query('INSERT INTO provider_transactions(id,provider_code,provider_transaction_id,user_id,type,amount,status,raw_json,command,trans_guid,cancel_trans_guid,account,gplay_id,round_id,provider_id,game_code,balance_after,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[newId(),'goldslotpalase',lookupId,userId,providerType,ledgerAmount,'completed',JSON.stringify(b),command,transGuid,cancelGuid||null,account,String(d.gplay_id??''),String(d.round_id??''),String(d.provider_id??''),String(d.game_code??''),after,JSON.stringify(out)]);
  await conn.query('UPDATE provider_events SET response_json=?,processing_status="completed",processed_at=NOW() WHERE provider_code="goldslotpalase" AND event_key=?',[JSON.stringify(out),eventKey]);
  return out;
 });
 return res.json(response);
}catch(e){if(e.code==='provider_callback_unauthorized')return res.status(401).json({result:1009,status:'TOKEN_INVALID'});next(e)}});

app.get('/api/backoffice-health',adminAuth,(_,res)=>ok(res,{status:'ok'}));
app.get('/api/backoffice-readiness',adminAuth,async(_,res,next)=>{try{await pingDatabase();ok(res,{ready:true,database:true,providerConfigured:provider.configured,paymentConfigured:xendit.configured,bootstrapEnabled:Boolean(config.masterBootstrapToken),configuration:[{name:'DATABASE_URL',present:true},{name:'GOLDSLOTPALASE_API_TOKEN',present:provider.configured},{name:'GOLDSLOTPALASE_CALLBACK_TOKEN',present:Boolean(config.providerCallbackToken)},{name:'PAYMENT_API_BASE',present:Boolean(config.paymentBaseUrl)},{name:'PAYMENT_API_KEY',present:Boolean(config.paymentApiKey)}]})}catch(e){next(e)}});
app.get('/api/backoffice-dashboard',adminAuth,async(req,res,next)=>{try{
 const range=String(req.query?.range||'7d'),days=range==='1d'?1:range==='30d'?30:7;
 const [[m],[d],[w],[wd],[pd],[pw],[pr],[ph]] = await Promise.all([
  pool.query('SELECT COUNT(*) count FROM users WHERE role="member"'),
  pool.query('SELECT COALESCE(SUM(amount),0) amount FROM deposits WHERE status="completed" AND created_at>=CURRENT_DATE'),
  pool.query('SELECT COALESCE(SUM(balance),0) balance FROM wallets'),
  pool.query('SELECT COALESCE(SUM(amount),0) amount FROM withdrawals WHERE status="completed" AND created_at>=CURRENT_DATE'),
  pool.query('SELECT COUNT(*) count FROM deposits WHERE status="pending"'),
  pool.query('SELECT COUNT(*) count FROM withdrawals WHERE status IN ("pending","processing","pending_compliance")'),
  pool.query('SELECT COUNT(*) count FROM provider_transactions WHERE status="pending"'),
  pool.query('SELECT COUNT(*) count FROM games WHERE is_active=1')
 ]);
 const [trend]=await pool.query('SELECT DATE(created_at) day,COALESCE(SUM(CASE WHEN type IN ("payment_deposit","deposit") THEN amount ELSE 0 END),0) deposits,COALESCE(SUM(CASE WHEN type IN ("payment_withdrawal","withdrawal") THEN amount ELSE 0 END),0) withdrawals FROM transactions WHERE created_at>=CURRENT_DATE-INTERVAL ? DAY GROUP BY DATE(created_at) ORDER BY day',[days-1]);
 ok(res,{members:Number(m[0].count),depositToday:Number(d[0].amount),withdrawToday:Number(wd[0].amount),walletTotal:Number(w[0].balance),depositTotal:Number(d[0].amount),withdrawalTotal:Number(wd[0].amount),activeGames:Number(ph[0].count),providerHealth:provider.configured?'ready':'unconfigured',pendingDeposits:Number(pd[0].count),pendingWithdrawals:Number(pw[0].count),pendingReconciliation:Number(pr[0].count),transactionTrend:trend.map(x=>({date:x.day,deposits:Number(x.deposits),withdrawals:Number(x.withdrawals)})),memberTrend:'LIVE',depositTrend:'LIVE',withdrawTrend:'LIVE',activity:[],provider:{configured:provider.configured}});
}catch(e){next(e)}});
app.get('/api/backoffice-members',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT u.id,u.username,u.email,u.display_name displayName,u.phone,u.status,u.role,u.referral_code referralCode,u.created_at createdAt,u.last_login_at lastLoginAt,w.balance,w.locked FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE u.role="member" ORDER BY u.created_at DESC LIMIT 500');ok(res,{members:r,items:r})}catch(e){next(e)}});
app.get('/api/backoffice-finance',adminAuth,async(req,res,next)=>{try{
 const [d]=await pool.query('SELECT d.id,d.user_id userId,u.username member,d.amount,d.status,d.gateway channel,d.gateway_reference gatewayReference,d.gateway_reference reference,d.created_at createdAt FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 200');
 const [w]=await pool.query('SELECT w.id,w.user_id userId,u.username member,w.amount,w.status,w.bank_account_id bankAccountId,w.gateway_reference gatewayReference,CONCAT("WD-",LEFT(w.id,12)) reference,CONCAT(ba.provider," • ",RIGHT(ba.account_number,4)) destinationMasked,w.reject_reason rejectReason,w.created_at createdAt FROM withdrawals w JOIN users u ON u.id=w.user_id LEFT JOIN bank_accounts ba ON ba.id=w.bank_account_id ORDER BY w.created_at DESC LIMIT 200');
 const [[pd],[pw],[pr]] = await Promise.all([pool.query('SELECT COUNT(*) count FROM deposits WHERE status="pending"'),pool.query('SELECT COUNT(*) count FROM withdrawals WHERE status="pending"'),pool.query('SELECT COUNT(*) count FROM provider_transactions WHERE status IN ("pending","reconciled")')]);
 ok(res,{deposits:d,withdrawals:w,reconciliation:[],pendingDeposits:Number(pd[0].count),pendingWithdrawals:Number(pw[0].count),providerReconciliationPending:Number(pr[0].count),paymentOperational:xendit.configured,callbackIssues:null,note:xendit.configured?'Xendit adapter aktif; settlement tetap berbasis webhook.':'Xendit API key belum dikonfigurasi.'});
}catch(e){next(e)}});
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
 if(b.action==='update'){
  const x=b.settings||{};
  const display={revision:Number(b.expectedRevision||0),popularOrder:Array.isArray(x.popular)?x.popular:[],newestOrder:Array.isArray(x.newest)?x.newest:[],pinnedOrder:Array.isArray(x.pinned)?x.pinned:[],hiddenGames:Array.isArray(x.hiddenGames)?x.hiddenGames:[],providerOrder:Array.isArray(x.providerOrder)?x.providerOrder:[],hiddenProviders:Array.isArray(x.hiddenProviders)?x.hiddenProviders:[]};
  b.action='save-display'; b.display=display;
 }
 if(b.action==='save-display'){
  const display=b.display||{},revision=Number(display.revision||0)+1;display.revision=revision;
  await withTransaction(async conn=>{
   await conn.query('INSERT INTO system_settings(setting_key,value_json,updated_by) VALUES("game_display",?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json),updated_by=VALUES(updated_by)',[JSON.stringify(display),req.user.id]);
   const upsert=async(gameId,section,order,visible)=>conn.query('INSERT INTO game_display_settings(id,game_id,section,display_order,is_visible,updated_by) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE display_order=VALUES(display_order),is_visible=VALUES(is_visible),updated_by=VALUES(updated_by)',[newId(),String(gameId),section,Number(order||0),visible!==false,req.user.id]);
   const popular=Array.isArray(display.popularOrder)?display.popularOrder:[], newest=Array.isArray(display.newestOrder)?display.newestOrder:[], hidden=new Set(Array.isArray(display.hiddenGames)?display.hiddenGames.map(String):[]), pinned=Array.isArray(display.pinnedOrder)?display.pinnedOrder:[];
   for(let i=0;i<popular.length;i++)await upsert(popular[i],'popular',i,true);
   for(let i=0;i<newest.length;i++)await upsert(newest[i],'terbaru',i,true);
   for(let i=0;i<pinned.length;i++)await upsert(pinned[i],'all',i,true);
   for(const gameId of hidden)await upsert(gameId,'all',0,false);
   const providerOrder=Array.isArray(display.providerOrder)?display.providerOrder:[];
   for(let i=0;i<providerOrder.length;i++)await conn.query('INSERT INTO provider_display_settings(id,provider_id,display_order,is_visible,updated_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE display_order=VALUES(display_order),is_visible=VALUES(is_visible),updated_by=VALUES(updated_by)',[newId(),String(providerOrder[i]),i,true,req.user.id]);
  });
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
 const isXendit=providerName==='xendit';
 ok(res,{id,saved:true,operational:isXendit&&xendit.configured,status:isXendit&&xendit.configured?'READY':'GATED',message:isXendit&&xendit.configured?'Xendit adapter aktif dari server environment.':'Credential tersimpan; adapter belum aktif sampai provider dikonfigurasi dan diverifikasi di server.'});
}catch(e){next(e)}});
app.get('/api/backoffice-payment-connections',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT id,name,provider,mode,is_active isActive,created_at createdAt FROM payment_connections ORDER BY created_at DESC');ok(res,{items:r,connections:r,configured:xendit.configured,vaultConfigured:Boolean(config.paymentVaultKey)})}catch(e){next(e)}});
app.get('/api/backoffice-promotions',adminAuth,async(req,res,next)=>{try{
 const [r]=await pool.query('SELECT p.*,pc.slug,pc.extra_config content_config FROM promotions p LEFT JOIN promotions_content pc ON pc.id=p.id ORDER BY p.sort_order,p.id');
 const items=r.map(x=>{let e={};try{e=x.content_config?JSON.parse(x.content_config):{}}catch{};return {...x,revision:Number(e.revision||0),category:e.category||'general',badge:e.badge||'',summary:e.summary||x.description||'',active:Boolean(x.is_active),imageUrl:x.image_url||'',sortOrder:Number(x.sort_order||0),ctaLabel:e.ctaLabel||'Lanjutkan',ctaRoute:e.ctaRoute||'route-home',detailIntro:e.detailIntro||'',sections:Array.isArray(e.sections)?e.sections:[]}});
 ok(res,{items,promotions:items})
}catch(e){next(e)}});
app.post('/api/backoffice-promotions',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const b=req.body||{},action=String(b.action||'upsert'),p=b.promotion&&typeof b.promotion==='object'?b.promotion:b,id=String(p.id||b.id||newId());
 if(action==='delete'){
  await withTransaction(async conn=>{await conn.query('DELETE FROM promotions_content WHERE id=?',[id]);await conn.query('DELETE FROM promotions WHERE id=?',[id])});
  await audit(req,'promotion.delete','promotion',id);return ok(res,{deleted:true,id})
 }
 if(!String(p.title||'').trim())return fail(res,400,'promotion_title_required');
 const [[old]]=await pool.query('SELECT extra_config FROM promotions_content WHERE id=?',[id]);let oldExtra={};try{oldExtra=old?.extra_config?JSON.parse(old.extra_config):{}}catch{}
 const revision=Number(oldExtra.revision||0)+1;
 const extra={...oldExtra,revision,category:String(p.category||oldExtra.category||'general'),badge:String(p.badge||oldExtra.badge||''),summary:String(p.summary??p.description??oldExtra.summary??''),ctaLabel:String(p.ctaLabel||oldExtra.ctaLabel||'Lanjutkan'),ctaRoute:String(p.ctaRoute||oldExtra.ctaRoute||'route-home'),detailIntro:String(p.detailIntro||oldExtra.detailIntro||''),sections:Array.isArray(p.sections)?p.sections:(Array.isArray(oldExtra.sections)?oldExtra.sections:[])};
 const active=p.active!==undefined?Boolean(p.active):p.isActive!==false,sortOrder=Number(p.sortOrder??oldExtra.sortOrder??100);
 await withTransaction(async conn=>{
  await conn.query('INSERT INTO promotions(id,title,description,image_url,start_at,end_at,is_active,sort_order) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),description=VALUES(description),image_url=VALUES(image_url),start_at=VALUES(start_at),end_at=VALUES(end_at),is_active=VALUES(is_active),sort_order=VALUES(sort_order)',[id,String(p.title).trim(),p.summary||p.description||null,p.imageUrl||null,p.startAt||null,p.endAt||null,active,sortOrder]);
  const slug=String(p.slug||String(p.title).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')).slice(0,190);
  await conn.query('INSERT INTO promotions_content(id,title,slug,description,image_url,start_at,end_at,is_active,display_order,extra_config,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),slug=VALUES(slug),description=VALUES(description),image_url=VALUES(image_url),start_at=VALUES(start_at),end_at=VALUES(end_at),is_active=VALUES(is_active),display_order=VALUES(display_order),extra_config=VALUES(extra_config),updated_by=VALUES(updated_by)',[id,String(p.title).trim(),slug,p.summary||p.description||null,p.imageUrl||null,p.startAt||null,p.endAt||null,active,sortOrder,JSON.stringify(extra),req.user.id,req.user.id]);
 });
 await audit(req,'promotion.upsert','promotion',id,{revision});ok(res,{id,saved:true,revision,promotion:{id,revision,active,sortOrder,...extra}})
}catch(e){next(e)}});
app.get('/api/backoffice-rewards',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT c.user_id userId,u.username,c.balance FROM cashback_accounts c JOIN users u ON u.id=c.user_id ORDER BY c.balance DESC LIMIT 500');ok(res,{items:r,settlement:{status:'GATED',reason:'reward_payout_disabled'}})}catch(e){next(e)}});
app.post('/api/backoffice-rewards',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const action=String(req.body?.action||'').trim();
 if(action==='issue-referral-code'){
  const targetUid=String(req.body?.targetUid||'').trim();if(!targetUid)return fail(res,400,'target_uid_required');
  const [u]=await pool.query('SELECT id,username,referral_code FROM users WHERE id=? AND role="member" LIMIT 1',[targetUid]);if(!u[0])return fail(res,404,'member_not_found');
  let code=String(req.body?.code||u[0].referral_code||'').trim().toUpperCase();
  if(!code) code='REF-'+crypto.randomBytes(4).toString('hex').toUpperCase();
  if(!/^[A-Z0-9_-]{4,32}$/.test(code))return fail(res,400,'invalid_referral_code');
  const [dupe]=await pool.query('SELECT id FROM users WHERE referral_code=? AND id<>? LIMIT 1',[code,targetUid]);if(dupe[0])return fail(res,409,'referral_code_exists');
  await pool.query('UPDATE users SET referral_code=? WHERE id=?',[code,targetUid]);
  await audit(req,'reward.referral_code.issue','user',targetUid,{code});
  return ok(res,{referral:{code,promoterUid:targetUid}});
 }
 if(action==='finalize-week') return fail(res,503,'reward_payout_disabled');
 return fail(res,400,'unknown_reward_action');
}catch(e){next(e)}});
app.get('/api/backoffice-reports',adminAuth,async(req,res,next)=>{try{const [[m],[d],[w],[g]] = await Promise.all([pool.query('SELECT COUNT(*) count FROM users WHERE role="member"'),pool.query('SELECT COALESCE(SUM(amount),0) amount FROM deposits WHERE status="completed"'),pool.query('SELECT COALESCE(SUM(amount),0) amount FROM withdrawals WHERE status="completed"'),pool.query('SELECT COUNT(*) count FROM games')]);ok(res,{members:m[0].count,deposits:d[0].amount,withdrawals:w[0].amount,games:g[0].count})}catch(e){next(e)}});
app.post('/api/backoffice-reports',adminAuth,role('operator','finance','admin','superadmin'),async(req,res,next)=>{try{
 const type=String(req.body?.type||'summary').toLowerCase();
 const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
 let header=[],rows=[];
 if(type==='finance'||type==='summary'){
  header=['createdAt','reference','member','type','amount','status'];
  const [r]=await pool.query('SELECT t.created_at createdAt,t.reference,u.username,t.type,t.amount,t.status FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 5000');
  rows=r.map(x=>[x.createdAt,x.reference,x.username,x.type,x.amount,x.status]);
 }else if(type==='game'){
  header=['provider','gameCode','name','category','active','popular','new'];
  const [r]=await pool.query('SELECT provider_code provider,game_code gameCode,name,category,is_active active,is_popular popular,is_new isNew FROM games ORDER BY provider_code,sort_order,id LIMIT 5000');
  rows=r.map(x=>[x.provider,x.gameCode,x.name,x.category,x.active,x.popular,x.isNew]);
 }else if(type==='member'){
  header=['username','email','status','balance','createdAt'];
  const [r]=await pool.query('SELECT u.username,u.email,u.status,w.balance,u.created_at createdAt FROM users u LEFT JOIN wallets w ON w.user_id=u.id WHERE u.role="member" ORDER BY u.created_at DESC LIMIT 5000');
  rows=r.map(x=>[x.username,x.email,x.status,x.balance,x.createdAt]);
 }else return fail(res,400,'unsupported_report_type');
 const csv=[header.map(esc).join(','),...rows.map(row=>row.map(esc).join(','))].join('\\n')+'\\n';
 const filename='brandalbet-'+type+'-'+new Date().toISOString().slice(0,10)+'.csv';
 await audit(req,'report.export','report',type,{rows:rows.length});
 ok(res,{filename,mimeType:'text/csv;charset=utf-8',contentBase64:Buffer.from(csv,'utf8').toString('base64'),rowCount:rows.length,type})
}catch(e){next(e)}});
app.get('/api/backoffice-audit',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT a.*,u.username actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT 200');ok(res,{items:r,audit:r})}catch(e){next(e)}});
app.get('/api/backoffice-website-settings',adminAuth,async(req,res,next)=>{try{
 const [r]=await pool.query('SELECT setting_key,value_json FROM system_settings');const settings={};
 for(const x of r)settings[x.setting_key]=parseJson(x.value_json,{});
 const flat={...settings.general,...settings.website,...settings.banner,...settings.loading,...settings.seo};
 const [[site]]=await pool.query('SELECT site_name siteName,seo_title seoTitle,seo_description seoDescription,logo_url logoUrl,favicon_url faviconUrl,primary_color primaryColor,secondary_color secondaryColor,maintenance_mode maintenanceMode,registration_enabled registrationEnabled,game_launch_enabled gameLaunchEnabled,wallet_enabled walletEnabled FROM website_settings WHERE id=1');
 ok(res,{settings:{...flat,...site}});
}catch(e){next(e)}});
app.post('/api/backoffice-website-settings',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const section=req.body?.section||'general',settings=req.body?.settings||{};
 await pool.query('INSERT INTO system_settings(setting_key,value_json,updated_by) VALUES(?,?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json),updated_by=VALUES(updated_by)',[section,JSON.stringify(settings),req.user.id]);
 // Keep the legacy endpoint compatible while mirroring recognized website controls into the normalized store.
 const s=settings||{};
 if(section==='general'||section==='website'){
  await pool.query('UPDATE website_settings SET site_name=COALESCE(?,site_name),logo_url=COALESCE(?,logo_url),favicon_url=COALESCE(?,favicon_url),primary_color=COALESCE(?,primary_color),secondary_color=COALESCE(?,secondary_color),seo_title=COALESCE(?,seo_title),seo_description=COALESCE(?,seo_description),hero_config=COALESCE(?,hero_config),navigation_config=COALESCE(?,navigation_config),footer_config=COALESCE(?,footer_config),extra_config=COALESCE(?,extra_config),updated_by=? WHERE id=1',[s.siteName??s.site_name??null,s.logoUrl??s.logo_url??null,s.faviconUrl??s.favicon_url??null,s.primaryColor??s.primary_color??null,s.secondaryColor??s.secondary_color??null,s.seoTitle??s.seo_title??null,s.seoDescription??s.seo_description??null,s.heroConfig?JSON.stringify(s.heroConfig):null,s.navigationConfig?JSON.stringify(s.navigationConfig):null,s.footerConfig?JSON.stringify(s.footerConfig):null,s.extraConfig?JSON.stringify(s.extraConfig):null,req.user.id]);
 }
 if(section==='maintenance'&&s.maintenanceMode!==undefined)await pool.query('UPDATE website_settings SET maintenance_mode=?,updated_by=? WHERE id=1',[Boolean(s.maintenanceMode),req.user.id]);
 if(section==='registration'&&s.registrationEnabled!==undefined)await pool.query('UPDATE website_settings SET registration_enabled=?,updated_by=? WHERE id=1',[Boolean(s.registrationEnabled),req.user.id]);
 if(section==='games'&&s.gameLaunchEnabled!==undefined)await pool.query('UPDATE website_settings SET game_launch_enabled=?,updated_by=? WHERE id=1',[Boolean(s.gameLaunchEnabled),req.user.id]);
 if(section==='wallet'&&s.walletEnabled!==undefined)await pool.query('UPDATE website_settings SET wallet_enabled=?,updated_by=? WHERE id=1',[Boolean(s.walletEnabled),req.user.id]);
 await audit(req,'website.settings.update','settings',section,{settings:Object.keys(settings)});ok(res,{saved:true})
}catch(e){next(e)}});
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


// Persistent configuration APIs. These are additive and keep legacy system_settings responses compatible.
const parseJson=(v,fallback={})=>{try{return v==null?fallback:(typeof v==='string'?JSON.parse(v):v)}catch{return fallback}};
const upsertSingleton=async(table,fields,userId)=>{
 const cols=Object.keys(fields),vals=Object.values(fields),sets=cols.map(k=>`${k}=VALUES(${k})`).join(',');
 await pool.query(`INSERT INTO ${table}(id,${cols.join(',')},updated_by) VALUES(1,${cols.map(()=>'?').join(',')},?) ON DUPLICATE KEY UPDATE ${sets},updated_by=VALUES(updated_by)`,[...vals,userId]);
};

app.get('/api/backoffice-settings',adminAuth,async(req,res,next)=>{try{
 const [[site]]=await pool.query('SELECT * FROM website_settings WHERE id=1');
 const [[pay]]=await pool.query('SELECT * FROM payment_settings WHERE id=1');
 const [[reward]]=await pool.query('SELECT * FROM reward_settings WHERE id=1');
 const [providers]=await pool.query('SELECT p.*,d.display_order displayOrder,d.is_visible displayVisible,d.extra_config displayConfig FROM providers p LEFT JOIN provider_display_settings d ON d.provider_id=p.id ORDER BY COALESCE(d.display_order,999999),p.code,p.id');
 ok(res,{website:{...site,heroConfig:parseJson(site?.hero_config),navigationConfig:parseJson(site?.navigation_config),footerConfig:parseJson(site?.footer_config),extraConfig:parseJson(site?.extra_config)},payment:{...pay,channels:parseJson(pay?.channels,[])},rewards:{...reward,rules:parseJson(reward?.rules),extraConfig:parseJson(reward?.extra_config)},providers});
}catch(e){next(e)}});

app.post('/api/backoffice-settings',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const b=req.body||{};
 await withTransaction(async conn=>{
   const q=async(sql,args)=>conn.query(sql,args);
   if(b.website){const x=b.website;await q('UPDATE website_settings SET site_name=?,logo_url=?,favicon_url=?,primary_color=?,secondary_color=?,maintenance_mode=?,registration_enabled=?,game_launch_enabled=?,wallet_enabled=?,seo_title=?,seo_description=?,hero_config=?,navigation_config=?,footer_config=?,extra_config=?,updated_by=? WHERE id=1',[x.siteName??'BrandalBet',x.logoUrl??null,x.faviconUrl??null,x.primaryColor??null,x.secondaryColor??null,Boolean(x.maintenanceMode),x.registrationEnabled!==false,x.gameLaunchEnabled!==false,x.walletEnabled!==false,x.seoTitle??null,x.seoDescription??null,JSON.stringify(x.heroConfig??{}),JSON.stringify(x.navigationConfig??{}),JSON.stringify(x.footerConfig??{}),JSON.stringify(x.extraConfig??{}),req.user.id])}
   if(b.payment){const x=b.payment;await q('UPDATE payment_settings SET deposit_enabled=?,withdrawal_enabled=?,min_deposit=?,max_deposit=?,min_withdrawal=?,max_withdrawal=?,deposit_fee=?,withdrawal_fee=?,channels=?,extra_config=?,updated_by=? WHERE id=1',[x.depositEnabled!==false,x.withdrawalEnabled!==false,Number(x.minDeposit??config.minDeposit),x.maxDeposit==null?null:Number(x.maxDeposit),Number(x.minWithdrawal??config.minWithdrawal),x.maxWithdrawal==null?null:Number(x.maxWithdrawal),Number(x.depositFee||0),Number(x.withdrawalFee||0),JSON.stringify(x.channels??[]),JSON.stringify(x.extraConfig??{}),req.user.id])}
   if(b.rewards){const x=b.rewards;await q('UPDATE reward_settings SET cashback_enabled=?,referral_enabled=?,rules=?,extra_config=?,updated_by=? WHERE id=1', [Boolean(x.cashbackEnabled),Boolean(x.referralEnabled),JSON.stringify(x.rules??{}),JSON.stringify(x.extraConfig??{}),req.user.id])}
 });
 await audit(req,'settings.update','system','configuration',{sections:Object.keys(b)});
 ok(res,{saved:true});
}catch(e){next(e)}});

app.get('/api/backoffice-game-display',adminAuth,async(req,res,next)=>{try{
 const [games]=await pool.query('SELECT g.*,d.section,d.display_order displayOrder,d.is_visible displayVisible,d.custom_title customTitle,d.custom_image_url customImageUrl,d.extra_config displayConfig FROM games g LEFT JOIN game_display_settings d ON d.game_id=g.id ORDER BY COALESCE(d.display_order,999999),g.provider_code,g.sort_order,g.id');
 const [providers]=await pool.query('SELECT p.*,d.display_order displayOrder,d.is_visible displayVisible,d.extra_config displayConfig FROM providers p LEFT JOIN provider_display_settings d ON d.provider_id=p.id ORDER BY COALESCE(d.display_order,999999),p.code,p.id');
 ok(res,{games,providers});
}catch(e){next(e)}});

app.post('/api/backoffice-game-display',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const b=req.body||{};await withTransaction(async conn=>{
   if(Array.isArray(b.games)) for(const x of b.games){if(!x.gameId)continue;await conn.query('INSERT INTO game_display_settings(id,game_id,section,display_order,is_visible,custom_title,custom_image_url,extra_config,updated_by) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE display_order=VALUES(display_order),is_visible=VALUES(is_visible),custom_title=VALUES(custom_title),custom_image_url=VALUES(custom_image_url),extra_config=VALUES(extra_config),updated_by=VALUES(updated_by)',[newId(),x.gameId,x.section||'all',Number(x.displayOrder||0),x.isVisible!==false,x.customTitle||null,x.customImageUrl||null,JSON.stringify(x.extraConfig||{}),req.user.id])}
   if(Array.isArray(b.providers)) for(const x of b.providers){if(!x.providerId)continue;await conn.query('INSERT INTO provider_display_settings(id,provider_id,display_order,is_visible,extra_config,updated_by) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE display_order=VALUES(display_order),is_visible=VALUES(is_visible),extra_config=VALUES(extra_config),updated_by=VALUES(updated_by)',[newId(),x.providerId,Number(x.displayOrder||0),x.isVisible!==false,JSON.stringify(x.extraConfig||{}),req.user.id])}
 });await audit(req,'catalog.display.update','system','game_display',{games:Array.isArray(b.games)?b.games.length:0,providers:Array.isArray(b.providers)?b.providers.length:0});ok(res,{saved:true});
}catch(e){next(e)}});

app.get('/api/backoffice-promotions-content',adminAuth,async(req,res,next)=>{try{const [items]=await pool.query('SELECT * FROM promotions_content ORDER BY display_order,id');ok(res,{items})}catch(e){next(e)}});
app.post('/api/backoffice-promotions-content',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{
 const b=req.body||{},id=b.id||newId(),title=String(b.title||'').trim(),slug=String(b.slug||title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')).slice(0,190);
 if(!title||!slug)return fail(res,400,'promotion_title_required');
 await withTransaction(async conn=>{
  await conn.query('INSERT INTO promotions_content(id,title,slug,description,image_url,start_at,end_at,is_active,display_order,extra_config,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),slug=VALUES(slug),description=VALUES(description),image_url=VALUES(image_url),start_at=VALUES(start_at),end_at=VALUES(end_at),is_active=VALUES(is_active),display_order=VALUES(display_order),extra_config=VALUES(extra_config),updated_by=VALUES(updated_by)',[id,title,slug,b.description||null,b.imageUrl||null,b.startAt||null,b.endAt||null,b.isActive!==false,Number(b.displayOrder||0),JSON.stringify(b.extraConfig||{}),req.user.id,req.user.id]);
  await conn.query('INSERT INTO promotions(id,title,description,image_url,start_at,end_at,is_active,sort_order) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),description=VALUES(description),image_url=VALUES(image_url),start_at=VALUES(start_at),end_at=VALUES(end_at),is_active=VALUES(is_active),sort_order=VALUES(sort_order)',[id,title,b.description||null,b.imageUrl||null,b.startAt||null,b.endAt||null,b.isActive!==false,Number(b.displayOrder||0)]);
 });
 await audit(req,'promotion.content.upsert','promotion',id,{title});ok(res,{id,saved:true})
}catch(e){next(e)}});

app.get('/api/backoffice-permissions',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{const [items]=await pool.query('SELECT * FROM admin_permissions ORDER BY role,permission_key');ok(res,{items})}catch(e){next(e)}});
app.post('/api/backoffice-permissions',adminAuth,role('superadmin'),async(req,res,next)=>{try{const b=req.body||{};if(!b.role||!b.permissionKey)return fail(res,400,'permission_required');await pool.query('INSERT INTO admin_permissions(id,role,permission_key,allowed,updated_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE allowed=VALUES(allowed),updated_by=VALUES(updated_by)',[newId(),String(b.role),String(b.permissionKey),b.allowed!==false,req.user.id]);await audit(req,'permission.update','role',String(b.role),{permissionKey:b.permissionKey,allowed:b.allowed!==false});ok(res,{saved:true})}catch(e){next(e)}});

app.use(notFound);app.use(errorHandler);
const server=app.listen(config.port,()=>console.log('BrandalBet V2 listening on '+config.port));
async function shutdown(signal){console.log('Received '+signal);server.close(async()=>{try{await closeDatabase();process.exit(0)}catch{process.exit(1)}});setTimeout(()=>process.exit(1),10000).unref()}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));