import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = await fs.readFile(path.join(root, 'schema.sql'), 'utf8');

const db = mysql.createPool({
  uri: config.databaseUrl,
  connectionLimit: 2,
  multipleStatements: true,
});

const connection = await db.getConnection();
try {
  await connection.query(schema);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(120) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await connection.query(
    'INSERT IGNORE INTO schema_migrations(id) VALUES (?)',
    ['001_initial_schema']
  );
  console.log('Database migration 001_initial_schema applied/verified');
} finally {
  connection.release();
  await db.end();
}
