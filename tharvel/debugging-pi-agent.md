# Tharvel: Stato del Progetto e Debugging Pi Agent SDK

Questo documento riassume l'architettura attuale di Tharvel, le implementazioni effettuate per integrare il `pi-coding-agent` (SDK) e lo storico dettagliato del problema persistente che stiamo affrontando con l'esecuzione dei tool da parte dell'Agente AI (Claude 3.5 Sonnet via GitHub Copilot).

## 🏗 Architettura Attuale

Tharvel è diviso in due pacchetti all'interno di un monorepo:
1. **Frontend (`tharvel/ui`)**: Un'interfaccia in Vue 3 (Vite) che mostra:
   - Un iframe centrale che carica il sito target.
   - Una sidebar destra con la chat AI e la selezione del modello.
   - Una logica di puntamento DOM nativa iniettata nel client (Alt + Click) per selezionare elementi.
   - Drag & Drop per caricare file, inviati via WebSocket al server in formato Base64.
2. **Backend (`tharvel/server`)**: Un server Node.js (Express + `ws`) che:
   - Espone un Web Server statico sulla cartella `site/` (raggiungibile a `http://localhost:3000/site/index.html`).
   - Gestisce la connessione WebSocket con la UI.
   - Inizializza l'Agente AI utilizzando `@mariozechner/pi-coding-agent`.

---

## ⚙️ Configurazione dell'Agente (Pi Agent SDK)

Abbiamo configurato l'SDK di Pi per limitare il raggio d'azione dell'AI esclusivamente alla cartella fittizia del sito (`site/`).

### 1. Il Resource Loader e le Istruzioni (AGENTS.md)
Inizialmente avevamo usato `systemPromptOverride` all'interno di `DefaultResourceLoader`. Questo causava un blocco totale dell'Agente: sovrascrivendo l'intero *System Prompt*, cancellavamo le istruzioni native di Pi SDK su *come* formattare l'XML per chiamare i tool. 
**Soluzione applicata**: Abbiamo utilizzato `agentsFilesOverride` per iniettare un file virtuale `/virtual/AGENTS.md`. Questo preserva il cervello base dell'SDK, aggiungendo semplicemente il contesto del nostro progetto:
```typescript
const loader = new DefaultResourceLoader({
  cwd: sitePath,
  agentDir: getAgentDir(),
  agentsFilesOverride: (current) => ({
    agentsFiles: [...current.agentsFiles, {
      path: "/virtual/AGENTS.md",
      content: `Sei Tharvel... lavora nella cartella corrente... le immagini sono in assets/...`
    }]
  })
});
```

### 2. Iniezione dei Tools (createCodingTools)
Per garantire che l'AI abbia a disposizione i comandi di sistema (`bash`, `read`, `edit`, `ls`), abbiamo istanziato la sessione passando esplicitamente il `cwd` e i tool di base, uniti al nostro tool custom per l'upload:
```typescript
const { session } = await createAgentSession({
  // ...
  cwd: sitePath,
  tools: createCodingTools(sitePath),
  customTools: [processUploadTool],
  resourceLoader: loader,
});
```

### 3. Il Custom Tool dell'Upload (`processUploadTool`)
Riceve i file Base64 via WS, usa `sharp` per comprimere le immagini in `.webp` e le salva fisicamente nella directory `site/assets/`.

---

## 🐞 Il Problema Persistente

Nonostante l'architettura sia solida e i percorsi siano mappati correttamente, stiamo riscontrando una grave difficoltà nel far completare all'AI il flusso end-to-end di modifica del codice.

### Sintomi riscontrati in ordine cronologico:
1. **Crash per File Inesistente**: All'inizio l'AI cercava di usare il tool `edit` su un mock in memoria. Risolto creando un vero file `site/index.html`.
2. **AI "Vegetativa" (Nessun Tool Chiamato)**: L'AI emetteva chunk di testo (`message_update`) ma non chiamava mai i tool (`tool_start`). Risolto eliminando il `systemPromptOverride` (che rompeva le istruzioni XML dei tool) in favore di `agentsFilesOverride`.
3. **Mancanza dei Tool nel Contesto**: Quando passavamo un array manuale vuoto o parziale di tools, l'Agente rispondeva testualmente *"Non ho a disposizione gli strumenti come bash o read"*. Risolto reintroducendo `createCodingTools(sitePath)`.
4. **Directory Assets Mancante**: L'agente tentava finalmente di usare `ls` per esplorare, ma si bloccava perché la cartella `site/assets/` non esisteva fisicamente sul disco (creata poi manualmente con `mkdir -p`).
5. **Stallo Finale**: Al momento attuale, l'Agente riesce a vedere i file, riceve l'immagine correttamente nella cartella `site/assets/`, ma **quando gli viene chiesto esplicitamente di applicare l'immagine come sfondo nell'HTML (usando `read` e `edit`), si blocca, fallisce l'edit silenziosamente o risponde senza eseguire l'azione sul file reale.**

### Ipotesi sulle cause ancora attive (RISOLTO!)
Il problema non era Copilot, né il path resolution dell'editTool, né il prompt asincrono. Era un clamoroso **mismatch di API SDK**:

| Versione SDK | Tipo di proprietà `tools` |
|---|---|
| Vecchia (docs `sdk.md`, esempi datati) | `Tool[]` — array di oggetti tool interi |
| 0.73.0 (quella installata) | `string[]` — array di *nomi* dei tool da attivare |

Il nostro codice passava l'output di `createCodingTools(sitePath)` (che restituisce oggetti `Tool`) direttamente nel campo `tools` (che nella v0.73+ si aspetta solo stringhe). Di conseguenza, l'SDK provava ad attivare dei tool prendendo oggetti e trattandoli come nomi, fallendo miseramente e lasciando l'agente con **zero tool a disposizione**. Da qui la celebre risposta: *"non ho gli strumenti"*.

**Stato attuale del fix in `server/index.ts`:**
- Rimosso `tools: createCodingTools(sitePath)` e il relativo import.
- Il solo parametro `cwd: sitePath` al top-level della configurazione di sessione è sufficiente: l'SDK crea e inietta internamente `read`, `bash`, `edit`, `write` (bindati a quel cwd) automaticamente se non si forniscono stringhe o override che rompono la routine.
- `customTools: [processUploadTool]` rimane, in quanto è il campo dedicato appositamente agli oggetti Custom Tool.
- Mantenuti i fix paralleli che si sono rivelati validi: salvataggio corretto nell'upload in `site/assets` al posto della root, e iniezione del virtual `AGENTS.md` per non sovrascrivere l'XML di sistema.

## 🔗 Risorse di Riferimento e Documentazione

Per proseguire con il debugging, le fonti primarie di consultazione sono:

- **Pi Coding Agent SDK (NPM)**: Il package ufficiale che stiamo utilizzando per instanziare l'agente e iniettare i tools.
  - Documentazione SDK: [https://github.com/mariozechner/pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) (in particolare i file in `/docs/sdk.md`)
- **Progetto Esempio (Bigbud)**: Repository di riferimento che avevamo analizzato per capire come iniettare contesto locale e customizzare il comportamento dell'Agente senza rompere le definizioni XML interne.
  - Link al repo (inviato dall'utente): [https://github.com/youpele52/bigbud](https://github.com/youpele52/bigbud)