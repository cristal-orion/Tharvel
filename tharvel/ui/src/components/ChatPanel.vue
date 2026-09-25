<script setup lang="ts">
import { ref, nextTick, watch, computed } from 'vue';
import type { ChatMessage, PendingImage, SelectedElement } from '../composables/useTharvelSession';
import ProviderPicker from './ProviderPicker.vue';
import ChatWelcome from './ChatWelcome.vue';
import EmptyState from './EmptyState.vue';
import { useResizable } from '../composables/useResizable';
import { useAuth } from '../composables/useAuth';

const props = defineProps<{
  messages: ChatMessage[];
  isProcessing: boolean;
  isConnected: boolean;
  selectedModel: string;
  auth: Record<string, 'connected' | 'disconnected' | 'pending'>;
  pendingImages: PendingImage[];
  mobile?: boolean;
  visible?: boolean;
  expanded?: boolean;
  selectedElement?: SelectedElement | null;
}>();

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'update:selectedModel', val: string): void;
  (e: 'open-settings'): void;
  (e: 'attach-image', file: File): void;
  (e: 'remove-pending-image', id: string): void;
  (e: 'clear-chat'): void;
  (e: 'reconnect'): void;
  (e: 'close'): void;
  (e: 'toggle-expand'): void;
  (e: 'clear-element'): void;
}>();

// La scelta del modello AI è riservata all'admin (vedi GET /api/models e
// set_model lato server). Al cliente il picker va nascosto, non disabilitato:
// un controllo visibile che risponde "non puoi" è solo una richiesta di supporto
// in più. Il server rifiuta comunque, questa è la parte cosmetica.
const { user } = useAuth();
const isAdmin = computed(() => user.value?.role === 'admin');

// "Vuoto" = nessun messaggio user/ai. I system message (saluto iniziale,
// tool_start, ecc.) non contano per questa logica: vogliamo mostrare il
// welcome con suggestion chips finché l'utente non ha mai scritto nulla.
const hasContent = computed(() =>
  props.messages.some((m) => m.role === 'user' || m.role === 'ai'),
);

const panelResize = useResizable({
  storageKey: 'tharvel-chat-width',
  defaultPx: 400,
  minPx: 320,
  maxPx: 640,
  edge: 'left',
});

const input = ref('');
const messagesEl = ref<HTMLElement | null>(null);
const textareaEl = ref<HTMLTextAreaElement | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const dragging = ref(false);
let dragDepth = 0;

function pickFile() {
  fileInputEl.value?.click();
}

function onPickFile(e: Event) {
  const target = e.target as HTMLInputElement;
  const files = target.files;
  if (files) {
    for (const f of Array.from(files)) emit('attach-image', f);
  }
  // reset così lo stesso file può essere ri-selezionato in futuro
  target.value = '';
}

// Drag&drop scoped sulla chat. Usiamo un contatore per gestire i drag su figli
// (l'evento dragenter scatta anche entrando in un figlio, dragleave entrando dal
// figlio al parent ⇒ senza contatore l'overlay sparirebbe).
function onDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth += 1;
  dragging.value = true;
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}
function onDrop(e: DragEvent) {
  dragDepth = 0;
  dragging.value = false;
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const f of Array.from(files)) emit('attach-image', f);
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of Array.from(items)) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) {
        emit('attach-image', f);
        e.preventDefault();
      }
    }
  }
}

const reasoning = ref<'low' | 'medium' | 'high'>('medium');
const reasoningOpen = ref(false);

const send = () => {
  const t = input.value.trim();
  // Mandiamo anche con testo vuoto se ci sono immagini allegate.
  if (props.isProcessing || !props.isConnected) return;
  if (!t && props.pendingImages.length === 0) return;
  emit('send', t);
  input.value = '';
  resize();
};

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !props.mobile) {
    e.preventDefault();
    send();
  }
};

const resize = () => {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
};

const following = ref(true);
function onScroll() {
  const el = messagesEl.value;
  if (el) following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
}
const scroll = () => {
  if (!following.value || !props.visible) return;
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  });
};

watch(() => props.messages.length, scroll);
watch(() => props.messages[props.messages.length - 1]?.content, scroll);
watch(() => props.visible, (visible) => {
  if (visible) nextTick(() => {
    resize(); scroll();
    if (props.mobile) closeButton.value?.focus({ preventScroll: true });
  });
  else {
    textareaEl.value?.blur();
    reasoningOpen.value = false;
    if (props.mobile) nextTick(() => document.querySelector<HTMLButtonElement>('.chat-bubble')?.focus({ preventScroll: true }));
  }
});

let handleStart = 0;
let handleMoved = false;
function handleDown(event: PointerEvent) {
  handleStart = event.clientY;
  handleMoved = false;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function handleUp(event: PointerEvent) {
  const delta = event.clientY - handleStart;
  handleMoved = Math.abs(delta) > 40;
  if (delta < -40 && !props.expanded) emit('toggle-expand');
  if (delta > 40) props.expanded ? emit('toggle-expand') : emit('close');
}

const formatMessage = (text: string) => {
  let out = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
  out = out.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
};
</script>

<template>
  <aside
    id="tharvel-chat"
    aria-label="Chat Tharvel"
    class="chat"
    :class="{ resizing: panelResize.dragging.value, dragging, 'mobile-chat': mobile, expanded }"
    :style="{ width: panelResize.width.value + 'px' }"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
    @keydown.esc.stop="emit('close')"
  >
    <button v-if="mobile" class="sheet-handle" :aria-label="expanded ? 'Riduci chat' : 'Espandi chat'"
      @pointerdown="handleDown" @pointerup="handleUp" @click="!handleMoved && emit('toggle-expand')"><span></span></button>
    <div
      class="resize-handle"
      :class="{ active: panelResize.dragging.value }"
      @pointerdown="panelResize.onPointerDown"
      role="separator"
      aria-orientation="vertical"
      aria-label="Ridimensiona chat"
    ></div>
    <transition name="dz">
      <div v-if="dragging" class="chat-dropzone">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <div class="dz-title">Allega alla chat</div>
        <div class="dz-sub">Lo screenshot resta solo qui (non viene salvato negli asset)</div>
      </div>
    </transition>
    <header class="chat-bar">
      <div class="chat-title">Chat</div>
      <span class="status-pill" :class="{ on: isConnected }">
        <span class="dot"></span>
        {{ isConnected ? 'Connessa' : 'Non connessa' }}
      </span>
      <div class="chat-actions">
        <button v-if="mobile" class="hdr-btn" @click="emit('toggle-expand')" :aria-label="expanded ? 'Riduci chat' : 'Espandi chat'" :aria-expanded="expanded">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path :d="expanded ? 'M6 9 L12 15 L18 9' : 'M6 15 L12 9 L18 15'" /></svg>
        </button>
        <button
          v-if="hasContent"
          class="hdr-btn"
          @click="emit('clear-chat')"
          title="Svuota chat"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M3 6 H21 M8 6 V4 H16 V6 M6 6 L7 20 H17 L18 6" />
          </svg>
        </button>
        <button ref="closeButton" class="hdr-btn" @click="emit('close')" aria-label="Nascondi chat" title="Nascondi chat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6 L18 18 M18 6 L6 18" /></svg>
        </button>
      </div>
    </header>

    <div class="messages" ref="messagesEl" @scroll="onScroll">
      <div class="messages-inner">
        <template v-if="!hasContent && !isConnected">
          <EmptyState
            title="Chat non connessa"
            body="Non riusciamo a parlare con il server di Tharvel. Verifica che il backend sia avviato e riprova."
            tone="warning"
          >
            <template #icon>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M5 12.55 a11 11 0 0 1 14 0 M8.5 16.05 a6 6 0 0 1 7 0 M12 20 h.01 M2 8.82 a15 15 0 0 1 4-2.45 M18 6.37 a15 15 0 0 1 4 2.45 M3 3 L21 21" />
              </svg>
            </template>
            <template #actions>
              <button class="es-action primary" @click="emit('reconnect')">Riprova</button>
              <button class="es-action" @click="emit('open-settings')">Impostazioni</button>
            </template>
          </EmptyState>
        </template>

        <template v-else-if="!hasContent">
          <ChatWelcome :is-connected="isConnected" @pick="emit('send', $event)" />
        </template>

        <template v-else>
          <div
            v-for="(msg, i) in messages"
            :key="i"
            class="msg"
            :class="msg.role"
          >
            <template v-if="msg.role !== 'system'">
              <div v-if="msg.attachments && msg.attachments.length" class="msg-attachments">
                <a
                  v-for="a in msg.attachments"
                  :key="a.dataUrl"
                  class="msg-attachment"
                  :href="a.dataUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="a.name"
                >
                  <img :src="a.dataUrl" :alt="a.name" />
                </a>
              </div>
              <div v-if="msg.content" class="msg-bubble" v-html="formatMessage(msg.content)"></div>
            </template>
            <div v-else class="msg-system">{{ msg.content }}</div>
          </div>
          <div v-if="isProcessing" class="typing">
            <span></span><span></span><span></span>
          </div>
        </template>
      </div>
    </div>

    <div class="composer">
      <div v-if="selectedElement" class="selection-context">
        <span>Elemento: <strong>{{ selectedElement.tag }}{{ selectedElement.id ? `#${selectedElement.id}` : '' }}</strong></span>
        <button @click="emit('clear-element')" aria-label="Deseleziona elemento">×</button>
      </div>
      <transition-group v-if="pendingImages.length" name="chip" tag="div" class="pending-images">
        <div v-for="p in pendingImages" :key="p.id" class="pending-chip" :title="p.name">
          <img :src="p.dataUrl" :alt="p.name" />
          <span class="pending-name">{{ p.name }}</span>
          <button
            class="pending-x"
            @click="emit('remove-pending-image', p.id)"
            title="Rimuovi dall'allegato"
          >
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
          </button>
        </div>
      </transition-group>
      <textarea
        ref="textareaEl"
        v-model="input"
        @keydown="onKey"
        @input="resize"
        @paste="onPaste"
        placeholder="Modifica il sito, fai una domanda…"
        aria-label="Messaggio per Tharvel"
        rows="1"
        :disabled="!isConnected"
      />
      <div class="composer-bar">
        <input
          ref="fileInputEl"
          type="file"
          class="hidden-file-input"
          accept="image/*"
          multiple
          @change="onPickFile"
        />
        <button
          class="attach-btn"
          @click="pickFile"
          :disabled="!isConnected"
          title="Allega un'immagine alla chat (resta solo qui, non viene salvata negli asset)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M21 15 V19 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 V5 a2 2 0 0 1 2 -2 h9 M17 8 L21 4 M21 4 V8 M21 4 H17" />
          </svg>
        </button>

        <ProviderPicker
          v-if="isAdmin && visible"
          :selected="selectedModel"
          :auth="auth"
          @update:selected="emit('update:selectedModel', $event)"
          @open-settings="emit('open-settings')"
        />

        <div class="reasoning-wrap">
          <button class="pill" @click="reasoningOpen = !reasoningOpen">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2 L13 9 L20 10 L13 11 L12 18 L11 11 L4 10 L11 9 Z" />
            </svg>
            {{ reasoning }}
          </button>
          <transition name="pop">
            <div v-if="reasoningOpen" class="reasoning-pop">
              <button v-for="r in (['low','medium','high'] as const)" :key="r" @click="reasoning = r; reasoningOpen = false" :class="{ active: reasoning === r }">
                {{ r }}
              </button>
            </div>
          </transition>
        </div>

        <div class="spacer"></div>

        <button class="send" @click="send" aria-label="Invia messaggio" :disabled="(!input.trim() && pendingImages.length === 0) || isProcessing || !isConnected">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <path d="M5 12 L12 5 L19 12 M12 5 L12 19" />
          </svg>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.chat {
  min-height: 0;
  min-width: 0;
  flex-shrink: 0;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  position: relative;
  transition: width var(--t-base);
}
.chat.resizing { transition: none; }
.chat:not(.mobile-chat) { max-width: 38vw; }

.resize-handle {
  position: absolute;
  top: 0;
  left: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 10;
  background: transparent;
  transition: background var(--t-fast);
}
.resize-handle:hover,
.resize-handle.active {
  background: var(--brand-soft);
}

.chat-bar {
  flex-shrink: 0;
  height: 48px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  gap: 10px;
}
.chat-title { font-size: 13px; font-weight: 600; }
.chat-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; }

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-mute);
  background: var(--bg-hover);
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
}
.status-pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--error);
  transition: background var(--t-fast);
}
.status-pill.on { color: var(--success); background: var(--success-soft); border-color: transparent; }
.status-pill.on .dot { background: var(--success); }

.hdr-btn {
  background: transparent;
  border: 0;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--text-mute);
  transition: background var(--t-fast), color var(--t-fast);
}
.hdr-btn:hover { background: var(--bg-hover); color: var(--text); }

.es-action {
  font-size: 12px;
  padding: 6px 12px;
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
  background: var(--accent);
  color: var(--on-accent);
  border-color: transparent;
}
.es-action.primary:hover {
  background: var(--accent-hover);
}

.messages {
  min-height: 0;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.messages-inner {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.msg.user { align-self: flex-end; max-width: 90%; }
.msg.ai { align-self: flex-start; max-width: 100%; }
.msg.system { align-self: center; max-width: 100%; }

.msg-bubble {
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  font-size: 13.5px;
  line-height: 1.55;
  word-wrap: break-word;
}
.msg.user .msg-bubble {
  background: var(--accent);
  color: var(--on-accent);
  border-bottom-right-radius: 4px;
}
.msg.ai .msg-bubble {
  background: var(--bg-soft);
  color: var(--text);
  border: 1px solid var(--border);
  border-bottom-left-radius: 4px;
}

.msg-system {
  font-size: 11.5px;
  color: var(--text-mute);
  text-align: center;
  font-family: var(--font-mono);
  padding: 4px 8px;
}

.msg-bubble :deep(code) {
  background: var(--code-bg);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
}
.msg.user .msg-bubble :deep(code) {
  background: var(--code-bg-on-accent);
}

.typing {
  align-self: flex-start;
  display: flex;
  gap: 4px;
  padding: 12px 14px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  border-bottom-left-radius: 4px;
}
.typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-mute);
  animation: bounce 1.4s infinite ease-in-out both;
}
.typing span:nth-child(1) { animation-delay: -0.32s; }
.typing span:nth-child(2) { animation-delay: -0.16s; }
@keyframes bounce {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

.composer {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  padding: 12px;
  background: var(--bg);
}
.composer textarea {
  width: 100%;
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: var(--radius);
  padding: 10px 12px;
  font-size: 13.5px;
  resize: none;
  outline: none;
  line-height: 1.45;
  min-height: 40px;
  max-height: 180px;
  transition: border-color 0.15s;
}
.composer textarea:focus { border-color: var(--text); }
.composer textarea::placeholder { color: var(--text-mute); }

.composer-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.pill {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-soft);
  text-transform: capitalize;
}
.pill:hover { background: var(--bg-hover); color: var(--text); }

.reasoning-wrap { position: relative; }
.reasoning-pop {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 100px;
  z-index: 50;
}
.reasoning-pop button {
  background: transparent;
  border: 0;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 12px;
  text-align: left;
  text-transform: capitalize;
  color: var(--text-soft);
}
.reasoning-pop button:hover { background: var(--bg-hover); color: var(--text); }
.reasoning-pop button.active { color: var(--text); font-weight: 500; }

.spacer { flex: 1; }

.send {
  background: var(--accent);
  color: var(--on-accent);
  border: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  transition: background var(--t-fast), transform var(--t-fast);
}
.send:hover:not(:disabled) { background: var(--accent-hover); transform: translateY(-1px); }

.hidden-file-input { display: none; }
.attach-btn {
  background: transparent;
  border: 1px solid var(--border);
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--text-soft);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.attach-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
  border-color: var(--text);
}
.attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.pop-enter-active, .pop-leave-active {
  transition: all 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pop-enter-from, .pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
  justify-content: flex-end;
}
.msg-attachment {
  display: block;
  width: 140px;
  max-width: 60%;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-soft);
  transition: transform var(--t-fast), box-shadow var(--t-fast);
}
.msg-attachment:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }
.msg-attachment img {
  display: block;
  width: 100%;
  height: auto;
  max-height: 160px;
  object-fit: cover;
}

.pending-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.pending-chip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 3px 8px 3px 3px;
  font-size: 11.5px;
  color: var(--text-soft);
  max-width: 100%;
}
.pending-chip img {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
}
.pending-name {
  max-width: 110px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pending-x {
  background: transparent;
  border: 0;
  color: var(--text-mute);
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast);
}
.pending-x:hover { background: var(--bg-hover); color: var(--error); }

.chat-dropzone {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(6px);
  border: 2px dashed var(--brand);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--brand);
  z-index: 30;
  pointer-events: none;
  margin: 6px;
}
.dz-title { font-size: 14px; font-weight: 600; }
.dz-sub { font-size: 11.5px; color: var(--text-mute); }
.dz-enter-active, .dz-leave-active { transition: opacity var(--t-fast); }
.dz-enter-from, .dz-leave-to { opacity: 0; }

.chip-enter-active, .chip-leave-active { transition: all 0.18s cubic-bezier(0.2, 0.8, 0.2, 1); }
.chip-enter-from, .chip-leave-to { opacity: 0; transform: scale(0.9); }
.selection-context { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--brand); margin-bottom: 6px; }
.selection-context span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.selection-context button { background: var(--brand-soft); border: 0; border-radius: 6px; font-size: 20px; min-width: 32px; min-height: 32px; }
.mobile-chat {
  --chat-height: min(60dvh, calc(var(--visual-height, 100dvh) - 64px - env(safe-area-inset-top)));
  position: fixed; z-index: 50; left: max(6px, env(safe-area-inset-left)); right: max(6px, env(safe-area-inset-right));
  top: calc(var(--visual-top, 0px) + var(--visual-height, 100dvh) - var(--chat-height));
  width: auto !important; height: var(--chat-height);
  border: 1px solid var(--border-strong); border-bottom: 0; border-radius: 20px 20px 0 0;
  box-shadow: 0 -8px 40px rgba(0,0,0,.18); padding-bottom: env(safe-area-inset-bottom);
  transition: none;
}
.mobile-chat.expanded, :global(.keyboard-open) .mobile-chat {
  --chat-height: calc(var(--visual-height, 100dvh) - 64px - env(safe-area-inset-top));
}
.sheet-handle { height: 22px; flex-shrink: 0; border: 0; background: transparent; display: grid; place-items: center; touch-action: none; border-radius: 20px 20px 0 0; }
.sheet-handle span { width: 36px; height: 4px; border-radius: 4px; background: var(--border-strong); }
.mobile-chat .resize-handle { display: none; }
.mobile-chat .chat-bar { padding: 0 10px; }
.mobile-chat .hdr-btn { width: 44px; height: 44px; }
.mobile-chat .messages { padding: 12px; }
.mobile-chat .composer { padding: 8px; }
.mobile-chat .composer textarea { font-size: 16px; max-height: min(120px, 22dvh); }
.mobile-chat .composer-bar { flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.mobile-chat .attach-btn, .mobile-chat .send { width: 44px; height: 44px; flex-shrink: 0; }
.mobile-chat .pill { min-height: 44px; }
.mobile-chat .pending-images { max-height: 72px; overflow-y: auto; }
.mobile-chat .pending-x { width: 36px; height: 36px; }
.mobile-chat .selection-context button { min-height: 36px; min-width: 36px; }
@media (max-height: 500px) and (max-width: 1100px) {
  .mobile-chat { --chat-height: calc(var(--visual-height, 100dvh) - 56px - env(safe-area-inset-top)); }
  .sheet-handle { height: 12px; }
  .mobile-chat .chat-bar { height: 44px; }
}
</style>
