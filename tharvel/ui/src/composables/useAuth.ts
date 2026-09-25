// Composable singleton per lo stato di autenticazione lato UI.
// Lo stato è module-level così tutti i componenti condividono la stessa istanza
// (no provide/inject, no pinia per Beta).

import { ref, computed } from 'vue';
import { apiUrl } from '../site';

export type UserRole = 'admin' | 'client';

export interface SessionUser {
  id: number;
  email: string;
  role: UserRole;
  slug: string | null;
}

const user = ref<SessionUser | null>(null);
const loading = ref(true); // true finché la prima /api/me non torna
const error = ref<string | null>(null);

// Slug "attivo" — per i client coincide con user.slug; per gli admin parte dal
// primo sito disponibile e può cambiare dalla sidebar.
const adminActiveSlug = ref<string | null>(null);

const activeSlug = computed<string | null>(() => {
  if (!user.value) return null;
  if (user.value.role === 'client') return user.value.slug;
  return adminActiveSlug.value;
});

// Bypass auth in dev: se VITE_DEV_BYPASS_AUTH=1 (vedi .env.local) saltiamo il
// roundtrip a /api/me e popoliamo un admin finto. Utile per iterare sulla UI
// senza dover avviare backend + DB. Non viene MAI eseguito in build di prod
// (import.meta.env.DEV guard).
const DEV_BYPASS =
  import.meta.env.DEV && import.meta.env.VITE_DEV_BYPASS_AUTH === '1';

function expireSession(): void {
  if (!user.value) return;
  user.value = null;
  adminActiveSlug.value = null;
  loading.value = false;
  error.value = 'La sessione è scaduta o non è più valida. Accedi di nuovo per continuare.';
}

// Every authenticated API request handles expiry consistently. A late 401 from
// an old session must not sign out an account that has logged in in the meantime.
export async function authFetch(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const requestUser = user.value;
  const response = await fetch(input, options);
  if (response.status === 401 && requestUser && user.value === requestUser) expireSession();
  return response;
}

let revalidation: Promise<void> | null = null;
function revalidate(): Promise<void> {
  if (!user.value || DEV_BYPASS) return Promise.resolve();
  if (!revalidation) {
    revalidation = authFetch(apiUrl('/api/me'), { credentials: 'include' })
      .then(() => {})
      // A network failure is not an expired login; keep normal offline recovery.
      .catch(() => {})
      .finally(() => { revalidation = null; });
  }
  return revalidation;
}

async function init(): Promise<void> {
  loading.value = true;
  if (DEV_BYPASS) {
    user.value = {
      id: 0,
      email: 'dev@tharvel.local',
      role: 'admin',
      slug: null,
    };
    loading.value = false;
    return;
  }
  try {
    const res = await fetch(apiUrl('/api/me'), { credentials: 'include' });
    if (res.ok) {
      const body = await res.json();
      user.value = body.user;
    } else {
      user.value = null;
    }
  } catch {
    user.value = null;
  } finally {
    loading.value = false;
  }
}

async function login(email: string, password: string): Promise<void> {
  error.value = null;
  const res = await fetch(apiUrl('/api/login'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    let msg = 'login fallito';
    try {
      const body = await res.json();
      msg = body.error || msg;
    } catch {
      // body non JSON
    }
    error.value = msg;
    throw new Error(msg);
  }
  const body = await res.json();
  user.value = body.user;
}

async function logout(): Promise<void> {
  await fetch(apiUrl('/api/logout'), { method: 'POST', credentials: 'include' });
  user.value = null;
  adminActiveSlug.value = null;
  error.value = null;
}

function setAdminActiveSlug(slug: string): void {
  if (user.value?.role === 'admin') {
    adminActiveSlug.value = slug;
  }
}

export function useAuth() {
  return {
    user,
    loading,
    error,
    activeSlug,
    init,
    login,
    logout,
    setAdminActiveSlug,
    expireSession,
    revalidate,
  };
}
