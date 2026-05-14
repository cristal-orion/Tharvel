CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  domain TEXT UNIQUE,
  cwd_path TEXT NOT NULL,
  framework TEXT NOT NULL DEFAULT 'html',
  repo_url TEXT,
  preview_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);

-- Strato 4 (auth/identity) — vedi progetto-tharvel-security.md §3 Strato 4.
-- Modello semplificato Beta: un utente è legato a UN solo sito (slug NOT NULL per
-- client; NULL per admin che accede a tutti). Migrazione a M:N quando serve.
-- totp_secret nullable dal day 1 per evitare migration post-2FA.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','client')),
  slug TEXT,
  totp_secret TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (slug) REFERENCES sites(slug) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Storico modifiche per sito: una riga per turn riuscito dell'agente
-- (commit auto su branch `preview`). Vive in DB anche se git fa squash al
-- publish, così l'utente vede sempre "cosa ha chiesto e quando" anche dopo
-- che la storia git è stata compattata.
-- superseded_at: NULL = revisione ancora ripristinabile su preview.
--                Valorizzato dopo `publish` (squash) → revisione "archiviata",
--                non più ripristinabile perché il commit non esiste più su preview.
CREATE TABLE IF NOT EXISTS site_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  parent_sha TEXT,
  user_prompt TEXT NOT NULL,
  summary TEXT,
  files_changed TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'turn' CHECK(kind IN ('turn','publish')),
  superseded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_revisions_site ON site_revisions(site_id, created_at DESC);
