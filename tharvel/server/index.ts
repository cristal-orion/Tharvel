import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import { createServer, IncomingMessage } from 'http';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'node:url';
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import sharp from 'sharp';
import { getDb } from './db/index.js';
import { listSites, getSiteBySlug, getSiteByDomain, type Site } from './db/sites.js';
import { getUserByEmail } from './db/users.js';
import { publishSite } from './publish.js';
import { findApplicationByRepo, getApplication, splitFqdns, pickRecommendedFqdn } from './coolify-api.js';
import { onboardSite, OnboardError } from './onboard-pipeline.js';
import { autoCommitTurn } from './auto-commit.js';
import { ensurePreviewBranch } from './preview-branch.js';
import { ensurePiSettings } from './pi-settings.js';
import {
  getLastTurnRevision,
  getRevisionById,
  listRevisionsBySite,
  deleteRevisionById,
  deleteTurnsFromId,
} from './db/revisions.js';
import { resetPreviewTo, rebuildSite } from './revisions-ops.js';
import {
  requireAuth,
  requireAdmin,
  verifyPassword,
  verifySession,
  issueSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
  publicUser,
} from './auth.js';

dotenv.config();

// Prefisso path "esposto" su cui Tharvel è montato sul dominio del cliente.
// Il proxy (Traefik configurato da Coolify) fa StripPrefix di questo path prima
// di inoltrare al container, quindi il server riceve URL già senza prefisso e
// resta montato a root. Il valore qui serve solo per RIEMETTERE il prefisso
// negli HTML che torniamo al browser (rewriteHtmlForTenant): l'iframe della
// preview deve generare link che il proxy possa rinviare di nuovo a Tharvel,
// altrimenti caddono sul sito pubblicato del cliente.
// Identico a `base` in ui/vite.config.ts e BASE_PATH in ui/src/site.ts.
const BASE_PATH = '/tharveladmin';

// Inizializza DB SQLite (crea il file + schema al primo avvio).
// Multi-tenancy: la tabella `sites` mappa slug/domain → cwd_path.
getDb();
console.log(`[DB] sites registrati: ${listSites().length}`);

// Root dei siti gestiti. Default: tharvel/sites/ (sibling di server/).
// Override via env per prod (es. /var/tharvel/sites).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITES_ROOT = process.env.THARVEL_SITES_ROOT
  ? path.resolve(process.env.THARVEL_SITES_ROOT)
  : path.resolve(__dirname, '..', 'sites');
console.log(`[SITES] root: ${SITES_ROOT}`);

// Risolve il cwd assoluto di un sito.
// Se cwd_path è relativo, lo risolve contro SITES_ROOT; se è assoluto lo usa così com'è.
function resolveSiteCwd(site: Site): string {
  return path.isAbsolute(site.cwd_path)
    ? site.cwd_path
    : path.join(SITES_ROOT, site.cwd_path);
}

// Cartella da servire al browser come "preview" del sito.
// - html: serve direttamente il cwd (index.html alla root, assets/ accanto).
// - astro/vite: serve cwd/dist/ perché i sorgenti (.astro/.tsx/.vue) non sono
//   HTML eseguibili. Il cwd dell'agente resta la root del progetto, così
//   l'agente vede i sorgenti + package.json per lanciare `npm run build`.
function resolveSiteServeRoot(site: Site): string {
  const cwd = resolveSiteCwd(site);
  if (site.framework === 'astro' || site.framework === 'vite') {
    return path.join(cwd, 'dist');
  }
  return cwd;
}

// Cartella in cui depositare gli upload (immagini compresse, file utente).
// Per Astro/Vite va in public/ (entrambi i framework la copiano 1:1 in dist/
// al build successivo). Per html resta assets/ accanto a index.html.
function resolveSiteUploadsDir(site: Site): string {
  const cwd = resolveSiteCwd(site);
  if (site.framework === 'astro' || site.framework === 'vite') {
    return path.join(cwd, 'public');
  }
  return path.join(cwd, 'assets');
}

// Dispatch per-connection ibrido:
//  1) ?site=<slug> nella query string → override esplicito (test, admin multi-sito)
//  2) altrimenti X-Forwarded-Host (Nginx) o Host header → lookup per dominio
// Ritorna null se nessuna delle due strade trova un sito registrato.
function resolveSiteFromRequest(req: IncomingMessage): Site | null {
  const url = new URL(req.url || '/', 'http://localhost');
  const slug = url.searchParams.get('site');
  if (slug) {
    return getSiteBySlug(slug); // null se slug esplicito ma inesistente: rifiutiamo
  }
  const rawHost = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
  const host = rawHost.split(':')[0];
  if (host) {
    return getSiteByDomain(host);
  }
  return null;
}

const app = express();
const server = createServer(app);
// Il proxy fa StripPrefix di BASE_PATH per i tenant, quindi il WS handshake
// arriva qui sempre su `/` (con query string `?site=...`). Niente filtro di path:
// la logica di "sito sconosciuto" la gestisce resolveSiteFromRequest dentro
// l'handler di connection.
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(cookieParser());

// --- Strato 4 (auth) — endpoint identity. Vivono PRIMA delle route /site e dello
// static UI così non vengono mangiati dal middleware-fallback SPA.
app.post('/api/login', async (req, res) => {
  const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'email e password richiesti' });
    return;
  }
  const user = getUserByEmail(email.trim().toLowerCase());
  // Verifico la password anche se utente non esiste (tempo costante-ish, evita user enumeration).
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: 'credenziali invalide' });
    return;
  }
  await issueSessionCookie(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Lista siti per la sidebar admin (decisione 6.1 del doc security: gated su role=admin).
app.get('/api/sites', requireAuth, requireAdmin, (_req, res) => {
  const sites = listSites().map((s) => ({
    id: s.id,
    slug: s.slug,
    domain: s.domain,
    framework: s.framework,
  }));
  res.json({ sites });
});

// --- Storico modifiche / undo / restore (Strato Undo).
// Auth: admin OR client.slug === :slug (stesso pattern dell'iframe /site/:slug).
function canAccessSlug(reqUser: { role: string; slug?: string | null }, slug: string): boolean {
  return reqUser.role === 'admin' || reqUser.slug === slug;
}

app.get('/api/session/:slug/history', requireAuth, (req, res) => {
  const slug = req.params.slug;
  if (!canAccessSlug(req.user!, slug)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const site = getSiteBySlug(slug);
  if (!site) {
    res.status(404).json({ error: 'site not found' });
    return;
  }
  const rows = listRevisionsBySite(site.id, 100);
  res.json({
    revisions: rows.map((r) => ({
      id: r.id,
      commit_sha: r.commit_sha,
      parent_sha: r.parent_sha,
      user_prompt: r.user_prompt,
      summary: r.summary,
      files_changed: JSON.parse(r.files_changed || '[]'),
      kind: r.kind,
      superseded: r.superseded_at !== null,
      created_at: r.created_at,
    })),
  });
});

// Annulla l'ultimo turn ripristinabile: reset --hard al parent dell'ultima
// revisione 'turn' non superseded. Cancella quella riga dal DB.
app.post('/api/session/:slug/undo', requireAuth, async (req, res) => {
  const slug = req.params.slug;
  if (!canAccessSlug(req.user!, slug)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const site = getSiteBySlug(slug);
  if (!site) {
    res.status(404).json({ error: 'site not found' });
    return;
  }
  const last = getLastTurnRevision(site.id);
  if (!last) {
    res.status(409).json({ error: 'Nessuna modifica da annullare.' });
    return;
  }
  if (!last.parent_sha) {
    res.status(409).json({ error: 'Impossibile annullare: questa è la prima modifica registrata.' });
    return;
  }
  const cwd = resolveSiteCwd(site);
  const reset = await resetPreviewTo(cwd, last.parent_sha);
  if (!reset.ok) {
    res.status(500).json({ error: reset.message });
    return;
  }
  deleteRevisionById(last.id, site.id);
  const rebuild = await rebuildSite(cwd, site.framework);
  res.json({
    ok: true,
    undone: {
      id: last.id,
      summary: last.summary,
      commit_sha: last.commit_sha,
    },
    rebuild,
  });
});

// Ripristina lo stato precedente alla revisione X: reset --hard a parent_sha
// di quella revisione, cancella dal DB tutte le revisioni 'turn' con id >= X.
app.post('/api/session/:slug/restore/:revisionId', requireAuth, async (req, res) => {
  const slug = req.params.slug;
  if (!canAccessSlug(req.user!, slug)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const site = getSiteBySlug(slug);
  if (!site) {
    res.status(404).json({ error: 'site not found' });
    return;
  }
  const revId = parseInt(req.params.revisionId, 10);
  if (!Number.isFinite(revId)) {
    res.status(400).json({ error: 'revisionId non valido' });
    return;
  }
  const rev = getRevisionById(revId, site.id);
  if (!rev) {
    res.status(404).json({ error: 'revisione non trovata' });
    return;
  }
  if (rev.kind !== 'turn' || rev.superseded_at !== null) {
    res.status(409).json({ error: 'Revisione non ripristinabile (già pubblicata o archiviata).' });
    return;
  }
  if (!rev.parent_sha) {
    res.status(409).json({ error: 'Revisione senza parent: impossibile ripristinare lo stato precedente.' });
    return;
  }
  const cwd = resolveSiteCwd(site);
  const reset = await resetPreviewTo(cwd, rev.parent_sha);
  if (!reset.ok) {
    res.status(500).json({ error: reset.message });
    return;
  }
  const removed = deleteTurnsFromId(site.id, rev.id);
  const rebuild = await rebuildSite(cwd, site.framework);
  res.json({
    ok: true,
    restored_to_parent_of: rev.id,
    removed_revisions: removed,
    rebuild,
  });
});

// Wizard onboarding (admin-only) — vedi project_tharvel memory.
// Step "lookup": dato un URL repo, cerca l'app Coolify corrispondente e ritorna
// FQDN/branch/framework così il form UI può precompilare il resto.
app.get('/api/admin/coolify-app-by-repo', requireAuth, requireAdmin, async (req, res) => {
  const url = String(req.query.url ?? '').trim();
  if (!url) {
    res.status(400).json({ error: 'parametro `url` richiesto (URL repo GitHub)' });
    return;
  }
  try {
    const app = await findApplicationByRepo(url);
    if (!app) {
      res.status(404).json({ error: 'Nessuna app Coolify trovata per questo repo. Crea prima l\'app su Coolify.' });
      return;
    }
    // Recupero dettagli (l'endpoint list non sempre ha tutti i campi popolati).
    const detail = await getApplication(app.uuid);
    const fqdns = splitFqdns(detail.fqdn);
    res.json({
      uuid: detail.uuid,
      name: detail.name,
      fqdn: detail.fqdn, // backward-compat: CSV originale
      fqdns,             // array già splittato, preserva schema https/http
      recommendedFqdn: pickRecommendedFqdn(fqdns),
      git_repository: detail.git_repository,
      git_branch: detail.git_branch,
      build_pack: detail.build_pack,
    });
  } catch (e: any) {
    res.status(502).json({ error: `Errore API Coolify: ${e?.message ?? String(e)}` });
  }
});

// Step "esegui": pipeline completa di onboarding sito.
app.post('/api/admin/onboard-site', requireAuth, requireAdmin, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const repoUrl = typeof body.repoUrl === 'string' ? body.repoUrl.trim() : '';
  const clientFqdn = typeof body.clientFqdn === 'string' ? body.clientFqdn.trim() : '';
  const clientEmail = typeof body.clientEmail === 'string' ? body.clientEmail.trim() : '';
  const clientPassword = typeof body.clientPassword === 'string' ? body.clientPassword : '';
  const framework = body.framework as 'html' | 'astro' | undefined;

  if (!slug || !repoUrl || !clientFqdn || !clientEmail || !clientPassword) {
    res.status(400).json({
      error: 'Campi richiesti: slug, repoUrl, clientFqdn, clientEmail, clientPassword.',
    });
    return;
  }
  if (clientPassword.length < 8) {
    res.status(400).json({ error: 'Password troppo corta (min 8 caratteri).' });
    return;
  }

  try {
    const result = await onboardSite({
      slug,
      repoUrl,
      clientFqdn,
      framework,
      clientEmail,
      clientPassword,
      sitesRoot: SITES_ROOT,
    });
    res.json(result);
  } catch (e: any) {
    if (e instanceof OnboardError) {
      res.status(400).json({ error: e.message, step: e.step });
    } else {
      console.error('[onboard-site] errore inatteso:', e);
      res.status(500).json({ error: `Errore inatteso: ${e?.message ?? String(e)}` });
    }
  }
});

// Overlay Tharvel (CSS + JS per Alt+click) iniettato negli HTML dei siti che non
// includono già lo snippet (es. build Astro). Caricato una volta sola al boot.
import { readFileSync, existsSync } from 'node:fs';
const THARVEL_OVERLAY = readFileSync(path.resolve(__dirname, 'overlay.html'), 'utf-8');

// Riscrive gli href/src "assoluti dalla root" con il prefisso BASE_PATH/site/<slug>/.
// Necessario per i siti SSG (Astro & co.) buildati con base path arbitrario:
// Astro applica `base` agli asset compilati, ma i link <a href="/about/"> nei
// template restano grezzi e finirebbero fuori dal mount del tenant.
// Senza il BASE_PATH davanti, su un dominio cliente i link assoluti uscirebbero
// completamente dal namespace Tharvel e cadrebbero sul sito pubblicato.
//
// Match: attributo (href|src) seguito da "/" SINGOLO (no //, no http://, ecc.).
// Non tocca: //cdn..., http(s)://..., data:, mailto:, # ancore, path relativi.
function rewriteHtmlForTenant(html: string, slug: string): string {
  const prefix = `${BASE_PATH}/site/${slug}`;
  return html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${prefix}/`);
}

// Inietta l'overlay Tharvel prima di </body>. Idempotente: se per caso lo script
// è già presente (siti Tharvel-aware tipo demo) lo skippa.
function injectOverlay(html: string): string {
  if (html.includes('THARVEL_ELEMENT_SELECTED')) return html;
  return html.replace(/<\/body>/i, `${THARVEL_OVERLAY}\n</body>`);
}

// Static serve scoped per tenant: /site/<slug>/... → cwd del sito risolto via DB.
// Per Astro: HTML viene riscritto al volo (href/src + overlay). Asset → static puro.
// Per html: tutto static (i siti Tharvel-aware hanno già lo script inline).
// Mount a root: il proxy strippa BASE_PATH prima di arrivare qui.
// Strato 4: richiede auth + per role=client il slug DEVE coincidere con user.slug.
// (Senza questo check un client autenticato potrebbe visualizzare la preview di
// un altro tenant manipolando l'URL dell'iframe.)
const staticHandlerCache = new Map<string, express.RequestHandler>();
app.use('/site/:slug', requireAuth, async (req, res, next) => {
  const slug = req.params.slug;
  if (req.user!.role !== 'admin' && req.user!.slug !== slug) {
    res.status(403).send('forbidden');
    return;
  }
  const site = getSiteBySlug(slug);
  if (!site) {
    res.status(404).send(`Site '${slug}' not found`);
    return;
  }

  // Per Astro/Vite intercettiamo solo le richieste HTML (root, /pagina/, *.html).
  // Tutto il resto (asset _astro/, /assets/, immagini, font) passa allo static handler sotto.
  // Vite genera un solo index.html in dist/, ma gli `href`/`src` interni sono
  // assoluti (`/favicon.svg`, `/assets/...`) → senza rewrite escono dal namespace
  // /tharveladmin/site/<slug>/ e tornano 404.
  if (site.framework === 'astro' || site.framework === 'vite') {
    const reqPath = req.path;
    const isHtml =
      reqPath === '/' ||
      reqPath.endsWith('/') ||
      reqPath.endsWith('.html');
    if (isHtml) {
      const serveRoot = resolveSiteServeRoot(site);
      const filePath = reqPath.endsWith('.html')
        ? path.join(serveRoot, reqPath)
        : path.join(serveRoot, reqPath, 'index.html');
      // Path traversal guard: dopo path.join il risultato deve restare dentro serveRoot.
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(serveRoot) + path.sep) && resolved !== path.resolve(serveRoot)) {
        res.status(400).send('Bad path');
        return;
      }
      try {
        let html = await fs.readFile(resolved, 'utf-8');
        html = rewriteHtmlForTenant(html, slug);
        html = injectOverlay(html);
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        res.send(html);
        return;
      } catch (e) {
        // File non trovato → lascia gestire al fallback static (che farà 404).
      }
    }
  }

  let handler = staticHandlerCache.get(slug);
  if (!handler) {
    const serveRoot = resolveSiteServeRoot(site);
    handler = express.static(serveRoot);
    staticHandlerCache.set(slug, handler);
    console.log(`[STATIC] '${slug}' (${site.framework}) servito da ${serveRoot}`);
  }
  return handler(req, res, next);
});

// Rende un nome file sicuro per il filesystem e per il parser XML dei tool dell'LLM
// (no spazi, no punti multipli, no caratteri speciali). L'estensione viene preservata.
function sanitizeFileName(name: string): string {
  const parsed = path.parse(name);
  const base = parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file';
  return base + parsed.ext.toLowerCase();
}

// Endpoint WS chiamato dal widget Tharvel: la connessione è autenticata via cookie
// di sessione (Strato 4) e scoped per slug.
// - role=client: lo slug viene dal token, l'eventuale ?site= è ignorato (no cross-tenant).
// - role=admin: ?site= esplicito permesso (per la sidebar selettore siti),
//   fallback host header come prima.
wss.on('connection', async (ws, req) => {
  const token = parseSessionCookie(req.headers.cookie);
  const user = await verifySession(token);
  if (!user) {
    console.warn(`[WS] connessione rifiutata: non autenticato (url=${req.url})`);
    ws.close(1008, 'unauthorized');
    return;
  }

  let site: Site | null = null;
  if (user.role === 'client') {
    site = user.slug ? getSiteBySlug(user.slug) : null;
  } else {
    site = resolveSiteFromRequest(req);
  }
  if (!site) {
    const reqHost = req.headers['x-forwarded-host'] || req.headers.host || '(none)';
    console.warn(
      `[WS] connessione rifiutata: nessun sito per user=${user.email} role=${user.role} url=${req.url} host=${reqHost}`,
    );
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Sito non riconosciuto.',
    }));
    ws.close(1008, 'unknown site');
    return;
  }
  console.log(
    `[WS] connessione accettata: user=${user.email} role=${user.role} site='${site.slug}' (id=${site.id})`,
  );

  try {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    const sitePath = resolveSiteCwd(site);

    // System prompt parametrizzato sul framework del sito.
    // - html: file piatti (index.html + assets/), edit visibile subito.
    // - astro: sorgenti in src/ (.astro/.md/.mdx), asset in public/, dopo l'edit
    //   serve `npm run build` per rigenerare dist/ (che è quello servito al browser).
    const vitePrompt = `Sei Tharvel, l'agente AI esperto per la gestione del sito Vite "${site.slug}" (React/Vue/Svelte/altro a seconda del progetto, controlla package.json).

Struttura del progetto (cartella corrente):
- "src/": sorgenti applicazione (componenti, pagine, stili). Punto di partenza per esplorare.
- "public/": file statici copiati 1:1 in dist/ (immagini, favicon, font). Le immagini caricate dall'utente finiscono qui.
- "index.html": entry point dell'app, ROOT del progetto Vite (NON dentro src/).
- "vite.config.*": config del bundler. Non toccare a meno di richiesta esplicita.
- "package.json": script (build/dev/preview) e dipendenze. Non toccare a meno di richiesta esplicita.
- "dist/": OUTPUT del build, NON modificare a mano (viene rigenerato).

CARTELLE DA NON ESPLORARE MAI:
- "node_modules/": dipendenze NPM, decine di migliaia di file.
- ".git/": metadati git interni.
- "dist/": output di build, asset hashati che cambiano ad ogni build.

Quando usi ls/find/grep, parti SEMPRE da src/ o public/, MAI dalla root con tutte le cartelle.

Flusso di lavoro:
1. Quando l'utente chiede una modifica, USA SEMPRE gli strumenti (read, edit, write) per applicarla realmente.
2. Prima di "edit", usa sempre "read" per leggere il contenuto esatto.
3. Modifica i SORGENTI in src/ (e/o public/), MAI dist/.
4. Dopo aver applicato modifiche ai sorgenti, ricompila eseguendo \`npm run build\` con il tool bash. Il preview mostra dist/ e si aggiorna solo dopo il build.
5. Non chiedere mai conferma prima di usare uno strumento: agisci autonomo.
6. Parla in italiano in modo conciso e professionale. La tua risposta finale (1-2 frasi) va in CHAT — non scriverla mai dentro a un file del sito.

DUE CANALI SEPARATI:
- **Contenuto del SITO**: codice/markup in src/ o public/. Modificalo SOLO per cambiare cosa si vede sul sito.
- **CHAT con l'utente**: risposta finale a parole, che spiega cosa hai fatto. Va prodotta come output testuale, MAI come edit a un file del sito.

L'edit di un file del sito deve essere CHIRURGICO: cambia SOLO ciò che l'utente ha chiesto.

PUBBLICAZIONE:
- Quando l'utente chiede di "pubblicare" / "mandare online" / "rendere live", USA il tool "publish_site" passando un commit message conciso (1 riga, IT) che riassuma cosa hai cambiato in questa sessione.
- NON usare il tool bash per fare git add/commit/push manualmente.
- Se publish_site fallisce per "modifiche remote più recenti" (non-fast-forward), esegui \`git pull --rebase\` con il bash e richiama publish_site automaticamente, senza chiedere conferma.

IMMAGINI AI:
- Se l'utente chiede esplicitamente di "genera/crea un'immagine" (es. "fammi un'immagine hero di una fabbrica", "crea una foto stilizzata di un panino"), usa il tool "image_generation". Salva il file in public/ (per Vite/Astro/SPA) o nella cartella appropriata.
- Dopo la generazione, modifica il sorgente del componente per usare la nuova immagine (es. \`<img src="/nome-file.webp">\`) e poi rifai \`npm run build\`.
- Per ANALIZZARE un'immagine esistente del sito (es. "guarda il logo e fammelo più scuro nello sfondo"), usa "view_image" sul path della risorsa.
- NON usare image_generation se l'utente sta caricando un suo file via drag-and-drop — quello passa già dal tool process_uploaded_file.`;

    const agentsContent = site.framework === 'vite'
      ? vitePrompt
      : site.framework === 'astro'
      ? `Sei Tharvel, l'agente AI esperto per la gestione del sito Astro "${site.slug}".

Struttura del progetto (cartella corrente):
- "src/pages/": pagine del sito (.astro, .md, .mdx). Modificare qui per cambiare contenuto/layout di una pagina.
- "src/components/": componenti riusabili.
- "src/layouts/": layout condivisi.
- "src/content/" (se presente): content collections in markdown/MDX (post, articoli).
- "public/": file statici copiati 1:1 in dist/ (immagini, favicon, robots.txt). Le immagini caricate dall'utente finiscono qui.
- "package.json", "astro.config.*": config del progetto. Non toccarli a meno che l'utente non lo chieda esplicitamente.
- "dist/": OUTPUT del build, NON modificare a mano (viene rigenerato).

CARTELLE DA NON ESPLORARE MAI (sono enormi e satureranno il context):
- "node_modules/": dipendenze NPM, decine di migliaia di file. NON fare ls/find/cat qui dentro.
- ".git/": metadati git interni.
- "dist/": output di build, contiene asset hashati che cambiano ad ogni build.
- "public/_astro/" se presente: asset generati.
Quando esegui comandi bash come ls/find/grep, escludi sempre queste cartelle (es: \`find . -path ./node_modules -prune -o -type f -print\` oppure usa \`ls src/\` invece di \`ls\`).

Flusso di lavoro:
1. Quando l'utente chiede una modifica, USA SEMPRE gli strumenti (read, edit, write) per applicarla realmente. Non limitarti a spiegare a parole, FALLO TU.
2. Prima di "edit", usa sempre "read" per leggere il contenuto esatto.
3. Per ESPLORARE il progetto, parti da "src/" e "public/" (NON dalla root, perché contiene node_modules/). Esempio: \`ls src/pages\`, \`ls src/components\`.
4. Modifica i SORGENTI in src/ (e/o public/), MAI dist/.
5. Dopo aver applicato modifiche ai sorgenti, ricompila il sito eseguendo \`npm run build\` con il tool bash. Il preview del browser mostra dist/ e si aggiorna solo dopo il build.
6. Non chiedere mai conferma prima di usare uno strumento: agisci in modo autonomo.
7. Parla in italiano in modo conciso e professionale. La tua risposta finale (1-2 frasi) va in CHAT — non scriverla mai dentro a un file del sito.

DUE CANALI SEPARATI — non confonderli MAI:
- **Contenuto del SITO**: testo/HTML che finisce dentro src/pages, src/components, src/layouts. Modificalo SOLO se l'utente ti chiede di cambiare cosa si vede sul sito (titoli, paragrafi, traduzioni, layout).
- **CHAT con l'utente**: la tua risposta finale a parole, che spiega all'utente cosa hai fatto. Va prodotta come normale output testuale, MAI come edit a un file del sito.

ESEMPIO di errore da NON fare:
- Utente: "cambia il titolo della home in 'Benvenuti'"
- SBAGLIATO: scrivere in src/pages/index.astro un paragrafo tipo "Ho cambiato il titolo, ora la home dice Benvenuti, ho anche tradotto..."
- CORRETTO: edit chirurgico di src/pages/index.astro che sostituisce SOLO il titolo con "Benvenuti", poi in chat un testo breve "Fatto, ho aggiornato il titolo della home."

L'edit di un file del sito deve essere CHIRURGICO: cambia SOLO ciò che l'utente ha chiesto, non riscrivere intere pagine né aggiungere contenuti non richiesti.

PUBBLICAZIONE:
- Quando l'utente chiede di "pubblicare", "mandare online", "rendere live", "fare push" le modifiche, USA il tool "publish_site" passando un commit message conciso (1 riga, IT) che riassuma cosa hai cambiato in questa sessione.
- NON usare il tool bash per fare git add/commit/push manualmente: il tool publish_site gestisce auth, branch e push in modo sicuro.
- Dopo che il tool ritorna, riporta in chat l'esito (es. "Pubblicato. Il sito verrà rideployato a breve" oppure "Niente da pubblicare").
- SE publish_site fallisce perché "il repository remoto contiene modifiche più recenti" (non-fast-forward, rejected), NON chiedere conferma all'utente: esegui automaticamente \`git pull --rebase origin <branch-corrente>\` con il tool bash (per ricavare il branch usa \`git rev-parse --abbrev-ref HEAD\`), poi richiama publish_site con lo stesso commit message. Riporta in chat solo l'esito finale.

IMMAGINI AI:
- Se l'utente chiede esplicitamente di "genera/crea un'immagine" (es. "fammi un'immagine hero di una fabbrica industriale moderna", "crea una foto stilizzata di un panino vegano"), usa il tool "image_generation". Salva il file generato in public/ così Astro lo include in dist/ al prossimo build.
- Dopo la generazione, modifica il sorgente Astro (in src/) per puntare alla nuova immagine, poi rifai \`npm run build\`.
- Per ANALIZZARE un'immagine esistente del sito (es. "guarda il logo e suggeriscimi una palette", "controlla la foto hero e scrivi un alt text appropriato"), usa "view_image" sul path della risorsa in public/.
- NON usare image_generation se l'utente sta caricando un suo file via drag-and-drop — quello passa già dal tool process_uploaded_file.`
      : `Sei Tharvel, l'agente AI esperto per la gestione del sito "${site.slug}".
Regole fondamentali:
1. I file del sito web si trovano nella tua cartella corrente. Il file HTML principale è "index.html" e le immagini sono in "assets/".
2. Quando l'utente chiede una modifica, USA SEMPRE gli strumenti (read, edit) per applicarla realmente. Non limitarti a spiegare a parole come fare, FALLO TU fisicamente usando i tool.
3. Prima di usare "edit", usa sempre "read" per leggere il contenuto esatto e non sbagliare il rimpiazzo.
4. Non chiedere mai conferma prima di usare uno strumento: agisci direttamente in modo autonomo.
5. Parla in italiano in modo conciso e professionale. Al termine della modifica avvisa l'utente.
6. Quando l'utente chiede di "pubblicare" / "mandare online", usa il tool "publish_site" con un commit message conciso che riassume le modifiche. NON usare il bash per git add/commit/push.
7. Se publish_site fallisce per "modifiche remote più recenti" (non-fast-forward), esegui \`git pull --rebase\` col tool bash e richiama publish_site automaticamente, senza chiedere conferma.
8. IMMAGINI AI — se l'utente chiede esplicitamente di GENERARE/CREARE un'immagine, usa il tool "image_generation" e salva il file in assets/. Poi modifica index.html per usarla. Per ANALIZZARE un'immagine esistente, usa "view_image" sul path. NON usare image_generation per gli upload utente (gestiti da process_uploaded_file).`;

    const loader = new DefaultResourceLoader({
      cwd: sitePath,
      agentDir: getAgentDir(),
      agentsFilesOverride: (current) => ({
        agentsFiles: [
          ...current.agentsFiles,
          {
            path: "/virtual/AGENTS.md",
            content: agentsContent,
          }
        ]
      })
    });
    
    // Per assicurarci che i file extension di .pi vengano caricati e la cache aggiornata:
    await loader.reload();

    // Log diagnostico: quali extension ha caricato il loader per questo sito,
    // e quali errori ha registrato durante il discovery. Utile per capire perché
    // pi-codex-image non si registra (es. settings.json non letto, symlink non
    // risolto, extension file non parseable).
    const extRes = loader.getExtensions();
    console.log(
      `[PI ext] '${site.slug}': loaded ${extRes.extensions.length} extension(s)` +
        (extRes.extensions.length > 0
          ? ': ' + extRes.extensions.map((e: any) => e.path).join(', ')
          : '')
    );
    if (extRes.errors.length > 0) {
      console.warn(`[PI ext] '${site.slug}': errors:`, JSON.stringify(extRes.errors, null, 2));
    }

    // Cartella default per gli upload del sito corrente (assets/ per html, public/ per astro).
    const defaultUploadsDir = resolveSiteUploadsDir(site);
    const defaultUploadsRel = path.relative(sitePath, defaultUploadsDir) || '.';

    // Tool per processare l'upload di un file (specialmente immagini per compressione)
    const processUploadTool = defineTool({
      name: "process_uploaded_file",
      label: "Processa File Caricato",
      description: `Questo tool salva e, se necessario, comprime un file (immagine o altro) nella cartella di upload del progetto (default: ${defaultUploadsRel}/).`,
      parameters: Type.Object({
        fileName: Type.String({ description: "Il nome originale del file" }),
        fileBase64: Type.String({ description: "Il contenuto del file codificato in Base64" }),
        mimeType: Type.String({ description: "Il tipo MIME del file (es. image/png)" }),
        targetFolder: Type.String({ description: `La cartella di destinazione relativa al cwd. Default: ${defaultUploadsRel}`, default: defaultUploadsRel })
      }),
      execute: async (_toolCallId, params) => {
        try {
          const buffer = Buffer.from(params.fileBase64, 'base64');
          // FIX CHIAVE: Usare sitePath invece di process.cwd() altrimenti ricarica le immagini nella root e non in site/!
          const targetDir = path.resolve(sitePath, params.targetFolder || defaultUploadsRel);

          // Assicurati che la cartella esista
          await fs.mkdir(targetDir, { recursive: true });

          let finalPath = '';
          const safeName = sanitizeFileName(params.fileName);
          let finalFileName = safeName;

          // Se è un'immagine, la convertiamo in webp e la comprimiamo
          if (params.mimeType.startsWith('image/') && !params.mimeType.includes('svg')) {
            const nameWithoutExt = path.parse(safeName).name;
            finalFileName = `${nameWithoutExt}.webp`;
            finalPath = path.join(targetDir, finalFileName);

            await sharp(buffer)
              .webp({ quality: 80 })
              .toFile(finalPath);
          } else {
            // File normale, salva così com'è
            finalPath = path.join(targetDir, finalFileName);
            await fs.writeFile(finalPath, buffer);
          }
          
          // Avvisa il client che i file sono cambiati
          ws.send(JSON.stringify({ type: 'files_updated' }));

          return {
            content: [{ type: "text", text: `File salvato con successo in: ${path.relative(process.cwd(), finalPath)}` }],
            details: { path: finalPath }
          };
        } catch (error: any) {
          return {
             content: [{ type: "text", text: `Errore durante il salvataggio del file: ${error.message}` }],
             details: {}
          };
        }
      }
    });

    // Tool publish: commit + push autenticato via GitHub App. Lo slug e il
    // sitePath sono catturati dalla closure → niente parametro lato agente,
    // niente possibilità per l'agente di pubblicare un sito che non sia il suo.
    const publishTool = defineTool({
      name: "publish_site",
      label: "Pubblica modifiche",
      description:
        `Pubblica le modifiche al sito "${site.slug}": stage di tutto il working tree, ` +
        `commit con il messaggio fornito, push autenticato sul repo GitHub del cliente. ` +
        `Usalo SOLO quando l'utente chiede esplicitamente di "pubblicare" / "mandare online" ` +
        `le modifiche. Non chiedere conferma all'utente prima di chiamarlo, ma scegli un ` +
        `commit message conciso (1 riga, IT) che riassuma le modifiche fatte in questa sessione.`,
      parameters: Type.Object({
        commitMessage: Type.String({
          description:
            "Messaggio di commit, 1 riga, in italiano, che riassume le modifiche di questa sessione. Es: 'Aggiornato titolo della home e cambiato testo hero'.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        try {
          const result = await publishSite(site, SITES_ROOT, params.commitMessage);
          return {
            content: [{ type: "text", text: result.message }],
            details: {
              ok: result.ok,
              pushed: result.pushed,
              commitSha: result.commitSha ?? null,
            },
          };
        } catch (e: any) {
          return {
            content: [{ type: "text", text: `Errore publish: ${e?.message ?? String(e)}` }],
            details: { ok: false, pushed: false, commitSha: null },
          };
        }
      },
    });

    // Nell'SDK 0.73 `tools` è string[] di nomi attivi; i tool built-in (read/bash/edit/write)
    // vengono creati internamente con il `cwd` passato qui sopra. Omettendo `tools` l'SDK
    // attiva tutti i default automaticamente.
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      model: modelRegistry.find("openai-codex", "gpt-5.5"),
      authStorage,
      modelRegistry,
      cwd: sitePath,
      customTools: [processUploadTool, publishTool],
      resourceLoader: loader,
    });

    // Log diagnostico: tool effettivamente attivi sulla session.
    try {
      const activeTools = (session as any).getActiveToolNames?.() ?? [];
      console.log(`[PI tools] '${site.slug}': active=${JSON.stringify(activeTools)}`);
    } catch (e) {
      console.warn(`[PI tools] '${site.slug}': unable to list active tools:`, e);
    }

    const sendFilesList = async () => {
      try {
        // FIX: mostriamo i file da site/assets (html) o site/public (astro), non da root/assets
        await fs.mkdir(defaultUploadsDir, { recursive: true });
        const files = await fs.readdir(defaultUploadsDir);
        ws.send(JSON.stringify({
          type: 'files_list',
          files: files.map(f => ({ name: f, path: `${defaultUploadsRel}/${f}` }))
        }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'files_list', files: [] }));
      }
    };

    // Invio iniziale
    await sendFilesList();

    // Garantisce branch `preview` al primo turn (lazy migration per i siti
    // onboardati prima dell'introduzione del flusso preview). Errori silenziati
    // qui: il primo auto-commit ritenterà.
    let previewBranchReady = false;
    const tryEnsurePreview = async () => {
      if (previewBranchReady) return;
      const res = await ensurePreviewBranch(sitePath);
      if (res.ok) {
        previewBranchReady = true;
        console.log(`[PREVIEW] '${site.slug}': ${res.message}`);
      } else {
        console.warn(`[PREVIEW] '${site.slug}': ${res.message}`);
      }
    };
    tryEnsurePreview().catch(() => {});

    // Garantisce .pi/settings.json + symlink npm condiviso per i tool
    // image_generation / view_image del package pi-codex-image. Lazy come
    // sopra: errori silenziati, l'agente funzionerà senza il tool extra.
    ensurePiSettings(sitePath)
      .then((res) => {
        if (res.ok) console.log(`[PI] '${site.slug}': ${res.message}`);
        else console.warn(`[PI] '${site.slug}': ${res.message}`);
      })
      .catch((e) => console.warn(`[PI] '${site.slug}': fatal`, e));

    // Stato per l'auto-commit: cattura l'ultimo prompt utente del turno e
    // se almeno un tool ha errored. Resettato a fine turn (agent_end).
    let currentTurnPrompt = '';
    let currentTurnHadError = false;

    const unsubscribe = session.subscribe((event) => {
      // Logging diagnostico: per message_update stampiamo anche il sotto-tipo (text_delta,
      // reasoning_delta, tool_call_progress, ecc.) e un'anteprima del payload, perché il
      // semplice "[EVENT] message_update" non rivelava cosa stesse facendo l'agente nei loop.
      if (event.type === 'message_update') {
        const sub = (event as any).assistantMessageEvent?.type || '?';
        const payload = (event as any).assistantMessageEvent;
        const preview =
          payload?.delta?.slice?.(0, 80) ??
          (payload?.toolName ? `tool=${payload.toolName}` : '') ??
          '';
        console.log("[EVENT] message_update", sub, JSON.stringify(preview));
      } else {
        console.log("[EVENT]", event.type, (event as any).toolName || '');
      }

      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        // Aggiunto log e flush esplicito per capire se la websocket sta davvero mandando
        console.log("[WS SEND] text_delta:", event.assistantMessageEvent.delta);
        ws.send(JSON.stringify({
          type: 'stream',
          content: event.assistantMessageEvent.delta
        }));
      }
      
      if (event.type === 'agent_end') {
        // Auto-commit per turn dell'agente. Fire-and-forget: non bloccare il
        // 'done' al client. Se l'utente clicca subito Pubblica prima che il
        // commit sia finito, publishSite ritrova il working tree clean+ahead
        // (caso già gestito) o dirty (e committerà lui). Race accettata.
        const promptForCommit = currentTurnPrompt;
        const hadError = currentTurnHadError;
        currentTurnPrompt = '';
        currentTurnHadError = false;

        if (promptForCommit) {
          autoCommitTurn({
            site,
            sitePath,
            userPrompt: promptForCommit,
            turnHadError: hadError,
          })
            .then((res) => {
              if (res.committed) {
                console.log(`[AUTO-COMMIT] '${site.slug}' ${res.commitSha?.slice(0, 8)} (${res.filesChanged?.length ?? 0} file)`);
                ws.send(JSON.stringify({ type: 'history_updated' }));
              } else {
                console.log(`[AUTO-COMMIT] '${site.slug}' skipped: ${res.reason}`);
              }
            })
            .catch((e) => console.error(`[AUTO-COMMIT] '${site.slug}' fatal:`, e));
        }

        ws.send(JSON.stringify({ type: 'done' }));
      }

      if (event.type === 'tool_execution_start') {
         ws.send(JSON.stringify({
           type: 'tool_start',
           tool: event.toolName
         }));
      }

      if (event.type === 'tool_execution_end') {
         console.log("[TOOL END]", event.toolName, "Error?", event.isError);
         if (event.isError) currentTurnHadError = true;
      }
    });

    ws.on('message', async (message) => {
      const data = JSON.parse(message.toString());
      
      if (data.type === 'set_model') {
        const [provider, modelId] = data.model.split('/');
        const newModel = modelRegistry.find(provider, modelId);
        if (newModel) {
          await session.setModel(newModel);
          ws.send(JSON.stringify({ type: 'system', content: `✅ Modello cambiato in: ${newModel.name}` }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: `Modello non trovato: ${data.model}` }));
        }
        return;
      }

      if (data.type === 'get_files') {
        await sendFilesList();
        return;
      }

      if (data.type === 'upload_file') {
        ws.send(JSON.stringify({ type: 'system', content: `⏳ Ricevuto file ${data.fileName}, salvataggio in corso...` }));
        try {
          // Salviamo e ottimizziamo l'immagine direttamente lato server, senza passare il base64 all'LLM (che andrebbe in tilt per la lunghezza)
          const buffer = Buffer.from(data.fileBase64, 'base64');
          // FIX: sitePath, non process.cwd(). Altrimenti il file finisce in server/assets/
          // mentre l'agente lo cerca in server/site/assets/ (cwd dell'agente).
          // La cartella varia per framework (assets/ per html, public/ per astro).
          const targetDir = defaultUploadsDir;
          await fs.mkdir(targetDir, { recursive: true });

          let finalPath = '';
          const safeName = sanitizeFileName(data.fileName);
          let finalFileName = safeName;

          if (data.mimeType.startsWith('image/') && !data.mimeType.includes('svg')) {
            const nameWithoutExt = path.parse(safeName).name;
            finalFileName = `${nameWithoutExt}.webp`;
            finalPath = path.join(targetDir, finalFileName);

            await sharp(buffer)
              .webp({ quality: 80 })
              .toFile(finalPath);
          } else {
            finalPath = path.join(targetDir, finalFileName);
            await fs.writeFile(finalPath, buffer);
          }

          // Aggiorna la lista file
          await sendFilesList();
          ws.send(JSON.stringify({ type: 'files_updated' }));
          ws.send(JSON.stringify({
            type: 'system',
            content: `✅ File salvato in \`${defaultUploadsRel}/${finalFileName}\`. Ora puoi chiedermi di usarlo (es. "metti questa come sfondo dell'hero").`
          }));

          // Nessun session.prompt() automatico: consumava un turno e confondeva l'agente
          // quando l'utente subito dopo inviava il vero comando di modifica. L'agente troverà
          // il file via `ls assets/` quando necessario (vedi AGENTS.md virtuale).
        } catch (error: any) {
          ws.send(JSON.stringify({ type: 'error', message: error.message || 'Errore salvataggio file' }));
        }
        return;
      }

      if (data.type === 'prompt') {
        const text = data.content.trim();
        
        // Gestione comandi slash manuale
        if (text.startsWith('/model ')) {
          const newModelId = text.split(' ')[1];
          const newModel = modelRegistry.find("github-copilot", newModelId) || modelRegistry.find("anthropic", newModelId);
          if (newModel) {
            await session.setModel(newModel);
            ws.send(JSON.stringify({ type: 'system', content: `✅ Modello cambiato in: ${newModel.name}` }));
          } else {
            ws.send(JSON.stringify({ type: 'error', message: `Modello non trovato.` }));
          }
          ws.send(JSON.stringify({ type: 'done' }));
          return;
        }
        
        if (text.startsWith('/clear')) {
          session.agent.state.messages = [];
          ws.send(JSON.stringify({ type: 'system', content: `🧹 Memoria della chat cancellata.` }));
          ws.send(JSON.stringify({ type: 'done' }));
          return;
        }

        // Cattura il prompt utente per l'auto-commit a fine turn.
        currentTurnPrompt = text;
        currentTurnHadError = false;

        try {
          await session.prompt(text);
        } catch (error: any) {
          ws.send(JSON.stringify({ type: 'error', message: error.message || 'Errore sconosciuto' }));
        }
      }
    });

    ws.on('close', () => {
      console.log('Connessione chiusa');
      unsubscribe();
    });

  } catch (error) {
    console.error('Errore inizializzazione sessione:', error);
    ws.send(JSON.stringify({ type: 'error', message: 'Impossibile avviare il motore AI' }));
  }
});

// Static serve della UI Vue (single-container in produzione).
// Il Dockerfile target=server copia ui/dist da ui-builder in /app/ui-dist.
// In dev questo path non esiste: il server salta lo static e l'UI viene servita da `vite dev` su :5173.
// Mount a root perché il proxy strippa BASE_PATH; gli asset emessi da Vite hanno
// comunque link prefissati (`/tharveladmin/assets/...`), che il browser ripresenta
// al proxy con il prefix → strip → arrivano qui come `/assets/...` ✓.
// Path override via env perché in prod giriamo da dist/ (__dirname diverso da source).
const uiDistPath = process.env.THARVEL_UI_DIST
  ? path.resolve(process.env.THARVEL_UI_DIST)
  : path.resolve(__dirname, '..', 'ui-dist');
if (existsSync(uiDistPath)) {
  app.use(express.static(uiDistPath));
  // SPA fallback: GET non-static, non-preview → index.html (Vue gestisce lo state).
  // Express 5: `app.get('*', ...)` rompe path-to-regexp 8 → uso app.use middleware.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/site/')) return next();
    res.sendFile(path.join(uiDistPath, 'index.html'));
  });
  console.log(`[UI] static served from ${uiDistPath} (exposed under ${BASE_PATH} via proxy)`);
} else {
  console.log(`[UI] ui-dist non trovato (${uiDistPath}): dev mode, l'UI gira su vite :5173`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tharvel Engine in esecuzione sulla porta ${PORT}`);
});
