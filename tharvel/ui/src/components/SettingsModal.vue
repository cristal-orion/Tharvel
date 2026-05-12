<script setup lang="ts">
import { ref } from 'vue';
import { PROVIDERS } from '../composables/providers';

defineProps<{
  auth: Record<string, 'connected' | 'disconnected' | 'pending'>;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'login', providerId: string): void;
  (e: 'set-key', payload: { providerId: string; key: string }): void;
}>();

const apiKeyInputs = ref<Record<string, string>>({});

const handleSubmit = (providerId: string) => {
  const key = apiKeyInputs.value[providerId]?.trim();
  if (!key) return;
  emit('set-key', { providerId, key });
  apiKeyInputs.value[providerId] = '';
};
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal">
      <header class="modal-head">
        <h2>Impostazioni</h2>
        <button class="close" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
      </header>

      <div class="modal-body">
        <h3 class="section-title">Provider AI</h3>
        <p class="section-desc">
          Connetti uno o più provider. Per Codex, Claude, Copilot serve un login OAuth con il tuo abbonamento.
          Per OpenCode e OpenAI API basta una chiave.
        </p>

        <div class="prov-card" v-for="p in PROVIDERS" :key="p.id">
          <div class="prov-head">
            <span class="prov-icon" :data-prov="p.id"></span>
            <div class="prov-text">
              <div class="prov-name">{{ p.label }}</div>
              <div class="prov-desc">{{ p.description }}</div>
            </div>
            <span
              class="status-pill"
              :class="{
                connected: auth[p.id] === 'connected',
                pending: auth[p.id] === 'pending',
              }"
            >
              {{ auth[p.id] === 'connected' ? 'Connesso' : auth[p.id] === 'pending' ? 'In corso…' : 'Non connesso' }}
            </span>
          </div>

          <div class="prov-action">
            <template v-if="p.authMode === 'oauth'">
              <button
                class="btn"
                :class="auth[p.id] === 'connected' ? 'btn-ghost' : 'btn-primary'"
                @click="emit('login', p.id)"
              >
                {{ auth[p.id] === 'connected' ? 'Disconnetti' : 'Login' }}
              </button>
            </template>
            <template v-else>
              <input
                type="password"
                v-model="apiKeyInputs[p.id]"
                :placeholder="auth[p.id] === 'connected' ? '••••••••••••' : 'Incolla la API key'"
              />
              <button class="btn btn-primary" @click="handleSubmit(p.id)" :disabled="!apiKeyInputs[p.id]?.trim()">
                Salva
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  z-index: 1000;
  padding: 32px;
}
.modal {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
.modal-head {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.modal-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.close {
  margin-left: auto;
  background: transparent;
  border: 0;
  padding: 6px;
  border-radius: 4px;
  color: var(--text-mute);
  display: grid;
  place-items: center;
}
.close:hover { background: var(--bg-hover); color: var(--text); }

.modal-body {
  padding: 20px;
  overflow-y: auto;
}

.section-title {
  margin: 0 0 4px 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-mute);
  font-weight: 600;
}
.section-desc {
  margin: 0 0 16px 0;
  font-size: 12.5px;
  color: var(--text-soft);
  line-height: 1.5;
}

.prov-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  margin-bottom: 10px;
}
.prov-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.prov-icon {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: var(--bg-active);
  flex-shrink: 0;
}
.prov-icon[data-prov="anthropic"] { background: linear-gradient(135deg, #d97757 0%, #c66a4f 100%); }
.prov-icon[data-prov="openai-codex"] { background: linear-gradient(135deg, #10a37f 0%, #0d8a6c 100%); }
.prov-icon[data-prov="github-copilot"] { background: #24292e; }
.prov-icon[data-prov="opencode"] { background: linear-gradient(135deg, #6366f1, #4f46e5); }
.prov-icon[data-prov="opencode-go"] { background: linear-gradient(135deg, #8b5cf6, #6366f1); }
.prov-icon[data-prov="openai"] { background: #10a37f; }

.prov-text { flex: 1; }
.prov-name { font-size: 13.5px; font-weight: 600; }
.prov-desc { font-size: 12px; color: var(--text-soft); margin-top: 2px; line-height: 1.4; }

.status-pill {
  font-size: 10.5px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-mute);
  white-space: nowrap;
}
.status-pill.connected {
  background: rgba(22,163,74,0.12);
  color: var(--success);
}
.status-pill.pending {
  background: rgba(217,119,6,0.12);
  color: var(--warning);
}

.prov-action {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.prov-action input {
  flex: 1;
  border: 1px solid var(--border);
  background: var(--bg);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  outline: none;
  font-family: var(--font-mono);
}
.prov-action input:focus { border-color: var(--text); }

.btn {
  border: 0;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-weight: 500;
  transition: background 0.15s;
}
.btn-primary {
  background: var(--text);
  color: var(--bg);
}
.btn-primary:hover:not(:disabled) { background: #000; }
.btn-ghost {
  background: var(--bg-hover);
  color: var(--text);
  border: 1px solid var(--border);
}
.btn-ghost:hover { background: var(--bg-active); }
</style>
