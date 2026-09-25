<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import AppSidebar from './AppSidebar.vue';
import PreviewPane from './PreviewPane.vue';
import ChatPanel from './ChatPanel.vue';
import SettingsModal from './SettingsModal.vue';
import AddSiteWizard from './AddSiteWizard.vue';
import AccessKeysModal from './AccessKeysModal.vue';
import ActivityModal from './ActivityModal.vue';
import PublishDialog from './PublishDialog.vue';
import MobileChatBubble from './MobileChatBubble.vue';
import { useMobileLayout } from '../composables/useMobileLayout';
import { useTharvelSession } from '../composables/useTharvelSession';
import { authFetch, useAuth } from '../composables/useAuth';
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
// Slug di cui stiamo mostrando le chiavi di accesso (null = modale chiusa).
const accessSlug = ref<string | null>(null);
const activitySlug = ref<string | null>(null);
const publishDialogOpen = ref(false);
// Desktop preferences are independent of the compact panels.
const SIDEBAR_KEY = 'tharvel-sidebar-collapsed';
const CHAT_KEY = 'tharvel-chat-hidden';
const sidebarCollapsed = ref<boolean>(localStorage.getItem(SIDEBAR_KEY) === '1');
const chatHidden = ref<boolean>(localStorage.getItem(CHAT_KEY) === '1');
watch(sidebarCollapsed, (v) => localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0'));
watch(chatHidden, (v) => localStorage.setItem(CHAT_KEY, v ? '1' : '0'));

const { compact } = useMobileLayout();
const toolsOpen = ref(false);
const mobileChatOpen = ref(false);
const chatExpanded = ref(false);
const unread = ref(false);
const chatVisible = computed(() => compact.value ? mobileChatOpen.value : !chatHidden.value);
const modalOpen = computed(() => settingsOpen.value || wizardOpen.value || !!accessSlug.value || !!activitySlug.value || publishDialogOpen.value);

function toggleChat() {
  if (compact.value) mobileChatOpen.value = !mobileChatOpen.value;
  else chatHidden.value = !chatHidden.value;
}
function selectSite(slug: string) {
  setAdminActiveSlug(slug);
  toolsOpen.value = false;
}
watch(chatVisible, (visible) => { if (visible) unread.value = false; });
watch(() => session.messages.value.at(-1)?.content, () => {
  if (!chatVisible.value && session.messages.value.at(-1)?.role === 'ai') unread.value = true;
});
watch(activeSlug, () => { unread.value = false; mobileChatOpen.value = false; });
watch(compact, () => { toolsOpen.value = false; });

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
    const res = await authFetch(apiUrl('/api/sites'), { credentials: 'include' });
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
  <div class="app" :class="{ compact }">
    <div v-if="compact && toolsOpen" class="tools-backdrop" @click="toolsOpen = false" aria-hidden="true"></div>
    <div v-show="!compact || toolsOpen" class="sidebar-shell" id="tharvel-tools"
      v-dialog="compact && toolsOpen && !modalOpen"
      :role="compact ? 'dialog' : undefined" :aria-modal="compact ? true : undefined" aria-label="Strumenti Tharvel"
      :inert="modalOpen">
    <AppSidebar
      :files="session.projectFiles.value"
      :selected="session.selectedFiles.value"
      :is-connected="session.isConnected.value"
      :user="user"
      :admin-sites="adminSites"
      :active-slug="activeSlug"
      :sites-loading="sitesLoading"
      :history-nonce="session.historyNonce.value"
      :collapsed="compact ? false : sidebarCollapsed"
      :compact="compact"
      @update:selected="session.selectedFiles.value = $event"
      @open-settings="settingsOpen = true"
      @clear-chat="session.clearChat()"
      @select-site="selectSite"
      @add-site="wizardOpen = true"
      @site-access="accessSlug = $event"
      @site-activity="activitySlug = $event"
      @upload-asset="session.uploadFile($event)"
      @logout="logout"
      @reload-preview="session.reloadIframe()"
      @toggle-collapse="compact ? toolsOpen = false : sidebarCollapsed = !sidebarCollapsed"
    />
    </div>

    <template v-if="noSlug">
      <div class="empty-stage" :inert="modalOpen || (compact && toolsOpen)">
        <div class="empty-card">
          <h2>Nessun sito selezionato</h2>
          <p v-if="user?.role === 'admin'">Scegli un sito dal menu strumenti.</p>
          <p v-else>Il tuo account non ha ancora un sito assegnato. Contatta l'amministratore.</p>
          <button v-if="compact" class="empty-tools" @click="toolsOpen = true">Apri strumenti</button>
        </div>
      </div>
    </template>

    <template v-else>
      <PreviewPane
        :compact="compact"
        :inert="modalOpen || (compact && toolsOpen)"
        :slug="activeSlug as string"
        :iframe-nonce="session.iframeNonce.value"
        :preview-path="session.previewPath.value"
        :current-path="session.currentPreviewPath.value"
        :selected-element="session.selectedElement.value"
        :chat-hidden="!chatVisible"
        :is-connected="session.isConnected.value"
        :pending-changes="revisions.pendingChanges.value"
        :is-processing="session.isProcessing.value"
        @clear-element="session.selectedElement.value = null"
        @publish="publishDialogOpen = true"
        @toggle-chat="toggleChat"
        @open-tools="toolsOpen = true"
        @inspect-start="mobileChatOpen = false"
        @select-element="session.selectedElement.value = $event"
        @route-changed="session.currentPreviewPath.value = $event"
        @reconnect="session.reconnect()"
        @reload-preview="session.reloadIframe()"
        @navigate="session.navigatePreview($event)"
        @upload-asset="session.uploadFile($event)"
      />

      <ChatPanel
        v-show="chatVisible"
        :key="activeSlug as string"
        :visible="chatVisible"
        :mobile="compact"
        :expanded="chatExpanded"
        :selected-element="session.selectedElement.value"
        :inert="modalOpen || (compact && toolsOpen)"
        :messages="session.messages.value"
        :is-processing="session.isProcessing.value"
        :is-connected="session.isConnected.value"
        :selected-model="session.selectedModel.value"
        :is-changing-model="session.isChangingModel.value"
        :model-error="session.modelError.value"
        :auth="session.auth"
        :pending-images="session.pendingImages.value"
        @send="session.sendPrompt($event)"
        @update:selected-model="session.setModel($event)"
        @open-settings="settingsOpen = true"
        @attach-image="session.addPendingImage($event)"
        @remove-pending-image="session.removePendingImage($event)"
        @clear-chat="session.clearChat()"
        @reconnect="session.reconnect()"
        @close="toggleChat"
        @toggle-expand="chatExpanded = !chatExpanded"
        @clear-element="session.selectedElement.value = null"
      />
      <MobileChatBubble v-if="compact" v-show="!mobileChatOpen && !toolsOpen && !modalOpen"
        :processing="session.isProcessing.value" :connected="session.isConnected.value" :unread="unread"
        @open="mobileChatOpen = true" />
    </template>

    <SettingsModal
      v-if="settingsOpen"
      :auth="session.auth"
      @close="settingsOpen = false"
      @login="onLogin"
      @set-key="onSetKey"
    />

    <AccessKeysModal
      v-if="accessSlug"
      :slug="accessSlug"
      @close="accessSlug = null"
    />

    <ActivityModal
      v-if="activitySlug"
      :slug="activitySlug"
      @close="activitySlug = null"
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
  height: 100dvh;
  width: 100%;
  overflow: hidden;
  background: var(--bg);
}
.sidebar-shell { display: flex; flex-shrink: 0; min-height: 0; }
.app:not(.compact) .sidebar-shell :deep(.sidebar) { max-width: 28vw; }
.empty-tools { margin-top: 20px; padding: 12px 18px; border: 0; border-radius: var(--radius); background: var(--brand); color: white; }
.tools-backdrop { position: fixed; inset: 0; background: var(--backdrop); z-index: 60; }
.compact .sidebar-shell {
  position: fixed; z-index: 70; left: 0; top: var(--visual-top, 0px);
  height: var(--visual-height, 100dvh); width: min(380px, calc(100% - 24px));
  background: var(--bg-soft); box-shadow: var(--shadow-lg);
  padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom) env(safe-area-inset-left);
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
