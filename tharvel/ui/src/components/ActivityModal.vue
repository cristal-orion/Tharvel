<script setup lang="ts">
// Pannello attività di un sito (admin).
//
// Risponde a "cosa ha chiesto il cliente a Tharvel e cosa è successo". Tre viste:
//  - Timeline : conversazione + comandi + revisioni in ordine cronologico. È la
//               fonte da guardare quando il cliente scrive "non funziona": si vede
//               la richiesta esatta invece di ricostruirla al telefono.
//  - Comandi  : riepilogo aggregato della modalità osservazione. È la lista da cui
//               ricavare la whitelist prima di sostituire il tool bash con un
//               terminale virtuale (progetto-tharvel-security.md, vettore B).
//  - Online   : le pubblicazioni, con ripristino a una precedente.
import { ref, computed, onMounted } from 'vue';
import { apiUrl } from '../site';

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

type Tab = 'timeline' | 'commands' | 'publishes';
const tab = ref<Tab>('timeline');

interface ActivityEvent {
  kind: 'prompt' | 'reply' | 'command' | 'revision';
  at: string;
  turnId: string | null;
  content: string;
  hadError: boolean;
  filesChanged?: string[];
  commitSha?: string;
  revisionKind?: string;
}
interface CommandSummary {
  command: string;
  uses: number;
  errors: number;
  last_used: string;
}
interface PublishRow {
  id: number;
  commitSha: string;
  shortSha: string;
  summary: string | null;
  at: string;
}

const loading = ref(true);
const errorMsg = ref<string | null>(null);
const events = ref<ActivityEvent[]>([]);
const commands = ref<CommandSummary[]>([]);
const publishes = ref<PublishRow[]>([]);

// Ripristino: due passaggi (click → conferma), perché tocca il sito online.
const confirmingId = ref<number | null>(null);
const rollingBackId = ref<number | null>(null);
const rollbackMsg = ref<string | null>(null);

async function getJson(path: string) {
  const r = await fetch(apiUrl(path), { credentials: 'include' });
  const body = await r.json();
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
  return body;
}

async function load() {
  loading.value = true;
  errorMsg.value = null;
  const s = encodeURIComponent(props.slug);
  try {
    const [activity, summary, pubs] = await Promise.all([
      getJson(`/api/admin/sites/${s}/activity`),
      getJson(`/api/admin/commands-summary?slug=${s}`),
      getJson(`/api/admin/sites/${s}/publishes`),
    ]);
    events.value = activity.events ?? [];
    commands.value = summary.commands ?? [];
    publishes.value = pubs.publishes ?? [];
  } catch (e: any) {
    errorMsg.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function rollback(row: PublishRow) {
  confirmingId.value = null;
  rollingBackId.value = row.id;
  rollbackMsg.value = null;
  errorMsg.value = null;
  try {
    const r = await fetch(
      apiUrl(`/api/admin/sites/${encodeURIComponent(props.slug)}/rollback/${row.id}`),
      { method: 'POST', credentials: 'include' },
    );
    const body = await r.json();
    if (!r.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${r.status}`);
    rollbackMsg.value = body.message;
    await load();
  } catch (e: any) {
    errorMsg.value = e?.message ?? String(e);
  } finally {
    rollingBackId.value = null;
  }
}

const KIND_LABEL: Record<ActivityEvent['kind'], string> = {
  prompt: 'Cliente',
  reply: 'Tharvel',
  command: 'Comando',
  revision: 'Modifica',
};

function fmt(ts: string): string {
  // Le date arrivano da SQLite come "YYYY-MM-DD HH:MM:SS" in UTC.
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('it-IT');
}

const promptCount = computed(() => events.value.filter((e) => e.kind === 'prompt').length);
</script>

<template>
  <div class="modal-shell" @click.self="emit('close')">
    <div class="modal">
      <header class="modal-head">
        <h2>Attività · {{ slug }}</h2>
        <button class="close-btn" @click="emit('close')" title="Chiudi">✕</button>
      </header>

      <nav class="tabs">
        <button :class="{ on: tab === 'timeline' }" @click="tab = 'timeline'">
          Timeline <span class="count">{{ promptCount }}</span>
        </button>
        <button :class="{ on: tab === 'commands' }" @click="tab = 'commands'">
          Comandi <span class="count">{{ commands.length }}</span>
        </button>
        <button :class="{ on: tab === 'publishes' }" @click="tab = 'publishes'">
          Online <span class="count">{{ publishes.length }}</span>
        </button>
      </nav>

      <section class="body">
        <div v-if="loading" class="running">
          <div class="spinner"></div>
          <p>Caricamento…</p>
        </div>

        <template v-else>
          <p v-if="errorMsg" class="error-box">{{ errorMsg }}</p>
          <p v-if="rollbackMsg" class="ok-box">{{ rollbackMsg }}</p>

          <!-- TIMELINE -->
          <template v-if="tab === 'timeline'">
            <p v-if="events.length === 0" class="hint">
              Nessuna attività registrata. Il log parte dalla prima richiesta fatta
              dopo l'attivazione di questa funzione: le conversazioni precedenti non
              sono recuperabili.
            </p>
            <ul v-else class="timeline">
              <li v-for="(ev, i) in events" :key="i" class="event" :class="ev.kind">
                <div class="event-head">
                  <span class="badge">{{ KIND_LABEL[ev.kind] }}</span>
                  <span class="ts">{{ fmt(ev.at) }}</span>
                  <span v-if="ev.hadError" class="badge err">errore</span>
                </div>
                <pre class="content">{{ ev.content }}</pre>
                <p v-if="ev.filesChanged?.length" class="files">
                  {{ ev.filesChanged.length }} file:
                  <code v-for="f in ev.filesChanged.slice(0, 6)" :key="f">{{ f }}</code>
                  <span v-if="ev.filesChanged.length > 6">…</span>
                </p>
              </li>
            </ul>
          </template>

          <!-- COMANDI -->
          <template v-else-if="tab === 'commands'">
            <p class="hint">
              Modalità osservazione: i comandi vengono registrati ma <strong>non</strong>
              bloccati. Questa è la lista da cui ricavare la whitelist prima di
              attivare il terminale virtuale.
            </p>
            <p v-if="commands.length === 0" class="hint">
              Nessun comando ancora osservato.
            </p>
            <table v-else class="table">
              <thead>
                <tr><th>Comando</th><th>Usi</th><th>Errori</th><th>Ultimo</th></tr>
              </thead>
              <tbody>
                <tr v-for="c in commands" :key="c.command">
                  <td><code>{{ c.command }}</code></td>
                  <td>{{ c.uses }}</td>
                  <td :class="{ warn: c.errors > 0 }">{{ c.errors }}</td>
                  <td class="ts">{{ fmt(c.last_used) }}</td>
                </tr>
              </tbody>
            </table>
          </template>

          <!-- ONLINE -->
          <template v-else>
            <p class="hint">
              Le pubblicazioni del sito. Ripristinare crea un commit nuovo in cima a
              <code>main</code> con il contenuto scelto: la storia del repo non viene
              riscritta e Coolify ridispiega come per una pubblicazione normale.
            </p>
            <p v-if="publishes.length === 0" class="hint">
              Nessuna pubblicazione registrata per questo sito.
            </p>
            <ul v-else class="publishes">
              <li v-for="(p, i) in publishes" :key="p.id">
                <div class="pub-info">
                  <span v-if="i === 0" class="badge live">online ora</span>
                  <code>{{ p.shortSha }}</code>
                  <span class="pub-summary">{{ p.summary || '(nessuna descrizione)' }}</span>
                  <span class="ts">{{ fmt(p.at) }}</span>
                </div>
                <div v-if="i > 0" class="pub-action">
                  <button
                    v-if="confirmingId !== p.id"
                    class="btn"
                    :disabled="rollingBackId !== null"
                    @click="confirmingId = p.id"
                  >
                    {{ rollingBackId === p.id ? 'Ripristino…' : 'Ripristina' }}
                  </button>
                  <template v-else>
                    <span class="confirm-text">Rimetti online questa versione?</span>
                    <button class="btn danger" @click="rollback(p)">Conferma</button>
                    <button class="btn ghost" @click="confirmingId = null">Annulla</button>
                  </template>
                </div>
              </li>
            </ul>
          </template>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.modal-shell {
  position: fixed;
  inset: 0;
  background: var(--backdrop);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  z-index: 2000;
}
.modal {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 100%;
  max-width: 760px;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.modal-head h2 { margin: 0; font-size: 17px; }
.close-btn {
  background: transparent;
  border: 0;
  font-size: 18px;
  color: var(--text-soft);
  padding: 4px 8px;
  border-radius: 4px;
}
.close-btn:hover { background: var(--bg-hover); color: var(--text); }

.tabs {
  display: flex;
  gap: 4px;
  padding: 10px 20px 0;
  border-bottom: 1px solid var(--border);
}
.tabs button {
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 8px 12px;
  color: var(--text-soft);
  font-size: 13px;
  cursor: pointer;
}
.tabs button.on { color: var(--text); border-bottom-color: var(--accent, currentColor); }
.tabs .count {
  font-size: 11px;
  opacity: 0.6;
  margin-left: 4px;
}

.body {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
}

.hint { margin: 0; font-size: 12.5px; color: var(--text-soft); line-height: 1.5; }
.error-box {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: color-mix(in srgb, red 12%, transparent);
  font-size: 12.5px;
}
.ok-box {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: color-mix(in srgb, green 12%, transparent);
  font-size: 12.5px;
}

.running { display: flex; align-items: center; gap: 10px; }
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--text);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.event {
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: var(--radius);
  padding: 10px 12px;
}
.event.prompt { border-left-color: var(--accent, #6b8afd); }
.event.reply { border-left-color: var(--border); }
.event.command { border-left-color: #c9a227; }
.event.revision { border-left-color: #3fa66a; }
.event-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.badge {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--text-soft);
}
.badge.err { background: color-mix(in srgb, red 18%, transparent); }
.badge.live { background: color-mix(in srgb, green 18%, transparent); }
.ts { font-size: 11px; color: var(--text-soft); }
.content {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  max-height: 160px;
  overflow-y: auto;
}
.event.command .content { font-family: ui-monospace, monospace; font-size: 12px; }
.files { margin: 6px 0 0; font-size: 11.5px; color: var(--text-soft); }
.files code { margin-right: 6px; }

.table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-soft);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.table td { padding: 7px 8px; border-bottom: 1px solid var(--border); }
.table td.warn { color: #c9a227; }

.publishes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.publishes li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 9px 12px;
  flex-wrap: wrap;
}
.pub-info { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.pub-summary { font-size: 12.5px; }
.pub-action { display: flex; align-items: center; gap: 6px; }
.confirm-text { font-size: 12px; color: var(--text-soft); }
.btn {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: var(--radius);
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}
.btn:hover:not(:disabled) { background: var(--bg-hover); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.danger { background: color-mix(in srgb, red 16%, transparent); }
.btn.ghost { color: var(--text-soft); }
</style>
