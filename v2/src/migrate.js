import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import {fileURLToPath} from 'node:url';
import {config} from './config.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),schema=await fs.readFile(path.join(root,'schema.sql'),'utf8');
const db=mysql.createPool({uri:config.databaseUrl,connectionLimit:2,multipleStatements:true});const c=await db.getConnection();
try{await c.query(schema);await c.query('INSERT IGNORE INTO schema_migrations(id) VALUES (?)',['002_v2_complete']);console.log('BrandalBet V2 schema verified/applied')}finally{c.release();await db.end()}