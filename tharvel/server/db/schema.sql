CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  domain TEXT UNIQUE,
  cwd_path TEXT NOT NULL,
  framework TEXT NOT NULL DEFAULT 'html',
  -- Modello AI scelto per questo sito ("<provider>/<modelId>"). NULL = default.
  model TEXT,
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
  -- Password cifrata (secret-box.ts) per poter ristampare il messaggio di
  -- handover al cliente. NULL = non recuperabile, si può solo rigenerare.
  password_enc TEXT,
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

-- Modelli aggiunti a mano dall'admin oltre a quelli built-in dell'SDK.
-- Caso d'uso: un nuovo modello ChatGPT/Codex esce dopo il pin dell'SDK
-- (pi-coding-agent 0.73 conosce fino a gpt-5.5) — l'admin lo registra qui
-- indicando l'id esatto accettato dal backend del provider. Il transport
-- OAuth di Codex inoltra l'id come stringa, quindi il modello funziona senza
-- update dell'SDK. context_window/max_tokens sono opzionali: se NULL vengono
-- clonati dal template built-in dello stesso provider (vedi buildCodexModel).
-- Scope GLOBALE (non per-sito): è la subscription condivisa gestita dall'admin.
CREATE TABLE IF NOT EXISTS custom_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  label TEXT NOT NULL,
  context_window INTEGER,
  max_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, model_id)
);

-- Transcript completo della chat, per sito. Distinto da site_revisions: quella
-- nasce SOLO per i turni che producono un commit, quindi non vede le domande
-- ("come faccio a..."), i turni falliti, né le risposte dell'agente. Questa
-- tabella registra tutto, ed è la fonte per il pannello attività dell'admin
-- ("cosa ha chiesto il cliente"). La session dell'SDK è inMemory: senza questo
-- il transcript si perde alla disconnessione.
-- turn_id raggruppa il prompt e la risposta dello stesso turno.
-- user_id: chi ha scritto (NULL per i messaggi dell'agente e per i turni in cui
-- l'utente non è risolvibile).
CREATE TABLE IF NOT EXISTS site_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  user_id INTEGER,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  had_error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_site ON site_chat_messages(site_id, id DESC);

-- Modalità osservazione (vedi progetto-tharvel-security.md, vettore B).
-- Registra ogni comando che l'agente esegue col tool bash SENZA bloccarlo:
-- serve a ricavare dall'uso reale la whitelist dei comandi da mantenere quando
-- il terminale verrà sostituito con quello virtuale. Finché questa tabella non
-- ha abbastanza dati, il blocco NON va attivato.
CREATE TABLE IF NOT EXISTS site_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  turn_id TEXT,
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commands_site ON site_commands(site_id, id DESC);
