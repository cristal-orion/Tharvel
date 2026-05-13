import { getDb } from './index.js';

export type UserRole = 'admin' | 'client';

export interface User {
  id: number;
  email: string;
  password_hash: string;
  role: UserRole;
  slug: string | null;
  totp_secret: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewUser {
  email: string;
  password_hash: string;
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

export function createUser(input: NewUser): User {
  const stmt = getDb().prepare(`
    INSERT INTO users (email, password_hash, role, slug)
    VALUES (@email, @password_hash, @role, @slug)
    RETURNING *
  `);
  return stmt.get({
    email: input.email,
    password_hash: input.password_hash,
    role: input.role,
    slug: input.slug ?? null,
  }) as User;
}

export function updateUserPassword(id: number, password_hash: string): void {
  getDb()
    .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(password_hash, id);
}
