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
app.get('/api/member-profile',memberAuth,(req,res,next)=>next());
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
 if(!providerUser){const created=await provider.createUser(req.user.username);providerUser=String(created?.data?.user_code??created?.user_code??'');if(!providerUser)throw Object.assign(new Error('provider_user_create_invalid'),{code:'provider_invalid_response',status:502});await pool.query('INSERT INTO provider_users(id,user_id,provider_code,provider_user_code) VALUES(?,?,?,?,?)'.replace('?,?,?,?,?','?,?,?,?'),[newId(),req.user.id,'goldslotpalase',providerUser])}
 const launched=await provider.launch({user_code:Number(providerUser),provider_id:Number(providerId),game_symbol:symbol,lang:9,return_url:req.body.returnUrl||undefined});
 const launchUrl=launched?.data?.game_url??launched?.data?.url??launched?.game_url??launched?.url;
 if(typeof launchUrl!=='string'||!/^https:\/\//i.test(launchUrl))return fail(res,502,'provider_invalid_launch_url');
 let exp=new Date(Date.now()+10*60*1000);await pool.query('INSERT INTO game_launches(id,user_id,game_id,provider,request_id,status,launch_url,expires_at) VALUES(?,?,?,?,?,?,?,?)',[newId(),req.user.id,games[0].id,'goldslotpalase',requestId,'issued',launchUrl,exp]);
 await audit(req,'game.launch','game',games[0].id,{providerId,gameSymbol});ok(res,{game:{launchUrl,expiresAt:exp.toISOString(),gameId:games[0].id}});
}catch(e){next(e)}});

app.post('/api/payment-deposit',memberAuth,async(req,res,next)=>{try{
 if(!config.paymentBaseUrl||!config.paymentApiKey)return fail(res,503,'payment_adapter_unavailable');
 const amount=money(req.body?.amountRupiah);if(amount<config.minDeposit)return fail(res,400,'minimum_deposit');
 const reference='DEP-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(4).toString('hex').toUpperCase();
 const id=newId();await pool.query('INSERT INTO deposits(id,user_id,amount,status,gateway) VALUES(?,?,?,?,?)',[id,req.user.id,amount,'pending',config.paymentProvider||'configured']);
 await pool.query('INSERT INTO payment_orders(id,user_id,reference,amount,channel,status) VALUES(?,?,?,?,?,?)',[newId(),req.user.id,reference,amount,String(req.body?.channel||'QRIS'),'pending']);
 return fail(res,503,'payment_adapter_not_implemented',{reference});
}catch(e){next(e)}});

app.post('/api/payment-withdraw',memberAuth,async(req,res,next)=>{try{
 const amount=money(req.body?.amountRupiah);if(amount<config.minWithdrawal)return fail(res,400,'minimum_withdrawal');
 const [banks]=await pool.query('SELECT id FROM bank_accounts WHERE user_id=? ORDER BY created_at DESC LIMIT 1',[req.user.id]);if(!banks[0])return fail(res,400,'bank_account_required');
 const id=newId(),ref='WD-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(4).toString('hex').toUpperCase();
 await withTransaction(async c=>{const [[w]]=await c.query('SELECT balance,locked FROM wallets WHERE user_id=? FOR UPDATE',[req.user.id]);if(!w||w.locked)throw Object.assign(new Error('wallet_locked'),{code:'wallet_locked',status:409});if(Number(w.balance)<amount)throw Object.assign(new Error('insufficient_balance'),{code:'insufficient_balance',status:409});await c.query('UPDATE wallets SET balance=balance-? WHERE user_id=?',[amount,req.user.id]);await c.query('INSERT INTO withdrawals(id,user_id,amount,status,bank_account_id,gateway_reference) VALUES(?,?,?,?,?,?)',[id,req.user.id,amount,'pending',banks[0].id,ref]);await c.query('INSERT INTO transactions(id,user_id,type,amount,status,reference,metadata) VALUES(?,?,?,?,?,?,?)',[newId(),req.user.id,'withdrawal_hold',amount,'pending',ref,JSON.stringify({withdrawalId:id})])});
 await audit(req,'withdrawal.create','withdrawal',id,{amount,reference:ref});
 if(!config.paymentBaseUrl)return ok(res,{withdraw:{id,reference:ref,status:'pending'}});
 return ok(res,{withdraw:{id,reference:ref,status:'pending'}});
}catch(e){next(e)}});

app.post('/webhooks/v1/payments/:provider',async(req,res,next)=>{try{
 if(!config.paymentWebhookSecret)return fail(res,503,'payment_webhook_unconfigured');
 const supplied=String(req.get('X-Webhook-Secret')||req.get('X-Signature')||'');if(supplied!==config.paymentWebhookSecret)return fail(res,401,'webhook_unauthorized');
 const b=req.body||{},eventKey=String(b.eventId||b.id||b.reference||'');if(!eventKey)return fail(res,400,'webhook_event_required');
 const [exists]=await pool.query('SELECT id,processed_at FROM webhook_events WHERE source=? AND event_key=?',[req.params.provider,eventKey]);if(exists[0])return ok(res,{received:true,idempotent:true});
 const amount=Number(b.amount??b.amountRupiah??0),reference=String(b.reference||b.orderId||b.merchantReference||'');
 await pool.query('INSERT INTO webhook_events(id,source,event_key,signature_valid,amount,payload) VALUES(?,?,?,?,?,?)',[newId(),req.params.provider,eventKey,true,amount,JSON.stringify(b)]);
 if(String(b.status||'').toLowerCase()!=='paid'&&String(b.status||'').toLowerCase()!=='success')return ok(res,{received:true});
 const [orders]=await pool.query('SELECT * FROM payment_orders WHERE reference=? FOR UPDATE',[reference]);if(!orders[0])return fail(res,404,'payment_order_not_found');
 if(Number(orders[0].amount)!==amount)return fail(res,409,'payment_amount_mismatch');
 if(orders[0].status==='paid')return ok(res,{received:true,idempotent:true});
 await creditWallet(orders[0].user_id,amount,'payment_deposit',reference,{provider:req.params.provider,eventKey});
 await pool.query('UPDATE payment_orders SET status="paid",provider_reference=? WHERE id=?',[String(b.transactionId||b.providerReference||eventKey),orders[0].id]);
 await pool.query('UPDATE deposits SET status="completed",gateway_reference=? WHERE id=?',[String(b.transactionId||b.providerReference||eventKey),orders[0].id]);
 ok(res,{received:true});
}catch(e){next(e)}});

app.post('/api/provider/callback',express.json({limit:'256kb'}),async(req,res,next)=>{try{
 verifyProviderCallback(req);const b=req.body||{},command=String(b.command||b.action||'').toLowerCase(),data=b.data||{},account=String(data.account||data.username||'');
 const eventKey=String(data.transaction_id||data.transactionId||data.id||[command,account,b.request_timestamp||''].join(':'));
 const [ev]=await pool.query('SELECT id,processed_at FROM provider_events WHERE provider_code="goldslotpalase" AND event_key=?',[eventKey]);if(ev[0]?.processed_at)return res.json({result:0,status:'OK',data:{balance:0}});
 if(!ev[0])await pool.query('INSERT INTO provider_events(id,provider_code,event_key,command,raw_json) VALUES(?,?,?,?,?)',[newId(),'goldslotpalase',eventKey,command,JSON.stringify(b)]);
 const [pu]=await pool.query('SELECT user_id FROM provider_users WHERE provider_code="goldslotpalase" AND provider_user_code=? LIMIT 1',[account]);if(!pu[0])return res.status(404).json({result:2002,status:'USER_NOT_FOUND'});
 const userId=pu[0].user_id;const [[w]]=await pool.query('SELECT balance FROM wallets WHERE user_id=?',[userId]);const balance=Number(w?.balance||0);
 if(command==='authenticate'||command==='balance'||command==='status')return res.json({result:0,status:'OK',data:{account,balance}});
 if(command==='bet'||command==='win'||command==='cancel'){
  const amount=money(data.amount??data.win??data.bet??0),txRef='GSP-'+eventKey;
  if(command==='bet')await debitWallet(userId,amount,'provider_bet',txRef,{providerPayload:b});
  else if(command==='win')await creditWallet(userId,amount,'provider_win',txRef,{providerPayload:b});
  else if(command==='cancel'&&amount>0)await creditWallet(userId,amount,'provider_cancel',txRef,{providerPayload:b});
  await pool.query('UPDATE provider_events SET processed_at=NOW() WHERE id=?',(ev[0]?.id||'').toString()?['UPDATE provider_events SET processed_at=NOW() WHERE id=?',[ev[0]?.id||'']]:['SELECT 1']);
  const [[nw]]=await pool.query('SELECT balance FROM wallets WHERE user_id=?',[userId]);return res.json({result:0,status:'OK',data:{account,balance:Number(nw?.balance||0)}});
 }
 return res.status(400).json({result:1012,status:'PARAMETERS_INVALID'});
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
app.get('/api/backoffice-game-catalog',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT * FROM games ORDER BY provider_code,sort_order,id');ok(res,{games:r,items:r})}catch(e){next(e)}});
app.post('/api/backoffice-game-catalog',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{const b=req.body||{},gid=b.id||newId();await pool.query('INSERT INTO games(id,provider_code,provider_id,game_code,name,category,image_url,is_active,is_popular,is_new,sort_order,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE provider_id=VALUES(provider_id),name=VALUES(name),category=VALUES(category),image_url=VALUES(image_url),is_active=VALUES(is_active),is_popular=VALUES(is_popular),is_new=VALUES(is_new),sort_order=VALUES(sort_order),metadata=VALUES(metadata)',[gid,b.providerCode||'goldslotpalase',b.providerId||null,b.gameCode,b.name,b.category||null,b.imageUrl||null,b.isActive!==false,b.isPopular===true,b.isNew===true,Number(b.sortOrder||0),JSON.stringify(b.metadata||{})]);await audit(req,'catalog.game.upsert','game',gid,{gameCode:b.gameCode});ok(res,{id:gid})}catch(e){next(e)}});
app.post('/api/backoffice-provider',adminAuth,role('admin','superadmin'),async(req,res,next)=>{try{const action=req.body?.action||'health';if(action==='health'){const info=await provider.info();return ok(res,{provider:info})}if(action==='sync'){const p=await provider.providers();const g=await provider.allGames({});let games=[];const raw=g?.data?.games||g?.games||g?.data||[];if(Array.isArray(raw))games=raw;let count=0;for(const x of games){const game=(await import('./provider.js')).normalizeProviderGame(x);if(!game)continue;await pool.query('INSERT INTO games(id,provider_code,provider_id,game_code,name,category,image_url,is_active,metadata) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE provider_id=VALUES(provider_id),name=VALUES(name),category=VALUES(category),image_url=VALUES(image_url),is_active=VALUES(is_active),metadata=VALUES(metadata)',[newId(),game.providerCode,game.providerId,game.gameCode,game.name,game.category,game.imageUrl,game.isActive,JSON.stringify(game.metadata)]);count++}await audit(req,'provider.catalog.sync','provider','goldslotpalase',{count});return ok(res,{count,provider:p})}return fail(res,400,'unknown_provider_action')}catch(e){next(e)}});
app.get('/api/backoffice-provider',adminAuth,async(req,res,next)=>{try{const info=provider.configured?await provider.info():null;ok(res,{configured:provider.configured,provider:info})}catch(e){next(e)}});
app.get('/api/backoffice-payment-connections',adminAuth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT id,name,provider,mode,is_active isActive,created_at createdAt FROM payment_connections ORDER BY created_at DESC');ok(res,{items:r,connections:r,configured:Boolean(config.paymentBaseUrl&&config.paymentApiKey)})}catch(e){next(e)}});
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