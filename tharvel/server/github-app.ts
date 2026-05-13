// Ottiene installation token short-lived dalla GitHub App `coolify-pawmatch`
// per autenticare i `git push` durante il publish. È lo stesso meccanismo che
// usa Coolify per clonare i repo cliente: niente PAT da gestire, niente
// rotazione manuale, scope ristretto all'installazione (cristal-orion/*).
//
// Flow GitHub App:
//   1. Si firma un JWT (RS256) con la private key, claim iss=APP_ID, exp ≤ 10min.
//   2. Si chiama POST /app/installations/{id}/access_tokens con quel JWT.
//   3. GitHub ritorna un token `ghs_...` valido 1h con i permessi
//      dell'installazione (Contents: read/write per noi).
//
// Cache: il token è riutilizzato finché manca >5min alla scadenza, così non
// generiamo un nuovo token per ogni push.

import { createSign, createPrivateKey, type KeyObject } from 'node:crypto';

interface CachedToken {
  token: string;
  expiresAt: number; // ms epoch
}

let cached: CachedToken | null = null;
let cachedKey: KeyObject | null = null;

function getPrivateKey(): KeyObject {
  if (cachedKey) return cachedKey;
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!raw) {
    throw new Error('GITHUB_APP_PRIVATE_KEY non impostata (env Coolify).');
  }
  // Coolify a volte salva con \r\n o senza newline reali: normalizza.
  const pem = raw.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  cachedKey = createPrivateKey(pem);
  return cachedKey;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signAppJwt(): string {
  const appId = process.env.GITHUB_APP_ID;
  if (!appId) throw new Error('GITHUB_APP_ID non impostato.');

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      iat: now - 60, // clock skew tollerato da GitHub
      exp: now + 9 * 60, // max 10min, GitHub rifiuta oltre
      iss: appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(getPrivateKey());
  return `${signingInput}.${signature.toString('base64url')}`;
}

export async function getInstallationToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  if (!installationId) throw new Error('GITHUB_APP_INSTALLATION_ID non impostato.');

  const jwt = signAppJwt();
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tharvel-publish',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub installation token API ${res.status}: ${body}`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  cached = {
    token: body.token,
    expiresAt: new Date(body.expires_at).getTime(),
  };
  return body.token;
}

// Costruisce URL HTTPS autenticato per `git push`. Il token va in posizione di
// "username" tipo x-access-token (convenzione GitHub App / installation).
export function authenticatedRepoUrl(repoUrl: string, token: string): string {
  // Accetta sia https://github.com/owner/repo(.git) sia git@github.com:owner/repo.git.
  // Per SSH non possiamo usare il token (servirebbe deploy key); convertiamo a HTTPS.
  if (repoUrl.startsWith('git@github.com:')) {
    const path = repoUrl.replace('git@github.com:', '').replace(/\.git$/, '');
    return `https://x-access-token:${token}@github.com/${path}.git`;
  }
  if (repoUrl.startsWith('https://github.com/')) {
    return repoUrl.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
  }
  throw new Error(`URL repo non riconosciuto (atteso GitHub https/ssh): ${repoUrl}`);
}
