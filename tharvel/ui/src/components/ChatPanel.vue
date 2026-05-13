<script setup lang="ts">
import { ref, nextTick, watch } from 'vue';
import type { ChatMessage } from '../composables/useTharvelSession';
import ProviderPicker from './ProviderPicker.vue';

const props = defineProps<{
  messages: ChatMessage[];
  isProcessing: boolean;
  isConnected: boolean;
  selectedModel: string;
  auth: Record<string, 'connected' | 'disconnected' | 'pending'>;
}>();

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'update:selectedModel', val: string): void;
  (e: 'open-settings'): void;
  (e: 'upload-file', file: File): void;
}>();

const input = ref('');
const messagesEl = ref<HTMLElement | null>(null);
const textareaEl = ref<HTMLTextAreaElement | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);

function pickFile() {
  fileInputEl.value?.click();
}

function onPickFile(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) emit('upload-file', file);
  // reset così lo stesso file può essere ri-selezionato in futuro
  target.value = '';
}

const reasoning = ref<'low' | 'medium' | 'high'>('medium');
const reasoningOpen = ref(false);

const send = () => {
  const t = input.value.trim();
  if (!t || props.isProcessing) return;
  emit('send', t);
  input.value = '';
  resize();
};

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
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

const scroll = () => {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  });
};

watch(() => props.messages.length, scroll);
watch(() => props.messages[props.messages.length - 1]?.content, scroll);

const formatMessage = (text: string) => {
  let out = text.replace(/\n/g, '<br/>');
  out = out.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
};
</script>

<template>
  <aside class="chat">
    <header class="chat-bar">
      <div class="chat-title">Chat</div>
      <div class="chat-actions">
        <span class="status" :class="{ on: isConnected }">{{ isConnected ? 'online' : 'offline' }}</span>
      </div>
    </header>

    <div class="messages" ref="messagesEl">
      <div class="messages-inner">
        <div
          v-for="(msg, i) in messages"
          :key="i"
          class="msg"
          :class="msg.role"
        >
          <div v-if="msg.role !== 'system'" class="msg-bubble" v-html="formatMessage(msg.content)"></div>
          <div v-else class="msg-system">{{ msg.content }}</div>
        </div>
        <div v-if="isProcessing" class="typing">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>

    <div class="composer">
      <textarea
        ref="textareaEl"
        v-model="input"
        @keydown="onKey"
        @input="resize"
        placeholder="Modifica il sito, fai una domanda…"
        rows="1"
        :disabled="!isConnected"
      />
      <div class="composer-bar">
        <input
          ref="fileInputEl"
          type="file"
          class="hidden-file-input"
          @change="onPickFile"
        />
        <button
          class="attach-btn"
          @click="pickFile"
          :disabled="!isConnected"
          title="Allega file (immagini compresse e salvate in public/ o assets/)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M12 5 V19 M5 12 H19" />
          </svg>
        </button>

        <ProviderPicker
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

        <button class="send" @click="send" :disabled="!input.trim() || isProcessing || !isConnected">
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
  width: 400px;
  flex-shrink: 0;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.chat-bar {
  height: 48px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  gap: 12px;
}
.chat-title { font-size: 13px; font-weight: 600; }
.chat-actions { margin-left: auto; }
.status {
  font-size: 11px;
  color: var(--text-mute);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.status.on { color: var(--success); }

.messages {
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
  background: var(--text);
  color: var(--bg);
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
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
}
.msg.user .msg-bubble :deep(code) {
  background: rgba(255,255,255,0.15);
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
  background: var(--text);
  color: var(--bg);
  border: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  transition: background 0.15s;
}
.send:hover:not(:disabled) { background: #000; }

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
</style>
