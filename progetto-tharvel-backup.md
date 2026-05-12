# Tharvel — Piano Backup & Restore (workstream #8)

## Documento di pianificazione: backup off-site + drill di restore

> Apertura: 2026-05-10. Workstream tracciato come decisione #8 nella tabella §7
> di `progetto-tharvel-security.md`. Obiettivo: chiudere il gap operativo
> identificato in `vps_backup_gap.md` (memory) prima di aprire la Beta privata.
>
> Scope: solo Tharvel. I DB co-tenant sulla stessa VPS (Directus, Plausible,
> Coolify standalone) hanno lo stesso gap ma sono trattati come issue separato
> — vedi §6.

---

## 1. Premesse operative

Stato infrastruttura (2026-05-10):

- **VPS**: OVH.
- **Stack Tharvel**: container singolo Node/TS, SQLite locale (`better-sqlite3`,
  WAL mode), cartelle siti su volume `/data` (in dev: `tharvel/data/` +
  `tharvel/sites/`, in prod: `/var/tharvel/`).
- **Modello deploy siti** (target Beta/Prod): ogni sito ha **repo Git remoto**
  come ground truth dei sorgenti. Push verso origin → webhook Coolify → rebuild.
  Stato 2026-05-10: nessun sito cliente reale esiste ancora; gli unici siti in
  `tharvel/sites/` sono fixture POC (`acme`, `demo` senza `.git/`,
  `restaurant-astro` clone di un repo esempio destinato a essere eliminato).
  Solo il **codice Tharvel** è oggi su Git remoto; il deploy del server Tharvel
  sulla VPS avviene via Claude on-host. Il modello "repo Git per sito" si
  attiva con il primo cliente reale.
- **Automazione Git nel server** (post-decisione B3 del 2026-05-10):
  auto-commit SÌ sul branch `preview` dopo ogni turn riuscito dell'agente,
  auto-push NO. "Pubblica" resta azione esplicita che merge `preview` →
  `main` + push. Specifica completa in `progetto-tharvel.md` §6.4.1.

Implicazione: l'auto-commit su preview riduce drasticamente l'RPO sui file
siti — tra un turno e l'altro la perdita massima è la working copy del turno
in corso, non "tutte le modifiche dall'ultimo push manuale". Tuttavia,
**la cartella VPS contiene comunque stato che non è altrove**:

- modifiche committate sul branch `preview` ma non ancora pushate (per design,
  finché l'utente non clicca "Pubblica"),
- upload utente che vivono nella working copy fino al commit di fine turno,
- working copy del turno in corso (gap RPO residuo, ~1 turno),
- `dist/` (gitignored di norma) — la cui ricostruzione richiede `npm install`
  + `npm run build` su ogni sito, allungando RTO.

Il backup completo della cartella siti resta giustificato anche post-B3:
auto-commit è mitigazione RPO **complementare** al backup, non sostitutiva.

---

## 2. Inventario dati (cosa salvare)

| Tier | Asset | Path tipico (prod) | Frequenza | Note |
|---|---|---|---|---|
| **A — critico** | DB Tharvel SQLite | `/var/tharvel/data/tharvel.db` | daily | online safe via `sqlite3 .backup`, NON `cp` (WAL attivo) |
| **A — critico** | Cartelle siti — sorgenti utente | `/var/tharvel/sites/<slug>/{src,public,assets,*.json,*.config.*,index.html}` | daily | esclude `node_modules/`, `dist/`, `.cache/`, build artifact |
| **A — critico** | Upload utente (immagini caricate via widget) | `<slug>/public/` per Astro, `<slug>/assets/` per html | daily | sovrapposto al punto sopra, citato per chiarezza |
| **A — critico** | Config server e segreti | `/var/tharvel/.env`, file chiavi (vedi §3) | daily | encrypted at rest obbligatorio |
| **B — utile** | `.git/` locale di ogni sito | `<slug>/.git/` | daily | facilita `git status` post-restore senza re-clone; cheap con dedup restic |
| **C — diagnostica** | Log server | `/var/tharvel/logs/server.log` | weekly o no | log rotation locale + retention 14gg basta |
| **OUT** | `node_modules/`, `dist/`, build cache | — | mai | rigenerabile da `npm install` + `npm run build` |
| **OUT** | DB co-tenant (Directus/Plausible/Coolify) | — | — | issue separato, vedi §6 |

### Note sull'inventario

- **DB SQLite**: il comando giusto è `sqlite3 tharvel.db ".backup '/tmp/tharvel-snapshot.db'"`. Produce un file consistente anche con writes in corso. Solo dopo, `restic backup /tmp/tharvel-snapshot.db`. Mai backup diretto del file mentre WAL è attivo: rischio dump incoerente.
- **Sorgenti siti**: pattern di esclusione restic:
  ```
  --exclude '**/node_modules' --exclude '**/dist' --exclude '**/.cache' --exclude '**/.astro'
  ```
- **Segreti**: vedi §3, capitolo dedicato.

---

## 3. Chiavi e segreti — gestione separata

I segreti hanno requisiti diversi dal resto del backup: encryption mandatoria,
key custodian distinto, rotation pianificata.

Asset attuali e futuri:

| Segreto | Quando arriva | Storage suggerito | Backup |
|---|---|---|---|
| API key provider AI (anthropic, github-copilot) | già presenti in dev (auth-storage SDK) | `.env` server | dentro restic encrypted |
| JWT signing key (Strato 4) | con Strato 4 | `.env` o file dedicato in `/var/tharvel/secrets/` | dentro restic encrypted |
| Deploy keys per sito (Strato 3a, 1 per sito) | con Strato 3a | `/var/tharvel/secrets/deploy-keys/<slug>.key` | dentro restic encrypted |
| Restic repository passphrase | subito | password manager personale del founder, MAI sulla VPS | fuori da tutto, custodito separatamente |
| Credenziali OVH Object Storage (S3 access key + secret) | subito | `.env` server, NO commit Git | dentro restic encrypted (recupero richiede solo passphrase + accesso a OVH) |

Regola d'oro: la **passphrase del repository restic** è il single point of recovery.
Se la perdi, il backup è inutile. Va custodita:

- **Primaria**: password manager personale (1Password / Bitwarden).
- **Secondaria**: copia cartacea sigillata in luogo fisico sicuro.

Mai sulla VPS Tharvel stessa, mai in un repo Git, mai in chat.

---

## 4. Destinazione off-site

### Scelta: **OVH Object Storage Standard** (S3-compatible)

Razionale:

- VPS è OVH → stesso provider, stessa fattura, stessa rete privata in alcune
  region (latenza minima, traffico interno gratuito se applicabile).
- S3-compatible → restic supporta nativamente backend S3.
- Region EU disponibili (Gravelines GRA, Strasburgo SBG) → coerenza GDPR.
- Tier Standard è quello giusto per backup giornalieri con restore occasionale.
- Tier Cold Archive è disponibile come secondo livello per long-term snapshot
  (yearly), ma non in fase Beta.

Alternative valutate e scartate per ora:

- **Backblaze B2**: ~50% più economico ($0.005/GB vs ~$0.01/GB OVH), egress
  free fino a 3x storage. Vincente sul TCO puro. Scartato per ora per coerenza
  operativa: 2 fatture, 2 console, 2 set di credenziali. Da rivalutare se il
  volume cresce sopra ~50 GB.
- **Cloudflare R2**: egress totalmente gratis. Più caro su storage. Vantaggio
  reale solo se serve restore frequente di grossi volumi — non è il nostro caso.
- **Hetzner Storage Box**: vantaggio principale (same-network) si perde con
  VPS OVH.

### Configurazione restic

Repository naming: `s3:s3.<region>.io.cloud.ovh.net/tharvel-backups`.

Bucket: `tharvel-backups`, region GRA o SBG. Versioning attivato a livello bucket
come difesa-in-profondità contro corruption del repository restic stesso.

Object Lock / immutability: **NON disponibile su OVH Object Storage Standard**
(verificare al setup; se diventa disponibile, attivarlo per i backup mensili come
protezione anti-ransomware).

Mitigazione in assenza di Object Lock: tenere un secondo repository restic su
provider diverso (B2 o R2) con frequenza ridotta (weekly), come copia
"cold" indipendente. Decisione rimandata alla fase Prod (vedi §7).

---

## 5. Retention policy

Schema standard `restic forget --prune`:

```
--keep-daily 7
--keep-weekly 4
--keep-monthly 6
--keep-yearly 1
```

Lettura:
- ultimi 7 giorni → snapshot daily, rollback fine
- ultime 4 settimane → 1 snapshot/settimana per ricostruire history mensile
- ultimi 6 mesi → 1 snapshot/mese, recupero da incidenti vecchi
- 1 yearly → insurance long-term

Dimensionamento atteso (Beta privata, 5-10 siti):
- DB Tharvel: <10 MB
- Sorgenti siti totali: <500 MB (escluso node_modules/dist)
- Snapshot delta giornaliero: pochi MB grazie a dedup restic
- Storage totale ipotizzato dopo 1 anno: <5 GB → costo <€0.05/mese su OVH Standard

Da rivalutare quando i siti reali superano 20 (volume + dedup ratio).

---

## 6. DB co-tenant (Directus, Plausible, Coolify) — fuori scope

Il gap di backup identificato in `vps_backup_gap.md` (memory 2026-05-08) tocca
anche servizi non-Tharvel sulla stessa VPS:

- Postgres Directus (in stack Service `directus-db-pf4nbj3p91og2xksxr7ep1jk`)
- Postgres Plausible + ClickHouse Plausible
- Postgres Coolify "standalone" (`ck3de7o…`)

Non sono parte di questo workstream — il loro backup va orchestrato a parte
(probabilmente con Coolify `database_backups` per quelli registrati come
Standalone, e `pg_dump` cron per quelli in stack Service).

Va però segnalato nel piano operativo VPS come issue indipendente con la stessa
priorità (precondizione prod), perché la perdita di un Directus pieno di
contenuti clienti o un Plausible pieno di history analytics sarebbe dolorosa
quanto la perdita di un DB Tharvel.

Azione: aprire workstream parallelo "VPS-wide backup" che gestisca i DB
co-tenant. Non blocca Beta privata Tharvel se Tharvel è il primo servizio in
questa fase, ma blocca la convivenza prod.

---

## 7. Restore drill — checklist eseguibile

> "Un backup non testato non è un backup."

### 7.1 Drill standard (da eseguire prima di Beta + ogni mese in Beta)

Pre-condizioni:
- Accesso a console OVH per provisioning VPS staging (size: stesso della prod).
- Accesso a password manager con passphrase restic + chiavi S3 OVH.
- Cronometro avviato (per misurare RTO).

Step:

- [ ] **1. Provisioning VPS staging** OVH, Debian/Ubuntu pari alla prod.
- [ ] **2. Setup ambiente minimo**: `apt install restic git nodejs npm sqlite3`.
- [ ] **3. Recupero passphrase restic** dal password manager.
- [ ] **4. Recupero credenziali OVH S3** dal password manager (access key + secret).
- [ ] **5. Inizializzazione client restic**: export `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `RESTIC_REPOSITORY=s3:...`, `RESTIC_PASSWORD=...`.
- [ ] **6. Verifica integrità repository**: `restic check`. Atteso: `no errors were found`.
- [ ] **7. Lista snapshot**: `restic snapshots`. Verifica presenza snapshot recente (<24h).
- [ ] **8. Restore latest**: `restic restore latest --target /restore`.
- [ ] **9. Verifica integrità DB**: `sqlite3 /restore/var/tharvel/data/tharvel.db "PRAGMA integrity_check"`. Atteso: `ok`.
- [ ] **10. Verifica conta righe DB**: `sqlite3 ... "SELECT COUNT(*) FROM sites"`. Confronto col valore noto al momento del backup.
- [ ] **11. Verifica cartella sito a campione**: presenza `src/`, `public/`, `package.json` di un sito noto.
- [ ] **12. Ricostruzione runtime** sul sito a campione: `cd <slug> && npm install && npm run build`. Atteso: build verde.
- [ ] **13. Boot server Tharvel** sullo staging puntando ai dati ripristinati. Atteso: log `[DB] sites registrati: N` con N atteso.
- [ ] **14. Smoke test funzionale**: connettere widget, verificare load del sito, edit chirurgico, salvataggio → DB/cartella aggiornati.
- [ ] **15. Misurazione**: registrare RTO totale (step 1 → 14) e RPO osservato (delta tra timestamp ultimo snapshot e "ora reale prod").
- [ ] **16. Tear-down**: spegnere staging, deallocare risorse OVH per non lasciare drift.
- [ ] **17. Report**: riempire una riga in `progetto-tharvel-backup-drills.md` (da creare al primo drill) con data, RTO, RPO, problemi incontrati, fix applicati.

### 7.2 Drill veloce (mensile, in produzione)

Versione ridotta da fare dopo il primo drill completo, per mantenere la
disciplina senza rifare tutto:

- [ ] `restic check --read-data-subset=5%` (verifica integrità di un campione).
- [ ] `restic snapshots` (presenza recente + frequenza coerente con cron).
- [ ] `restic restore latest --target /tmp/restore-test --include /var/tharvel/data/tharvel.db`.
- [ ] `sqlite3 /tmp/restore-test/.../tharvel.db "PRAGMA integrity_check"` → `ok`.
- [ ] `rm -rf /tmp/restore-test`.

Tempo target: <15 minuti.

### 7.3 Target RTO / RPO

Per Beta privata:
- **RTO target**: 4 ore (dalla decisione di restore al servizio operativo).
- **RPO target**: 24 ore (perdita massima accettabile = un giorno di lavoro).

Per Prod aperta (futuro):
- **RTO target**: 1 ora.
- **RPO target**: 4 ore (richiederà backup DB più frequenti, es. ogni 4h).

Misurati al primo drill, calibrabili dopo.

---

## 8. Cosa NON è in questo documento

- **Codice**. Niente script `restic` o `cron` qui. Implementazione → sprint
  operations dedicato dopo approvazione del piano.
- **Disaster recovery completo** (perdita VPS intera + redirect DNS): out of
  scope Beta privata. Documento separato per Prod.
- **Backup co-tenant** (Directus/Plausible/Coolify): vedi §6, workstream
  separato.
- **Strategia rotation chiavi e secret**: documento separato (security
  operations), tocca Strato 4 e Strato 3a.
- **Compliance specifica** (GDPR DPA con OVH): da chiudere prima Beta ma è
  documento legale, non di operations.

---

## 9. Riepilogo decisioni chiuse

- **Inventario**: tier A (DB + sorgenti siti + upload + segreti), tier B (.git/ locale, log), OUT (node_modules/dist/cache).
- **Tool**: `restic` (encrypted, deduplicated, incremental).
- **Destinazione**: OVH Object Storage Standard, region EU (GRA o SBG).
- **Retention**: 7 daily + 4 weekly + 6 monthly + 1 yearly.
- **Frequenza backup**: daily.
- **Restore drill**: completo prima di Beta + mensile in Beta.
- **RTO/RPO Beta**: 4h / 24h.
- **Co-tenant DB**: workstream separato, non blocca Beta Tharvel.

## 10. Decisioni ancora aperte (da chiudere prima implementazione)

| # | Decisione | Note |
|---|---|---|
| B1 | Region OVH Object Storage: GRA vs SBG | Scelta operativa, dipende da region VPS attuale. |
| B2 | Object Lock alternative: secondo repository su B2/R2 weekly? | Solo Prod, rimandato. |
| B3 | ~~Auto-commit post-edit dell'agente?~~ | **CHIUSA (2026-05-10)** — auto-commit SÌ sul branch `preview` dopo ogni turn riuscito, auto-push NO. "Pubblica" resta azione esplicita. Specifica completa in `progetto-tharvel.md` §6.4.1. Riduce RPO sui file siti a ~1 turno (working copy in corso). |
| B4 | DB backup frequency a regime: daily basta? Hourly? | Calibrabile dopo i primi mesi di traffico reale. |
| B5 | Notifica fallimento backup: email founder? webhook Slack? Healthchecks.io? | Operations, da decidere all'implementazione. |

Fine documento.
