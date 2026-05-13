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
  fqdn: string | null; // backward-compat CSV
  fqdns: string[];     // splittato, ogni entry include schema (https/http)
  recommendedFqdn: string | null;
  git_repository: string | null;
  git_branch: string | null;
  build_pack: string | null;
}

// Parsa "https://plusvending.it" → { protocol: "https", host: "plusvending.it" }.
// Se l'URL ha un path (es. "http://x.com/y"), il path viene scartato: lo riprendiamo
// noi con `/tharveladmin`.
function parseFqdnUrl(url: string): { protocol: 'http' | 'https'; host: string } {
  const m = url.match(/^(https?):\/\/([^/]+)(\/.*)?$/i);
  if (!m) return { protocol: 'http', host: url };
  return { protocol: (m[1].toLowerCase() as 'http' | 'https'), host: m[2] };
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
const framework = ref<'html' | 'astro' | 'vite' | ''>('');
const clientEmail = ref('');
const clientPassword = ref('');
// Per il dominio cliente: l'utente sceglie tra i FQDN trovati su Coolify
// (radio button), oppure scrive manualmente. selectedFqdnUrl contiene la
// stringa completa con schema (es. "https://plusvending.it"); host e
// protocol vengono ricavati al submit.
const selectedFqdnUrl = ref<string>(''); // valore selezionato/digitato
const customFqdnMode = ref<boolean>(false); // true se l'admin sta scrivendo manualmente

const clientFqdnHost = computed(() => parseFqdnUrl(selectedFqdnUrl.value).host);
const clientFqdnProtocol = computed(() => parseFqdnUrl(selectedFqdnUrl.value).protocol);

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

const passwordStrong = computed(() => clientPassword.value.length >= 8);
const formValid = computed(
  () =>
    slug.value.length >= 2 &&
    clientEmail.value.includes('@') &&
    passwordStrong.value &&
    clientFqdnHost.value.length > 3,
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
    // Precompila form. Il server suggerisce già il FQDN "migliore" (dominio reale
    // > sslip, https > http). Se admin lo cambia via radio button o lo edita,
    // sovrascrive.
    slug.value = suggestSlug(repoInput.value);
    selectedFqdnUrl.value = body.recommendedFqdn ?? body.fqdns[0] ?? '';
    customFqdnMode.value = body.fqdns.length === 0; // nessun FQDN su Coolify → modalità custom
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
        clientFqdn: clientFqdnHost.value,
        protocol: clientFqdnProtocol.value,
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

const adminUrlPreview = computed(() => {
  if (!clientFqdnHost.value) return '';
  return `${clientFqdnProtocol.value}://${clientFqdnHost.value}/tharveladmin`;
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

        <div class="fqdn-block">
          <span class="label-span">Dominio cliente (dove esporre /tharveladmin)</span>
          <div v-if="!customFqdnMode && preview && preview.fqdns.length > 0" class="fqdn-options">
            <label v-for="url in preview.fqdns" :key="url" class="radio-row">
              <input
                type="radio"
                :value="url"
                v-model="selectedFqdnUrl"
              />
              <span class="radio-url">{{ url }}</span>
              <span v-if="url === preview.recommendedFqdn" class="badge">consigliato</span>
            </label>
            <button type="button" class="link-btn" @click="customFqdnMode = true">
              ✎ Usa un dominio diverso
            </button>
          </div>
          <div v-else class="fqdn-custom">
            <input
              v-model="selectedFqdnUrl"
              placeholder="es. https://cliente.com"
              type="url"
            />
            <button
              v-if="preview && preview.fqdns.length > 0"
              type="button"
              class="link-btn"
              @click="customFqdnMode = false; selectedFqdnUrl = preview?.recommendedFqdn ?? preview?.fqdns[0] ?? ''"
            >
              ← Torna ai domini suggeriti
            </button>
          </div>
          <small v-if="adminUrlPreview">
            URL admin: <code>{{ adminUrlPreview }}</code>
          </small>
          <small v-else class="weak">Seleziona o scrivi un dominio.</small>
        </div>

        <label>
          <span>Framework (override)</span>
          <select v-model="framework">
            <option value="">Auto-detect</option>
            <option value="astro">Astro</option>
            <option value="vite">Vite (React/Vue/Svelte)</option>
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
            <p v-else class="warn">FQDN non aggiunto automaticamente (errore Coolify). Aggiungilo manualmente: <code>{{ adminUrlPreview }}</code> nella app Tharvel.</p>
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

.fqdn-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-soft, #555);
}
.label-span {
  font-size: 13px;
  color: var(--text-soft, #555);
}
.fqdn-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--bg-soft, #f8f8f8);
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 7px;
  padding: 8px 10px;
}
.radio-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13.5px;
  color: var(--text, #111);
  cursor: pointer;
}
.radio-row input[type='radio'] {
  margin: 0;
}
.radio-url {
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
  flex: 1;
}
.badge {
  font-size: 10.5px;
  background: #dcfce7;
  color: #166534;
  padding: 1px 6px;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  font-weight: 600;
}
.fqdn-custom {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fqdn-custom input {
  font-size: 14px;
  padding: 9px 11px;
  border: 1px solid var(--border, #d4d4d4);
  border-radius: 7px;
}
.link-btn {
  background: transparent;
  border: 0;
  color: var(--text-soft, #666);
  font-size: 12px;
  text-align: left;
  padding: 4px 0;
  cursor: pointer;
  text-decoration: underline;
  font-family: inherit;
}
.link-btn:hover { color: var(--text, #111); }
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
