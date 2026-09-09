import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import { createServer, IncomingMessage } from 'http';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
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
import { listSites, getSiteBySlug, getSiteByDomain, setSiteModel, type Site } from './db/sites.js';
import { getUserByEmail, getUserById, listUsersBySlug, updateUserPassword } from './db/users.js';
import { unseal, trySeal } from './secret-box.js';
import { publishSite } from './publish.js';
import { findApplicationByRepo, getApplication, splitFqdns, pickRecommendedFqdn } from './coolify-api.js';
import { onboardSite, OnboardError } from './onboard-pipeline.js';
import { autoCommitTurn } from './auto-commit.js';
import { ensurePreviewBranch } from './preview-branch.js';
import { ensurePiSettings } from './pi-settings.js';
import { buildAgentPrompt } from './agent-prompt.js';
import { buildSiteContext, writeSiteContextFile } from './site-context.js';
import {
  getLastTurnRevision,
  getRevisionById,
  listRevisionsBySite,
  deleteRevisionById,
  deleteTurnsFromId,
} from './db/revisions.js';
import { resetPreviewTo, rebuildSite } from './revisions-ops.js';
import { rollbackToPublish } from './rollback.js';
import {
  insertChatMessage,
  insertCommandLog,
  listChatMessages,
  listCommandLogs,
  summarizeCommands,
} from './db/activity.js';
import {
  listCustomModels,
  getCustomModel,
  upsertCustomModel,
  deleteCustomModel,
  type CustomModel,
} from './db/custom-models.js';
import { buildCodexModel, testModelConnection } from './model-testing.js';
import {
  requireAuth,
  requireAdmin,
  verifyPassword,
  verifySession,
  issueSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
  publicUser,
  hashPassword,
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

// URL del pannello per un sito. Ricostruito invece di salvato perché `sites.domain`
// tiene il solo host: la regola sul protocollo è la stessa dell'onboarding (i domini
// reali vanno su https, solo gli sslip.io provvisori restano http — vedi
// onboard-pipeline.ts). Se cambia là va cambiata anche qui.
function adminUrlForSite(site: { domain: string | null }): string | null {
  if (!site.domain) return null;
  const host = site.domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const protocol = /\.sslip\.io$/i.test(host) ? 'http' : 'https';
  return `${protocol}://${host}${BASE_PATH}`;
}

// Chiavi di accesso di un sito: le stesse credenziali che il wizard mostra a fine
// onboarding, ma recuperabili in qualsiasi momento. Serve quando il cliente
// ripete "non trovo più la mail con gli accessi".
//
// `password: null` significa non recuperabile: l'account è stato creato prima che
// esistesse password_enc, oppure il segreto di cifratura non è più quello di allora.
// In quel caso l'unica strada è il reset qui sotto.
app.get('/api/admin/sites/:slug/access', requireAuth, requireAdmin, (req, res) => {
  const site = getSiteBySlug(String(req.params.slug));
  if (!site) {
    res.status(404).json({ error: 'Sito non trovato.' });
    return;
  }
  res.json({
    slug: site.slug,
    domain: site.domain,
    adminUrl: adminUrlForSite(site),
    users: listUsersBySlug(site.slug).map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      password: unseal(u.password_enc),
      updatedAt: u.updated_at,
    })),
  });
});

// Reset password di un utente cliente. Genera, salva (hash + copia cifrata) e
// ritorna la nuova password in chiaro: è l'unico modo di rimettere in mano all'admin
// una credenziale funzionante quando quella vecchia non è recuperabile.
// Invalida immediatamente la password che il cliente sta usando, quindi la UI chiede
// conferma prima di chiamarlo.
app.post('/api/admin/sites/:slug/access/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteBySlug(String(req.params.slug));
  if (!site) {
    res.status(404).json({ error: 'Sito non trovato.' });
    return;
  }
  const userId = Number(req.body?.userId);
  const user = Number.isFinite(userId) ? getUserById(userId) : null;
  // Il vincolo sullo slug impedisce di resettare, passando un userId qualsiasi,
  // la password di un utente che non appartiene a questo sito (incluso un admin).
  if (!user || user.slug !== site.slug) {
    res.status(404).json({ error: 'Utente non trovato per questo sito.' });
    return;
  }
  // 18 byte base64url ≈ 24 caratteri stampabili: robusta e copiabile a mano.
  const password = randomBytes(18).toString('base64url');
  updateUserPassword(user.id, await hashPassword(password), trySeal(password));
  console.log(`[ACCESS] password rigenerata per ${user.email} (sito ${site.slug})`);
  res.json({ id: user.id, email: user.email, password, adminUrl: adminUrlForSite(site) });
});

// --- Pannello attività (admin).
//
// Risponde alla domanda "cosa ha chiesto il cliente a Tharvel e cosa è successo".
// Tre sorgenti unite in una timeline:
//  - site_chat_messages : conversazione completa, inclusi i turni che NON hanno
//                         prodotto un commit (domande, errori) e le risposte.
//  - site_commands      : comandi bash eseguiti dall'agente (modalità osservazione).
//  - site_revisions     : i turni che hanno cambiato file, con i file toccati.
// Admin-only di proposito: al cliente la sua chat è già visibile nel pannello.
app.get('/api/admin/sites/:slug/activity', requireAuth, requireAdmin, (req, res) => {
  const site = getSiteBySlug(String(req.params.slug));
  if (!site) {
    res.status(404).json({ error: 'Sito non trovato.' });
    return;
  }
  const limit = Math.min(Number(req.query.limit) || 200, 500);

  const events = [
    ...listChatMessages(site.id, limit).map((m) => ({
      kind: m.role === 'user' ? ('prompt' as const) : ('reply' as const),
      at: m.created_at,
      turnId: m.turn_id,
      content: m.content,
      hadError: m.had_error === 1,
      userId: m.user_id,
    })),
    ...listCommandLogs(site.id, limit).map((c) => ({
      kind: 'command' as const,
      at: c.created_at,
      turnId: c.turn_id,
      content: c.command,
      hadError: c.is_error === 1,
      userId: null,
    })),
    ...listRevisionsBySite(site.id, limit).map((r) => ({
      kind: 'revision' as const,
      at: r.created_at,
      turnId: null,
      content: r.summary ?? r.user_prompt,
      hadError: false,
      userId: null,
      filesChanged: JSON.parse(r.files_changed || '[]') as string[],
      commitSha: r.commit_sha,
      revisionKind: r.kind,
    })),
  ]
    // Ordine cronologico inverso: l'ultima cosa successa in cima.
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  res.json({ slug: site.slug, events });
});

// Elenco delle pubblicazioni di un sito, cioè i punti a cui si può riportare
// ciò che è ONLINE. Distinto da /history (che elenca i turni su preview).
app.get('/api/admin/sites/:slug/publishes', requireAuth, requireAdmin, (req, res) => {
  const site = getSiteBySlug(String(req.params.slug));
  if (!site) {
    res.status(404).json({ error: 'Sito non trovato.' });
    return;
  }
  const publishes = listRevisionsBySite(site.id, 200)
    .filter((r) => r.kind === 'publish')
    .map((r) => ({
      id: r.id,
      commitSha: r.commit_sha,
      shortSha: r.commit_sha.slice(0, 8),
      summary: r.summary,
      at: r.created_at,
    }));
  res.json({ slug: site.slug, publishes });
});

// Riporta il sito online a una pubblicazione precedente. Admin-only: tocca `main`
// del repo del cliente e fa ripartire il deploy.
app.post('/api/admin/sites/:slug/rollback/:revisionId', requireAuth, requireAdmin, async (req, res) => {
  const site = getSiteBySlug(String(req.params.slug));
  if (!site) {
    res.status(404).json({ error: 'Sito non trovato.' });
    return;
  }
  const revId = Number(req.params.revisionId);
  const rev = Number.isFinite(revId) ? getRevisionById(revId, site.id) : null;
  // Il vincolo su kind evita di passare l'id di un turno preview, il cui commit
  // non esiste più su main dopo lo squash.
  if (!rev || rev.kind !== 'publish') {
    res.status(404).json({ error: 'Pubblicazione non trovata per questo sito.' });
    return;
  }
  try {
    const result = await rollbackToPublish(site, SITES_ROOT, rev.commit_sha, rev.summary ?? '');
    console.log(`[ROLLBACK] '${site.slug}' → ${rev.commit_sha.slice(0, 8)}: ${result.message}`);
    res.status(result.ok ? 200 : 500).json(result);
  } catch (e: any) {
    console.error(`[ROLLBACK] '${site.slug}' errore:`, e);
    res.status(500).json({ ok: false, pushed: false, message: e?.message ?? 'Errore interno.' });
  }
});

// Riepilogo dei comandi osservati, aggregati per "<binario> <sottocomando>".
// È la lista da leggere PRIMA di attivare qualunque blocco sul tool bash: la
// whitelist va costruita da qui, non a memoria. Senza `?slug=` aggrega tutti i siti.
app.get('/api/admin/commands-summary', requireAuth, requireAdmin, (req, res) => {
  const slug = req.query.slug ? String(req.query.slug) : null;
  const site = slug ? getSiteBySlug(slug) : null;
  if (slug && !site) {
    res.status(404).json({ error: 'Sito non trovato.' });
    return;
  }
  res.json({ slug, commands: summarizeCommands(site?.id) });
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
//
// Admin-only (a differenza di /undo, che resta al cliente): saltare a un punto
// arbitrario della storia può buttare via settimane di lavoro in un click, e chi
// lo fa non ha modo di vedere cosa sta perdendo. L'"ops, non intendevo questo"
// del cliente è coperto da /undo sull'ultimo turno.
app.post('/api/session/:slug/restore/:revisionId', requireAuth, requireAdmin, async (req, res) => {
  const slug = req.params.slug;
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

// --- Modelli custom (aggiunti a mano dall'admin oltre ai built-in dell'SDK) ---
// Motivazione: quando esce un nuovo modello ChatGPT/Codex dopo il pin dell'SDK,
// non è selezionabile perché ModelRegistry.find() non lo conosce. Qui l'admin lo
// registra per id + fa un test di connessione. Scope GLOBALE (subscription
// condivisa). Vedi model-testing.ts e db/custom-models.ts.

// Provider su cui è abilitato l'inserimento manuale. Per ora solo Codex: il suo
// transport OAuth inoltra l'id come stringa, quindi un id nuovo funziona senza
// update dell'SDK. Estendibile agli altri provider quando validato.
const CUSTOM_MODEL_PROVIDERS = new Set(['openai-codex']);
const MODEL_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function serializeCustomModel(m: CustomModel) {
  return {
    provider: m.provider,
    id: m.model_id,
    label: m.label,
    contextWindow: m.context_window,
    maxTokens: m.max_tokens,
  };
}

// Lista modelli custom (per il picker/settings). Admin-only: la scelta del modello
// decide costo e qualità delle risposte, e il cliente non ha gli elementi per farla.
// Il picker è nascosto lato UI per i client; questo endpoint è la difesa server-side.
app.get('/api/models', requireAuth, requireAdmin, (_req, res) => {
  res.json({ models: listCustomModels().map(serializeCustomModel) });
});

// Parsing + validazione comune del body per test/add.
// Tipo a forma singola con `error` opzionale (niente discriminated union: il
// tsconfig del server ha strict:false e il narrowing su `ok:true/false` non è
// affidabile). Se `error` è valorizzato gli altri campi sono da ignorare.
interface ParsedModelBody {
  error?: string;
  provider: string;
  modelId: string;
  label: string;
  contextWindow: number | null;
  maxTokens: number | null;
}

function parseModelBody(body: Record<string, unknown>): ParsedModelBody {
  const provider = typeof body.provider === 'string' ? body.provider.trim() : 'openai-codex';
  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : modelId;

  const toIntOrNull = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };
  const base: ParsedModelBody = {
    provider,
    modelId,
    label,
    contextWindow: toIntOrNull(body.contextWindow),
    maxTokens: toIntOrNull(body.maxTokens),
  };

  if (!CUSTOM_MODEL_PROVIDERS.has(provider)) {
    return { ...base, error: `Provider non supportato per l'inserimento manuale: "${provider}". Al momento solo Codex.` };
  }
  if (!MODEL_ID_RE.test(modelId)) {
    return { ...base, error: 'Id modello non valido. Usa solo lettere, numeri, punto, trattino e underscore (es. gpt-5.6).' };
  }
  return base;
}

// Test di connessione: costruisce il Model al volo e fa un ping con l'auth OAuth
// già salvata. NON persiste nulla — serve solo a validare prima di salvare.
app.post('/api/admin/models/test', requireAuth, requireAdmin, async (req, res) => {
  const parsed = parseModelBody((req.body ?? {}) as Record<string, unknown>);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);
    const model = buildCodexModel(registry, {
      modelId: parsed.modelId,
      label: parsed.label,
      contextWindow: parsed.contextWindow,
      maxTokens: parsed.maxTokens,
    });
    const result = await testModelConnection(registry, model);
    if (result.ok) {
      res.json({ ok: true, sample: result.sample });
    } else {
      res.json({ ok: false, error: result.error });
    }
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

// Salva (upsert) un modello custom. Il frontend chiama /test prima, ma per
// robustezza qui NON rifacciamo il test: salvare un modello che al momento non
// risponde è lecito (es. rollout graduale lato provider).
app.post('/api/admin/models/custom', requireAuth, requireAdmin, (req, res) => {
  const parsed = parseModelBody((req.body ?? {}) as Record<string, unknown>);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const saved = upsertCustomModel({
    provider: parsed.provider,
    model_id: parsed.modelId,
    label: parsed.label,
    context_window: parsed.contextWindow,
    max_tokens: parsed.maxTokens,
  });
  console.log(`[MODELS] custom model salvato: ${saved.provider}/${saved.model_id} ("${saved.label}")`);
  res.json({ model: serializeCustomModel(saved) });
});

app.delete('/api/admin/models/custom/:provider/:modelId', requireAuth, requireAdmin, (req, res) => {
  const provider = String(req.params.provider);
  const modelId = String(req.params.modelId);
  const removed = deleteCustomModel(provider, modelId);
  if (!removed) {
    res.status(404).json({ error: 'Modello custom non trovato.' });
    return;
  }
  console.log(`[MODELS] custom model rimosso: ${provider}/${modelId}`);
  res.json({ ok: true });
});

// Overlay Tharvel (CSS + JS per Alt+click) iniettato negli HTML dei siti che non
// includono già lo snippet (es. build Astro). Caricato una volta sola al boot.
import { readFileSync, existsSync } from 'node:fs';
const THARVEL_OVERLAY = readFileSync(path.resolve(__dirname, 'overlay.html'), 'utf-8');
const PREVIEW_BOOTSTRAP = readFileSync(path.resolve(__dirname, 'preview-bootstrap.html'), 'utf-8');

// Rotta che la pagina avrebbe sul dominio del cliente, cioè quello che il router
// client-side del sito si aspetta di leggere in location.pathname. Deriva dal path
// della richiesta (già ripulito da Express del mount /site/:slug) meno:
//  - l'`index.html` implicito (`/index.html` → `/`, `/sub/index.html` → `/sub/`);
//  - il cache-buster `_` che l'iframe della preview aggiunge a ogni reload.
function virtualRouteFor(req: express.Request): string {
  const routePath = req.path.replace(/index\.html$/, '') || '/';
  const qIndex = req.url.indexOf('?');
  if (qIndex < 0) return routePath;
  const params = new URLSearchParams(req.url.slice(qIndex + 1));
  params.delete('_');
  const qs = params.toString();
  return qs ? `${routePath}?${qs}` : routePath;
}

// Rimappa un singolo URL del documento dentro il namespace del tenant.
// Ritorna null quando l'URL va lasciato invariato.
//
// `base` è la URL che la pagina ha in produzione: serve a risolvere i path
// relativi esattamente come farebbe il browser sul dominio del cliente. È
// necessario perché preview-bootstrap.html riallinea location.pathname alla rotta
// virtuale: senza risolverli qui, un `src="assets/x.png"` finirebbe sulla root del
// dominio, fuori dal namespace Tharvel.
function mapTenantUrl(value: string, prefix: string, base: URL): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('#')) return null; // ancora nella stessa pagina
  if (v.startsWith('//')) return null; // protocol-relative
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null; // http:, mailto:, tel:, data:, javascript:
  if (v.startsWith('/')) {
    if (v === prefix || v.startsWith(`${prefix}/`)) return null; // già dentro il namespace
    return `${prefix}${v}`;
  }
  try {
    const resolved = new URL(v, base);
    return `${prefix}${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
}

// Riscrive gli href/src del documento con il prefisso BASE_PATH/site/<slug>.
// Necessario perché i siti sono scritti per stare sulla root del dominio cliente:
// Astro applica `base` agli asset compilati, ma i link <a href="/about/"> nei
// template restano grezzi, e le SPA Vite emettono `/assets/...` assoluti. Senza il
// prefisso questi URL escono dal namespace Tharvel e cadono sul sito pubblicato.
function rewriteHtmlForTenant(html: string, slug: string, route: string): string {
  const prefix = `${BASE_PATH}/site/${slug}`;
  // Host fittizio: di questa URL usiamo solo path/search/hash.
  const base = new URL(route, 'http://tharvel.invalid');
  return html.replace(/\b(href|src)="([^"]*)"/gi, (full, attr: string, value: string) => {
    const mapped = mapTenantUrl(value, prefix, base);
    return mapped === null ? full : `${attr}="${mapped}"`;
  });
}

// Inietta il bootstrap della preview (riallineamento rotta + report al pannello)
// come primo figlio di <head>: deve girare prima di qualunque script del sito.
function injectPreviewBootstrap(html: string, slug: string, route: string): string {
  if (html.includes('__tharvelPreviewBootstrapped')) return html;
  const script = PREVIEW_BOOTSTRAP.replace(/__THARVEL_(PREFIX|ROUTE)__/g, (_m, key: string) =>
    JSON.stringify(key === 'PREFIX' ? `${BASE_PATH}/site/${slug}` : route),
  );
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], () => `${head[0]}\n${script}`);
  return `${script}\n${html}`;
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
    // Richieste "pagina": root, trailing slash, *.html, oppure path senza estensione
    // (es. /jose, /tenuta — Astro build.format 'directory'). Senza questo ramo i link
    // interni estensionless cadevano su express.static, che per una directory emette un
    // redirect a `<path>/` perdendo il prefisso /tharveladmin (strippato da Traefik) → 404.
    // Gli asset hanno un'estensione (.css/.svg/.js/...) e passano allo static handler sotto.
    const ext = path.extname(reqPath);
    const isHtml = ext === '' || ext === '.html';
    if (isHtml) {
      const serveRoot = resolveSiteServeRoot(site);
      const serveRootResolved = path.resolve(serveRoot);
      // Replica `try_files $uri $uri/ $uri.html`: file .html esplicito, poi
      // <path>/index.html (directory mode), poi <path>.html (file mode).
      const candidates = reqPath.endsWith('.html')
        ? [path.join(serveRoot, reqPath)]
        : [
            path.join(serveRoot, reqPath, 'index.html'),
            ...(reqPath === '/' ? [] : [path.join(serveRoot, `${reqPath}.html`)]),
          ];
      // SPA fallback, equivalente a `try_files $uri $uri/ /index.html` in nginx (è
      // esattamente la conf con cui questi siti girano in produzione). Una build
      // Vite ha UN solo index.html e le rotte sono client-side: senza questo,
      // /site/twobee/casestudy cade su express.static → 404, anche se la rotta
      // esiste ed è raggiungibile sul dominio del cliente.
      if (site.framework === 'vite') candidates.push(path.join(serveRoot, 'index.html'));

      // Rotta "di produzione" da far vedere al router del sito (vedi preview-bootstrap).
      const route = virtualRouteFor(req);
      for (const filePath of candidates) {
        // Path traversal guard: dopo path.join il risultato deve restare dentro serveRoot.
        const resolved = path.resolve(filePath);
        if (resolved !== serveRootResolved && !resolved.startsWith(serveRootResolved + path.sep)) {
          res.status(400).send('Bad path');
          return;
        }
        try {
          let html = await fs.readFile(resolved, 'utf-8');
          html = rewriteHtmlForTenant(html, slug, route);
          html = injectPreviewBootstrap(html, slug, route);
          html = injectOverlay(html);
          res.set('Content-Type', 'text/html; charset=utf-8');
          res.set('Cache-Control', 'no-store');
          res.send(html);
          return;
        } catch {
          // Candidato inesistente → prova il prossimo; se nessuno esiste cade allo static (404).
        }
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

// Preview/Download di un asset del sito direttamente dalla uploads dir.
// Bypassa il flusso `/site/:slug` (che per Astro serve da dist/): un file appena
// caricato in public/ è subito disponibile qui anche senza un build.
// Auth: stessa policy del path `/site/:slug` (admin o slug coincidente).
app.get('/api/sites/:slug/uploads/:filename', requireAuth, async (req, res) => {
  const slug = req.params.slug;
  if (req.user!.role !== 'admin' && req.user!.slug !== slug) {
    res.status(403).send('forbidden');
    return;
  }
  const site = getSiteBySlug(slug);
  if (!site) {
    res.status(404).send('site not found');
    return;
  }
  const uploadsDir = resolveSiteUploadsDir(site);
  const safeName = path.basename(req.params.filename);
  const resolved = path.resolve(path.join(uploadsDir, safeName));
  if (!resolved.startsWith(path.resolve(uploadsDir) + path.sep)) {
    res.status(400).send('bad path');
    return;
  }
  try {
    await fs.access(resolved);
  } catch {
    res.status(404).send('not found');
    return;
  }
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  }
  res.sendFile(resolved);
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

    // Risoluzione di una chiave "<provider>/<modelId>" in un Model dell'SDK.
    // Due sorgenti, in ordine: i modelli built-in del registry, poi i custom che
    // l'admin ha aggiunto a mano (usciti dopo il pin dell'SDK — vedi db/custom-models).
    // Serve in tre punti (boot della sessione, set_model, default): tenerla in una
    // funzione evita che la scelta persistita si risolva in modo diverso dalla live.
    const resolveModel = (key: string | null | undefined) => {
      if (!key) return null;
      const [provider, ...rest] = key.split('/');
      const modelId = rest.join('/');
      if (!provider || !modelId) return null;
      const builtin = modelRegistry.find(provider, modelId);
      if (builtin) return builtin;
      if (provider === 'openai-codex') {
        const custom = getCustomModel(provider, modelId);
        if (custom) {
          return buildCodexModel(modelRegistry, {
            modelId: custom.model_id,
            label: custom.label,
            contextWindow: custom.context_window,
            maxTokens: custom.max_tokens,
          });
        }
      }
      return null;
    };

    // Default per i siti senza scelta salvata: è quello che gira sui pannelli
    // cliente, che non hanno il picker del modello (solo l'admin può cambiarlo).
    // gpt-5.6-sol esiste solo come modello custom (db/custom-models): se quella
    // riga non c'è (DB nuovo, modello rimosso a mano) si ricade sull'ultimo
    // built-in noto all'SDK, invece di partire senza modello.
    const DEFAULT_MODEL_KEY = 'openai-codex/gpt-5.6-sol';
    const FALLBACK_MODEL_KEY = 'openai-codex/gpt-5.5';
    // Il modello scelto è per-sito (sites.model): la sessione dell'agente è per-sito,
    // e siti diversi possono volere modelli diversi. Se la scelta salvata non è più
    // risolvibile (modello custom cancellato, SDK aggiornato) si torna al default
    // invece di rifiutare la connessione.
    const savedModel = resolveModel(site.model);
    if (site.model && !savedModel) {
      console.warn(`[MODELS] '${site.slug}': modello salvato '${site.model}' non risolvibile, uso il default`);
    }
    const defaultModel = resolveModel(DEFAULT_MODEL_KEY);
    if (!savedModel && !defaultModel) {
      console.warn(`[MODELS] default '${DEFAULT_MODEL_KEY}' non risolvibile, uso il fallback '${FALLBACK_MODEL_KEY}'`);
    }
    const initialModel = savedModel ?? defaultModel ?? resolveModel(FALLBACK_MODEL_KEY);
    // Mutabile: segue i set_model andati a buon fine, così un cambio rifiutato può
    // rimandare alla UI il modello che sta girando davvero.
    let activeModelKey = savedModel
      ? site.model!
      : defaultModel
      ? DEFAULT_MODEL_KEY
      : FALLBACK_MODEL_KEY;

    const sitePath = resolveSiteCwd(site);

    // System prompt dell'agente, composto per blocchi in agent-prompt.ts (uno
    // profilo per framework + i blocchi comuni). Stava qui come tre literal
    // duplicati: ogni regola nuova andava scritta tre volte.
    const agentsContent = buildAgentPrompt(site);

    // Scheda "com'è fatto questo sito e cosa ci è stato fatto finora".
    // Rigenerata dal filesystem a ogni sessione (deterministica, ~20ms, cache su
    // mtime) e completata con lo storico da DB. Serve perché la session dell'SDK
    // è inMemory: senza, il cliente che torna il giorno dopo trova un agente che
    // non sa nulla del sito e riesplora tutto da capo, o peggio crea markup
    // estraneo al design system esistente.
    let siteContextMd = '';
    try {
      const ctx = buildSiteContext({
        sitePath,
        siteId: site.id,
        slug: site.slug,
        framework: site.framework,
      });
      siteContextMd = ctx.markdown;
      console.log(
        `[CONTEXT] '${site.slug}': ${ctx.chars} char da ${ctx.filesScanned} file in ${ctx.ms}ms` +
          (ctx.cached ? ' (cache)' : ''),
      );
      // Copia ispezionabile per l'agenzia; esclusa dai commit del cliente.
      writeSiteContextFile(sitePath, siteContextMd);
    } catch (e) {
      // Il contesto è un miglioramento, non un requisito: se lo scanner fallisce
      // la sessione parte comunque col solo system prompt.
      console.warn(`[CONTEXT] '${site.slug}': scanner fallito, proseguo senza:`, e);
    }

    // Garantisce .pi/settings.json + symlink npm condiviso PRIMA del loader.reload(),
    // altrimenti su un sito appena onboardato la prima sessione partirebbe senza i
    // pi-package extension caricati (il loader non troverebbe .pi/settings.json).
    // Migra anche eventuali settings.json che puntano a pacchetti deprecati.
    const piSettingsResult = await ensurePiSettings(sitePath);
    if (piSettingsResult.ok) console.log(`[PI] '${site.slug}': ${piSettingsResult.message}`);
    else console.warn(`[PI] '${site.slug}': ${piSettingsResult.message}`);

    const loader = new DefaultResourceLoader({
      cwd: sitePath,
      agentDir: getAgentDir(),
      agentsFilesOverride: (current) => ({
        agentsFiles: [
          ...current.agentsFiles,
          {
            path: "/virtual/AGENTS.md",
            content: agentsContent,
          },
          // La scheda del sito va DOPO le regole: sono i dati su cui le regole
          // operano ("usa i token esistenti" → eccoli). Se lo scanner fallisce
          // resta fuori e l'agente lavora come prima.
          ...(siteContextMd
            ? [{ path: "/virtual/SITE-CONTEXT.md", content: siteContextMd }]
            : []),
        ]
      })
    });

    // Per assicurarci che i file extension di .pi vengano caricati e la cache aggiornata:
    await loader.reload();

    // Log diagnostico: quali extension ha caricato il loader per questo sito,
    // e quali errori ha registrato durante il discovery. Utile per capire perché
    // @hewliyang/pi-codex-image non si registra (es. settings.json non letto,
    // symlink non risolto, extension file non parseable).
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
      model: initialModel,
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

    const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);
    const sendFilesList = async () => {
      try {
        // FIX: mostriamo i file da site/assets (html) o site/public (astro), non da root/assets
        await fs.mkdir(defaultUploadsDir, { recursive: true });
        const files = await fs.readdir(defaultUploadsDir);
        ws.send(JSON.stringify({
          type: 'files_list',
          files: files.map(f => ({
            name: f,
            path: `${defaultUploadsRel}/${f}`,
            isImage: IMAGE_EXTS.has(path.extname(f).toLowerCase()),
          }))
        }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'files_list', files: [] }));
      }
    };

    // Invio iniziale
    await sendFilesList();
    // Il picker della UI parte da un default hardcoded: senza questo messaggio
    // mostrerebbe quel default anche quando la sessione sta girando su un altro modello.
    ws.send(JSON.stringify({ type: 'model_active', model: activeModelKey }));

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

    // (ensurePiSettings è ora chiamato PRIMA di loader.reload, vedi sopra:
    // serve che .pi/settings.json esista quando il loader scansiona le
    // extension, altrimenti la prima sessione di un sito nuovo parte senza
    // generate_image.)

    // Stato per l'auto-commit: cattura l'ultimo prompt utente del turno e
    // se almeno un tool ha errored. Resettato a fine turn (agent_end).
    let currentTurnPrompt = '';
    let currentTurnHadError = false;

    // Stato per il log attività (db/activity.ts). Separato da quello dell'auto-commit
    // perché va persistito SEMPRE, anche quando il turno non produce un commit:
    // è l'unico posto in cui resta traccia delle domande, dei turni falliti e delle
    // risposte dell'agente. `currentTurnId` lega prompt, risposta e comandi.
    let currentTurnId = '';
    let currentTurnReply = '';

    const logActivity = (fn: () => void, label: string) => {
      // Il log non deve mai far fallire un turno: se il DB dà errore lo segnaliamo
      // in console e si prosegue.
      try {
        fn();
      } catch (e) {
        console.error(`[ACTIVITY] '${site.slug}' ${label} fallito:`, e);
      }
    };

    // File caricati via upload_file (asset "+") ma non ancora menzionati all'agente.
    // Vengono salvati su disco subito, ma l'agente non ne sa nulla (nessun turno
    // automatico, per non sprecarne uno). Accumuliamo i path qui e li anteponiamo
    // al prossimo prompt reale, così l'agente sa dove guardare quando l'utente dice
    // "usa questa foto". Vedi gotcha "upload invisibile all'agente".
    let pendingUploadNotices: string[] = [];

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
        // Accumuliamo la risposta per salvarla intera a fine turn: i delta sono
        // troppo granulari per una riga di DB ciascuno.
        currentTurnReply += event.assistantMessageEvent.delta;
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

        // Persistiamo la risposta dell'agente PRIMA di resettare lo stato del turn.
        // Nota: avviene anche quando promptForCommit è vuoto (turno senza modifiche),
        // che è esattamente il caso che site_revisions non vede.
        const replyToLog = currentTurnReply.trim();
        const turnIdForLog = currentTurnId;
        if (replyToLog && turnIdForLog) {
          logActivity(
            () =>
              insertChatMessage({
                site_id: site.id,
                turn_id: turnIdForLog,
                role: 'assistant',
                content: replyToLog,
                had_error: hadError,
              }),
            'insert assistant message',
          );
        }
        currentTurnReply = '';
        currentTurnId = '';

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
         // MODALITÀ OSSERVAZIONE (progetto-tharvel-security.md, vettore B):
         // registriamo il comando ma NON lo blocchiamo. Serve a ricavare dall'uso
         // reale la whitelist da mantenere quando il tool bash verrà sostituito
         // con un terminale virtuale. Non attivare nessun blocco prima di aver
         // letto GET /api/admin/commands-summary su dati di uso vero.
         if (event.toolName === 'bash') {
           const args: any = (event as any).args;
           const cmd =
             typeof args?.command === 'string'
               ? args.command
               : typeof args?.cmd === 'string'
                 ? args.cmd
                 : JSON.stringify(args ?? {});
           console.log(`[OSSERVAZIONE] '${site.slug}' bash: ${cmd}`);
           logActivity(
             () =>
               insertCommandLog({
                 site_id: site.id,
                 turn_id: currentTurnId || null,
                 tool: event.toolName,
                 command: cmd,
               }),
             'insert command log',
           );
         }
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

    // Registrata sotto con un try/catch attorno: un throw non gestito qui
    // diventerebbe una unhandled rejection, che in Node abbatte il PROCESSO — e con
    // esso le sessioni di tutti gli altri tenant. Un errore su un messaggio deve
    // restare confinato alla connessione che l'ha causato.
    const handleClientMessage = async (message: unknown) => {
      const data = JSON.parse(String(message));
      
      if (data.type === 'set_model') {
        // Admin-only, come GET /api/models: la scelta del modello decide costo e
        // qualità. Il picker è nascosto lato UI ai client, ma la WS è raggiungibile
        // a mano, quindi il controllo deve stare anche qui.
        if (user.role !== 'admin') {
          console.warn(`[WS] '${site.slug}': set_model rifiutato per ${user.email} (role=${user.role})`);
          ws.send(JSON.stringify({ type: 'error', message: 'Solo l\'amministratore può cambiare il modello AI.' }));
          return;
        }
        // resolveModel copre sia i built-in dell'SDK sia i custom aggiunti dall'admin.
        const newModel = resolveModel(data.model);
        if (!newModel) {
          ws.send(JSON.stringify({ type: 'error', message: `Modello non trovato: ${data.model}` }));
          return;
        }
        try {
          // setModel valida le credenziali del provider e lancia se mancano
          // ("No API key for <provider>/<id>"): va intercettato, altrimenti un
          // modello scelto senza login butta giù il server per tutti.
          await session.setModel(newModel);
        } catch (e: any) {
          ws.send(JSON.stringify({
            type: 'error',
            message: `Impossibile passare a ${newModel.name}: ${e?.message ?? e}`,
          }));
          // Rimanda il modello che è ancora attivo, così il picker non resta a
          // mostrare una scelta che il server ha rifiutato.
          ws.send(JSON.stringify({ type: 'model_active', model: activeModelKey }));
          return;
        }
        // Persistiamo solo dopo che la session l'ha accettato: salvare un modello
        // che non parte lascerebbe il sito inutilizzabile alla riconnessione.
        setSiteModel(site.slug, data.model);
        activeModelKey = data.model;
        ws.send(JSON.stringify({ type: 'system', content: `✅ Modello cambiato in: ${newModel.name}` }));
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
          // quando l'utente subito dopo inviava il vero comando di modifica.
          // Però l'agente NON sa che il file esiste né dove sta: registriamo il path
          // così viene anteposto al prossimo prompt reale (vedi pendingUploadNotices).
          pendingUploadNotices.push(`${defaultUploadsRel}/${finalFileName}`);
        } catch (error: any) {
          ws.send(JSON.stringify({ type: 'error', message: error.message || 'Errore salvataggio file' }));
        }
        return;
      }

      if (data.type === 'prompt') {
        const text = data.content.trim();

        // Gestione comandi slash manuale
        if (text.startsWith('/model ')) {
          // Stessa restrizione di set_model: senza questo il cliente cambierebbe
          // modello scrivendolo in chat, aggirando il picker nascosto.
          if (user.role !== 'admin') {
            ws.send(JSON.stringify({ type: 'error', message: 'Solo l\'amministratore può cambiare il modello AI.' }));
            ws.send(JSON.stringify({ type: 'done' }));
            return;
          }
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
          pendingUploadNotices = [];
          ws.send(JSON.stringify({ type: 'system', content: `🧹 Memoria della chat cancellata.` }));
          ws.send(JSON.stringify({ type: 'done' }));
          return;
        }

        // Immagini allegate inline al prompt: vengono passate come ImageContent[]
        // al modello (multimodal input), senza essere salvate sul filesystem.
        // È il canale "screenshot di riferimento", distinto dall'upload_file.
        const images = Array.isArray(data.images)
          ? data.images
              .filter((img: any) => img && typeof img.fileBase64 === 'string' && typeof img.mimeType === 'string')
              .map((img: any) => ({
                type: 'image' as const,
                data: img.fileBase64,
                mimeType: img.mimeType,
              }))
          : undefined;

        // Cattura il prompt utente per l'auto-commit a fine turn (solo il testo reale).
        currentTurnPrompt = text;
        currentTurnHadError = false;

        // Log attività: il prompt va salvato SUBITO e sempre, anche se il turno
        // poi fallisce o non tocca file. Il turn_id lega prompt, risposta e comandi.
        currentTurnId = randomBytes(8).toString('hex');
        currentTurnReply = '';
        logActivity(
          () =>
            insertChatMessage({
              site_id: site.id,
              user_id: user.id,
              turn_id: currentTurnId,
              role: 'user',
              content: text,
            }),
          'insert user message',
        );

        // Se ci sono file appena caricati via "+" di cui l'agente non sa nulla,
        // anteponiamo i loro path al prompt così sa dove guardare quando li menziona.
        let promptForAgent = text;
        if (pendingUploadNotices.length > 0) {
          promptForAgent = `[Sistema — l'utente ha appena caricato questi file, già salvati su disco e pronti all'uso quando li menziona (NON usarli se non te lo chiede esplicitamente): ${pendingUploadNotices.join(', ')}]\n\n${text}`;
          pendingUploadNotices = [];
        }

        try {
          if (images && images.length > 0) {
            await session.prompt(promptForAgent, images);
          } else {
            await session.prompt(promptForAgent);
          }
        } catch (error: any) {
          ws.send(JSON.stringify({ type: 'error', message: error.message || 'Errore sconosciuto' }));
        }
      }
    };

    ws.on('message', async (message) => {
      try {
        await handleClientMessage(message);
      } catch (e: any) {
        console.error(`[WS] '${site.slug}': errore non gestito su un messaggio client:`, e);
        ws.send(JSON.stringify({ type: 'error', message: e?.message ?? 'Errore interno del server.' }));
        // `done` sblocca la UI: senza questo la chat resta a "sto lavorando…" per
        // sempre se l'errore è arrivato durante un turno.
        ws.send(JSON.stringify({ type: 'done' }));
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
