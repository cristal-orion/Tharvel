import { getDb } from './index.js';

export type UserRole = 'admin' | 'client';

export interface User {
  id: number;
  email: string;
  password_hash: string;
  // Stessa password, cifrata (secret-box.ts): il login usa SOLO l'hash, questa serve
  // a ristampare il messaggio di handover per il cliente. NULL = non recuperabile
  // (account creato prima di questa feature, o segreto di cifratura non disponibile).
  password_enc: string | null;
  role: UserRole;
  slug: string | null;
  totp_secret: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewUser {
  email: string;
  password_hash: string;
  password_enc?: string | null;
  role: UserRole;
  slug?: string | null;
}

export function getUserByEmail(email: string): User | null {
  return (getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined) ?? null;
}

export function getUserById(id: number): User | null {
  return (getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined) ?? null;
}

export function listUsers(): User[] {
  return getDb().prepare('SELECT * FROM users ORDER BY id ASC').all() as User[];
}

// Utenti legati a un sito (modello Beta: di norma un solo client per slug).
export function listUsersBySlug(slug: string): User[] {
  return getDb().prepare('SELECT * FROM users WHERE slug = ? ORDER BY id ASC').all(slug) as User[];
}

export function createUser(input: NewUser): User {
  const stmt = getDb().prepare(`
    INSERT INTO users (email, password_hash, password_enc, role, slug)
    VALUES (@email, @password_hash, @password_enc, @role, @slug)
    RETURNING *
  `);
  return stmt.get({
    email: input.email,
    password_hash: input.password_hash,
    password_enc: input.password_enc ?? null,
    role: input.role,
    slug: input.slug ?? null,
  }) as User;
}

// password_enc va passato SEMPRE insieme all'hash: se restasse quello vecchio, il
// pannello "Chiavi di accesso" mostrerebbe una password che non funziona più.
export function updateUserPassword(id: number, password_hash: string, password_enc: string | null): void {
  getDb()
    .prepare("UPDATE users SET password_hash = ?, password_enc = ?, updated_at = datetime('now') WHERE id = ?")
    .run(password_hash, password_enc, id);
}
