import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { config } from './config.js';
import { pool, pingDatabase, closeDatabase } from './db.js';
import { requestContext, timeout, notFound, errorHandler } from './middleware.js';
import { sendOk, sendError } from './http.js';

const app=express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.use(requestContext);
app.use(helmet({contentSecurityPolicy:false}));
const origins=config.corsOrigins;
app.use(cors({origin:(o,cb)=>!o||origins.includes(o)?cb(null,true):cb(new Error('origin_not_allowed')),credentials:true}));
app.use(timeout(config.requestTimeoutMs));
app.use(express.json({limit: config.bodyLimit, strict: true}));
const hash=t=>crypto.createHash('sha256').update(String(t)).digest('hex');
const token=()=>crypto.randomBytes(48).toString('base64url');
const ok=sendOk;
const fail=sendError;

async function auth(req,res,next){
 try{
  const h=req.get('authorization')||'';
  if(!h.startsWith('Bearer ')) return fail(res,401,'unauthorized');
  const [r]=await pool.query('SELECT u.*,s.id session_id,s.device_id FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>NOW() LIMIT 1',[hash(h.slice(7))]);
  if(!r[0]) return fail(res,401,'session_invalid');
  req.user=r[0]; next();
 }catch(e){next(e)}
}
const roles=(...allowed)=>(req,res,next)=>allowed.includes(req.user?.role)?next():fail(res,403,'forbidden');

app.get('/api/health',async(_,res)=>{try{await pingDatabase();ok(res,{service:'brandalbet-backend-v2',database:'ok',version:'2.0.0'})}catch{fail(res,503,'database_unavailable')}});
app.get('/api/me',auth,(req,res)=>ok(res,{user:{id:req.user.id,username:req.user.username,email:req.user.email,role:req.user.role,displayName:req.user.display_name}}));

app.post('/api/auth/register',async(req,res,next)=>{
 try{
  const b=req.body||{}; if(!b.username||!b.email||!b.password||String(b.password).length<8)return fail(res,400,'invalid_registration');
  const [e]=await pool.query('SELECT id FROM users WHERE username=? OR email=? LIMIT 1',[b.username,b.email]); if(e[0])return fail(res,409,'account_exists');
  const id=crypto.randomUUID(), pass=await argon2.hash(b.password), referral=crypto.randomBytes(5).toString('hex').toUpperCase();
  const c=await pool.getConnection();
  try{await c.beginTransaction();
   await c.query('INSERT INTO users(id,username,email,password_hash,display_name,phone,referral_code,referred_by) VALUES(?,?,?,?,?,?,?,?)',[id,b.username,b.email,pass,b.displayName||null,b.phone||null,referral,b.referralCode||null]);
   await c.query('INSERT INTO wallets(user_id,balance) VALUES(?,0)',[id]);
   await c.query('INSERT INTO cashback_accounts(user_id,balance) VALUES(?,0)',[id]);
   if(b.bankAccount?.provider&&b.bankAccount?.accountNumber&&b.bankAccount?.accountName)await c.query('INSERT INTO bank_accounts(id,user_id,type,provider,account_number,account_name) VALUES(?,?,?,?,?,?)',[crypto.randomUUID(),id,b.bankAccount.type||'bank',b.bankAccount.provider,b.bankAccount.accountNumber,b.bankAccount.accountName]);
   await c.commit();
  }catch(e){await c.rollback();throw e}finally{c.release()}
  return login(req,res,b.username,b.password,b.deviceId);
 }catch(e){next(e)}
});

app.post('/api/auth/login',async(req,res,next)=>{try{return login(req,res,req.body?.username,req.body?.password,req.body?.deviceId)}catch(e){next(e)}});
async function login(req,res,username,password,deviceId){
 if(!username||!password)return fail(res,400,'credentials_required');
 const [r]=await pool.query('SELECT * FROM users WHERE (username=? OR email=?) AND status="active" LIMIT 1',[username,username]);
 if(!r[0]||!(await argon2.verify(r[0].password_hash,password)))return fail(res,401,'invalid_credentials');
 const c=await pool.getConnection(); const t=token(); const sid=crypto.randomUUID(); const exp=new Date(Date.now()+Number(config.sessionTtlDays||30)*86400000);
 try{await c.beginTransaction();
  await c.query('UPDATE user_sessions SET revoked_at=NOW() WHERE user_id=? AND session_type=? AND revoked_at IS NULL',[r[0].id,r[0].role==='member'?'member':'backoffice']);
  await c.query('INSERT INTO user_sessions(id,user_id,token_hash,device_id,session_type,ip,user_agent,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',[sid,r[0].id,hash(t),deviceId||null,r[0].role==='member'?'member':'backoffice',req.ip,req.get('user-agent')||null,exp]);
  await c.query('UPDATE users SET last_login_at=NOW() WHERE id=?',[r[0].id]); await c.commit();
 }catch(e){await c.rollback();throw e}finally{c.release()}
 return ok(res,{token:t,expiresAt:exp.toISOString(),user:{id:r[0].id,username:r[0].username,email:r[0].email,role:r[0].role,displayName:r[0].display_name}});
}
app.post('/api/auth/logout',auth,async(req,res)=>{await pool.query('UPDATE user_sessions SET revoked_at=NOW() WHERE id=?',[req.user.session_id]);ok(res,{loggedOut:true})});
app.post('/api/auth/refresh',auth,(req,res)=>ok(res,{sessionValid:true}));

app.get('/api/member/profile',auth,(req,res)=>ok(res,{profile:{id:req.user.id,username:req.user.username,email:req.user.email,displayName:req.user.display_name,phone:req.user.phone,role:req.user.role,referralCode:req.user.referral_code}}));
app.get('/api/member/bank-account',auth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT type,provider,account_number accountNumber,account_name accountName FROM bank_accounts WHERE user_id=? ORDER BY created_at DESC LIMIT 1',[req.user.id]);ok(res,{bankAccount:r[0]||null})}catch(e){next(e)}});
app.put('/api/member/bank-account',auth,async(req,res,next)=>{try{const b=req.body||{};if(!b.provider||!b.accountNumber||!b.accountName)return fail(res,400,'invalid_bank_account');await pool.query('INSERT INTO bank_accounts(id,user_id,type,provider,account_number,account_name) VALUES(?,?,?,?,?,?)',[crypto.randomUUID(),req.user.id,b.type||'bank',b.provider,b.accountNumber,b.accountName]);ok(res,{saved:true})}catch(e){next(e)}});

app.get('/api/wallet',auth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT balance FROM wallets WHERE user_id=?',[req.user.id]);ok(res,{balance:r[0]?.balance||0})}catch(e){next(e)}});
app.get('/api/transactions',auth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT id,type,amount,status,reference,created_at FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 200',[req.user.id]);ok(res,{transactions:r})}catch(e){next(e)}});
app.get('/api/member-rewards',auth,async(req,res,next)=>{try{const [r]=await pool.query('SELECT balance FROM cashback_accounts WHERE user_id=?',[req.user.id]);const [h]=await pool.query('SELECT id,amount,type,status,reference,created_at FROM cashback_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 200',[req.user.id]);ok(res,{balance:r[0]?.balance||0,history:h})}catch(e){next(e)}});

app.get('/api/games',async(_,res,next)=>{try{const [r]=await pool.query('SELECT id,provider_code providerCode,game_code gameCode,name,category,image_url imageUrl,is_active isActive,is_popular isPopular,is_new isNew,sort_order sortOrder FROM games WHERE is_active=1 ORDER BY sort_order,id');ok(res,{games:r})}catch(e){next(e)}});
app.get('/api/member-config',async(_,res)=>ok(res,{minimumDeposit:20000,minimumWithdrawal:50000}));
app.get('/api/promotions',async(_,res,next)=>{try{const [r]=await pool.query('SELECT id,title,description,image_url imageUrl,start_at startAt,end_at endAt FROM promotions WHERE is_active=1 ORDER BY sort_order,id');ok(res,{promotions:r})}catch(e){next(e)}});

app.get('/api/backoffice-health',auth,roles('operator','finance','admin','superadmin'),(_,res)=>ok(res,{status:'ok'}));
app.get('/api/backoffice-dashboard',auth,roles('operator','finance','admin','superadmin'),async(_,res,next)=>{try{const [[m],[d],[w]]=await Promise.all([pool.query('SELECT COUNT(*) count FROM users WHERE role="member"'),pool.query('SELECT COALESCE(SUM(amount),0) amount FROM deposits WHERE status="completed"'),pool.query('SELECT COALESCE(SUM(balance),0) balance FROM wallets')]);ok(res,{members:m[0].count,depositTotal:d[0].amount,walletTotal:w[0].balance})}catch(e){next(e)}});
app.get('/api/backoffice-members',auth,roles('operator','admin','superadmin'),async(_,res,next)=>{try{const [r]=await pool.query('SELECT id,username,email,display_name displayName,phone,status,role,referral_code referralCode,created_at createdAt,last_login_at lastLoginAt FROM users ORDER BY created_at DESC LIMIT 500');ok(res,{members:r})}catch(e){next(e)}});
app.get('/api/backoffice-game-catalog',auth,roles('admin','superadmin'),async(_,res,next)=>{try{const [r]=await pool.query('SELECT * FROM games ORDER BY provider_code,sort_order,id');ok(res,{games:r})}catch(e){next(e)}});
app.post('/api/backoffice-game-catalog',auth,roles('admin','superadmin'),async(req,res,next)=>{try{const b=req.body||{},id=b.id||crypto.randomUUID();await pool.query('INSERT INTO games(id,provider_code,game_code,name,category,image_url,is_active,is_popular,is_new,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),image_url=VALUES(image_url),is_active=VALUES(is_active),is_popular=VALUES(is_popular),is_new=VALUES(is_new),sort_order=VALUES(sort_order)',[id,b.providerCode||'goldslotpalase',b.gameCode,b.name,b.category||null,b.imageUrl||null,b.isActive!==false,b.isPopular===true,b.isNew===true,Number(b.sortOrder||0)]);ok(res,{id})}catch(e){next(e)}});
app.get('/api/backoffice-audit',auth,roles('admin','superadmin'),async(_,res,next)=>{try{const [r]=await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500');ok(res,{audit:r})}catch(e){next(e)}});

app.use(notFound);
app.use(errorHandler);

const port=config.port;
const server=app.listen(port,()=>console.log('BrandalBet V2 listening on '+port));

async function shutdown(signal) {
  console.log('Received '+signal+'; shutting down');
  server.close(async () => {
    try { await closeDatabase(); process.exit(0); }
    catch (error) { console.error(error); process.exit(1); }
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
