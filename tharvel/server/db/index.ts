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
  // Ogni colonna aggiunta qui va aggiunta ANCHE a schema.sql, per i DB nuovi.
  const addColumnIfMissing = (table: string, column: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[DB] migration: aggiunta colonna ${table}.${column}`);
  };

  addColumnIfMissing('sites', 'framework', "framework TEXT NOT NULL DEFAULT 'html'");
  // Modello AI scelto per questo sito, come "<provider>/<modelId>". NULL = default.
  addColumnIfMissing('sites', 'model', 'model TEXT');
  // Password del pannello cifrata (vedi secret-box.ts): serve a ristampare il
  // messaggio di handover per il cliente. NULL = non recuperabile.
  addColumnIfMissing('users', 'password_enc', 'password_enc TEXT');

  dbInstance = db;
  console.log(`[DB] tharvel.db ready at ${dbPath}`);
  return dbInstance;
}
