<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import AppSidebar from './AppSidebar.vue';
import PreviewPane from './PreviewPane.vue';
import ChatPanel from './ChatPanel.vue';
import SettingsModal from './SettingsModal.vue';
import AddSiteWizard from './AddSiteWizard.vue';
import PublishDialog from './PublishDialog.vue';
import { useTharvelSession } from '../composables/useTharvelSession';
import { useAuth } from '../composables/useAuth';
import { useRevisions } from '../composables/useRevisions';
import { apiUrl } from '../site';

const { user, activeSlug, setAdminActiveSlug, logout } = useAuth();

// Lo slug attivo guida tutto (WS, iframe preview). Per client è user.slug; per
// admin lo decide la sidebar — appena montata, l'admin riceve la lista siti e
// se lo slug attivo non è ancora settato selezioniamo il primo della lista.
const session = useTharvelSession(activeSlug);
const revisions = useRevisions(activeSlug, session.historyNonce);
const settingsOpen = ref(false);
const wizardOpen = ref(false);
const publishDialogOpen = ref(false);

// Layout state: due flag persistiti separatamente. La sidebar rail-mode e la
// chat nascosta sono indipendenti: l'utente può combinare per massimizzare
// la preview.
const SIDEBAR_KEY = 'tharvel-sidebar-collapsed';
const CHAT_KEY = 'tharvel-chat-hidden';
const sidebarCollapsed = ref<boolean>(localStorage.getItem(SIDEBAR_KEY) === '1');
const chatHidden = ref<boolean>(localStorage.getItem(CHAT_KEY) === '1');
watch(sidebarCollapsed, (v) => localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0'));
watch(chatHidden, (v) => localStorage.setItem(CHAT_KEY, v ? '1' : '0'));

interface SiteSummary {
  id: number;
  slug: string;
  domain: string | null;
  framework: 'html' | 'astro';
}
const adminSites = ref<SiteSummary[]>([]);
const sitesLoading = ref(false);

const DEV_BYPASS =
  import.meta.env.DEV && import.meta.env.VITE_DEV_BYPASS_AUTH === '1';

async function loadSitesForAdmin() {
  if (user.value?.role !== 'admin') return;
  sitesLoading.value = true;
  try {
    if (DEV_BYPASS) {
      // Siti finti per iterare sulla UI senza backend.
      adminSites.value = [
        { id: 1, slug: 'demo-site', domain: 'demo.tharvel.local', framework: 'astro' },
        { id: 2, slug: 'industrial-service', domain: 'industrial.local', framework: 'html' },
      ];
      if (!activeSlug.value) setAdminActiveSlug('demo-site');
      return;
    }
    const res = await fetch(apiUrl('/api/sites'), { credentials: 'include' });
    if (res.ok) {
      const body = await res.json();
      adminSites.value = body.sites;
      if (!activeSlug.value && adminSites.value.length > 0) {
        setAdminActiveSlug(adminSites.value[0].slug);
      }
    }
  } finally {
    sitesLoading.value = false;
  }
}

onMounted(loadSitesForAdmin);
watch(() => user.value?.role, loadSitesForAdmin);

const onLogin = (providerId: string) => {
  session.messages.value.push({
    role: 'system',
    content: `Il login per ${providerId} si fa dal terminale (es. \`npm run login:codex\`). Le credenziali vivono in ~/.pi/agent/auth.json e il server le legge automaticamente.`,
  });
};

const onSetKey = ({ providerId }: { providerId: string; key: string }) => {
  session.auth[providerId] = 'connected';
  session.messages.value.push({
    role: 'system',
    content: `API key per ${providerId} salvata localmente. Backend wiring TODO.`,
  });
};

const noSlug = computed(() => !activeSlug.value);
</script>

<template>
  <div class="app">
    <AppSidebar
      :files="session.projectFiles.value"
      :selected="session.selectedFiles.value"
      :is-connected="session.isConnected.value"
      :user="user"
      :admin-sites="adminSites"
      :active-slug="activeSlug"
      :sites-loading="sitesLoading"
      :history-nonce="session.historyNonce.value"
      :collapsed="sidebarCollapsed"
      @update:selected="session.selectedFiles.value = $event"
      @open-settings="settingsOpen = true"
      @clear-chat="session.clearChat()"
      @select-site="setAdminActiveSlug($event)"
      @add-site="wizardOpen = true"
      @upload-asset="session.uploadFile($event)"
      @logout="logout"
      @reload-preview="session.reloadIframe()"
      @toggle-collapse="sidebarCollapsed = !sidebarCollapsed"
    />

    <template v-if="noSlug">
      <div class="empty-stage">
        <div class="empty-card">
          <h2>Nessun sito selezionato</h2>
          <p v-if="user?.role === 'admin'">Scegli un sito dalla sidebar a sinistra.</p>
          <p v-else>Il tuo account non ha ancora un sito assegnato. Contatta l'amministratore.</p>
        </div>
      </div>
    </template>

    <template v-else>
      <PreviewPane
        :slug="activeSlug as string"
        :iframe-nonce="session.iframeNonce.value"
        :selected-element="session.selectedElement.value"
        :chat-hidden="chatHidden"
        :is-connected="session.isConnected.value"
        :pending-changes="revisions.pendingChanges.value"
        @clear-element="session.selectedElement.value = null"
        @publish="publishDialogOpen = true"
        @toggle-chat="chatHidden = !chatHidden"
        @reconnect="session.reconnect()"
        @reload-preview="session.reloadIframe()"
        @upload-asset="session.uploadFile($event)"
      />

      <ChatPanel
        v-if="!chatHidden"
        :messages="session.messages.value"
        :is-processing="session.isProcessing.value"
        :is-connected="session.isConnected.value"
        :selected-model="session.selectedModel.value"
        :auth="session.auth"
        :pending-images="session.pendingImages.value"
        @send="session.sendPrompt($event)"
        @update:selected-model="session.setModel($event)"
        @open-settings="settingsOpen = true"
        @attach-image="session.addPendingImage($event)"
        @remove-pending-image="session.removePendingImage($event)"
        @clear-chat="session.clearChat()"
        @reconnect="session.reconnect()"
      />
    </template>

    <SettingsModal
      v-if="settingsOpen"
      :auth="session.auth"
      @close="settingsOpen = false"
      @login="onLogin"
      @set-key="onSetKey"
    />

    <AddSiteWizard
      v-if="wizardOpen"
      @close="wizardOpen = false"
      @done="loadSitesForAdmin"
    />

    <PublishDialog
      v-if="publishDialogOpen"
      :pending-count="revisions.pendingChanges.value"
      :files="revisions.pendingFiles.value"
      @close="publishDialogOpen = false"
      @confirm="() => { publishDialogOpen = false; session.sendPrompt('Pubblica le modifiche al sito.'); }"
    />

  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100vh;
  width: 100vw;
  background: var(--bg);
}

.empty-stage {
  flex: 1;
  display: grid;
  place-items: center;
  background: var(--bg-soft);
  color: var(--text-soft);
}
.empty-card {
  text-align: center;
  padding: 40px;
}
.empty-card h2 {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}
.empty-card p {
  margin: 0;
  font-size: 14px;
}

</style>
