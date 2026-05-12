import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { WS_URL } from '../site';

export type Role = 'user' | 'ai' | 'system';
export interface ChatMessage {
  role: Role;
  content: string;
}
export interface SelectedElement {
  tag: string;
  id: string;
  classes: string;
  text: string;
  xpath: string;
}
export interface ProjectFile {
  name: string;
  path: string;
}

export function useTharvelSession() {
  const isConnected = ref(false);
  const isProcessing = ref(false);
  const messages = ref<ChatMessage[]>([
    { role: 'system', content: 'Pronto. Scrivi una richiesta o trascina un file.' },
  ]);
  const projectFiles = ref<ProjectFile[]>([]);
  const selectedFiles = ref<string[]>([]);
  const selectedElement = ref<SelectedElement | null>(null);
  const selectedModel = ref('openai-codex/gpt-5.5');
  const iframeNonce = ref(0);

  const auth = reactive<Record<string, 'connected' | 'disconnected' | 'pending'>>({
    'anthropic': 'disconnected',
    'github-copilot': 'connected',
    'openai-codex': 'connected',
    'opencode': 'disconnected',
    'opencode-go': 'disconnected',
    'openai': 'disconnected',
  });

  let ws: WebSocket | null = null;
  let currentAi = '';

  const scrollHooks = new Set<() => void>();
  const onAfterMessage = (fn: () => void) => scrollHooks.add(fn);

  const send = (payload: unknown) => {
    if (ws && isConnected.value) ws.send(JSON.stringify(payload));
  };

  const reloadIframe = () => {
    iframeNonce.value = Date.now();
  };

  const handleEvent = (data: any) => {
    switch (data.type) {
      case 'stream': {
        currentAi += data.content;
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === 'ai') last.content = currentAi;
        else messages.value.push({ role: 'ai', content: currentAi });
        break;
      }
      case 'tool_start':
        messages.value.push({ role: 'system', content: `→ ${data.tool}` });
        break;
      case 'system':
        messages.value.push({ role: 'system', content: data.content });
        break;
      case 'done':
        isProcessing.value = false;
        currentAi = '';
        reloadIframe();
        break;
      case 'files_list':
        projectFiles.value = data.files;
        break;
      case 'files_updated':
        send({ type: 'get_files' });
        break;
      case 'error':
        isProcessing.value = false;
        messages.value.push({ role: 'system', content: `✕ ${data.message}` });
        break;
    }
    scrollHooks.forEach((fn) => fn());
  };

  const connect = () => {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { isConnected.value = true; };
    ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
    ws.onclose = () => { isConnected.value = false; setTimeout(connect, 3000); };
    ws.onerror = () => { /* swallow; close will retry */ };
  };

  const sendPrompt = (text: string) => {
    if (!text.trim() || isProcessing.value) return;
    messages.value.push({ role: 'user', content: text });

    let final = text;
    if (selectedFiles.value.length > 0) {
      final += `\n\n[file selezionati: ${selectedFiles.value.join(', ')}]`;
    }
    if (selectedElement.value) {
      const el = selectedElement.value;
      final += `\n\n[elemento puntato — tag: ${el.tag}; id: ${el.id || '-'}; classi: ${el.classes || '-'}; testo: "${el.text}"; xpath: ${el.xpath}]`;
    }
    send({ type: 'prompt', content: final });
    isProcessing.value = true;
    currentAi = '';
    scrollHooks.forEach((fn) => fn());
  };

  const setModel = (model: string) => {
    selectedModel.value = model;
    send({ type: 'set_model', model });
  };

  const uploadFile = async (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      send({
        type: 'upload_file',
        fileName: file.name,
        mimeType: file.type,
        fileBase64: base64,
      });
    };
    reader.readAsDataURL(file);
  };

  const clearChat = () => {
    messages.value = [{ role: 'system', content: 'Memoria cancellata.' }];
    send({ type: 'prompt', content: '/clear' });
  };

  const onElementMessage = (e: MessageEvent) => {
    if (e.data?.type === 'THARVEL_ELEMENT_SELECTED') {
      selectedElement.value = e.data.info;
    }
  };

  onMounted(() => {
    connect();
    window.addEventListener('message', onElementMessage);
  });
  onUnmounted(() => {
    window.removeEventListener('message', onElementMessage);
    if (ws) ws.close();
  });

  return {
    isConnected,
    isProcessing,
    messages,
    projectFiles,
    selectedFiles,
    selectedElement,
    selectedModel,
    iframeNonce,
    auth,
    sendPrompt,
    setModel,
    uploadFile,
    clearChat,
    onAfterMessage,
  };
}
