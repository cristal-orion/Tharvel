<script setup lang="ts">
import { ref } from 'vue';
import AppSidebar from './AppSidebar.vue';
import PreviewPane from './PreviewPane.vue';
import ChatPanel from './ChatPanel.vue';
import SettingsModal from './SettingsModal.vue';
import { useTharvelSession } from '../composables/useTharvelSession';

const session = useTharvelSession();
const settingsOpen = ref(false);
const isDragging = ref(false);

const onDrop = (e: DragEvent) => {
  isDragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) session.uploadFile(file);
};

const onLogin = (providerId: string) => {
  // Placeholder: il login OAuth dei provider AI viene fatto lato backend
  // (es. `npm run login:codex` per openai-codex). Questo bottone UI è
  // solo un indicatore di stato, non avvia un flow di autenticazione.
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
</script>

<template>
  <div
    class="app"
    @dragenter.prevent="isDragging = true"
    @dragover.prevent
  >
    <AppSidebar
      :files="session.projectFiles.value"
      :selected="session.selectedFiles.value"
      :is-connected="session.isConnected.value"
      @update:selected="session.selectedFiles.value = $event"
      @open-settings="settingsOpen = true"
      @clear-chat="session.clearChat()"
    />

    <PreviewPane
      :iframe-nonce="session.iframeNonce.value"
      :selected-element="session.selectedElement.value"
      @clear-element="session.selectedElement.value = null"
    />

    <ChatPanel
      :messages="session.messages.value"
      :is-processing="session.isProcessing.value"
      :is-connected="session.isConnected.value"
      :selected-model="session.selectedModel.value"
      :auth="session.auth"
      @send="session.sendPrompt($event)"
      @update:selected-model="session.setModel($event)"
      @open-settings="settingsOpen = true"
    />

    <SettingsModal
      v-if="settingsOpen"
      :auth="session.auth"
      @close="settingsOpen = false"
      @login="onLogin"
      @set-key="onSetKey"
    />

    <transition name="drop">
      <div
        v-if="isDragging"
        class="dropzone"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="onDrop"
      >
        <div class="drop-card">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <div class="drop-title">Rilascia il file</div>
          <div class="drop-sub">Le immagini vengono compresse e salvate in <code>assets/</code></div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100vh;
  width: 100vw;
  background: var(--bg);
}

.dropzone {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(8px);
  display: grid;
  place-items: center;
  z-index: 2000;
  pointer-events: all;
}
.drop-card {
  background: var(--bg);
  border: 1.5px dashed var(--text);
  border-radius: var(--radius-lg);
  padding: 32px 40px;
  text-align: center;
  color: var(--text);
  pointer-events: none;
  box-shadow: var(--shadow-lg);
}
.drop-title {
  font-size: 16px;
  font-weight: 600;
  margin-top: 12px;
}
.drop-sub {
  font-size: 12.5px;
  color: var(--text-soft);
  margin-top: 6px;
}
.drop-sub code {
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.drop-enter-active, .drop-leave-active {
  transition: opacity 0.15s ease;
}
.drop-enter-from, .drop-leave-to {
  opacity: 0;
}
</style>
