<script setup lang="ts">
import { ref, computed } from 'vue';
import { apiUrl } from '../site';

// Wizard 3 step:
//   1. lookup → admin incolla URL repo, Tharvel cerca app Coolify
//   2. form  → dettagli sito + cliente
//   3. result → pannello finale copy-paste per il cliente
type Step = 'lookup' | 'form' | 'running' | 'done' | 'error';

interface CoolifyAppPreview {
  uuid: string;
  name: string;
  fqdn: string | null; // può essere "http://a.com,http://b.com/path"
  git_repository: string | null;
  git_branch: string | null;
  build_pack: string | null;
}

interface OnboardResult {
  siteId: number;
  userId: number;
  framework: 'html' | 'astro';
  adminUrl: string;
  tharvelDomainsUpdated: boolean;
}

const emit = defineEmits<{ (e: 'close'): void; (e: 'done', adminUrl: string): void }>();

const step = ref<Step>('lookup');
const errorMsg = ref<string | null>(null);

// Step 1: lookup
const repoInput = ref('');
const preview = ref<CoolifyAppPreview | null>(null);
const lookupBusy = ref(false);

// Step 2: form (precompilato dal preview quando possibile)
const slug = ref('');
const framework = ref<'html' | 'astro' | ''>('');
const clientEmail = ref('');
const clientPassword = ref('');
const clientFqdn = ref('');

const result = ref<OnboardResult | null>(null);

// Slug suggerito dal nome repo: "owner/repo" → "repo" → lowercase + dashes safe
function suggestSlug(repoUrl: string): string {
  const parts = repoUrl.replace(/\.git$/, '').split(/[/:]/);
  const name = parts[parts.length - 1] || '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);
}

// Estrae il PRIMO FQDN dal campo Coolify (campo che può listare più domini).
// Per l'onboarding usiamo il primo come "dominio cliente di default" — l'admin
// può comunque editare il campo nel form se serve.
function primaryFqdn(fqdnField: string | null): string {
  if (!fqdnField) return '';
  const first = fqdnField.split(',')[0]?.trim() ?? '';
  return first.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

const passwordStrong = computed(() => clientPassword.value.length >= 8);
const formValid = computed(
  () =>
    slug.value.length >= 2 &&
    clientEmail.value.includes('@') &&
    passwordStrong.value &&
    clientFqdn.value.length > 3,
);

async function doLookup() {
  if (!repoInput.value.trim()) return;
  lookupBusy.value = true;
  errorMsg.value = null;
  try {
    const r = await fetch(
      apiUrl(`/api/admin/coolify-app-by-repo?url=${encodeURIComponent(repoInput.value.trim())}`),
      { credentials: 'include' },
    );
    const body = await r.json();
    if (!r.ok) {
      errorMsg.value = body.error ?? 'Lookup fallito';
      return;
    }
    preview.value = body;
    // Precompila form
    slug.value = suggestSlug(repoInput.value);
    clientFqdn.value = primaryFqdn(body.fqdn);
    // build_pack=dockerfile non implica per forza Astro. Lasciamo l'auto-detect
    // al pipeline server-side. Qui mostriamo solo l'override esplicito.
    framework.value = '';
    step.value = 'form';
  } catch (e: any) {
    errorMsg.value = `Errore: ${e?.message ?? String(e)}`;
  } finally {
    lookupBusy.value = false;
  }
}

async function doOnboard() {
  if (!formValid.value || !preview.value) return;
  step.value = 'running';
  errorMsg.value = null;
  try {
    const r = await fetch(apiUrl('/api/admin/onboard-site'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: slug.value,
        repoUrl: repoInput.value.trim(),
        clientFqdn: clientFqdn.value.trim(),
        clientEmail: clientEmail.value.trim(),
        clientPassword: clientPassword.value,
        framework: framework.value || undefined,
      }),
    });
    const body = await r.json();
    if (!r.ok) {
      errorMsg.value = body.error ?? 'Onboarding fallito';
      step.value = 'error';
      return;
    }
    result.value = body;
    step.value = 'done';
  } catch (e: any) {
    errorMsg.value = `Errore: ${e?.message ?? String(e)}`;
    step.value = 'error';
  }
}

const messageForClient = computed(() => {
  if (!result.value) return '';
  return `Ciao,

Il tuo pannello Tharvel è pronto:

URL:      ${result.value.adminUrl}
Email:    ${clientEmail.value}
Password: ${clientPassword.value}

Da lì puoi chiedere le modifiche al sito via chat e pubblicarle quando sei pronto.

Buon lavoro!`;
});

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {
    // fallback minimal: prompt
    window.prompt('Copia il testo:', text);
  });
}

function backToLookup() {
  preview.value = null;
  errorMsg.value = null;
  step.value = 'lookup';
}

function finish() {
  emit('done', result.value?.adminUrl ?? '');
  emit('close');
}
</script>

<template>
  <div class="modal-shell" @click.self="emit('close')">
    <div class="modal">
      <header class="modal-head">
        <h2>Aggiungi sito</h2>
        <button class="close-btn" @click="emit('close')" title="Chiudi">✕</button>
      </header>

      <!-- STEP 1: Lookup -->
      <section v-if="step === 'lookup'" class="body">
        <p class="hint">
          Incolla l'URL del repo GitHub del sito cliente. Tharvel verificherà che esista già
          come app su Coolify e precompilerà il resto.
        </p>
        <label>
          <span>URL repo GitHub</span>
          <input
            v-model="repoInput"
            type="url"
            placeholder="https://github.com/cristal-orion/nuovo-sito"
            :disabled="lookupBusy"
            @keyup.enter="doLookup"
            autofocus
          />
        </label>
        <div v-if="errorMsg" class="err">{{ errorMsg }}</div>
        <div class="actions">
          <button class="ghost" @click="emit('close')">Annulla</button>
          <button class="primary" :disabled="!repoInput.trim() || lookupBusy" @click="doLookup">
            {{ lookupBusy ? 'Cerco su Coolify…' : 'Verifica' }}
          </button>
        </div>
      </section>

      <!-- STEP 2: Form -->
      <section v-else-if="step === 'form'" class="body">
        <div class="preview-card">
          <div class="preview-row"><b>App Coolify trovata:</b> {{ preview?.name }}</div>
          <div class="preview-row"><b>Repo:</b> <code>{{ preview?.git_repository }}</code></div>
          <div class="preview-row"><b>Branch:</b> <code>{{ preview?.git_branch }}</code></div>
          <div class="preview-row"><b>FQDN:</b> <code>{{ preview?.fqdn || '(nessuno)' }}</code></div>
        </div>

        <label>
          <span>Slug Tharvel</span>
          <input v-model="slug" placeholder="es. industrial" />
          <small>Lettere minuscole, cifre, trattini. Usato come identificatore interno.</small>
        </label>

        <label>
          <span>Dominio cliente</span>
          <input v-model="clientFqdn" placeholder="es. cliente.com o sslip.io" />
          <small>Il dominio su cui il cliente accederà a Tharvel: <code>http://{{ clientFqdn }}/tharveladmin</code></small>
        </label>

        <label>
          <span>Framework (override)</span>
          <select v-model="framework">
            <option value="">Auto-detect</option>
            <option value="astro">Astro</option>
            <option value="html">HTML statico</option>
          </select>
        </label>

        <hr class="sep" />

        <label>
          <span>Email cliente</span>
          <input v-model="clientEmail" type="email" placeholder="cliente@dominio.it" />
        </label>

        <label>
          <span>Password cliente</span>
          <input v-model="clientPassword" type="text" placeholder="min 8 caratteri" />
          <small :class="{ ok: passwordStrong, weak: !passwordStrong && clientPassword }">
            {{ passwordStrong ? '✓ Lunghezza ok' : `${clientPassword.length}/8 caratteri` }}
          </small>
        </label>

        <div v-if="errorMsg" class="err">{{ errorMsg }}</div>

        <div class="actions">
          <button class="ghost" @click="backToLookup">← Indietro</button>
          <button class="primary" :disabled="!formValid" @click="doOnboard">Crea sito</button>
        </div>
      </section>

      <!-- STEP 3: Running -->
      <section v-else-if="step === 'running'" class="body running">
        <div class="spinner"></div>
        <p>Clono il repo, builda Astro (se serve), creo utente, aggiungo dominio su Coolify…</p>
        <p class="hint">Può richiedere 1–3 minuti per siti SSG con molte dipendenze.</p>
      </section>

      <!-- STEP 4: Error -->
      <section v-else-if="step === 'error'" class="body">
        <div class="err big">
          <b>Onboarding fallito.</b>
          <p>{{ errorMsg }}</p>
        </div>
        <div class="actions">
          <button class="ghost" @click="step = 'form'">← Modifica</button>
          <button class="primary" @click="emit('close')">Chiudi</button>
        </div>
      </section>

      <!-- STEP 5: Done -->
      <section v-else-if="step === 'done' && result" class="body">
        <div class="ok-banner">
          <span class="ok-icon">✓</span>
          <div>
            <b>Sito creato e routato.</b>
            <p v-if="result.tharvelDomainsUpdated">FQDN aggiunto all'app Tharvel su Coolify. Traefik attivo a breve.</p>
            <p v-else class="warn">FQDN non aggiunto automaticamente (errore Coolify). Aggiungilo manualmente: <code>http://{{ clientFqdn }}/tharveladmin</code> nella app Tharvel.</p>
          </div>
        </div>

        <label class="copy-block">
          <span>Messaggio pronto da inviare al cliente</span>
          <textarea readonly :value="messageForClient" rows="10"></textarea>
        </label>

        <div class="actions">
          <button class="ghost" @click="copyToClipboard(messageForClient)">Copia messaggio</button>
          <button class="primary" @click="finish">Fatto</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.modal-shell {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  z-index: 2000;
}
.modal {
  background: var(--bg, #fff);
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border, #eee);
}
.modal-head h2 {
  margin: 0;
  font-size: 17px;
}
.close-btn {
  background: transparent;
  border: 0;
  font-size: 18px;
  color: var(--text-soft, #666);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}
.close-btn:hover { background: var(--bg-hover, #f3f3f3); }

.body {
  padding: 18px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-soft, #555);
  line-height: 1.5;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--text-soft, #555);
}
label input,
label select,
label textarea {
  font-size: 14px;
  padding: 9px 11px;
  border: 1px solid var(--border, #d4d4d4);
  border-radius: 7px;
  background: var(--bg, #fff);
  color: var(--text, #111);
  outline: none;
  font-family: inherit;
}
label input:focus,
label select:focus,
label textarea:focus {
  border-color: var(--text, #111);
}
label small {
  font-size: 11.5px;
  color: var(--text-mute, #999);
}
label small.ok { color: #16a34a; }
label small.weak { color: #b91c1c; }
label small code { font-family: var(--font-mono, monospace); color: var(--text-soft, #555); }

.preview-card {
  background: var(--bg-soft, #f8f8f8);
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.preview-row code {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  background: var(--bg, #fff);
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--border, #eee);
}
.sep {
  border: 0;
  border-top: 1px solid var(--border, #eee);
  margin: 4px 0;
}

.err {
  background: #fee2e2;
  color: #991b1b;
  padding: 9px 12px;
  border-radius: 7px;
  font-size: 13px;
}
.err.big {
  padding: 14px 16px;
}
.err.big p { margin: 6px 0 0; }

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 6px;
}
button {
  font-family: inherit;
  font-size: 14px;
  padding: 9px 16px;
  border-radius: 7px;
  cursor: pointer;
  border: 0;
}
button.primary {
  background: var(--text, #111);
  color: #fff;
}
button.primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
button.ghost {
  background: transparent;
  border: 1px solid var(--border, #d4d4d4);
  color: var(--text, #111);
}

.running {
  text-align: center;
  padding: 28px 20px;
}
.spinner {
  width: 36px;
  height: 36px;
  margin: 0 auto 14px;
  border: 3px solid var(--border, #e5e5e5);
  border-top-color: var(--text, #111);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.ok-banner {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13.5px;
}
.ok-icon {
  font-size: 18px;
  color: #16a34a;
  flex-shrink: 0;
}
.ok-banner p { margin: 4px 0 0; color: #065f46; font-size: 13px; }
.ok-banner .warn { color: #92400e; }
.ok-banner code { background: rgba(0,0,0,0.05); padding: 1px 4px; border-radius: 3px; font-family: var(--font-mono, monospace); }

.copy-block textarea {
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
  line-height: 1.55;
  resize: vertical;
  min-height: 180px;
}
</style>
