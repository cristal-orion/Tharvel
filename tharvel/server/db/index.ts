import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Default: tharvel/data/tharvel.db (server/db -> server -> tharvel -> data/)
const DEFAULT_DB_PATH = path.resolve(__dirname, '..', '..', 'data', 'tharvel.db');

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = process.env.THARVEL_DB_PATH || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schemaPath = path.resolve(__dirname, 'schema.sql');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));

  // Migration idempotente: aggiunge colonne nuove ai DB esistenti.
  // CREATE TABLE IF NOT EXISTS non modifica le tabelle già presenti, quindi
  // controlliamo le colonne via pragma e aggiungiamo solo quelle mancanti.
  const cols = db.prepare("PRAGMA table_info(sites)").all() as Array<{ name: string }>;
  const hasFramework = cols.some(c => c.name === 'framework');
  if (!hasFramework) {
    db.exec("ALTER TABLE sites ADD COLUMN framework TEXT NOT NULL DEFAULT 'html'");
    console.log("[DB] migration: aggiunta colonna sites.framework");
  }

  dbInstance = db;
  console.log(`[DB] tharvel.db ready at ${dbPath}`);
  return dbInstance;
}
