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

async function init(): Promise<void> {
  loading.value = true;
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
  };
}
