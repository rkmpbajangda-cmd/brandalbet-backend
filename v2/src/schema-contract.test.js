import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const schema=await fs.readFile(path.join(root,'schema.sql'),'utf8');
const migration=await fs.readFile(path.join(root,'src','migrate.js'),'utf8');

const expectedTables=['users','user_sessions','member_profiles','bank_accounts','wallets','wallet_ledger','transactions','deposits','withdrawals','cashback_accounts','cashback_transactions','referrals','providers','provider_users','games','game_launches','provider_transactions','provider_events','promotions','payment_connections','payment_orders','webhook_events','audit_logs','system_settings','idempotency_keys','schema_migrations','member_rtp_settings','rtp_audit_logs','website_settings','game_display_settings','provider_display_settings','payment_settings','reward_settings','member_security_settings','promotions_content','admin_permissions','system_jobs'];
const tables=new Set([...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/gi)].map(m=>m[1].toLowerCase()));

test('schema contains every V2 persistence table',()=>{
  assert.deepEqual(expectedTables.filter(t=>!tables.has(t)),[]);
  assert.equal(tables.size,expectedTables.length);
});

const requiredColumns={
 users:['id','username','email','password_hash','role','status'],
 user_sessions:['id','user_id','token_hash','device_id','session_type','expires_at','revoked_at'],
 wallets:['user_id','balance','locked'],
 wallet_ledger:['id','user_id','reference','direction','amount','balance_before','balance_after'],
 transactions:['id','user_id','type','amount','status','reference'],
 deposits:['id','user_id','amount','status','gateway_reference'],
 withdrawals:['id','user_id','amount','status','bank_account_id','gateway_reference'],
 providers:['id','code','name','is_active'],
 provider_users:['user_id','provider_code','provider_user_code'],
 games:['id','provider_code','provider_id','game_code','is_active'],
 game_launches:['id','user_id','game_id','request_id','launch_url','expires_at'],
 provider_transactions:['provider_code','provider_transaction_id','type','amount','trans_guid','cancel_trans_guid','round_id'],
 provider_events:['provider_code','event_key','payload_hash','processing_status','response_json'],
 payment_orders:['user_id','reference','amount','channel','status','provider_reference'],
 webhook_events:['source','event_key','signature_valid','amount','payload'],
 member_rtp_settings:['user_id','enabled','rtp','min_rtp','max_rtp','updated_by'],
 website_settings:['id','maintenance_mode','registration_enabled','game_launch_enabled','wallet_enabled'],
 game_display_settings:['game_id','section','display_order','is_visible'],
 provider_display_settings:['provider_id','display_order','is_visible'],
 payment_settings:['id','deposit_enabled','withdrawal_enabled','min_deposit','min_withdrawal'],
 reward_settings:['id','cashback_enabled','referral_enabled'],
 member_security_settings:['user_id','one_device_only','login_enabled','require_password_for_withdrawal'],
 promotions_content:['id','title','slug','display_order'],
 admin_permissions:['role','permission_key','allowed'],
 system_jobs:['job_key','enabled']
};
function body(name){
 const m=schema.match(new RegExp('CREATE TABLE IF NOT EXISTS\\s+'+name+'\\s*\\(([\\s\\S]*?)\\)\\s*ENGINE=','i'));
 return m?m[1]:'';
}
test('critical backend columns are present',()=>{
 const missing=[];
 for(const [table,columns] of Object.entries(requiredColumns)){
  const b=body(table);
  for(const col of columns){if(!new RegExp('(?:^|,)\\s*'+col+'\\s+','im').test(b))missing.push(table+'.'+col);}
 }
 assert.deepEqual(missing,[]);
});

test('migration contains required compatibility and seed operations',()=>{
 for(const s of ['INSERT IGNORE INTO website_settings(id) VALUES(1)','INSERT IGNORE INTO payment_settings(id) VALUES(1)','INSERT IGNORE INTO reward_settings(id) VALUES(1)','INSERT IGNORE INTO schema_migrations(id) VALUES (?)','ADD COLUMN IF NOT EXISTS command','ADD COLUMN IF NOT EXISTS trans_guid','ADD COLUMN IF NOT EXISTS cancel_trans_guid','ADD COLUMN IF NOT EXISTS response_json']) assert.ok(migration.includes(s),s);
});