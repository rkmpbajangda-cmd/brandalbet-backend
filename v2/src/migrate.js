import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import {fileURLToPath} from 'node:url';
import {config} from './config.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),schema=await fs.readFile(path.join(root,'schema.sql'),'utf8');
const db=mysql.createPool({uri:config.databaseUrl,connectionLimit:2,multipleStatements:true});const c=await db.getConnection();
try{await c.query(schema);await c.query('ALTER TABLE provider_transactions ADD COLUMN IF NOT EXISTS command VARCHAR(40) NULL, ADD COLUMN IF NOT EXISTS trans_guid VARCHAR(190) NULL, ADD COLUMN IF NOT EXISTS cancel_trans_guid VARCHAR(190) NULL, ADD COLUMN IF NOT EXISTS account VARCHAR(120) NULL, ADD COLUMN IF NOT EXISTS gplay_id VARCHAR(120) NULL, ADD COLUMN IF NOT EXISTS round_id VARCHAR(190) NULL, ADD COLUMN IF NOT EXISTS provider_id VARCHAR(64) NULL, ADD COLUMN IF NOT EXISTS game_code VARCHAR(120) NULL, ADD COLUMN IF NOT EXISTS balance_after DECIMAL(20,2) NULL, ADD COLUMN IF NOT EXISTS response_json JSON NULL, ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMP NULL');
await c.query('ALTER TABLE provider_events ADD COLUMN IF NOT EXISTS response_json JSON NULL, ADD COLUMN IF NOT EXISTS payload_hash CHAR(64) NULL, ADD COLUMN IF NOT EXISTS processing_status VARCHAR(30) NOT NULL DEFAULT \'received\'');
await c.query('INSERT IGNORE INTO schema_migrations(id) VALUES (?)',['002_v2_complete']);console.log('BrandalBet V2 schema verified/applied')}finally{c.release();await db.end()}