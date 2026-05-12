# Progetto Tharvel

## Documento di Visione, Architettura e Filosofia

---

## 1. Il Problema

WordPress è stato per anni il punto di ingresso principale per chi voleva una presenza online. Tuttavia, oggi mostra tutti i limiti di una piattaforma progettata più di vent'anni fa: plugin incompatibili, aggiornamenti che rompono il sito, performance scadenti, sicurezza fragile e un ecosistema monolitico difficile da mantenere.

Il vero problema però non è solo WordPress — è il **combo WordPress + Elementor** che le agenzie utilizzano per offrire ai clienti un'interfaccia visiva di editing. Questo stack risolve un bisogno reale: il cliente deve poter modificare i propri contenuti in autonomia, senza chiamare lo sviluppatore ogni volta per cambiare un testo o aggiornare un prezzo.

Il ciclo attuale è rotto:

> Cliente vuole cambiare un testo → chiama l'agenzia → l'agenzia apre un ticket → modifica in 3 giorni → fattura 50€

Tharvel rompe questo ciclo.

---

## 2. La Visione

**Tharvel è un layer di gestione intelligente che si aggancia a qualsiasi sito web esistente** — HTML, React, Next.js, Vue, o anche WordPress — e lo trasforma in un prodotto gestibile autonomamente dal cliente, senza toccare il codice.

Non è un CMS che genera siti da zero. Non è un page builder che funziona solo su siti costruiti internamente. È un **admin panel universale** che "adotta" qualsiasi sito già esistente e lo rende gestibile, estendibile e sicuro.

Lo scopo finale è diventare lo **standard per gli sviluppatori del futuro** che non vogliono più dipendere da WordPress: uno strumento che le agenzie installano al termine dello sviluppo per consegnare al cliente un prodotto autonomo, moderno e sicuro.

Tharvel non è un SaaS pubblico da vendere a chiunque. È uno **strumento professionale** che il developer installa sulla propria VPS e distribuisce ai propri clienti — esattamente come un'agenzia distribuisce WordPress, ma con un'architettura moderna e intelligente.

---

## 3. Il Posizionamento

**Tharvel non sostituisce il tuo lavoro. Elimina le rotture di scatole.**

| | WordPress + Elementor | Tharvel |
|---|---|---|
| **Funziona su siti esistenti** | No (richiede WP) | Sì, qualsiasi sito |
| **Visual editor** | Sì (Elementor) | Sì (Vibeyard-based + Pi Agent) |
| **Preview in tempo reale** | Parziale | Sì, branch preview live prima del push |
| **Version control** | No (revisions limitate) | Sì, Git nativo + snapshot automatici |
| **Rollback** | Manuale e difficile | Un click |
| **AI integrata** | No | Sì (Pi Agent SDK wrappato) |
| **Upload file in chat** | No | Sì, immagini e file direttamente in chat |
| **Generazione immagini AI** | No | Sì, custom tool nel Pi Agent |
| **Plugin rotti** | Problema costante | Non esistono plugin di terze parti |
| **Performance** | Pesante, PHP monolitico | Agnostico, frontend statico/JAMstack |
| **Sicurezza** | Vulnerabile | 2FA obbligatorio, container isolati, audit log |
| **BYOK** | No | Sì (porta le tue API key) |
| **Self-hosted** | Parziale | Sì, gira sulla tua VPS con Coolify |

---

## 4. La Filosofia: Pi Agent come Cuore di Tharvel

### 4.1 Perché Pi Agent

Pi è un coding agent minimale progettato esplicitamente per essere **wrappato all'interno di altre applicazioni**. A differenza di Claude Code o OpenCode, non è un prodotto sigillato: espone un SDK TypeScript che permette di:

- Eseguire l'agent in modalità programmatica (`SDK mode`)
- Registrare **custom tools** (es. generazione immagini, upload file, compressione)
- Passare le API key come variabili d'ambiente nel container — mai esposte al frontend
- Ricevere lo streaming dei token in tempo reale per il feedback live all'utente

```typescript
import { createAgent, createCodingTools } from "@pi-agent/sdk";

const agent = createAgent({
  model: "claude-sonnet-4",
  tools: [
    ...createCodingTools({ cwd: "/var/www/clientesito.com" }),
    generateImageTool,  // custom
    uploadFileTool,     // custom
    compressImageTool,  // custom
  ],
});
```

Le API key restano variabili d'ambiente nel container AI — il BYOK è gestito nativamente.

### 4.2 Architettura Multi-Tenant Centralizzata

> **Revisione 2026-05-07.** L'idea originale (admin panel pushato come cartella `_tharvel/` dentro ogni repo cliente) è stata scartata in favore di un container Tharvel **unico e centralizzato** sulla VPS del developer. I repo dei clienti restano puliti: zero codice Tharvel al loro interno.

La filosofia architetturale centrale di Tharvel è che **l'admin panel è un singolo servizio multi-tenant** sulla VPS del developer, raggiunto attraverso il dominio del cliente via reverse proxy.

Il repo del sito cliente non viene mai toccato da Tharvel:

```
sito-cliente/
├── index.html          ← sito del cliente (invariato)
├── assets/
├── ...
                        ← nessuna cartella Tharvel
```

Il cliente accede a `clientesito.com/tharveladmin` → Nginx sulla VPS riconosce il path, fa proxy verso il container Tharvel `:3000` passando `X-Forwarded-Host: clientesito.com` → Tharvel risolve l'host nella tabella `sites` (`domain → cwd_path → repo_url → preview_url`) → schermata di login → Pi Agent si avvia con `cwd` puntato alla cartella del sito corretto.

Vantaggi di questo approccio rispetto alla co-location:
- **Un solo codebase da aggiornare** — ogni fix beneficia istantaneamente tutti i clienti
- **Repo cliente puliti** — zero codice admin in repo potenzialmente pubblici
- **Sicurezza** — il codice dell'admin non viene mai esposto, nemmeno indirettamente
- **Multi-tenancy reale** — DB unico, audit log unico, gestione utenti coerente
- Nessun sottodominio separato da configurare per ogni cliente
- Tutta l'intelligenza (Pi Agent, API key, Git) vive sulla VPS del developer, mai sul server del cliente

Trade-off accettato: se il container Tharvel cade, **tutti** i pannelli admin diventano irraggiungibili contemporaneamente. Mitigazioni: healthcheck Coolify + auto-restart, in prospettiva una pagina statica "manutenzione" come fallback Nginx.

### 4.3 Routing e Protezione del Path Admin

La protezione si applica al container centrale, non al repo cliente. Il proxy avviene a livello di reverse proxy del sito cliente, e il container Tharvel valida l'host nella richiesta prima di mostrare login.

```nginx
# Snippet da aggiungere nella config Nginx del sito cliente
location /tharveladmin {
    proxy_pass http://tharvel-app:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;

    # Upgrade per WebSocket streaming
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Lato Tharvel, l'autenticazione è applicata **dentro** il container con Argon2id + JWT + 2FA TOTP (vedi sezione 8). L'`X-Forwarded-Host` è autoritativo per scegliere il tenant: viene confrontato con la tabella `sites` e qualunque slug non corrispondente al JWT viene rifiutato.

---

## 5. Come Funziona: Il Flusso Completo

### 5.1 Flusso tecnico delle modifiche

```
Cliente scrive un prompt nella chat Tharvel
              ↓
Pi Agent riceve il prompt + eventuale file allegato
              ↓
Agent lavora sul branch "preview" del repo
(modifica file sorgente, comprime immagini, scrive codice)
              ↓
Streaming live: il cliente vede le modifiche in tempo reale
mentre l'agent lavora (token by token, file by file)
              ↓
Preview si aggiorna automaticamente (iframe live)
Il cliente vede il sito modificato prima del push
              ↓
Cliente approva → clicca "Pubblica"
              ↓
Snapshot automatico salvato
Git commit con messaggio leggibile → merge preview → main → push
              ↓
Webhook Coolify → rebuild + deploy automatico
              ↓
Sito live aggiornato
```

### 5.2 Onboarding di un sito esistente

1. **Connessione** — il developer connette il repo Git del sito (GitHub, GitLab, Gitea) tramite l'interfaccia Tharvel sulla VPS
2. **Analisi AI** — Pi Agent analizza il codebase e identifica automaticamente i contenuti modificabili
3. **Mapping** — viene generato uno schema editabile: "questo è il titolo della homepage", "questi sono i prodotti del negozio", "questa è la sezione blog"
4. **Configurazione routing** — il developer aggiunge alla config Nginx del sito cliente lo snippet `location /tharveladmin { proxy_pass http://tharvel-app:3000; ... }` e crea la riga corrispondente nella tabella `sites` del DB Tharvel (`domain → cwd_path → repo_url → preview_url`). Nessuna modifica al repo cliente.
5. **Consegna** — il developer fornisce al cliente URL (`clientesito.com/tharveladmin`) e credenziali. Da quel momento il cliente è autonomo

---

## 6. Funzionalità Chiave

### 6.1 Chat con Pi Agent

L'interfaccia principale di Tharvel è una **chat conversazionale** simile a Claude.ai ma specifica per la gestione del sito. Il cliente scrive in linguaggio naturale:

> "Cambia il colore del bottone principale in verde"
> "Aggiungi una sezione FAQ dopo i prezzi"
> "Usa questa foto come sfondo della homepage" *(allega l'immagine)*
> "Crea un'immagine hero con uno sfondo astratto blu per la landing"

Pi Agent esegue la richiesta, lo streaming mostra cosa sta facendo in tempo reale, la preview si aggiorna live.

### 6.2 Upload File in Chat

Il cliente può allegare file direttamente nella chat, esattamente come in qualsiasi app di messaggistica moderna. Pi Agent riceve il file tramite un custom tool e:

- **Immagini**: le comprime automaticamente (WebP, ottimizzazione dimensioni), le posiziona nella cartella `assets/` corretta, le imposta dove richiesto nel codice
- **PDF, documenti**: li analizza e li integra nel sito se necessario (es. "carica il nuovo listino prezzi come PDF scaricabile")
- **Font, SVG, altri asset**: li gestisce in base al contesto della richiesta

```typescript
const uploadFileTool = defineTool({
  name: "process_uploaded_file",
  description: "Riceve un file dalla chat, lo comprime se è un'immagine e lo salva nella cartella assets",
  parameters: Type.Object({
    fileBase64: Type.String(),
    fileName: Type.String(),
    mimeType: Type.String(),
    targetPath: Type.String(),
  }),
  execute: async (_id, params) => {
    // Compressione con Sharp (WebP, resize intelligente)
    // Salvataggio in /assets/images/
    // Ritorna path relativo da usare nel codice
  }
});
```

### 6.3 Generazione Immagini con AI

Custom tool che permette di generare immagini direttamente dalla chat e posizionarle nel sito:

```typescript
const generateImageTool = defineTool({
  name: "generate_image",
  description: "Genera un'immagine AI con il prompt specificato e la salva nella cartella assets",
  parameters: Type.Object({
    prompt: Type.String(),
    filename: Type.String(),
    style: Type.Optional(Type.String()),
  }),
  execute: async (_id, params) => {
    // Chiamata a Replicate (Flux) / DALL-E / Stability AI
    // Ottimizzazione automatica (WebP, dimensioni corrette)
    // Salvataggio in /assets/images/generated/
    // Ritorna path relativo
  }
});
```

Il cliente può dire: *"Crea un'immagine di sfondo astratta in toni blu per la sezione hero"* e l'agent la genera, la salva e la imposta nel codice automaticamente.

### 6.4 Preview in Tempo Reale

Il flusso preview/production è uno dei punti più importanti dell'esperienza Tharvel:

- Tutte le modifiche avvengono sul branch `preview` — il sito live non viene mai toccato finché il cliente non approva
- Un iframe nell'interfaccia mostra il sito sul branch preview, aggiornato in tempo reale mentre l'agent lavora
- Il cliente vede le modifiche prima di pubblicarle — esattamente come lavorare su una bozza
- Prima di ogni pubblicazione: **diff visivo** dei file modificati con possibilità di annullare
- **"Pubblica"** → merge preview → main → webhook Coolify → deploy automatico

#### 6.4.1 Auto-commit policy (decisione 2026-05-10, B3 di `progetto-tharvel-backup.md` chiusa)

**Policy approvata**:

- **Auto-commit SÌ** sul branch `preview`, dopo ogni *turn* riuscito dell'agente.
- **Auto-push NO**. Il push (verso origin) avviene solo come parte di "Pubblica".
- **"Pubblica"** rimane azione esplicita dell'utente: merge `preview` → `main` (o `master` per repo legacy) + push verso origin → webhook Coolify → deploy.

Razionale: committare dopo ogni save grezzo dell'agente sporcherebbe la storia
con micro-commit incoerenti. Committare solo a fine turn dà una unità di
cambiamento corrispondente all'intento utente ("cambia titolo home" = 1 commit
con tutti i file toccati nel turno). Il push separato preserva la semantica
"preview prima, pubblica poi" già scritta in §6.4.

**Definizione di "turn riuscito"** (criteri ANDed):

- Evento `agent_end` ricevuto dalla session SDK senza eccezione runtime;
- Nessun `tool_execution_end` con `isError: true` nel turno corrente;
- `git status --porcelain` dentro `sitePath` ritorna almeno una riga di modifica
  rispetto a `HEAD` (cioè l'agente ha davvero toccato file utente, non solo letto);
- Nessun marker di stato "rifiutato dall'utente" attivo (UX: pulsante "Annulla
  ultima modifica" durante lo streaming → blocca il commit a fine turn).

Se uno dei criteri fallisce: nessun commit. La modifica resta come dirty
working copy del branch preview, recuperabile dal backup giornaliero (vedi
`progetto-tharvel-backup.md`) in caso di crash server prima del turn successivo.

**Messaggio di commit**: template senza chiamata LLM extra, per non gonfiare
il costo per turn:

```
<verb> <prompt utente troncato a 60 char>

Tharvel auto-commit (turn <session-id>:<turn-n>).
File modificati:
- src/pages/index.astro
- public/hero.webp
```

Verb derivato dalla prima parola del prompt utente normalizzata
(`cambia` → `Cambia`, `aggiungi` → `Aggiungi`, fallback `Modifica`). La storia
resta leggibile da un umano che fa `git log --oneline` sul branch preview.

**Pubblica — strategia di merge**:

- Default: `git merge --ff-only preview` se `main` non è divergente.
- Se `main` è divergente (drift fuori da Tharvel, es. hotfix manuale via
  GitHub UI): UI Tharvel mostra alert + propone merge esplicito o rebase di
  `preview` su `main`. NON risolve automaticamente i conflitti.
- Squash merge come opzione utente (NON default): "Pubblica come singolo
  commit di sintesi" → utile per chiusura di sessioni lunghe con molti turn.

**Bootstrap del repo al momento di registrare un sito** (modello target Beta+):

1. `git clone <repo_url> /var/tharvel/sites/<slug>/` (con deploy key del sito,
   vedi piano sicurezza Strato 3a).
2. `git -C <slug> checkout -B preview` (crea branch preview da `main`/`master`
   se non esiste, oppure switcha all'esistente).
3. `git -C <slug> config user.name "Tharvel Agent (<slug>)"` +
   `user.email "agent+<slug>@tharvel.local"`.
4. Da questo momento ogni turn dell'agente fa commit qui.

Stato 2026-05-10: nessun sito cliente reale esiste ancora. Le fixture POC
(`acme`, `demo`, `restaurant-astro`) verranno eliminate quando si passa al
primo sito reale. Il bootstrap sopra si applica dal primo sito cliente in
poi.

**Conseguenza per il piano backup**: l'auto-commit riduce drasticamente l'RPO
sui file siti. Tra un turno e l'altro la perdita massima è il singolo turn in
corso (working copy non ancora committata), che è recuperabile dal backup
giornaliero — non più "tutte le modifiche dall'ultimo push manuale".
B3 nel doc backup è quindi chiusa con questa policy, e l'auto-commit diventa
una **mitigazione RPO complementare al backup**, non sostitutiva.

**Punti rimandati a implementazione operativa** (non architettonici):

- Hook concreto post-`agent_end` nel server WS per triggerare il commit.
- Gestione race condition se l'utente apre un secondo turn mentre il commit
  del primo è in corso.
- UI per "Annulla ultima modifica" durante lo streaming (collegato a §6.5
  rollback timeline).
- Cosa fare se il working tree è "dirty" all'apertura sessione (commit
  pendente di una sessione precedente crashata): proporre commit/discard
  all'utente.

#### 6.4.2 Distribuzione delle policy agente (riferimento)

Le policy agente che riguardano sicurezza, auto-commit, path-guard e wrap di
`bash` sono distribuite come **pi-package interno Tharvel** (extension
versionate del SDK pi-coding-agent), non come file sparsi nel server.
Architettura completa, layout monorepo, mappa agli esempi SDK e pushback
architetturale: vedi §6.7 di `progetto-tharvel-security.md`.

Sintesi: ogni sito cliente avrà un `.pi/settings.json` che lista i package
extension da caricare. Le extension vivono in un workspace separato
(`extensions/@tharvel-agent-extensions/`) montato read-only nel bwrap dei
siti. Pre-installate nell'image Docker del server (no `pi install` di rete
a runtime). Decisione tenuta nel doc sicurezza finché il wrap bwrap non è
stabilizzato; promozione a §7.4 dello stack quando l'implementazione sarà
in piedi.

### 6.5 Version Control e Rollback

Ogni modifica è tracciata e reversibile:

- **Rollback singolo campo** — ripristina il testo precedente in un paragrafo
- **Rollback pagina** — ripristina com'era la homepage ieri
- **Rollback sito completo** — torna alla versione di una settimana fa
- Timeline visuale delle modifiche con messaggio leggibile ("Modificato: hero text + immagine sfondo — 4 Maggio 2026 ore 21:30")

---

## 7. Stack Tecnologico

### 7.1 Architettura a Container su VPS/Coolify

```
Internet
   ↓ HTTPS only
Coolify reverse proxy (SSL Let's Encrypt automatico)
   ↓
┌─────────────────────────────────────────────┐
│  CONTAINER 1: Tharvel App                   │
│  - Frontend: Nuxt 3 + Vue 3                 │
│  - Backend: Node.js / Nitro                 │
│  - Chat UI + Visual Editor                  │
│  - Gestione upload file / preview iframe    │
│  - Auth layer (Argon2id + JWT + 2FA)        │
│  - Git integration + Coolify webhook        │
│  - WebSocket server per streaming Pi Agent  │
│  Porta: 3000 (interna Coolify)              │
└──────────────────┬──────────────────────────┘
                   │ IPC / WebSocket (rete Docker interna)
┌──────────────────▼──────────────────────────┐
│  CONTAINER 2: Pi Agent Engine               │
│  - Pi Agent SDK (TypeScript/Node.js)        │
│  - createCodingTools (readTool, editTool,   │
│    writeTool, bashTool)                     │
│  - generateImageTool (custom)               │
│  - uploadFileTool + compressImageTool       │
│  - API key come ENV vars cifrate            │
│  - MAI esposto pubblicamente                │
│  Porta: 8080 (solo rete Docker interna)     │
└──────────────────┬──────────────────────────┘
                   │ filesystem (volume Docker condiviso)
                   ▼
          /var/www/siti-clienti/
          ├── clientesito1.com/  ← solo codice sito, nessun _tharvel/
          ├── clientesito2.com/
          └── ...

Routing tenant (per ogni dominio cliente):
   clientesito1.com/tharveladmin
        ↓ Nginx (host=clientesito1.com, path=/tharveladmin)
        ↓ proxy_pass + X-Forwarded-Host
   Tharvel App :3000
        ↓ DB lookup su tabella `sites` (domain → cwd_path)
   Pi Agent con cwd = /var/www/siti-clienti/clientesito1.com/
```

### 7.2 Stack per Layer

| Layer | Tecnologia |
|---|---|
| **Frontend admin** | Nuxt 3, Vue 3, Tailwind CSS |
| **Backend** | Node.js, Nitro (Nuxt server) |
| **Chat UI** | Interfaccia conversazionale con streaming token |
| **Visual editor** | Vibeyard-based (iframe + overlay JS) |
| **AI engine** | Pi Agent SDK wrappato |
| **Modelli AI** | BYOK (Anthropic, OpenAI, Gemini) o managed |
| **Generazione immagini** | Replicate (Flux) / DALL-E / Stability AI |
| **Compressione immagini** | Sharp (Node.js) |
| **Database** | SQLite via `better-sqlite3` su volume Coolify dedicato `/data/tharvel.db` (utenti, sessioni, audit log, mapping siti). Decisione 2026-05-08; trigger di migrazione a Postgres documentati in memoria. |
| **Version control** | Git nativo (GitHub, GitLab, Gitea, self-hosted) |
| **Deploy** | Coolify webhook → rebuild automatico |
| **Container** | Docker + Docker Compose |
| **Auth** | Argon2id + JWT rotation + TOTP 2FA |

---

## 8. Sicurezza

### 8.1 Autenticazione

- **Password hashing**: Argon2id
- **Session management**: JWT con access token (15 min) + refresh token (7 giorni) con rotazione
- **2FA obbligatorio**: TOTP via Google Authenticator/Authy (otplib)
- **HTTPS forzato**: via Coolify

### 8.2 Protezione brute force

- 5 tentativi falliti → blocco IP 15 minuti
- 10 tentativi falliti → blocco permanente + alert email
- Rate limiting: max 10 richieste/minuto su `/login` (express-rate-limit + Redis)

### 8.3 Protezione del path admin

Con l'architettura centralizzata (vedi 4.2), il path `/tharveladmin` su ogni dominio cliente fa proxy al container Tharvel: non c'è pagina statica da proteggere a monte, quindi l'`auth_basic` Nginx non è più necessaria. La difesa è:

1. **Rate limiting Nginx** sulla `location /tharveladmin` (es. `limit_req zone=tharvelLogin burst=10`) — taglia bruteforce a monte
2. **Login Tharvel** dentro il container — Argon2id + JWT + 2FA TOTP
3. **Validazione `X-Forwarded-Host`** contro tabella `sites` e contro lo `slug` nel JWT — qualunque mismatch viene rifiutato

### 8.4 Isolamento container AI

Il container Pi Agent non è mai esposto pubblicamente. Le API key sono variabili d'ambiente nel container — mai visibili al frontend, mai nel codice del sito cliente.

### 8.5 Session management avanzato

- Login da nuovo dispositivo → notifica email
- Lista sessioni attive visibile nell'admin
- "Disconnetti tutti i dispositivi" con un click
- Timeout inattività configurabile (default: 30 minuti)

### 8.6 Audit log completo

Ogni azione registrata: chi ha fatto login, da quale IP, cosa ha modificato, quale file, quando ha pubblicato.

---

## 9. UI/UX: L'Interfaccia

L'interfaccia di Tharvel deve essere **immediatamente familiare** per chi viene da WordPress, ma visivamente superiore. Tre aree principali:

### Area 1 — Chat con Pi Agent
Interfaccia conversazionale con:
- Campo testo per il prompt
- **Pulsante di upload file** (drag & drop o click) — immagini, PDF, asset
- Streaming live dei token mentre l'agent lavora (con indicatori visivi del file che sta modificando)
- Storico della conversazione per sessione

### Area 2 — Preview Live
- Iframe che mostra il sito sul branch preview
- Si aggiorna automaticamente al termine di ogni modifica dell'agent
- Pulsante per aprire la preview in fullscreen o su dispositivo mobile simulato

### Area 3 — Pannello Gestione
- **Contenuti** — modifica rapida testi, immagini, prodotti, articoli senza passare dall'AI per operazioni semplici
- **Timeline modifiche** — storico visuale con rollback per ogni commit
- **File manager** — gestione asset del sito (immagini, documenti, font)
- **Impostazioni** — credenziali, API key (BYOK), configurazione deploy

---

## 10. Modello di Utilizzo

Tharvel non è un SaaS pubblico. È uno **strumento professionale self-hosted** che il developer installa sulla propria VPS e distribuisce ai propri clienti. Ogni developer è il proprio "Automattic" per i suoi clienti.

### BYOK (Bring Your Own Key)
Il developer configura le proprie API key (Anthropic, OpenAI, Gemini) nel container AI. Zero markup, zero dipendenza da servizi cloud terzi. Ideale per chi ha già API key e vuole controllo totale dei costi.

### Managed (futuro)
Un abbonamento flat che include i modelli AI pre-configurati. Il developer non deve gestire le chiavi. Ideale per chi vuole installare e dimenticare.

---

## 11. Feature List MVP

### Fase 1 — Core

- [ ] Autenticazione sicura (Argon2id + JWT + 2FA TOTP)
- [ ] Container Tharvel multi-tenant unico + tabella `sites` (domain → cwd_path)
- [ ] Snippet Nginx `proxy_pass /tharveladmin → tharvel-app:3000` + rate limiting
- [ ] Validazione `X-Forwarded-Host` contro `sites` e contro slug nel JWT
- [ ] Chat con Pi Agent (streaming live token)
- [ ] Upload file in chat con compressione automatica (Sharp)
- [ ] Preview live su branch separato (iframe aggiornato in tempo reale)
- [ ] Snapshot automatici pre-modifica
- [ ] Rollback con un click
- [ ] Bottone "Pubblica" → merge preview → main → webhook Coolify
- [ ] Diff visivo pre-pubblicazione
- [ ] Audit log base

### Fase 2 — Espansione

- [ ] Generazione immagini AI in chat (Replicate/Flux)
- [ ] Visual editor base (click-to-edit sull'iframe preview)
- [ ] Drag & drop blocchi semantici
- [ ] Gestione prodotti e-commerce
- [ ] Gestione blog/articoli
- [ ] Timeline grafica delle modifiche
- [ ] File manager integrato
- [ ] Gestione multi-sito (un account Tharvel, più siti)
- [ ] Notifiche email su login da nuovo dispositivo

### Fase 3 — Ecosistema

- [ ] Marketplace moduli AI generabili su richiesta
- [ ] Piano managed con modelli pre-configurati
- [ ] Integrazione Telegram/WhatsApp per comandi rapidi
- [ ] Dashboard analytics (token consumati, modifiche per utente, costi AI)
- [ ] Supporto siti con backend dinamico (PHP/Laravel) in modalità ibrida

---

## 12. Competitor Analisi

| Tool | Cosa fa | Perché non basta |
|---|---|---|
| **WordPress + Elementor** | CMS + visual editor | Monolitico, PHP, plugin rotti, no version control, no AI |
| **Onlook** | Visual editor React-like | Solo locale, solo React/Tailwind, non in produzione |
| **Builder.io** | Visual editor + CMS headless | Richiede SDK dedicato, non agnostico, SaaS cloud |
| **Strapi** | CMS headless open source | No visual editor, no AI, no analisi sito esistente |
| **Payload CMS** | CMS TypeScript-first | No AI, no visual editor, no analisi sito esistente |
| **Webflow** | No-code builder + CMS | Solo siti creati in Webflow, lock-in totale |
| **Framer** | Visual editor + CMS | Solo siti creati in Framer, lock-in totale |

**Il gap che Tharvel riempie**: agnosticità totale (qualsiasi sito esistente) + chat AI con streaming + upload file in chat + generazione immagini + version control automatico + self-hosted sulla propria VPS.

---

## 13. Nome e Identità

**Tharvel** — nome inventato con estetica Tolkien-inspired (filone Sindarin/nanico). Evoca solidità, artigianalità e affidabilità. Unico nello spazio software.

**CLI**: `tharv` — per operazioni da terminale (`tharv init`, `tharv deploy`, `tharv rollback`)

**Tagline**: *Tharvel non sostituisce il tuo lavoro. Elimina le rotture di scatole.*

**`tharv init` — e il gioco è fatto.**

---

*Documento aggiornato — Maggio 2026*
