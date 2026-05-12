<template>
  <div class="tharvel-admin-layout" @dragenter.prevent="isDragging = true">
    
    <!-- Fullscreen Drop Overlay -->
    <div v-if="isDragging" 
         class="fullscreen-dropzone" 
         @dragover.prevent 
         @dragleave.prevent="isDragging = false" 
         @drop.prevent="handleDrop">
      <div class="drop-content">
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <h2>Rilascia il file qui</h2>
        <p>Verrà elaborato dall'IA e salvato in assets/</p>
      </div>
    </div>

    <!-- Sidebar sinistra: Cartelle e asset -->
    <aside class="tharvel-sidebar">
      <div class="sidebar-header">
        <h3>Progetto ({{ projectFiles.length }} assets)</h3>
      </div>
      <div class="folder-tree">
        <div class="folder">📁 assets/</div>
        <div class="file-list">
          <label v-for="(file, idx) in projectFiles" :key="idx" class="file-item">
            <input type="checkbox" :value="file.path" v-model="selectedFiles" />
            <span class="file-icon">📄</span>
            <span class="file-name" :title="file.name">{{ file.name }}</span>
          </label>
        </div>
      </div>
      
      <div class="sidebar-footer" v-if="selectedFiles.length > 0">
        <span class="selection-count">{{ selectedFiles.length }} selezionati</span>
        <button class="clear-selection" @click="selectedFiles = []">Deseleziona</button>
      </div>
    </aside>

    <!-- Centro: Iframe per il sito -->
    <main class="tharvel-preview">
      <div class="preview-toolbar">
        <div class="toolbar-text">
          <span class="preview-title">Anteprima (Branch preview)</span>
          <span class="preview-hint">Premi <kbd>Alt/Option</kbd> e passa il mouse per ispezionare gli elementi. Clicca per selezionare.</span>
        </div>
        <button class="publish-btn">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Pubblica
        </button>
      </div>
      <div class="preview-content">
        <iframe 
          ref="previewIframe" 
          class="mock-iframe" 
          :src="`${SITE_BASE}/index.html`"
          frameborder="0"
        ></iframe>
      </div>
    </main>

    <!-- Sidebar destra: La chat AI -->
    <aside class="tharvel-chat-panel">
      <div class="tharvel-header">
        <div class="header-info">
          <h3>Tharvel AI</h3>
          <span class="status-dot" :class="{ connected: isConnected }"></span>
        </div>
        
        <!-- Selettore Modello in stile Bigbud -->
        <select v-model="selectedModel" @change="changeModel" class="model-selector" :disabled="!isConnected">
          <option value="github-copilot/claude-3-5-sonnet">Copilot: Claude 3.5</option>
          <option value="github-copilot/gpt-4o">Copilot: GPT-4o</option>
          <option value="anthropic/claude-3-5-sonnet-20241022">Anthropic: Claude 3.5</option>
        </select>
      </div>
      
      <div class="tharvel-messages" ref="messagesContainer">
        <transition-group name="msg" tag="div" class="messages-wrapper">
          <div v-for="(msg, i) in messages" :key="i" class="message" :class="msg.role">
            <div class="message-content" v-html="formatMessage(msg.content)"></div>
          </div>
          
          <!-- Typing Indicator -->
          <div v-if="isProcessing && !currentAiResponse" key="typing" class="message ai typing">
            <div class="typing-indicator">
              <span></span><span></span><span></span>
            </div>
          </div>
        </transition-group>
      </div>

      <!-- Chip Elemento Selezionato -->
      <div v-if="selectedElement" class="selected-element-chip">
        <span class="chip-label">🎯 Puntato:</span>
        <code class="chip-code">{{ selectedElement.tag }}{{ selectedElement.id ? '#' + selectedElement.id : '' }}{{ selectedElement.classes ? '.' + selectedElement.classes.split(' ')[0] : '' }}</code>
        <button class="chip-clear" @click="selectedElement = null">✕</button>
      </div>
      
      <div class="tharvel-input">
        <input 
          v-model="input" 
          @keyup.enter="sendPrompt" 
          placeholder="Modifica il sito, /model, /clear..."
          :disabled="isProcessing"
        />
        <button @click="sendPrompt" :disabled="!input.trim() || isProcessing || !isConnected">
          Invia
        </button>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { SITE_BASE, WS_URL } from '../site';

const isConnected = ref(false);
const isProcessing = ref(false);
const isDragging = ref(false);
const input = ref('');
const selectedModel = ref('github-copilot/claude-3-5-sonnet');
const selectedElement = ref<any>(null);
const projectFiles = ref<{name: string, path: string}[]>([]);
const selectedFiles = ref<string[]>([]);
const messages = ref<{role: 'user' | 'ai' | 'system', content: string}[]>([
  { role: 'system', content: 'Ciao! Sono Tharvel. Puoi chiedermi di modificare il sito o usare i comandi.' }
]);
const messagesContainer = ref<HTMLElement | null>(null);
let ws: WebSocket | null = null;
let currentAiResponse = '';

// Contenuto HTML dell'Iframe mock per testare il DOM targeting
const connect = () => {
  ws = new WebSocket(WS_URL);
  
  ws.onopen = () => {
    isConnected.value = true;
  };
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'stream') {
      currentAiResponse += data.content;
      const lastMsg = messages.value[messages.value.length - 1];
      if (lastMsg && lastMsg.role === 'ai') {
        lastMsg.content = currentAiResponse;
      } else {
        messages.value.push({ role: 'ai', content: currentAiResponse });
      }
      scrollToBottom();
    } 
    // Per ricaricare l'iframe ad ogni modifica
    const reloadIframe = () => {
      // previewIframe è nel setup() di Vue ma non lo avevamo messo fra le refs disponibili al template (o c'è un typo)
      const iframeElement = document.querySelector('.mock-iframe') as HTMLIFrameElement;
      if (iframeElement) {
        const currentSrc = iframeElement.src.split('?')[0];
        iframeElement.src = `${currentSrc}?t=${new Date().getTime()}`;
      }
    };
    
    // In ascolto degli eventi tool
    if (data.type === 'tool_start') {
      messages.value.push({ role: 'system', content: `🔧 Sto usando: ${data.tool}...` });
      scrollToBottom();
    }
    else if (data.type === 'system') {
      messages.value.push({ role: 'system', content: data.content });
      scrollToBottom();
    }
    else if (data.type === 'done') {
      isProcessing.value = false;
      currentAiResponse = '';
      reloadIframe(); // Aggiorniamo l'iframe automaticamente!
      scrollToBottom();
    }
    else if (data.type === 'files_list') {
      projectFiles.value = data.files;
    }
    else if (data.type === 'files_updated') {
      // Il server ci avvisa che i file sono cambiati (es. nuovo upload)
      if (ws && isConnected.value) {
        ws.send(JSON.stringify({ type: 'get_files' }));
      }
    }
    else if (data.type === 'error') {
      isProcessing.value = false;
      messages.value.push({ role: 'system', content: `❌ Errore: ${data.message}` });
      scrollToBottom();
    }
  };
  
  ws.onclose = () => {
    isConnected.value = false;
    setTimeout(connect, 3000);
  };
};

const changeModel = () => {
  if (!ws || !isConnected.value) return;
  ws.send(JSON.stringify({ type: 'set_model', model: selectedModel.value }));
};

const sendPrompt = () => {
  if (!input.value.trim() || !ws || !isConnected.value) return;
  
  messages.value.push({ role: 'user', content: input.value });
  
  // Appende in background il contesto dell'elemento selezionato
  let finalPrompt = input.value;
  
  if (selectedFiles.value.length > 0) {
    finalPrompt += `\n\n[Contesto di sistema: l'utente ha selezionato questi file dalla sidebar del progetto per questa richiesta: ${selectedFiles.value.join(', ')}. Usa o modifica questi file se richiesto.]`;
  }
  
  if (selectedElement.value) {
    finalPrompt += `\n\n[Contesto di sistema (NON rispondere a questo blocco, usalo solo come informazione): l'utente ha cliccato/puntato un elemento specifico nel browser per questa richiesta. I dettagli dell'elemento sono:
Tag: <${selectedElement.value.tag}>
ID: ${selectedElement.value.id || 'Nessuno'}
Classi: ${selectedElement.value.classes || 'Nessuna'}
Testo Visibile: "${selectedElement.value.text}"
XPath: ${selectedElement.value.xpath}]`;
  }
  
  ws.send(JSON.stringify({ type: 'prompt', content: finalPrompt }));
  
  input.value = '';
  isProcessing.value = true;
  currentAiResponse = '';
  scrollToBottom();
};

const handleDrop = async (e: DragEvent) => {
  console.log("🔥 Drop Event ricevuto!");
  isDragging.value = false;
  
  if (!e.dataTransfer?.files.length) {
    console.warn("⚠️ Nessun file trovato nel DataTransfer.");
    return;
  }
  if (!ws || !isConnected.value) {
    console.warn("⚠️ WebSocket non connesso!");
    return;
  }
  
  const file = e.dataTransfer.files[0];
  console.log(`📦 Preparazione file: ${file.name} (${file.type})`);
  
  // Leggiamo il file come Base64
  const reader = new FileReader();
  reader.onload = () => {
    console.log("✅ File letto in Base64. Invio via WebSocket in corso...");
    const base64String = (reader.result as string).split(',')[1];
    
    // Mandiamo il payload via websocket
    ws!.send(JSON.stringify({
      type: 'upload_file',
      fileName: file.name,
      mimeType: file.type,
      fileBase64: base64String
    }));
  };
  
  reader.onerror = (err) => {
    console.error("❌ Errore durante la lettura del file FileReader:", err);
  };
  
  reader.readAsDataURL(file);
};

const formatMessage = (text: string) => {
  // Parsing molto basico per il markdown (grassetto e inline code)
  let formatted = text.replace(/\n/g, '<br/>');
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  return formatted;
};

const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  });
};

onMounted(() => {
  connect();
  
  // Ascolta i messaggi dall'Iframe (il pointer click)
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'THARVEL_ELEMENT_SELECTED') {
      selectedElement.value = e.data.info;
    }
  });
});

onUnmounted(() => {
  if (ws) ws.close();
});
</script>

<style>
/* Reset base */
html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  font-family: system-ui, -apple-system, sans-serif;
  overflow: hidden;
}

.tharvel-admin-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  background: #f3f4f6;
}

/* Drag & Drop Fullscreen */
.fullscreen-dropzone {
  position: fixed;
  inset: 0;
  background: rgba(17, 24, 39, 0.8);
  backdrop-filter: blur(8px);
  z-index: 999999;
  display: flex;
  justify-content: center;
  align-items: center;
  color: white;
  border: 4px dashed #10b981;
  animation: fadeIn 0.2s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.drop-content {
  text-align: center;
  pointer-events: none; /* Evita flickering quando il mouse passa sul testo */
  transform: scale(1);
  animation: pulse 2s infinite;
}

.drop-content svg { color: #10b981; margin-bottom: 20px; }
.drop-content h2 { font-size: 32px; margin: 0 0 10px 0; font-weight: 600; }
.drop-content p { font-size: 18px; color: #d1d5db; margin: 0; }

@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.05); }
  100% { transform: scale(1); }
}

/* Sidebar Sinistra (Progetto) */
.tharvel-sidebar {
  width: 250px;
  background: #111827;
  color: #fff;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #1f2937;
}

.sidebar-header {
  padding: 16px;
  border-bottom: 1px solid #1f2937;
}
.sidebar-header h3 { margin: 0; font-size: 16px; }

.folder-tree {
  padding: 16px;
  flex: 1;
  overflow-y: auto;
}
.folder { margin-bottom: 8px; font-size: 14px; color: #d1d5db; font-weight: 500; padding: 6px 12px; }

.file-list {
  display: flex;
  flex-direction: column;
  padding-left: 20px;
  gap: 2px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: #9ca3af;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  transition: 0.15s;
}

.file-item:hover {
  background: rgba(255,255,255,0.05);
  color: #e5e7eb;
}

.file-item input[type="checkbox"] {
  accent-color: #10b981;
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
}

.file-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-footer {
  padding: 12px 16px;
  background: #1f2937;
  border-top: 1px solid #374151;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.selection-count {
  font-size: 12px;
  color: #10b981;
  font-weight: 500;
}

.clear-selection {
  background: transparent;
  border: 1px solid #4b5563;
  color: #d1d5db;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: 0.2s;
}
.clear-selection:hover {
  background: #374151;
  color: white;
}

/* Centro (Preview Iframe) */
.tharvel-preview {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #e5e7eb;
}

.preview-toolbar {
  height: 60px;
  background: white;
  border-bottom: 1px solid #d1d5db;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
}

.toolbar-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preview-title {
  font-size: 15px;
  font-weight: 600;
  color: #111827;
}

.preview-hint {
  font-size: 12px;
  color: #6b7280;
}

.publish-btn {
  background: #2563eb;
  color: white;
  border: none;
  padding: 8px 18px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: background 0.2s;
}
.publish-btn:hover { background: #1d4ed8; }

kbd {
  background: #f3f4f6;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 2px 5px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: #374151;
}

.preview-content {
  flex: 1;
  padding: 24px;
  display: flex;
  background: #f8fafc; /* Leggermente grigio per far staccare il foglio bianco */
}

.mock-iframe {
  width: 100%;
  height: 100%;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: white;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05), 0 4px 6px -2px rgba(0, 0, 0, 0.025);
}

/* Sidebar Destra (Chat) */
.tharvel-chat-panel {
  width: 350px;
  background: white;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #d1d5db;
}

.tharvel-header {
  padding: 16px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.header-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.header-info h3 { margin: 0; font-size: 16px; color: #111827; }

.status-dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; }
.status-dot.connected { background: #10b981; }

.model-selector {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: white;
  font-size: 12px;
  color: #374151;
  outline: none;
  cursor: pointer;
}

.model-selector:focus {
  border-color: #10b981;
}

.tharvel-messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.messages-wrapper {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Animazioni Messaggi Chat */
.msg-enter-active, .msg-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.msg-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}
.msg-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

.message {
  max-width: 88%;
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.5;
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}

.message.user {
  background: #10b981;
  color: white;
  align-self: flex-end;
  border-bottom-right-radius: 4px;
}

.message.ai {
  background: #f3f4f6;
  color: #1f2937;
  align-self: flex-start;
  border-bottom-left-radius: 4px;
  border: 1px solid #e5e7eb;
}

.message.system {
  background: transparent;
  color: #6b7280;
  align-self: center;
  font-size: 12px;
  text-align: center;
  box-shadow: none;
  font-style: italic;
  padding: 4px;
}

/* Markdown di base */
.inline-code {
  background: rgba(0,0,0,0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
}
.user .inline-code { background: rgba(255,255,255,0.2); color: white; }

/* Typing Indicator (3 pallini animati) */
.typing {
  padding: 14px 20px !important;
}

.typing-indicator {
  display: flex;
  gap: 4px;
  align-items: center;
  height: 10px;
}

.typing-indicator span {
  display: block;
  width: 6px;
  height: 6px;
  background-color: #9ca3af;
  border-radius: 50%;
  animation: typing 1.4s infinite ease-in-out both;
}

.typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
.typing-indicator span:nth-child(2) { animation-delay: -0.16s; }

@keyframes typing {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); background-color: #6b7280; }
}

.tharvel-input {
  padding: 16px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  gap: 8px;
}

.selected-element-chip {
  padding: 10px 16px;
  background: #ecfdf5;
  border-top: 1px solid #d1fae5;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #065f46;
}

.chip-label { font-weight: 600; }
.chip-code { background: #d1fae5; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
.chip-clear { 
  margin-left: auto; 
  background: transparent; 
  border: none; 
  color: #059669; 
  cursor: pointer; 
  font-size: 14px; 
}
.chip-clear:hover { color: #047857; }

.tharvel-input input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  outline: none;
}

.tharvel-input input:focus { border-color: #10b981; }

.tharvel-input button {
  padding: 8px 16px;
  background: #10b981;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
}

.tharvel-input button:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}
</style>

