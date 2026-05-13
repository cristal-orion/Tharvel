import express from 'express';
import cors from 'cors';
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

dotenv.config();

// Prefisso path su cui Tharvel è montato sul dominio del cliente.
// Identico a `base` in ui/vite.config.ts e BASE_PATH in ui/src/site.ts.
// Cambiare in tutti e tre i punti se si rinomina (rottura silenziosa garantita).
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
// - astro: serve cwd/dist/ perché i sorgenti (.astro/.md) non sono HTML eseguibili.
//   Il cwd dell'agente resta la root del progetto, così l'agente vede sia i sorgenti
//   sia il package.json per lanciare `npm run build`.
function resolveSiteServeRoot(site: Site): string {
  const cwd = resolveSiteCwd(site);
  return site.framework === 'astro' ? path.join(cwd, 'dist') : cwd;
}

// Cartella in cui depositare gli upload (immagini compresse, file utente).
// Per Astro va in public/ (Astro la copia 1:1 in dist/ al build successivo).
// Per html resta assets/ accanto a index.html.
function resolveSiteUploadsDir(site: Site): string {
  const cwd = resolveSiteCwd(site);
  return site.framework === 'astro'
    ? path.join(cwd, 'public')
    : path.join(cwd, 'assets');
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
// WS in modalità noServer: il filtro per path viene applicato sull'evento upgrade
// così rifiutiamo subito le connessioni che non puntano a BASE_PATH (es. probe,
// vecchie URL pre-prefix) invece di passare un ws aperto al codice di sessione.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', 'http://x').pathname;
  // Accetta sia `/tharveladmin` sia `/tharveladmin/` (con query string è la stessa cosa).
  if (pathname === BASE_PATH || pathname === `${BASE_PATH}/`) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

app.use(cors());
app.use(express.json());

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

// Static serve scoped per tenant: BASE_PATH/site/<slug>/... → cwd del sito risolto via DB.
// Per Astro: HTML viene riscritto al volo (href/src + overlay). Asset → static puro.
// Per html: tutto static (i siti Tharvel-aware hanno già lo script inline).
const staticHandlerCache = new Map<string, express.RequestHandler>();
app.use(`${BASE_PATH}/site/:slug`, async (req, res, next) => {
  const slug = req.params.slug;
  const site = getSiteBySlug(slug);
  if (!site) {
    res.status(404).send(`Site '${slug}' not found`);
    return;
  }

  // Per Astro intercettiamo solo le richieste HTML (root, /pagina/, *.html).
  // Tutto il resto (asset _astro/, immagini, font) passa allo static handler sotto.
  if (site.framework === 'astro') {
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

// Endpoint WS chiamato dal widget Tharvel: la connessione è scoped a uno specifico sito,
// risolto via slug (?site=) o Host header → DB lookup.
wss.on('connection', async (ws, req) => {
  const site = resolveSiteFromRequest(req);
  if (!site) {
    const reqHost = req.headers['x-forwarded-host'] || req.headers.host || '(none)';
    console.warn(`[WS] connessione rifiutata: nessun sito per url=${req.url} host=${reqHost}`);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Sito non riconosciuto. Specifica ?site=<slug> oppure configura il dominio nel DB.',
    }));
    ws.close(1008, 'unknown site');
    return;
  }
  console.log(`[WS] connessione accettata per sito '${site.slug}' (id=${site.id})`);

  try {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    const sitePath = resolveSiteCwd(site);

    // System prompt parametrizzato sul framework del sito.
    // - html: file piatti (index.html + assets/), edit visibile subito.
    // - astro: sorgenti in src/ (.astro/.md/.mdx), asset in public/, dopo l'edit
    //   serve `npm run build` per rigenerare dist/ (che è quello servito al browser).
    const agentsContent = site.framework === 'astro'
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

L'edit di un file del sito deve essere CHIRURGICO: cambia SOLO ciò che l'utente ha chiesto, non riscrivere intere pagine né aggiungere contenuti non richiesti.`
      : `Sei Tharvel, l'agente AI esperto per la gestione del sito "${site.slug}".
Regole fondamentali:
1. I file del sito web si trovano nella tua cartella corrente. Il file HTML principale è "index.html" e le immagini sono in "assets/".
2. Quando l'utente chiede una modifica, USA SEMPRE gli strumenti (read, edit) per applicarla realmente. Non limitarti a spiegare a parole come fare, FALLO TU fisicamente usando i tool.
3. Prima di usare "edit", usa sempre "read" per leggere il contenuto esatto e non sbagliare il rimpiazzo.
4. Non chiedere mai conferma prima di usare uno strumento: agisci direttamente in modo autonomo.
5. Parla in italiano in modo conciso e professionale. Al termine della modifica avvisa l'utente.`;

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

    // Nell'SDK 0.73 `tools` è string[] di nomi attivi; i tool built-in (read/bash/edit/write)
    // vengono creati internamente con il `cwd` passato qui sopra. Omettendo `tools` l'SDK
    // attiva tutti i default automaticamente.
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      model: modelRegistry.find("openai-codex", "gpt-5.5"),
      authStorage,
      modelRegistry,
      cwd: sitePath,
      customTools: [processUploadTool],
      resourceLoader: loader,
    });

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
// Mount sotto BASE_PATH così tutte le URL della UI sono coerenti col routing
// path-based sul dominio cliente (es. industrial.com/tharveladmin).
const uiDistPath = path.resolve(__dirname, '..', 'ui-dist');
if (existsSync(uiDistPath)) {
  app.use(BASE_PATH, express.static(uiDistPath));
  // SPA fallback: GET sotto BASE_PATH che non siano la preview tenant o file
  // statici esistenti tornano index.html (Vue Router/state lato client).
  // Express 5: `app.get('*', ...)` rompe path-to-regexp 8 → uso app.use middleware.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!req.path.startsWith(BASE_PATH)) return next();
    if (req.path.startsWith(`${BASE_PATH}/site/`)) return next();
    res.sendFile(path.join(uiDistPath, 'index.html'));
  });
  console.log(`[UI] static served from ${uiDistPath} on ${BASE_PATH}`);
} else {
  console.log(`[UI] ui-dist non trovato (${uiDistPath}): dev mode, l'UI gira su vite :5173`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tharvel Engine in esecuzione sulla porta ${PORT}`);
});
