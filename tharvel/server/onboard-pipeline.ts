// Pipeline programmatica di onboarding sito — versione importabile riusata da
// (a) CLI `npm run onboard`, (b) endpoint admin `/api/admin/onboard-site`
// del wizard UI. Centralizza la logica così l'aggiunta di step nuovi (es. setup
// deploy key, hook post-onboard) si fa in un posto solo.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createSite, getSiteBySlug, type SiteFramework } from './db/sites.js';
import { createUser, getUserByEmail, type UserRole } from './db/users.js';
import { hashPassword } from './auth.js';
import { getInstallationToken, authenticatedRepoUrl } from './github-app.js';
import { addDomainToTharvel } from './coolify-api.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export class OnboardError extends Error {
  constructor(public step: string, message: string) {
    super(message);
    this.name = 'OnboardError';
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function detectFramework(siteDir: string): SiteFramework {
  const pkgPath = path.join(siteDir, 'package.json');
  if (!existsSync(pkgPath)) return 'html';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    // Astro è prioritario perché di solito ha anche `vite` come transitive dep
    // (Astro internamente usa Vite per il dev server e per il build dei chunk
    // client). Senza questo ordine, un sito Astro verrebbe loggato come Vite.
    if (deps['astro']) return 'astro';
    if (deps['vite']) return 'vite';
  } catch {
    // package.json non parsabile → fallback html
  }
  return 'html';
}

export interface OnboardInput {
  slug: string;
  repoUrl: string;
  clientFqdn: string;
  framework?: SiteFramework;
  clientEmail: string;
  clientPassword: string;
  sitesRoot: string;
  skipBuild?: boolean;
  // Se vuoi che il pannello finale dia un URL pubblico/https custom invece del fqdn http.
  protocol?: 'http' | 'https';
}

export interface OnboardOutput {
  siteId: number;
  userId: number;
  framework: SiteFramework;
  adminUrl: string;
  tharvelDomainsUpdated: boolean;
}

// Esegue la pipeline. Best-effort cleanup su errore: se il clone è stato fatto
// e il successivo step fallisce, rimuove la cartella per non lasciare orfani che
// bloccherebbero un retry. NON tocca DB su errore precoce (slug occupato → uscita
// prima del clone).
export async function onboardSite(input: OnboardInput): Promise<OnboardOutput> {
  // 1. Validazione slug + unicità
  if (!SLUG_RE.test(input.slug)) {
    throw new OnboardError(
      'validate',
      `Slug "${input.slug}" non valido. Atteso pattern: ${SLUG_RE.source}`,
    );
  }
  if (getSiteBySlug(input.slug)) {
    throw new OnboardError('validate', `Slug "${input.slug}" già registrato.`);
  }
  if (getUserByEmail(input.clientEmail.toLowerCase())) {
    throw new OnboardError('validate', `Email "${input.clientEmail}" già in uso.`);
  }

  // 2. Path filesystem
  if (!existsSync(input.sitesRoot)) mkdirSync(input.sitesRoot, { recursive: true });
  const targetDir = path.join(input.sitesRoot, input.slug);
  if (existsSync(targetDir)) {
    throw new OnboardError(
      'clone',
      `La cartella ${targetDir} esiste già sul filesystem. Rimuovila prima di riprovare.`,
    );
  }

  // 3. Clone autenticato (GitHub App token: copre anche repo privati cristal-orion/*)
  let cloneCompleted = false;
  try {
    const token = await getInstallationToken();
    const url = authenticatedRepoUrl(input.repoUrl, token);
    const cloneRes = await run('git', ['clone', url, targetDir]);
    if (cloneRes.code !== 0) {
      const sanitized = cloneRes.stderr.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
      throw new OnboardError('clone', `git clone fallito: ${sanitized.trim()}`);
    }
    cloneCompleted = true;

    // 4. Framework detection + build SSG
    const framework: SiteFramework = input.framework ?? detectFramework(targetDir);
    // Build pipeline identica per astro/vite (entrambi sfornano dist/).
    // Solo `html` salta il build perché i file sono già statici.
    if ((framework === 'astro' || framework === 'vite') && !input.skipBuild) {
      // `--include=dev`: NODE_ENV=production nel container Tharvel altrimenti
      // omette le devDependencies. Plugin Vite tipo @tailwindcss/vite stanno
      // in devDeps ma servono al build → senza questo, il build fallisce con
      // "Cannot find module" import dell'astro.config.
      const installRes = await run('npm', ['install', '--include=dev'], { cwd: targetDir });
      if (installRes.code !== 0) {
        throw new OnboardError('build', `npm install fallito: ${installRes.stderr.slice(-400)}`);
      }
      const buildRes = await run('npm', ['run', 'build'], { cwd: targetDir });
      if (buildRes.code !== 0) {
        // Include sia stderr sia stdout: Astro stampa l'errore su stdout dopo
        // il banner di build, lo stderr da solo non racconta la storia.
        const tail = (buildRes.stdout + buildRes.stderr).slice(-600);
        throw new OnboardError('build', `npm run build fallito: ${tail}`);
      }
    }

    // 5. INSERT sites
    const site = createSite({
      slug: input.slug,
      cwd_path: input.slug, // relativo a sitesRoot
      framework,
      domain: input.clientFqdn,
      repo_url: input.repoUrl,
    });

    // 6. INSERT user client
    const passwordHash = await hashPassword(input.clientPassword);
    const user = createUser({
      email: input.clientEmail.toLowerCase(),
      password_hash: passwordHash,
      role: 'client' as UserRole,
      slug: input.slug,
    });

    // 7. PATCH Coolify: aggiungi <clientFqdn>/tharveladmin a FQDN app Tharvel.
    // Se questo step fallisce dopo che DB è già scritto, il sito è "orfano":
    // registrato in Tharvel ma non instradato. L'utente vedrebbe un errore e
    // potrebbe aggiungere il dominio a mano da UI Coolify (caso edge raro).
    let tharvelDomainsUpdated = false;
    try {
      const protocol = input.protocol ?? 'http';
      const newDomain = `${protocol}://${input.clientFqdn}/tharveladmin`;
      const result = await addDomainToTharvel(newDomain);
      tharvelDomainsUpdated = result.added;
    } catch (e: any) {
      // Non rollback: meglio sito-orfano che cancellare un onboarding andato a buon fine.
      console.error('[onboard] FQDN PATCH fallito (sito registrato comunque):', e?.message);
    }

    const protocol = input.protocol ?? 'http';
    const adminUrl = `${protocol}://${input.clientFqdn}/tharveladmin`;
    return {
      siteId: site.id,
      userId: user.id,
      framework,
      adminUrl,
      tharvelDomainsUpdated,
    };
  } catch (err) {
    // Cleanup best-effort: se il clone è stato fatto ma uno step successivo
    // ha fallito, rimuovi la cartella così un retry non trova "directory esiste".
    // NON tocchiamo DB perché gli step DB vengono per ultimi.
    if (cloneCompleted && existsSync(targetDir)) {
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // Se anche la rimozione fallisce (permessi/file lock), lasciamo all'utente.
      }
    }
    throw err;
  }
}
