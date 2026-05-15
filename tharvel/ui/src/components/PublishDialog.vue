<script setup lang="ts">
defineProps<{
  pendingCount: number;
  files: string[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm'): void;
}>();
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="pub-title">
      <header class="head">
        <div class="head-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M5 12 L9 16 L19 6" />
          </svg>
        </div>
        <div class="head-text">
          <h2 id="pub-title">Pubblica le modifiche</h2>
          <p>
            Stai per mandare online {{ pendingCount }}
            modific{{ pendingCount === 1 ? 'a' : 'he' }} non
            ancora pubblicat{{ pendingCount === 1 ? 'a' : 'e' }}.
          </p>
        </div>
        <button class="close" @click="emit('close')" aria-label="Chiudi">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
        </button>
      </header>

      <section class="body">
        <div class="section-label">
          File toccati
          <span class="count">{{ files.length }}</span>
        </div>
        <ul v-if="files.length > 0" class="file-list">
          <li v-for="f in files" :key="f">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M14 3 H6 a2 2 0 0 0 -2 2 V19 a2 2 0 0 0 2 2 H18 a2 2 0 0 0 2 -2 V9 Z M14 3 V9 H20" />
            </svg>
            <code>{{ f }}</code>
          </li>
        </ul>
        <div v-else class="no-files">
          Nessun file specifico — la modifica potrebbe non averne toccato uno tracciato.
        </div>

        <div class="hint">
          Pubblicare crea un commit di squash sul repo del sito e fa partire la build.
          L'azione è reversibile dallo Storico (puoi ripristinare a uno stato precedente).
        </div>
      </section>

      <footer class="actions">
        <button class="btn ghost" @click="emit('close')">Annulla</button>
        <button class="btn primary" @click="emit('confirm')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M5 12 L9 16 L19 6" />
          </svg>
          Pubblica ora
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--backdrop);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  z-index: 1500;
  padding: 32px;
}
.dialog {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 100%;
  max-width: 520px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--border);
}
.head-icon {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.head-text { flex: 1; min-width: 0; }
.head-text h2 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.head-text p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-soft);
  line-height: 1.45;
}
.close {
  background: transparent;
  border: 0;
  padding: 6px;
  border-radius: 4px;
  color: var(--text-mute);
  cursor: pointer;
  transition: all var(--t-fast);
  flex-shrink: 0;
}
.close:hover { background: var(--bg-hover); color: var(--text); }

.body {
  padding: 16px 18px;
  flex: 1;
  overflow-y: auto;
}
.section-label {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-mute);
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.section-label .count {
  font-family: var(--font-mono);
  background: var(--bg-hover);
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--text-soft);
}

.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px;
}
.file-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-soft);
}
.file-list li svg { color: var(--text-mute); flex-shrink: 0; }
.file-list li code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.no-files {
  padding: 12px 14px;
  font-size: 12px;
  color: var(--text-mute);
  font-style: italic;
  background: var(--bg-soft);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
}

.hint {
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--bg-soft);
  border-left: 2px solid var(--brand);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-soft);
  line-height: 1.5;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  border: 1px solid transparent;
  transition: all var(--t-fast);
}
.btn.ghost {
  background: transparent;
  border-color: var(--border);
  color: var(--text-soft);
}
.btn.ghost:hover { background: var(--bg-hover); color: var(--text); }
.btn.primary {
  background: var(--brand);
  color: #fff;
}
.btn.primary:hover { background: var(--brand-hover); transform: translateY(-1px); }
</style>
