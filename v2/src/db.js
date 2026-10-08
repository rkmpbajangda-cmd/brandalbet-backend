import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  uri: config.databaseUrl,
  connectionLimit: config.databaseConnectionLimit,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  decimalNumbers: true,
});

export async function pingDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
  } finally {
    connection.release();
  }
}

export async function withTransaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  } finally {
    connection.release();
  }
}

export async function closeDatabase() {
  await pool.end();
}
