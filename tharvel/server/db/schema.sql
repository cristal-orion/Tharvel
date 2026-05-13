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
