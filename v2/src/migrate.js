import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import {fileURLToPath} from 'node:url';
import {config} from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = await fs.readFile(path.join(root, 'schema.sql'), 'utf8');
const db = mysql.createPool({ uri: config.databaseUrl, connectionLimit: 2, multipleStatements: true });
const c = await db.getConnection();

const compatibilityColumns = {
  provider_transactions: { command:'VARCHAR(40) NULL', trans_guid:'VARCHAR(190) NULL', cancel_trans_guid:'VARCHAR(190) NULL', account:'VARCHAR(120) NULL', gplay_id:'VARCHAR(120) NULL', round_id:'VARCHAR(190) NULL', provider_id:'VARCHAR(64) NULL', game_code:'VARCHAR(120) NULL', balance_after:'DECIMAL(20,2) NULL', response_json:'JSON NULL', canceled_at:'TIMESTAMP NULL' },
  provider_events: { response_json:'JSON NULL', payload_hash:'CHAR(64) NULL', processing_status:"VARCHAR(30) NOT NULL DEFAULT 'received'" },
  wallets: { locked_balance:'DECIMAL(20,2) NOT NULL DEFAULT 0' },
  bank_accounts: { routing_type:'VARCHAR(40) NULL', routing_value:'VARCHAR(120) NULL', is_primary:'BOOLEAN NOT NULL DEFAULT 1', verified_at:'TIMESTAMP NULL' },
  deposits: { payment_request_id:'VARCHAR(190) NULL' },
  withdrawals: { payout_id:'VARCHAR(190) NULL', idempotency_key:'VARCHAR(190) NULL' }
};

async function ensureCompatibilityIndexes(connection) {
  const [rows] = await connection.query('SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['withdrawals']);
  const names = new Set(rows.map(row => String(row.INDEX_NAME).toLowerCase()));
  if (!names.has('uq_withdrawal_idempotency')) await connection.query('ALTER TABLE withdrawals ADD UNIQUE KEY uq_withdrawal_idempotency (idempotency_key)');
}

async function ensureCompatibilityColumns(connection) {
  for (const [table, columns] of Object.entries(compatibilityColumns)) {
    const [existing] = await connection.query('SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    const names = new Set(existing.map(row => String(row.COLUMN_NAME).toLowerCase()));
    for (const [column, definition] of Object.entries(columns)) {
      if (names.has(column.toLowerCase())) continue;
      await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
  }
}

try {
  await c.query(schema);
  await ensureCompatibilityColumns(c);
  await ensureCompatibilityIndexes(c);
  await c.query('INSERT IGNORE INTO website_settings(id) VALUES(1)');
  await c.query('INSERT IGNORE INTO payment_settings(id) VALUES(1)');
  await c.query('INSERT IGNORE INTO reward_settings(id) VALUES(1)');
  await c.query('INSERT IGNORE INTO schema_migrations(id) VALUES (?)', ['002_v2_complete']);
  console.log('BrandalBet V2 schema verified/applied');
} finally {
  c.release();
  await db.end();
}