<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import type { SelectedElement } from '../composables/useTharvelSession';
import { buildSiteBase } from '../site';
import EmptyState from './EmptyState.vue';

const props = defineProps<{
  slug: string;
  iframeNonce: number;
  selectedElement: SelectedElement | null;
  chatHidden: boolean;
  isConnected: boolean;
  pendingChanges: number;
}>();

const emit = defineEmits<{
  (e: 'clear-element'): void;
  (e: 'publish'): void;
  (e: 'toggle-chat'): void;
  (e: 'reconnect'): void;
  (e: 'reload-preview'): void;
}>();

type Device = 'desktop' | 'tablet' | 'mobile';
const device = ref<Device>('desktop');

const iframeSrc = computed(
  () => `${buildSiteBase(props.slug)}/index.html?_=${props.iframeNonce}`
);

const widths: Record<Device, string> = {
  desktop: '100%',
  tablet: '780px',
  mobile: '390px',
};

// Grace period iniziale: alla prima apertura non sappiamo ancora se il backend
// risponderà, quindi diamo 2s prima di considerare "preview rotta". Senza
// questo, l'utente vedrebbe l'overlay di errore lampeggiare ogni volta.
const grace = ref(true);
onMounted(() => {
  setTimeout(() => { grace.value = false; }, 2000);
});

// Quando l'utente clicca "Riprova" tentiamo sia la WS sia un reload dell'iframe.
// Il grace ricomincia per evitare flash-error mentre il backend ri-risponde.
function retry() {
  grace.value = true;
  setTimeout(() => { grace.value = false; }, 1500);
  emit('reconnect');
  emit('reload-preview');
}

function openInTab() {
  window.open(`${buildSiteBase(props.slug)}/index.html`, '_blank', 'noopener,noreferrer');
}

const previewFailed = computed(() => !props.isConnected && !grace.value);

const detailsOpen = ref(false);

// Se cambia slug, riazzera grace per evitare di mostrare l'overlay vecchio
// mentre il nuovo iframe parte.
watch(
  () => props.slug,
  () => {
    grace.value = true;
    setTimeout(() => { grace.value = false; }, 1500);
  },
);
</script>

<template>
  <main class="preview">
    <header class="preview-bar">
      <div class="bar-left">
        <span class="status-pill" :class="{ on: isConnected, off: !isConnected && !grace }">
          <span class="dot"></span>
          {{ isConnected ? 'Live' : grace ? 'In attesa…' : 'Offline' }}
        </span>
        <span class="path-sep">·</span>
        <span class="path-leaf">{{ slug }}</span>
      </div>

      <div class="device-tabs">
        <button :class="{ active: device === 'desktop' }" @click="device = 'desktop'" title="Desktop">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="12" rx="1.5" />
            <path d="M9 20 H15 M12 16 V20" />
          </svg>
        </button>
        <button :class="{ active: device === 'tablet' }" @click="device = 'tablet'" title="Tablet">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="6" y="3" width="12" height="18" rx="1.5" />
            <circle cx="12" cy="18" r="0.8" fill="currentColor" />
          </svg>
        </button>
        <button :class="{ active: device === 'mobile' }" @click="device = 'mobile'" title="Mobile">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="7" y="3" width="10" height="18" rx="1.5" />
            <circle cx="12" cy="18" r="0.7" fill="currentColor" />
          </svg>
        </button>
      </div>

      <div class="bar-right">
        <span class="hint">
          <kbd>Alt</kbd> + click per selezionare un elemento
        </span>
        <button
          class="icon-btn"
          @click="emit('toggle-chat')"
          :title="chatHidden ? 'Mostra chat' : 'Nascondi chat (preview a tutta larghezza)'"
        >
          <svg v-if="chatHidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M9 4 L4 4 L4 9 M15 4 L20 4 L20 9 M9 20 L4 20 L4 15 M15 20 L20 20 L20 15" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M4 4 L9 4 L9 9 M20 4 L15 4 L15 9 M4 20 L9 20 L9 15 M20 20 L15 20 L15 15" />
          </svg>
        </button>
        <button
          class="publish"
          :class="{ pending: pendingChanges > 0, disabled: pendingChanges === 0 }"
          :disabled="pendingChanges === 0 || !isConnected"
          @click="emit('publish')"
          :title="pendingChanges === 0
            ? 'Nessuna modifica da pubblicare'
            : `Pubblica ${pendingChanges} modific${pendingChanges === 1 ? 'a' : 'he'} non ancora online`"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M5 12 L9 16 L19 6" />
          </svg>
          <span>Pubblica</span>
          <span v-if="pendingChanges > 0" class="badge">{{ pendingChanges }}</span>
        </button>
      </div>
    </header>

    <div class="preview-stage">
      <div class="frame-wrap" :style="{ maxWidth: widths[device] }">
        <iframe
          :src="iframeSrc"
          class="frame"
          frameborder="0"
        />
        <transition name="overlay">
          <div v-if="previewFailed" class="preview-overlay">
            <EmptyState
              title="Anteprima non disponibile"
              body="Il server di Tharvel non risponde. Le modifiche già fatte sono al sicuro: appena torna online ripartiamo da qui."
              tone="warning"
            >
              <template #icon>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M5 12.55 a11 11 0 0 1 14 0 M8.5 16.05 a6 6 0 0 1 7 0 M12 20 h.01 M2 8.82 a15 15 0 0 1 4-2.45 M18 6.37 a15 15 0 0 1 4 2.45 M3 3 L21 21" />
                </svg>
              </template>
              <template #actions>
                <button class="es-action primary" @click="retry">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                    <path d="M3 12 a9 9 0 1 0 3 -6.7 L3 8 M3 3 V8 H8" />
                  </svg>
                  Riprova
                </button>
                <button class="es-action" @click="openInTab">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <path d="M15 3 H21 V9 M21 3 L10 14 M21 14 V20 a1 1 0 0 1 -1 1 H4 a1 1 0 0 1 -1 -1 V4 a1 1 0 0 1 1 -1 H10" />
                  </svg>
                  Apri in nuova scheda
                </button>
                <button class="es-action subtle" @click="detailsOpen = !detailsOpen">
                  {{ detailsOpen ? 'Nascondi' : 'Mostra' }} dettagli tecnici
                </button>
              </template>
            </EmptyState>
            <div v-if="detailsOpen" class="tech-details">
              <div class="td-row"><span class="td-k">Slug</span><code>{{ slug }}</code></div>
              <div class="td-row"><span class="td-k">URL iframe</span><code>{{ iframeSrc }}</code></div>
              <div class="td-row"><span class="td-k">WS</span><code>disconnected</code></div>
              <div class="td-hint">
                Probabili cause: server Tharvel non avviato, certificato/DNS in errore, oppure rete del browser bloccata.
              </div>
            </div>
          </div>
        </transition>
      </div>
    </div>

    <transition name="chip">
      <div v-if="selectedElement" class="element-chip">
        <span class="chip-dot"></span>
        <code>
          {{ selectedElement.tag }}<template v-if="selectedElement.id">#{{ selectedElement.id }}</template><template v-if="selectedElement.classes">.{{ selectedElement.classes.split(' ')[0] }}</template>
        </code>
        <span class="chip-text" v-if="selectedElement.text">"{{ selectedElement.text.slice(0, 40) }}{{ selectedElement.text.length > 40 ? '…' : '' }}"</span>
        <button class="chip-x" @click="emit('clear-element')" title="Deseleziona">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
      </div>
    </transition>
  </main>
</template>

<style scoped>
.preview {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-soft);
  position: relative;
  min-width: 0;
}

.preview-bar {
  height: 48px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  gap: 16px;
}

.bar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text-soft);
  flex: 1;
  min-width: 0;
}
.path-sep { color: var(--text-mute); }
.path-leaf { color: var(--text); font-weight: 500; font-family: var(--font-mono); font-size: 12.5px; }

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-mute);
  background: var(--bg-hover);
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
}
.status-pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-mute);
  transition: background var(--t-fast);
}
.status-pill.on { color: var(--success); background: var(--success-soft); border-color: transparent; }
.status-pill.on .dot {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
  animation: pulse 2s infinite;
}
.status-pill.off { color: var(--error); background: var(--error-bg); border-color: transparent; }
.status-pill.off .dot { background: var(--error); }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.device-tabs {
  display: flex;
  gap: 2px;
  background: var(--bg-hover);
  padding: 2px;
  border-radius: var(--radius-sm);
}
.device-tabs button {
  background: transparent;
  border: 0;
  padding: 5px 10px;
  border-radius: 4px;
  color: var(--text-mute);
  display: grid;
  place-items: center;
}
.device-tabs button:hover { color: var(--text-soft); }
.device-tabs button.active {
  background: var(--bg);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}

.bar-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
  justify-content: flex-end;
}
.hint {
  font-size: 12px;
  color: var(--text-mute);
}
kbd {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-soft);
}
.publish {
  background: var(--accent);
  color: var(--on-accent);
  border: 0;
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background var(--t-fast), transform var(--t-fast);
}
.publish:hover:not(:disabled) { background: var(--accent-hover); transform: translateY(-1px); }
.publish.pending {
  background: var(--brand);
  color: #fff;
  box-shadow: 0 0 0 3px var(--brand-soft);
}
.publish.pending:hover:not(:disabled) {
  background: var(--brand-hover);
}
.publish.disabled {
  background: var(--bg-hover);
  color: var(--text-mute);
  cursor: not-allowed;
}
.publish .badge {
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.25);
  display: inline-grid;
  place-items: center;
  font-size: 11px;
  font-weight: 600;
  font-feature-settings: 'tnum';
}
.publish.disabled .badge { background: var(--bg-active); color: var(--text-mute); }

.preview-overlay {
  position: absolute;
  inset: 0;
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 32px;
  z-index: 5;
}
.es-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  padding: 7px 13px;
  border-radius: var(--radius-sm);
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text-soft);
  transition: all var(--t-fast);
}
.es-action:hover {
  background: var(--bg-hover);
  color: var(--text);
  border-color: var(--text-soft);
}
.es-action.primary {
  background: var(--brand);
  color: #fff;
  border-color: transparent;
}
.es-action.primary:hover {
  background: var(--brand-hover);
}
.es-action.subtle {
  background: transparent;
  border-color: transparent;
  color: var(--text-mute);
}
.es-action.subtle:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.tech-details {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  font-size: 12px;
  width: 100%;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.td-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.td-k {
  color: var(--text-mute);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  font-size: 10.5px;
  font-weight: 600;
  width: 80px;
  flex-shrink: 0;
}
.td-row code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: var(--code-bg);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.td-hint {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  color: var(--text-mute);
  font-size: 11.5px;
  line-height: 1.5;
}

.overlay-enter-active, .overlay-leave-active {
  transition: opacity var(--t-base);
}
.overlay-enter-from, .overlay-leave-to {
  opacity: 0;
}

.icon-btn {
  background: transparent;
  border: 1px solid var(--border);
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--text-soft);
  transition: all var(--t-fast);
}
.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
  border-color: var(--text);
}

.preview-stage {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: stretch;
  padding: 24px;
  overflow: auto;
}
.frame-wrap {
  width: 100%;
  height: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  overflow: hidden;
  transition: max-width 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.frame {
  width: 100%;
  height: 100%;
  border: 0;
}

.element-chip {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--accent);
  color: var(--on-accent);
  padding: 8px 12px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  box-shadow: var(--shadow-lg);
  max-width: calc(100% - 48px);
}
.chip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}
.element-chip code {
  background: var(--code-bg-on-accent);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
}
.chip-text {
  color: var(--on-accent);
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}
.chip-x {
  background: transparent;
  border: 0;
  color: var(--on-accent);
  opacity: 0.6;
  padding: 2px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  transition: opacity var(--t-fast), background var(--t-fast);
}
.chip-x:hover { opacity: 1; background: var(--code-bg-on-accent); }

.chip-enter-active, .chip-leave-active {
  transition: all 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.chip-enter-from, .chip-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>
