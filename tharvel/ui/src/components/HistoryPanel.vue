<script setup lang="ts">
import { ref, watch } from 'vue';
import { apiUrl } from '../site';

interface Revision {
  id: number;
  commit_sha: string;
  parent_sha: string | null;
  user_prompt: string;
  summary: string | null;
  files_changed: string[];
  kind: 'turn' | 'publish';
  superseded: boolean;
  created_at: string;
}

const props = defineProps<{
  slug: string | null;
  // Bumpa quando il server segnala history_updated (auto-commit andato a buon
  // fine). Watchato per fare refetch automatico.
  nonce: number;
}>();

const emit = defineEmits<{
  (e: 'reload-preview'): void;
}>();

const revisions = ref<Revision[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const busyAction = ref<string | null>(null); // 'undo' | `restore:<id>`

async function fetchHistory() {
  if (!props.slug) {
    revisions.value = [];
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const res = await fetch(apiUrl(`/api/session/${props.slug}/history`), {
      credentials: 'include',
    });
    if (!res.ok) {
      error.value = `Errore ${res.status}`;
      revisions.value = [];
      return;
    }
    const body = await res.json();
    revisions.value = body.revisions;
  } catch (e: any) {
    error.value = e?.message ?? 'errore di rete';
  } finally {
    loading.value = false;
  }
}

watch(() => props.slug, fetchHistory, { immediate: true });
watch(() => props.nonce, () => {
  if (props.nonce > 0) fetchHistory();
});

async function undoLast() {
  if (!props.slug || busyAction.value) return;
  busyAction.value = 'undo';
  error.value = null;
  try {
    const res = await fetch(apiUrl(`/api/session/${props.slug}/undo`), {
      method: 'POST',
      credentials: 'include',
    });
    const body = await res.json();
    if (!res.ok) {
      error.value = body.error ?? 'errore undo';
      return;
    }
    await fetchHistory();
    emit('reload-preview');
  } catch (e: any) {
    error.value = e?.message ?? 'errore di rete';
  } finally {
    busyAction.value = null;
  }
}

async function restoreTo(rev: Revision) {
  if (!props.slug || busyAction.value) return;
  if (rev.kind !== 'turn' || rev.superseded) return;
  const idx = revisions.value.findIndex((r) => r.id === rev.id);
  const dropped = idx; // tutte le revisioni più recenti di rev (rev incluso)
  const msg = dropped > 0
    ? `Ripristina lo stato precedente a "${rev.summary ?? '...'}"?\n\n${dropped} modifich${dropped === 1 ? 'a' : 'e'} successiv${dropped === 1 ? 'a' : 'e'} verr${dropped === 1 ? 'à' : 'anno'} scartat${dropped === 1 ? 'a' : 'e'}.`
    : `Ripristina lo stato precedente a "${rev.summary ?? '...'}"?`;
  if (!window.confirm(msg)) return;
  busyAction.value = `restore:${rev.id}`;
  error.value = null;
  try {
    const res = await fetch(apiUrl(`/api/session/${props.slug}/restore/${rev.id}`), {
      method: 'POST',
      credentials: 'include',
    });
    const body = await res.json();
    if (!res.ok) {
      error.value = body.error ?? 'errore restore';
      return;
    }
    await fetchHistory();
    emit('reload-preview');
  } catch (e: any) {
    error.value = e?.message ?? 'errore di rete';
  } finally {
    busyAction.value = null;
  }
}

function timeAgo(iso: string): string {
  // iso è in UTC dal datetime('now') di SQLite (manca la Z, lo aggiungiamo).
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'ora';
  if (min < 60) return `${min} min fa`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h fa`;
  const days = Math.floor(h / 24);
  return `${days} g fa`;
}

const lastUndoable = (): Revision | null => {
  for (const r of revisions.value) {
    if (r.kind === 'turn' && !r.superseded) return r;
  }
  return null;
};
</script>

<template>
  <div class="history-panel">
    <div class="undo-row">
      <button
        class="undo-btn"
        :disabled="!lastUndoable() || busyAction === 'undo'"
        @click="undoLast"
        :title="lastUndoable() ? `Annulla: ${lastUndoable()?.summary}` : 'Nessuna modifica da annullare'"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M9 14 L4 9 L9 4" />
          <path d="M4 9 H15 a5 5 0 0 1 5 5 V19" />
        </svg>
        <span>{{ busyAction === 'undo' ? 'Annullamento…' : 'Annulla ultima' }}</span>
      </button>
    </div>

    <div v-if="error" class="error-row">✕ {{ error }}</div>

    <div v-if="loading && revisions.length === 0" class="empty">Caricamento…</div>
    <div v-else-if="revisions.length === 0" class="empty">
      Le modifiche al sito appariranno qui dopo ogni richiesta riuscita.
    </div>

    <ul v-else class="rev-list">
      <li
        v-for="r in revisions"
        :key="r.id"
        class="rev-item"
        :class="{
          publish: r.kind === 'publish',
          superseded: r.superseded,
        }"
      >
        <div class="rev-head">
          <span class="rev-kind">
            <svg v-if="r.kind === 'publish'" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M5 13 l4 4 L19 7" />
            </svg>
            <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <circle cx="12" cy="12" r="4" />
            </svg>
          </span>
          <span class="rev-summary" :title="r.user_prompt">
            {{ r.summary ?? r.user_prompt }}
          </span>
          <span class="rev-time">{{ timeAgo(r.created_at) }}</span>
        </div>
        <div v-if="r.files_changed.length > 0" class="rev-files">
          {{ r.files_changed.length }} file
          <span class="rev-files-list">
            ({{ r.files_changed.slice(0, 3).join(', ') }}{{ r.files_changed.length > 3 ? '…' : '' }})
          </span>
        </div>
        <div v-if="r.kind === 'turn' && !r.superseded" class="rev-actions">
          <button
            class="action-btn"
            :disabled="busyAction !== null"
            @click="restoreTo(r)"
          >
            {{ busyAction === `restore:${r.id}` ? 'Ripristino…' : 'Ripristina qui' }}
          </button>
        </div>
        <div v-else-if="r.kind === 'publish'" class="rev-tag">Pubblicato</div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.history-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.undo-row {
  padding: 0 4px;
}
.undo-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
  font-weight: 500;
}
.undo-btn:hover:not(:disabled) { background: var(--bg-active); }
.undo-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.error-row {
  font-size: 11.5px;
  color: var(--error);
  padding: 4px 8px;
}

.empty {
  padding: 6px 10px;
  color: var(--text-mute);
  font-size: 12px;
  font-style: italic;
}

.rev-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rev-item {
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  border-left: 2px solid transparent;
}
.rev-item:hover { background: var(--bg-hover); }
.rev-item.publish {
  border-left-color: var(--success);
  background: var(--success-soft);
}
.rev-item.superseded { opacity: 0.55; }

.rev-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text);
}
.rev-kind {
  display: inline-flex;
  align-items: center;
  color: var(--text-mute);
  flex-shrink: 0;
}
.rev-item.publish .rev-kind { color: var(--success); }
.rev-summary {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rev-time {
  font-size: 10.5px;
  color: var(--text-mute);
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.rev-files {
  font-size: 10.5px;
  color: var(--text-mute);
  padding-left: 17px;
  margin-top: 2px;
}
.rev-files-list { font-family: var(--font-mono); }

.rev-actions {
  padding-left: 17px;
  margin-top: 4px;
}
.action-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-soft);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.action-btn:hover:not(:disabled) {
  background: var(--bg-active);
  color: var(--text);
}
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.rev-tag {
  padding-left: 17px;
  margin-top: 2px;
  font-size: 10px;
  color: var(--success);
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
</style>
