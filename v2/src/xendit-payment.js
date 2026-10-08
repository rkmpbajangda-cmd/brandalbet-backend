import argon2 from 'argon2';
import crypto from 'node:crypto';
import {pool,withTransaction} from './db.js';
import {config} from './config.js';
import {createXendit,verifyCallbackToken} from './xendit.js';
import {id as newId,money} from './wallet.js';

export const xendit=createXendit({apiKey:config.xenditApiKey,apiVersion:config.xenditApiVersion});

function fail(code,status=400,message=code){throw Object.assign(new Error(message),{code,status})}

export async function createDeposit(user,body){
 const [[site]]=await pool.query('SELECT maintenance_mode,wallet_enabled FROM website_settings WHERE id=1');
 if(site?.maintenance_mode)fail('maintenance_mode',503);
 if(site&&Number(site.wallet_enabled)===0)fail('wallet_disabled',403);
 const [[ps]]=await pool.query('SELECT deposit_enabled,min_deposit,max_deposit FROM payment_settings WHERE id=1');
 if(ps&&Number(ps.deposit_enabled)===0)fail('deposit_disabled',403);
 if(!xendit.configured)fail('payment_adapter_unavailable',503);
 const amount=money(body?.amountRupiah),min=Number(ps?.min_deposit??config.minDeposit),max=ps?.max_deposit==null?null:Number(ps.max_deposit);
 if(amount<min)fail('minimum_deposit'); if(max!=null&&amount>max)fail('maximum_deposit');
 const channelCode=String(body?.channelCode||config.xenditDefaultChannel).trim().toUpperCase();
 const channelProperties=body?.channelProperties&&typeof body.channelProperties==='object'?body.channelProperties:{};
 const clientKey=String(body?.idempotencyKey||'').trim();
 const stableKey=clientKey?crypto.createHash('sha256').update(user.id+':deposit:'+clientKey).digest('hex').toUpperCase():newId().replace(/-/g,'').toUpperCase();
 const reference='DEP-'+stableKey.slice(0,40);
 const [existing]=await pool.query('SELECT amount,channel,status,provider_reference,payment_url,qr_image_url FROM payment_orders WHERE user_id=? AND reference=? LIMIT 1',[user.id,reference]);
 if(existing[0]){
  if(Number(existing[0].amount)!==amount||String(existing[0].channel)!==channelCode)fail('idempotency_conflict',409);
  return {reference,paymentRequestId:existing[0].provider_reference,status:existing[0].status==='paid'?'SUCCEEDED':'PENDING',paymentUrl:existing[0].payment_url,qrString:existing[0].qr_image_url,vaNumber:null,channelCode,idempotent:true};
 }
 const created=await xendit.paymentRequest({referenceId:reference,amount,channelCode,channelProperties,idempotencyKey:stableKey,metadata:{userId:user.id}});
 if(!created?.id)fail('xendit_invalid_payment_response',502);
 const orderId=newId();
 try{
  await withTransaction(async c=>{
   await c.query('INSERT INTO payment_orders(id,user_id,reference,amount,channel,status,provider_reference,payment_url,qr_image_url,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)',[orderId,user.id,reference,amount,channelCode,'pending',created.id,created.paymentUrl||null,created.qrString||null,JSON.stringify(created.raw)]);
   await c.query('INSERT INTO deposits(id,user_id,amount,status,gateway,gateway_reference,payment_request_id,payment_url,qr_image_url,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)',[newId(),user.id,amount,'pending','xendit',created.id,created.id,created.paymentUrl||null,created.qrString||null,JSON.stringify({channelCode,reference})]);
  });
 }catch(e){
  if(e.code==='ER_DUP_ENTRY'){
   const [r]=await pool.query('SELECT amount,channel,status,provider_reference,payment_url,qr_image_url FROM payment_orders WHERE user_id=? AND reference=? LIMIT 1',[user.id,reference]);
   if(r[0]&&Number(r[0].amount)===amount&&String(r[0].channel)===channelCode)return {reference,paymentRequestId:r[0].provider_reference,status:r[0].status==='paid'?'SUCCEEDED':'PENDING',paymentUrl:r[0].payment_url,qrString:r[0].qr_image_url,vaNumber:null,channelCode,idempotent:true};
  }
  throw e;
 }
 return {reference,paymentRequestId:created.id,status:'PENDING',providerStatus:created.status,paymentUrl:created.paymentUrl,qrString:created.qrString,vaNumber:created.vaNumber,channelCode,idempotent:false};
}

export async function createWithdrawal(user,body){
 const [[site]]=await pool.query('SELECT maintenance_mode,wallet_enabled FROM website_settings WHERE id=1');
 if(site?.maintenance_mode)fail('maintenance_mode',503);
 if(site&&Number(site.wallet_enabled)===0)fail('wallet_disabled',403);
 const [[ps]]=await pool.query('SELECT withdrawal_enabled,min_withdrawal,max_withdrawal FROM payment_settings WHERE id=1');
 if(ps&&Number(ps.withdrawal_enabled)===0)fail('withdrawal_disabled',403);
 if(!xendit.configured)fail('payment_adapter_unavailable',503);
 const amount=money(body?.amountRupiah),min=Number(ps?.min_withdrawal??config.minWithdrawal),max=ps?.max_withdrawal==null?null:Number(ps.max_withdrawal);
 if(amount<min)fail('minimum_withdrawal'); if(max!=null&&amount>max)fail('maximum_withdrawal');
 const [[sec]]=await pool.query('SELECT require_password_for_withdrawal FROM member_security_settings WHERE user_id=?',[user.id]);
 if(Number(sec?.require_password_for_withdrawal??1)!==0){const password=String(body?.password||'');if(!password||!(await argon2.verify(user.password_hash,password)))fail('withdrawal_password_invalid',401)}
 const requestedBankId=String(body?.bankAccountId||'').trim();const bankSql=requestedBankId?'SELECT * FROM bank_accounts WHERE user_id=? AND id=? LIMIT 1':'SELECT * FROM bank_accounts WHERE user_id=? ORDER BY is_primary DESC,created_at DESC LIMIT 1';const bankArgs=requestedBankId?[user.id,requestedBankId]:[user.id];const [banks]=await pool.query(bankSql,bankArgs);if(!banks[0])fail('bank_account_required');
 const ba=banks[0];const routingType=String(ba.routing_type||config.xenditBankRoutingType||'').trim();const routingValue=String(ba.routing_value||'').trim();if(!routingType||!routingValue)fail('bank_routing_unconfigured');
 const clientKey=String(body?.idempotencyKey||'').trim(),idempotencyKey=clientKey?crypto.createHash('sha256').update(user.id+':withdraw:'+clientKey).digest('hex'):null;
 const reference='WD-'+(idempotencyKey?idempotencyKey.slice(0,32).toUpperCase():newId().replace(/-/g,'').toUpperCase());
 if(idempotencyKey){
  const [existing]=await pool.query('SELECT id,amount,status,bank_account_id,payout_id,metadata FROM withdrawals WHERE user_id=? AND idempotency_key=? LIMIT 1',[user.id,idempotencyKey]);
  if(existing[0]){
   let meta=existing[0].metadata||{};if(typeof meta==='string'){try{meta=JSON.parse(meta)}catch{meta={}}}
   if(Number(existing[0].amount)!==amount||String(existing[0].bank_account_id)!==String(ba.id))fail('idempotency_conflict',409);
   return {withdrawalId:existing[0].id,reference:meta.reference||reference,payoutId:existing[0].payout_id||null,status:String(existing[0].status).toUpperCase(),idempotent:true};
  }
 }
 const withdrawalId=await withTransaction(async c=>{
  const [[w]]=await c.query('SELECT balance,locked_balance,locked FROM wallets WHERE user_id=? FOR UPDATE',[user.id]);if(!w)fail('wallet_not_found',404);if(w.locked)fail('wallet_locked',403);
  const available=Number(w.balance)-Number(w.locked_balance||0);if(available<amount)fail('balance_not_enough');
  const [dupe]=await c.query('SELECT id FROM withdrawals WHERE user_id=? AND status IN ("pending","processing","pending_compliance") LIMIT 1',[user.id]);if(dupe[0])fail('withdrawal_already_pending',409);
  await c.query('UPDATE wallets SET locked_balance=locked_balance+? WHERE user_id=?',[amount,user.id]);
  const id=newId();await c.query('INSERT INTO withdrawals(id,user_id,amount,status,bank_account_id,metadata,idempotency_key) VALUES(?,?,?,?,?,?,?)',[id,user.id,amount,'pending',ba.id,JSON.stringify({provider:'xendit',reference,bankProvider:ba.provider,accountMasked:String(ba.account_number).slice(-4)}),idempotencyKey]);return id;
 });
 try{
  const payout=await xendit.payout({referenceId:reference,amount,accountName:ba.account_name,accountNumber:ba.account_number,routingType,routingValue,description:reference,idempotencyKey:idempotencyKey||reference});
  await settleWithdrawal(withdrawalId,user.id,amount,payout);
  return {withdrawalId,reference,payoutId:payout.id,status:payout.status};
 }catch(error){
  // A network/5xx timeout is ambiguous: Xendit may have accepted the payout.
  // Keep funds reserved and let the payout webhook/reconciliation resolve it.
  if(Number(error.status)>=400&&Number(error.status)<500){
   await releaseWithdrawal(withdrawalId,user.id,amount,'gateway_rejected',error.code||error.message);
  }else{
   await withTransaction(async c=>{await c.query('UPDATE withdrawals SET status="processing",reject_reason=?,updated_at=NOW() WHERE id=?',[String('gateway_unknown:'+ (error.code||error.message)).slice(0,500),withdrawalId])});
  }
  throw error;
 }
}

async function settleWithdrawal(id,userId,amount,payout){
 const status=String(payout.status||'').toUpperCase();
 await withTransaction(async c=>{
  const [[w]]=await c.query('SELECT balance,locked_balance FROM wallets WHERE user_id=? FOR UPDATE',[userId]);
  if(!w)fail('wallet_not_found',404);
  if(['FAILED','REJECTED','CANCELLED','REVERSED','EXPIRED'].includes(status)){
   await c.query('UPDATE wallets SET locked_balance=GREATEST(0,locked_balance-?) WHERE user_id=?',[amount,userId]);
   await c.query('UPDATE withdrawals SET status="failed",gateway_reference=?,payout_id=?,reject_reason=?,updated_at=NOW() WHERE id=?',[payout.id,payout.id,payout.raw?.failure_code||status,id]);
   return;
  }
  if(status==='SUCCEEDED'){
   const before=Number(w.balance),after=before-amount,locked= Math.max(0,Number(w.locked_balance)-amount),txId=newId(),ref='PAY-OUT-'+id;
   if(before<amount)fail('wallet_balance_invariant',409);
   await c.query('UPDATE wallets SET balance=?,locked_balance=? WHERE user_id=?',[after,locked,userId]);
   await c.query('INSERT INTO transactions(id,user_id,type,amount,status,reference,metadata) VALUES(?,?,?,?,?,?,?)',[txId,userId,'payment_withdrawal',amount,'completed',ref,JSON.stringify({provider:'xendit',payoutId:payout.id})]);
   await c.query('INSERT INTO wallet_ledger(id,user_id,transaction_id,reference,direction,amount,balance_before,balance_after,reason,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)',[newId(),userId,txId,ref,'debit',amount,before,after,'payment_withdrawal',JSON.stringify({provider:'xendit',payoutId:payout.id})]);
   await c.query('UPDATE withdrawals SET status="completed",gateway_reference=?,payout_id=?,updated_at=NOW() WHERE id=?',[payout.id,payout.id,id]);return;
  }
  const next=status==='PENDING_COMPLIANCE_ASSESSMENT'?'pending_compliance':'processing';
  await c.query('UPDATE withdrawals SET status=?,gateway_reference=?,payout_id=?,updated_at=NOW() WHERE id=?',[next,payout.id,payout.id,id]);
 });
}

async function releaseWithdrawal(id,userId,amount,reason,detail){
 await withTransaction(async c=>{
  const [[w]]=await c.query('SELECT locked_balance FROM wallets WHERE user_id=? FOR UPDATE',[userId]);if(!w)return;
  await c.query('UPDATE wallets SET locked_balance=GREATEST(0,locked_balance-?) WHERE user_id=?',[amount,userId]);
  await c.query('UPDATE withdrawals SET status="failed",reject_reason=?,updated_at=NOW() WHERE id=?',[String(reason+':'+detail).slice(0,500),id]);
 });
}

export async function handleXenditPaymentWebhook(req){
 if(!verifyCallbackToken(req.get('x-callback-token'),config.xenditWebhookToken))fail('webhook_unauthorized',401);
 const body=req.body||{},event=String(body.event||''),d=body.data||{},paymentId=String(d.payment_id||''),requestId=String(d.payment_request_id||'');
 if(!paymentId&&!requestId)fail('webhook_event_required');
 const eventKey='xendit:'+event+':'+(paymentId||requestId);
 return withTransaction(async c=>{
  const [exists]=await c.query('SELECT processed_at FROM webhook_events WHERE source="xendit_payment" AND event_key=? FOR UPDATE',[eventKey]);
  if(exists[0]?.processed_at)return {received:true,idempotent:true};
  await c.query('INSERT INTO webhook_events(id,source,event_key,signature_valid,amount,payload) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),signature_valid=VALUES(signature_valid)',[newId(),'xendit_payment',eventKey,true,Number(d.request_amount||0),JSON.stringify(body)]);
  if(event==='payment.capture'&&String(d.status||'').toUpperCase()==='SUCCEEDED'){
   const reference=String(d.reference_id||'');const [orders]=await c.query('SELECT * FROM payment_orders WHERE reference=? FOR UPDATE',[reference]);if(!orders[0])fail('payment_order_not_found',404);
   const order=orders[0],amount=Number(d.request_amount||0);if(Number(order.amount)!==amount)fail('payment_amount_mismatch',409);
   if(order.status!=='paid'){
    const [[w]]=await c.query('SELECT balance,locked FROM wallets WHERE user_id=? FOR UPDATE',[order.user_id]);if(!w||w.locked)fail('wallet_locked',409);
    const before=Number(w.balance),after=before+amount,txId=newId(),ref='PAY-'+reference;
    await c.query('UPDATE wallets SET balance=? WHERE user_id=?',[after,order.user_id]);
    await c.query('INSERT INTO transactions(id,user_id,type,amount,status,reference,metadata) VALUES(?,?,?,?,?,?,?)',[txId,order.user_id,'payment_deposit',amount,'completed',ref,JSON.stringify({provider:'xendit',paymentId,requestId,reference})]);
    await c.query('INSERT INTO wallet_ledger(id,user_id,transaction_id,reference,direction,amount,balance_before,balance_after,reason,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)',[newId(),order.user_id,txId,ref,'credit',amount,before,after,'payment_deposit',JSON.stringify({provider:'xendit',paymentId,requestId})]);
    await c.query('UPDATE payment_orders SET status="paid",provider_reference=? WHERE id=?',[paymentId,order.id]);
    await c.query('UPDATE deposits SET status="completed",gateway_reference=?,metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()),"$.paymentId",?) WHERE payment_request_id=? OR gateway_reference=? OR gateway_reference=?',[paymentId,paymentId,requestId,order.provider_reference,paymentId]);
   }
  }else if(event==='payment.failure'||event==='payment_request.expiry'){
   const reference=String(d.reference_id||'');await c.query('UPDATE payment_orders SET status="failed" WHERE reference=? AND status<>"paid"',[reference]);await c.query('UPDATE deposits SET status="failed" WHERE payment_request_id=? AND status<>"completed"',[requestId]);
  }else if(event==='payment.reversal'||event==='payment.reversed'){
   const reference=String(d.reference_id||'');
   const [orders]=await c.query('SELECT * FROM payment_orders WHERE reference=? OR provider_reference=? OR provider_reference=? FOR UPDATE',[reference,requestId,paymentId]);
   if(!orders[0])fail('payment_order_not_found',404);
   await c.query('UPDATE payment_orders SET status="reversal_pending" WHERE id=?',[orders[0].id]);
   await c.query('UPDATE deposits SET status="reversal_pending" WHERE payment_request_id=? OR gateway_reference=? OR gateway_reference=?',[requestId,orders[0].provider_reference,paymentId]);
  }
  await c.query('UPDATE webhook_events SET processed_at=NOW() WHERE source="xendit_payment" AND event_key=?',[eventKey]);return {received:true,processed:true};
 });
}

export async function handleXenditPayoutWebhook(req){
 if(!verifyCallbackToken(req.get('x-callback-token'),config.xenditWebhookToken))fail('webhook_unauthorized',401);
 const body=req.body||{},event=String(body.event||''),d=body.data||{},payoutId=String(d.payout_id||''),reference=String(d.reference_id||'');
 if(!payoutId&&!reference)fail('webhook_event_required');
 const eventKey='xendit_payout:'+event+':'+(payoutId||reference);
 return withTransaction(async c=>{
  const [exists]=await c.query('SELECT processed_at FROM webhook_events WHERE source="xendit_payout" AND event_key=? FOR UPDATE',[eventKey]);if(exists[0]?.processed_at)return {received:true,idempotent:true};
  await c.query('INSERT INTO webhook_events(id,source,event_key,signature_valid,amount,payload) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),signature_valid=VALUES(signature_valid)',[newId(),'xendit_payout',eventKey,true,Number(d.source_amount||0),JSON.stringify(body)]);
  const [rows]=await c.query('SELECT * FROM withdrawals WHERE (payout_id=? AND ?<>"") OR gateway_reference=? OR JSON_UNQUOTE(JSON_EXTRACT(metadata,"$.reference"))=? FOR UPDATE',[payoutId,payoutId,reference,reference]);if(!rows[0])fail('withdrawal_not_found',404);
  const wd=rows[0],status=String(d.status||'').toUpperCase();
  const [[w]]=await c.query('SELECT balance,locked_balance FROM wallets WHERE user_id=? FOR UPDATE',[wd.user_id]);if(!w)fail('wallet_not_found',404);
  if(status==='REVERSED'&&wd.status==='completed'){
   const amount=Number(wd.amount),before=Number(w.balance),after=before+amount,txId=newId(),ref='PAY-OUT-REV-'+wd.id;
   await c.query('UPDATE wallets SET balance=? WHERE user_id=?',[after,wd.user_id]);
   await c.query('INSERT INTO transactions(id,user_id,type,amount,status,reference,metadata) VALUES(?,?,?,?,?,?,?)',[txId,wd.user_id,'payment_withdrawal_reversal',amount,'completed',ref,JSON.stringify({provider:'xendit',payoutId,reason:'reversed'})]);
   await c.query('INSERT INTO wallet_ledger(id,user_id,transaction_id,reference,direction,amount,balance_before,balance_after,reason,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)',[newId(),wd.user_id,txId,ref,'credit',amount,before,after,'payment_withdrawal_reversal',JSON.stringify({provider:'xendit',payoutId})]);
   await c.query('UPDATE withdrawals SET status="reversed",reject_reason="Xendit payout reversed",updated_at=NOW() WHERE id=?',[wd.id]);
  }else if(['FAILED','REJECTED','CANCELLED','EXPIRED'].includes(status)&&['pending','processing','pending_compliance'].includes(wd.status)){
   await c.query('UPDATE wallets SET locked_balance=GREATEST(0,locked_balance-?) WHERE user_id=?',[Number(wd.amount),wd.user_id]);await c.query('UPDATE withdrawals SET status="failed",reject_reason=?,updated_at=NOW() WHERE id=?',[String(d.failure_code||status),wd.id]);
  }else if(status==='SUCCEEDED'&&['pending','processing','pending_compliance'].includes(wd.status)){
   const amount=Number(wd.amount),before=Number(w.balance),after=before-amount,locked=Math.max(0,Number(w.locked_balance)-amount);if(before<amount)fail('wallet_balance_invariant',409);
   const txId=newId(),ref='PAY-OUT-'+wd.id;await c.query('UPDATE wallets SET balance=?,locked_balance=? WHERE user_id=?',[after,locked,wd.user_id]);await c.query('INSERT INTO transactions(id,user_id,type,amount,status,reference,metadata) VALUES(?,?,?,?,?,?,?)',[txId,wd.user_id,'payment_withdrawal',amount,'completed',ref,JSON.stringify({provider:'xendit',payoutId})]);await c.query('INSERT INTO wallet_ledger(id,user_id,transaction_id,reference,direction,amount,balance_before,balance_after,reason,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)',[newId(),wd.user_id,txId,ref,'debit',amount,before,after,'payment_withdrawal',JSON.stringify({provider:'xendit',payoutId})]);await c.query('UPDATE withdrawals SET status="completed",updated_at=NOW() WHERE id=?',[wd.id]);
   }else if(status==='PENDING_COMPLIANCE_ASSESSMENT')await c.query('UPDATE withdrawals SET status="pending_compliance",updated_at=NOW() WHERE id=?',[wd.id]);
  await c.query('UPDATE webhook_events SET processed_at=NOW() WHERE source="xendit_payout" AND event_key=?',[eventKey]);return {received:true,processed:true};
 });
}
