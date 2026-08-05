<script setup lang="ts">
// Chiavi di accesso di un sito: ristampa il messaggio di handover che il wizard mostra
// una volta sola a fine onboarding. Nasce da un bisogno concreto: il cliente non trova
// più la mail con gli accessi e l'admin non ha dove ripescarli.
//
// La password arriva dal server decifrata (secret-box.ts). Può essere null: gli account
// creati prima di questa feature hanno in DB solo l'hash Argon2id, che non è
// reversibile. In quel caso l'unica strada è rigenerarla, e va detto chiaramente
// perché così la password che il cliente ha in mano smette di funzionare.
import { ref, computed, onMounted } from 'vue';
import { apiUrl } from '../site';
import { buildHandoverMessage } from '../handover';

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

interface AccessUser {
  id: number;
  email: string;
  role: string;
  password: string | null;
  updatedAt: string;
}

const loading = ref(true);
const errorMsg = ref<string | null>(null);
const adminUrl = ref<string | null>(null);
const users = ref<AccessUser[]>([]);
const resettingId = ref<number | null>(null);
const confirmingId = ref<number | null>(null);
const copied = ref(false);

async function load() {
  loading.value = true;
  errorMsg.value = null;
  try {
    const r = await fetch(apiUrl(`/api/admin/sites/${encodeURIComponent(props.slug)}/access`), {
      credentials: 'include',
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
    adminUrl.value = body.adminUrl;
    users.value = body.users ?? [];
  } catch (e: any) {
    errorMsg.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function resetPassword(user: AccessUser) {
  confirmingId.value = null;
  resettingId.value = user.id;
  errorMsg.value = null;
  try {
    const r = await fetch(
      apiUrl(`/api/admin/sites/${encodeURIComponent(props.slug)}/access/reset-password`),
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      },
    );
    const body = await r.json();
    if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
    // Aggiorna in place: la nuova password è già quella buona, non serve rifare la GET.
    const idx = users.value.findIndex((u) => u.id === user.id);
    if (idx >= 0) users.value[idx] = { ...users.value[idx], password: body.password };
  } catch (e: any) {
    errorMsg.value = e?.message ?? String(e);
  } finally {
    resettingId.value = null;
  }
}

// Il pannello è pensato per un cliente per sito (modello Beta), ma se ce ne fossero
// più di uno il messaggio segue quello selezionato.
const selectedId = ref<number | null>(null);
const selected = computed(
  () => users.value.find((u) => u.id === selectedId.value) ?? users.value[0] ?? null,
);

const messageForClient = computed(() => {
  if (!selected.value || !adminUrl.value) return '';
  return buildHandoverMessage({
    adminUrl: adminUrl.value,
    email: selected.value.email,
    password: selected.value.password,
  });
});

function copyMessage() {
  navigator.clipboard
    .writeText(messageForClient.value)
    .then(() => {
      copied.value = true;
      setTimeout(() => { copied.value = false; }, 1800);
    })
    .catch(() => window.prompt('Copia il testo:', messageForClient.value));
}
</script>

<template>
  <div class="modal-shell" @click.self="emit('close')">
    <div class="modal">
      <header class="modal-head">
        <h2>Chiavi di accesso · {{ slug }}</h2>
        <button class="close-btn" @click="emit('close')" title="Chiudi">✕</button>
      </header>

      <section class="body">
        <div v-if="loading" class="running">
          <div class="spinner"></div>
          <p>Caricamento…</p>
        </div>

        <template v-else>
          <p v-if="errorMsg" class="error-box">{{ errorMsg }}</p>

          <p v-if="!adminUrl" class="hint warn">
            Questo sito non ha un dominio registrato, quindi non c'è un URL del pannello da
            consegnare. Aggiungi il dominio al sito e ricarica.
          </p>

          <p v-else-if="users.length === 0" class="hint warn">
            Nessun utente cliente collegato a <code>{{ slug }}</code>. Creane uno con
            <code>npm run create-user</code> oppure rifà l'onboarding del sito.
          </p>

          <template v-else>
            <div class="field-list">
              <div class="field">
                <span class="k">URL pannello</span>
                <code>{{ adminUrl }}</code>
              </div>
              <div v-for="u in users" :key="u.id" class="user-block" :class="{ active: u.id === selected?.id }">
                <label class="field clickable">
                  <input
                    v-if="users.length > 1"
                    type="radio"
                    :value="u.id"
                    :checked="u.id === selected?.id"
                    @change="selectedId = u.id"
                  />
                  <span class="k">Email</span>
                  <code>{{ u.email }}</code>
                </label>
                <div class="field">
                  <span class="k">Password</span>
                  <code v-if="u.password" class="pwd">{{ u.password }}</code>
                  <span v-else class="pwd-missing">
                    non recuperabile — account creato prima del salvataggio cifrato
                  </span>
                </div>
                <div class="user-actions">
                  <button
                    v-if="confirmingId !== u.id"
                    class="ghost small"
                    :disabled="resettingId === u.id"
                    @click="confirmingId = u.id"
                  >
                    {{ resettingId === u.id ? 'Rigenerazione…' : 'Rigenera password' }}
                  </button>
                  <span v-else class="confirm">
                    La password attuale del cliente smetterà di funzionare subito.
                    <button class="danger small" @click="resetPassword(u)">Confermo</button>
                    <button class="ghost small" @click="confirmingId = null">Annulla</button>
                  </span>
                </div>
              </div>
            </div>

            <label class="copy-block">
              <span>Messaggio pronto da inviare al cliente</span>
              <textarea readonly :value="messageForClient" rows="10"></textarea>
            </label>
          </template>
        </template>
      </section>

      <footer class="modal-foot">
        <button class="ghost" @click="emit('close')">Chiudi</button>
        <button
          class="primary"
          :disabled="!messageForClient"
          @click="copyMessage"
        >
          {{ copied ? '✓ Copiato' : 'Copia messaggio' }}
        </button>
      </footer>
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
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
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

.body { padding: 18px 20px; display: flex; flex-direction: column; gap: 16px; }

.hint { font-size: 13px; color: var(--text-soft); margin: 0; line-height: 1.55; }
.hint.warn { color: var(--warning); }
.hint code, .field code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--code-bg);
  padding: 2px 6px;
  border-radius: 4px;
}

.error-box {
  margin: 0;
  font-size: 13px;
  color: var(--error);
  background: var(--error-bg);
  border-radius: var(--radius-sm);
  padding: 9px 12px;
}

.field-list { display: flex; flex-direction: column; gap: 10px; }
.field {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font-size: 13px;
}
.field.clickable { cursor: pointer; }
.field .k {
  color: var(--text-mute);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  font-size: 10.5px;
  font-weight: 600;
  width: 92px;
  flex-shrink: 0;
}
.field code {
  overflow-wrap: anywhere;
  color: var(--text);
}
.field code.pwd { color: var(--brand); font-weight: 600; }
.pwd-missing { font-size: 12px; color: var(--warning); }

.user-block {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.user-block.active { border-color: var(--brand); }
.user-actions { display: flex; align-items: center; }
.confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--warning);
}

button.small { padding: 5px 10px; font-size: 12px; border-radius: var(--radius-sm); }
button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  transition: background var(--t-fast);
}
button.ghost:hover:not(:disabled) { background: var(--bg-hover); }
button.danger {
  background: var(--error);
  color: #fff;
  border: 0;
}
button.primary {
  background: var(--accent);
  color: var(--on-accent);
  border: 0;
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  transition: background var(--t-fast);
}
button.primary:hover:not(:disabled) { background: var(--accent-hover); }
button.primary:disabled, button.ghost:disabled { opacity: 0.4; cursor: not-allowed; }

.copy-block { display: flex; flex-direction: column; gap: 6px; }
.copy-block > span { font-size: 12px; color: var(--text-soft); }
.copy-block textarea {
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.55;
  resize: vertical;
  min-height: 180px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 10px 12px;
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}

.running { text-align: center; padding: 28px 20px; }
.running p { color: var(--text-soft); font-size: 13px; margin: 0; }
.spinner {
  width: 36px;
  height: 36px;
  margin: 0 auto 14px;
  border: 3px solid var(--border);
  border-top-color: var(--text);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
