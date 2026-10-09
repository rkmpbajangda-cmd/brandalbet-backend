import crypto from 'node:crypto';
import {withTransaction} from './db.js';
export const id=()=>crypto.randomUUID();
export function money(n){const v=Number(n);if(!Number.isFinite(v)||v<0||v>9000000000000000)throw Object.assign(new Error('invalid_amount'),{code:'invalid_amount',status:400});return Math.round(v*100)/100}
export function availableBalance(balance,lockedBalance=0){const b=Number(balance),l=Number(lockedBalance);if(!Number.isFinite(b)||!Number.isFinite(l))return 0;return Math.max(0,Math.round((b-l)*100)/100)}
async function mutate(userId,amount,reason,reference,meta,direction){
 amount=money(amount);if(amount<=0)throw Object.assign(new Error('invalid_amount'),{code:'invalid_amount',status:400});
 return withTransaction(async c=>{
  const checkDuplicate=async(lock=false)=>{
   // A locking read sees the latest committed row even after an earlier consistent read established a REPEATABLE READ snapshot.
   const [rows]=await c.query('SELECT id,user_id,amount,direction,balance_after FROM wallet_ledger WHERE reference=? LIMIT 1'+(lock?' FOR UPDATE':''),[reference]);
   if(!rows[0])return null;
   if(String(rows[0].user_id)!==String(userId)||Number(rows[0].amount)!==amount||rows[0].direction!==direction)throw Object.assign(new Error('idempotency_conflict'),{code:'idempotency_conflict',status:409});
   return {id:rows[0].id,balance:Number(rows[0].balance_after),idempotent:true};
  };
  const duplicate=await checkDuplicate();if(duplicate)return duplicate;
  const [[w]]=await c.query('SELECT balance,locked,locked_balance FROM wallets WHERE user_id=? FOR UPDATE',[userId]);if(!w)throw Object.assign(new Error('wallet_not_found'),{code:'wallet_not_found',status:404});
  // Recheck after taking the wallet lock: concurrent requests can share a reference.
  const duplicateAfterLock=await checkDuplicate(true);if(duplicateAfterLock)return duplicateAfterLock;
  if(Number(w.locked))throw Object.assign(new Error('wallet_locked'),{code:'wallet_locked',status:409});
  const before=Number(w.balance),lockedBalance=Number(w.locked_balance||0),after=direction==='credit'?before+amount:before-amount;if(after<0||(direction==='debit'&&availableBalance(before,lockedBalance)<amount))throw Object.assign(new Error('insufficient_balance'),{code:'insufficient_balance',status:409});
  const txId=id();await c.query('UPDATE wallets SET balance=? WHERE user_id=?',[after,userId]);
  await c.query('INSERT INTO transactions(id,user_id,type,amount,status,reference,metadata) VALUES(?,?,?,?,?,?,?)',[txId,userId,direction,amount,'completed',reference,JSON.stringify(meta)]);
  await c.query('INSERT INTO wallet_ledger(id,user_id,transaction_id,reference,direction,amount,balance_before,balance_after,reason,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)',[id(),userId,txId,reference,direction,amount,before,after,reason,JSON.stringify(meta)]);
  return {id:txId,balance:after,idempotent:false};
 })
}
export const creditWallet=(u,a,r,ref,m={})=>mutate(u,a,r,ref,m,'credit');
export const debitWallet=(u,a,r,ref,m={})=>mutate(u,a,r,ref,m,'debit');