<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { PROVIDERS } from '../composables/providers';
import { useModels } from '../composables/useModels';
import ProviderIcon from './ProviderIcon.vue';

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

// --- Modelli custom (solo Codex per ora) ---
const { customFor, loadModels, testModel, addModel, deleteModel } = useModels();

const modelId = ref('');
const label = ref('');
const showAdvanced = ref(false);
const contextWindow = ref<number | null>(null);
const maxTokens = ref<number | null>(null);
const testing = ref(false);
const saving = ref(false);
const feedback = ref<{ ok: boolean; message: string } | null>(null);

const idIsValid = computed(() => /^[a-zA-Z0-9._-]{1,64}$/.test(modelId.value.trim()));

function buildPayload() {
  return {
    provider: 'openai-codex',
    modelId: modelId.value.trim(),
    label: label.value.trim() || undefined,
    contextWindow: contextWindow.value ?? undefined,
    maxTokens: maxTokens.value ?? undefined,
  };
}

function resetForm() {
  modelId.value = '';
  label.value = '';
  contextWindow.value = null;
  maxTokens.value = null;
  showAdvanced.value = false;
}

async function runTest() {
  if (!idIsValid.value) return;
  testing.value = true;
  feedback.value = null;
  const r = await testModel(buildPayload());
  testing.value = false;
  feedback.value = r.ok
    ? { ok: true, message: `Connessione riuscita${r.sample ? ` — risposta: “${r.sample}”` : '.'}` }
    : { ok: false, message: `Test fallito: ${r.error}` };
}

async function runSave() {
  if (!idIsValid.value) return;
  saving.value = true;
  const r = await addModel(buildPayload());
  saving.value = false;
  if (r.ok) {
    feedback.value = { ok: true, message: `Modello “${r.data?.label}” salvato: ora è selezionabile nel menu modelli.` };
    resetForm();
  } else {
    feedback.value = { ok: false, message: `Salvataggio fallito: ${r.error}` };
  }
}

async function removeModel(id: string) {
  const r = await deleteModel('openai-codex', id);
  if (!r.ok) feedback.value = { ok: false, message: `Rimozione fallita: ${r.error}` };
}

onMounted(() => loadModels());
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
            <span class="prov-icon">
              <ProviderIcon :provider="p.id" :size="26" />
            </span>
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

          <!-- Modelli custom: per ora solo Codex. Serve quando esce un modello
               ChatGPT nuovo non ancora nella lista built-in dell'SDK. -->
          <div v-if="p.id === 'openai-codex'" class="custom-models">
            <div class="cm-title">Modelli aggiunti manualmente</div>
            <p class="cm-hint">
              Se ChatGPT rilascia un modello non ancora in elenco, inserisci il suo
              <strong>id esatto</strong> (es. <code>gpt-5.6</code>) e testa la connessione
              prima di salvarlo.
            </p>

            <ul v-if="customFor('openai-codex').length" class="cm-list">
              <li v-for="m in customFor('openai-codex')" :key="m.id">
                <span class="cm-label">{{ m.label }}</span>
                <span class="cm-id">{{ m.id }}</span>
                <button class="cm-del" @click="removeModel(m.id)" title="Rimuovi">
                  <svg width="12" height="12" viewBox="0 0 14 14"><path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
                </button>
              </li>
            </ul>

            <div class="cm-form">
              <div class="cm-row">
                <input v-model="modelId" class="cm-input" placeholder="id modello (es. gpt-5.6)" spellcheck="false" />
                <input v-model="label" class="cm-input" placeholder="etichetta (opzionale)" />
              </div>

              <button type="button" class="cm-adv" @click="showAdvanced = !showAdvanced">
                {{ showAdvanced ? '− Opzioni avanzate' : '+ Opzioni avanzate' }}
              </button>
              <div v-if="showAdvanced" class="cm-row">
                <input v-model.number="contextWindow" class="cm-input" type="number" min="1" placeholder="context window (token)" />
                <input v-model.number="maxTokens" class="cm-input" type="number" min="1" placeholder="max output (token)" />
              </div>
              <p v-if="showAdvanced" class="cm-adv-note">
                Lascia vuoto per ereditare i valori del modello Codex più recente noto.
              </p>

              <div class="cm-actions">
                <button class="btn btn-ghost" @click="runTest" :disabled="!idIsValid || testing || saving">
                  {{ testing ? 'Test in corso…' : 'Testa connessione' }}
                </button>
                <button class="btn btn-primary" @click="runSave" :disabled="!idIsValid || testing || saving">
                  {{ saving ? 'Salvo…' : 'Salva modello' }}
                </button>
              </div>

              <div v-if="feedback" class="cm-feedback" :class="feedback.ok ? 'ok' : 'err'">
                {{ feedback.message }}
              </div>
            </div>
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
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

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
  background: var(--success-soft);
  color: var(--success);
}
.status-pill.pending {
  background: var(--warning-soft);
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
  background: var(--accent);
  color: var(--on-accent);
}
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-ghost {
  background: var(--bg-hover);
  color: var(--text);
  border: 1px solid var(--border);
}
.btn-ghost:hover { background: var(--bg-active); }
.btn:disabled { opacity: 0.55; cursor: default; }

/* --- Modelli custom --- */
.custom-models {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--border);
}
.cm-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.cm-hint {
  font-size: 12px;
  color: var(--text-soft);
  line-height: 1.5;
  margin: 0 0 12px 0;
}
.cm-hint code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
}

.cm-list {
  list-style: none;
  margin: 0 0 12px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cm-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.cm-label { font-size: 12.5px; font-weight: 500; color: var(--text); }
.cm-id {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-mute);
}
.cm-del {
  margin-left: auto;
  background: transparent;
  border: 0;
  color: var(--text-mute);
  display: grid;
  place-items: center;
  padding: 4px;
  border-radius: 4px;
}
.cm-del:hover { background: var(--bg-hover); color: var(--error); }

.cm-form { display: flex; flex-direction: column; gap: 8px; }
.cm-row { display: flex; gap: 8px; }
.cm-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border);
  background: var(--bg);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  outline: none;
  color: var(--text);
}
.cm-input:focus { border-color: var(--text); }
.cm-adv {
  align-self: flex-start;
  background: transparent;
  border: 0;
  padding: 2px 0;
  font-size: 11.5px;
  color: var(--accent-soft, var(--text-mute));
}
.cm-adv:hover { text-decoration: underline; }
.cm-adv-note { margin: -2px 0 0 0; font-size: 11px; color: var(--text-mute); }

.cm-actions { display: flex; gap: 8px; margin-top: 2px; }

.cm-feedback {
  font-size: 12px;
  line-height: 1.45;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  word-break: break-word;
}
.cm-feedback.ok {
  background: var(--success-soft);
  color: var(--success);
}
.cm-feedback.err {
  background: var(--error-bg);
  color: var(--error-text);
}
</style>
