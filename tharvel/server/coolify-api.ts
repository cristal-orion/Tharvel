// Client server-side dell'API Coolify v4.
// Usato dal wizard di onboarding admin (endpoint /api/admin/onboard-site)
// per: (1) verificare che un repo cliente sia già configurato come app Coolify
// e ricavarne FQDN/branch/framework, (2) aggiungere il dominio cliente come
// FQDN aggiuntivo dell'app Tharvel così Traefik lo intercetta su /tharveladmin.
//
// Auth: bearer token "Read & Write" generato dall'utente in Coolify
// (Profile → Keys & Tokens → API Tokens). Env COOLIFY_API_URL +
// COOLIFY_API_TOKEN. Da dentro la rete docker `coolify` il container Coolify
// è raggiungibile su `http://coolify:8080`.

function apiBase(): string {
  const url = process.env.COOLIFY_API_URL;
  if (!url) throw new Error('COOLIFY_API_URL non impostata (atteso es. http://coolify:8080/api/v1).');
  return url.replace(/\/$/, '');
}

function authHeader(): string {
  const t = process.env.COOLIFY_API_TOKEN;
  if (!t) throw new Error('COOLIFY_API_TOKEN non impostato (genera in Coolify UI).');
  return `Bearer ${t}`;
}

async function coolifyFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Coolify API ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 400)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Forme parziali utilizzate dal wizard. Coolify ritorna molto di più, prendiamo
// solo i campi che ci servono per evitare lock-in stretto sulla loro schema.
export interface CoolifyApplicationSummary {
  uuid: string;
  name: string;
  fqdn: string | null;
  git_repository: string | null;
  git_branch: string | null;
  build_pack: string | null;
  status: string;
}

export interface CoolifyApplicationDetail extends CoolifyApplicationSummary {
  description: string | null;
  ports_exposes: string | null;
  dockerfile_location: string | null;
}

export async function listApplications(): Promise<CoolifyApplicationSummary[]> {
  return coolifyFetch<CoolifyApplicationSummary[]>('/applications');
}

export async function getApplication(uuid: string): Promise<CoolifyApplicationDetail> {
  return coolifyFetch<CoolifyApplicationDetail>(`/applications/${uuid}`);
}

// Normalizza URL repo per confronto: rimuove `.git`, prefisso `https://`/`git@`,
// case-insensitive sul dominio. Così "https://github.com/foo/bar.git" e
// "git@github.com:foo/bar" matchano lo stesso repo.
function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '');
}

// Spezza il campo `fqdn` CSV di Coolify in array, preservando lo schema (http/https)
// così il chiamante può sapere come è esposto ogni dominio. Filtra entries vuote.
export function splitFqdns(fqdnField: string | null): string[] {
  if (!fqdnField) return [];
  return fqdnField
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Decide il FQDN "preferito" per il wizard di onboarding. Strategia:
// 1) preferisci HTTPS (cert già configurato per quel host)
// 2) preferisci NON-sslip.io (= dominio reale del cliente)
// 3) in pari merito, primo della lista (ordine Coolify)
// Ritorna null se la lista è vuota.
export function pickRecommendedFqdn(fqdns: string[]): string | null {
  if (fqdns.length === 0) return null;
  const score = (url: string): number => {
    let s = 0;
    if (url.startsWith('https://')) s += 2;
    if (!/sslip\.io(\/|$)/i.test(url)) s += 4;
    return s;
  };
  return [...fqdns].sort((a, b) => score(b) - score(a))[0];
}

export async function findApplicationByRepo(
  repoUrl: string,
): Promise<CoolifyApplicationSummary | null> {
  const target = normalizeRepoUrl(repoUrl);
  if (!target) return null;
  const apps = await listApplications();
  for (const app of apps) {
    if (!app.git_repository) continue;
    if (normalizeRepoUrl(app.git_repository) === target) return app;
  }
  return null;
}

// PATCH application: passiamo solo i campi che cambiamo (Coolify accetta diff parziali).
// Per Tharvel: aggiungiamo il dominio cliente con prefix /tharveladmin all'elenco FQDN,
// preservando quelli esistenti.
export async function updateApplicationDomains(uuid: string, domains: string): Promise<void> {
  await coolifyFetch(`/applications/${uuid}`, {
    method: 'PATCH',
    body: JSON.stringify({ domains }),
  });
}

// Aggiunge un FQDN (con eventuale path) all'app Tharvel (uuid da env THARVEL_APP_UUID).
// Idempotente: se il dominio è già presente, no-op.
export async function addDomainToTharvel(newDomainWithPath: string): Promise<{ added: boolean; allDomains: string }> {
  const tharvelUuid = process.env.THARVEL_APP_UUID;
  if (!tharvelUuid) throw new Error('THARVEL_APP_UUID non impostato.');
  const app = await getApplication(tharvelUuid);
  const existing = (app.fqdn ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (existing.some((d) => d.toLowerCase() === newDomainWithPath.toLowerCase())) {
    return { added: false, allDomains: existing.join(',') };
  }
  const updated = [...existing, newDomainWithPath].join(',');
  await updateApplicationDomains(tharvelUuid, updated);
  return { added: true, allDomains: updated };
}
