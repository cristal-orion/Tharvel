// CLI `tharvel onboard` — pipeline unificata di onboarding sito.
//
// Modalità:
//   --repo <url>         clona un repo Git (prod / first-deploy)
//   --local-path <path>  symlink a cartella locale (dev sulla macchina del developer)
//
// Passi (MVP, parte routing Traefik è TODO finché path VPS non è verificato):
//   1. Valida slug + verifica unicità in DB
//   2. Clone o symlink dentro SITES_ROOT/<slug>
//   3. Auto-detect framework da package.json (override con --framework)
//   4. Build iniziale per framework SSG (Astro) — salta con --skip-build
//   5. Registra in DB via createSite()
//   6. Stampa riepilogo + URL di test
//
// Da implementare appena confermato l'ambiente VPS:
//   * Generazione deploy key per-repo + binding via `gh repo deploy-key add`
//   * Scrittura config Traefik dinamica in $THARVEL_TRAEFIK_DYNAMIC_DIR

import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/index.js';
import { createSite, getSiteBySlug, type SiteFramework } from '../db/sites.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITES_ROOT = process.env.THARVEL_SITES_ROOT
  ? path.resolve(process.env.THARVEL_SITES_ROOT)
  : path.resolve(__dirname, '..', '..', 'sites');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function fail(msg: string): never {
  console.error(`Errore: ${msg}`);
  process.exit(1);
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): void {
  console.log(`[run] ${cmd} ${args.join(' ')}${opts.cwd ? ` (cwd=${opts.cwd})` : ''}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd });
  if (res.status !== 0) fail(`${cmd} è uscito con codice ${res.status}`);
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
    if (deps['astro']) return 'astro';
  } catch {
    // package.json non parsabile → fallback html
  }
  return 'html';
}

function printUsage(): void {
  console.log(`Uso: onboard --slug <slug> (--repo <url> | --local-path <path>) [opzioni]

Modalità (una delle due):
  --repo <url>            Clona un repo Git in SITES_ROOT/<slug>
  --local-path <path>     Crea symlink a cartella locale (dev)

Argomenti:
  --slug <slug>           Identificatore univoco [a-z0-9-], max 31 caratteri
  --domain <host>         Dominio per lookup Host-based (opzionale ma raccomandato in prod)
  --framework html|astro  Override auto-detect da package.json
  --skip-build            Non eseguire npm install + npm run build
  -h, --help              Mostra questo messaggio

Esempi:
  onboard --slug industrial --local-path /home/michele/Desktop/Progetti/IS --framework astro
  onboard --slug acme --repo git@github.com:acme/site.git --domain acme.com
`);
}

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    repo: { type: 'string' },
    'local-path': { type: 'string' },
    domain: { type: 'string' },
    framework: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (values.help) {
  printUsage();
  process.exit(0);
}

if (!values.slug) fail('--slug è obbligatorio. Vedi --help.');
if (!values.repo && !values['local-path']) fail('Specifica --repo oppure --local-path.');
if (values.repo && values['local-path']) {
  fail('--repo e --local-path sono mutuamente esclusivi.');
}

const slug = values.slug;
if (!SLUG_RE.test(slug)) {
  fail(`Slug "${slug}" non valido. Atteso pattern: ${SLUG_RE.source}`);
}

const explicitFramework = values.framework as SiteFramework | undefined;
if (explicitFramework && explicitFramework !== 'html' && explicitFramework !== 'astro') {
  fail(`Framework "${explicitFramework}" non supportato (html|astro).`);
}

// Apre/crea DB e verifica unicità slug PRIMA di toccare il filesystem,
// così evitiamo cloni orfani in caso di conflitto.
getDb();
if (getSiteBySlug(slug)) {
  fail(`Slug "${slug}" già registrato. Scegli un altro slug o rimuovi prima quello esistente.`);
}

// SITES_ROOT può non esistere al primo onboard di una VPS pulita.
if (!existsSync(SITES_ROOT)) {
  mkdirSync(SITES_ROOT, { recursive: true });
  console.log(`[onboard] creata SITES_ROOT: ${SITES_ROOT}`);
}

const targetDir = path.join(SITES_ROOT, slug);
if (existsSync(targetDir)) {
  fail(`La destinazione esiste già sul filesystem: ${targetDir}. Rimuovila prima di riprovare.`);
}

console.log(`[onboard] slug=${slug} → ${targetDir}`);

// --- Passo 2: fetch del codice (clone vs symlink) ---
if (values['local-path']) {
  const src = path.resolve(values['local-path']);
  if (!existsSync(src)) fail(`Path locale non esiste: ${src}`);
  console.log(`[onboard] symlink ${targetDir} → ${src}`);
  symlinkSync(src, targetDir);
} else if (values.repo) {
  // git clone usa credenziali shell correnti (SSH agent, gh, https token).
  // La gestione deploy key per-repo (--use-deploy-key) verrà aggiunta dopo
  // aver verificato che gh CLI è disponibile e autenticato sulla VPS.
  run('git', ['clone', values.repo, targetDir]);
}

// --- Passo 3: framework detection ---
const framework: SiteFramework = explicitFramework ?? detectFramework(targetDir);
console.log(`[onboard] framework: ${framework}${explicitFramework ? ' (override)' : ' (auto)'}`);

// --- Passo 4: build iniziale per SSG ---
if (framework === 'astro' && !values['skip-build']) {
  console.log('[onboard] npm install + build iniziale (può richiedere 1-3 min)...');
  // `--include=dev`: il container Tharvel ha NODE_ENV=production che farebbe
  // saltare le devDependencies. Plugin Vite/Astro (es. @tailwindcss/vite)
  // stanno in devDeps ma servono al build.
  run('npm', ['install', '--include=dev'], { cwd: targetDir });
  run('npm', ['run', 'build'], { cwd: targetDir });
} else if (values['skip-build']) {
  console.log('[onboard] build saltato (--skip-build)');
}

// --- Passo 5: registrazione in DB ---
const site = createSite({
  slug,
  cwd_path: slug, // relativo a SITES_ROOT
  framework,
  domain: values.domain ?? null,
  repo_url: values.repo ?? null,
  preview_url: null,
});

// --- Passo 6: riepilogo ---
console.log('\n[onboard] ✓ sito registrato:');
console.log(site);
console.log(`\nTest UI:  http://localhost:5173/tharveladmin/?site=${slug}`);
if (values.domain) {
  console.log(`Prod:     https://${values.domain}/tharveladmin  (richiede routing Traefik sul dominio cliente)`);
}
console.log('\nProssimo: avvia ./dev.sh dalla root di tharvel/ per testare.\n');
