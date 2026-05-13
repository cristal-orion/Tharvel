// Strato 4 — Identity layer Tharvel.
// Vedi progetto-tharvel-security.md §3 Strato 4 e §9 sequenza operativa.
//
// Modello: JWT firmato HS256 con jose, payload {sub, email, role, slug, exp},
// trasportato via cookie httpOnly. Password hash con argon2id (parametri default
// di @node-rs/argon2 sono moderati e adeguati per Beta).
//
// In prod (containers Coolify HTTP/dietro Traefik con TLS termination) il cookie
// `secure` va abilitato via env COOKIE_SECURE=true quando si passa a HTTPS.
// Per ora siamo su sslip.io HTTP → cookie con secure=false così il browser lo invia.

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import argon2 from 'argon2';
import type { Request, Response, NextFunction, RequestHandler, CookieOptions } from 'express';
import type { UserRole, User } from './db/users.js';
import { getUserById } from './db/users.js';

const SESSION_COOKIE = 'tharvel-session';
const TOKEN_TTL = '8h'; // JWT long-lived senza refresh per Beta (decisione utente)

function getSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 16) {
    throw new Error(
      'JWT_SECRET non impostata o troppo corta (min 16 caratteri). Settala come env var Coolify.',
    );
  }
  return new TextEncoder().encode(raw);
}

export interface SessionPayload extends JWTPayload {
  sub: string; // user.id come stringa (JWT standard)
  email: string;
  role: UserRole;
  slug: string | null;
}

export interface SessionUser {
  id: number;
  email: string;
  role: UserRole;
  slug: string | null;
}

// Augment Express Request with our user shape. Importato lato server/index.ts via tipo.
declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export async function signSession(user: User): Promise<string> {
  return new SignJWT({
    email: user.email,
    role: user.role,
    slug: user.slug,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getSecret());
}

// Verifica firma + scadenza, ricarica User dal DB (così la revoca via DELETE FROM users
// ha effetto immediato senza dover invalidare token in memoria). Ritorna null su qualsiasi
// errore (token mancante, scaduto, firma errata, utente cancellato).
export async function verifySession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const id = Number(payload.sub);
    if (!Number.isFinite(id)) return null;
    const user = getUserById(id);
    if (!user) return null;
    return { id: user.id, email: user.email, role: user.role, slug: user.slug };
  } catch {
    return null;
  }
}

// Cookie config centralizzato così endpoint login/logout e WS upgrade usano gli
// stessi attributi: cambi qui, cambia ovunque.
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000, // 8h in ms, allineato con TOKEN_TTL
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

// Middleware Express: popola req.user oppure 401. Per route HTTP "API protette".
// L'UI (file statici) NON va dietro questo middleware perché serviamo anche /login.
export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  const user = await verifySession(token);
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = user;
  next();
};

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
};

// Parser cookie minimale per le WS (Express cookieParser non si applica all'upgrade).
// Estrae solo il nostro cookie di sessione dal raw header.
export function parseSessionCookie(rawHeader: string | undefined): string | undefined {
  if (!rawHeader) return undefined;
  for (const part of rawHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

// Helper consumato dai login route: setta il cookie + ritorna il payload "pubblico"
// (no hash password).
export function publicUser(user: User | SessionUser): SessionUser {
  return { id: user.id, email: user.email, role: user.role, slug: user.slug };
}

export async function issueSessionCookie(res: Response, user: User): Promise<void> {
  const token = await signSession(user);
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
}

// Re-export per i siti che importano da auth.ts un punto unico.
export type { User, UserRole } from './db/users.js';
// Silence "next unused" warning quando i middleware sono importati ma chiamati indirettamente.
export { Request, Response, NextFunction };
