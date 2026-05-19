import { ref, reactive, onMounted, onUnmounted, watch, type Ref } from 'vue';
import { buildWsUrl } from '../site';

export type Role = 'user' | 'ai' | 'system';
export interface ChatAttachment {
  name: string;
  dataUrl: string;
}
export interface ChatMessage {
  role: Role;
  content: string;
  attachments?: ChatAttachment[];
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
  isImage?: boolean;
}
export interface PendingImage {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  dataBase64: string;
}

export function useTharvelSession(slug: Ref<string | null>) {
  const isConnected = ref(false);
  const isProcessing = ref(false);
  const messages = ref<ChatMessage[]>([
    { role: 'system', content: 'Pronto. Scrivi, trascina uno screenshot in chat o un asset sulla preview.' },
  ]);
  const projectFiles = ref<ProjectFile[]>([]);
  const selectedFiles = ref<string[]>([]);
  const selectedElement = ref<SelectedElement | null>(null);
  const selectedModel = ref('openai-codex/gpt-5.5');
  // Immagini allegate al prossimo prompt: vivono solo lato client finché l'utente
  // non clicca "invia" — non vengono salvate come asset del sito, ma passate inline
  // all'LLM come ImageContent. Caso d'uso tipico: screenshot di riferimento.
  const pendingImages = ref<PendingImage[]>([]);
  const iframeNonce = ref(0);
  // Bumpa quando il server segnala che una nuova revisione è stata committata
  // (event `history_updated`, emesso dopo che l'auto-commit a fine turn riesce).
  // Il pannello Storico osserva questo contatore per fare refetch.
  const historyNonce = ref(0);

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
      case 'history_updated':
        historyNonce.value = Date.now();
        break;
      case 'error':
        isProcessing.value = false;
        messages.value.push({ role: 'system', content: `✕ ${data.message}` });
        break;
    }
    scrollHooks.forEach((fn) => fn());
  };

  // reconnectTimer ci permette di cancellare un retry pendente quando lo slug cambia
  // (admin che switcha sito dalla sidebar): senza questo guard avremmo due ws aperti
  // contemporaneamente e race su isConnected.
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldReconnect = true;

  const disconnect = () => {
    shouldReconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    isConnected.value = false;
  };

  const connect = () => {
    if (!slug.value) return; // nessuno slug attivo (es. admin senza sito selezionato)
    shouldReconnect = true;
    ws = new WebSocket(buildWsUrl(slug.value));
    ws.onopen = () => { isConnected.value = true; };
    ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
    ws.onclose = () => {
      isConnected.value = false;
      if (shouldReconnect) reconnectTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => { /* swallow; close will retry */ };
  };

  // Riconnessione su cambio slug (per admin che switcha sito).
  watch(slug, (next, prev) => {
    if (next === prev) return;
    disconnect();
    if (next) connect();
  });

  const sendPrompt = (text: string) => {
    if (isProcessing.value) return;
    const hasImages = pendingImages.value.length > 0;
    if (!text.trim() && !hasImages) return;

    const attachments = pendingImages.value.map((p) => ({ name: p.name, dataUrl: p.dataUrl }));
    messages.value.push({
      role: 'user',
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    let final = text;
    if (selectedFiles.value.length > 0) {
      final += `\n\n[file selezionati: ${selectedFiles.value.join(', ')}]`;
    }
    if (selectedElement.value) {
      const el = selectedElement.value;
      final += `\n\n[elemento puntato — tag: ${el.tag}; id: ${el.id || '-'}; classi: ${el.classes || '-'}; testo: "${el.text}"; xpath: ${el.xpath}]`;
    }
    const imagesForServer = pendingImages.value.map((p) => ({
      fileBase64: p.dataBase64,
      mimeType: p.mimeType,
    }));
    send({
      type: 'prompt',
      content: final,
      images: imagesForServer.length > 0 ? imagesForServer : undefined,
    });
    pendingImages.value = [];
    isProcessing.value = true;
    currentAi = '';
    scrollHooks.forEach((fn) => fn());
  };

  // Allegato effimero alla chat: il file vive in memoria finché l'utente non manda
  // il prompt successivo. Non tocca il filesystem del sito → non finisce in `Assets`.
  const addPendingImage = (file: File): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) {
        messages.value.push({
          role: 'system',
          content: `✕ Solo immagini: "${file.name}" è di tipo ${file.type || 'sconosciuto'}.`,
        });
        resolve();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const dataBase64 = dataUrl.split(',')[1] || '';
        pendingImages.value.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          mimeType: file.type,
          dataUrl,
          dataBase64,
        });
        resolve();
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  };

  const removePendingImage = (id: string) => {
    pendingImages.value = pendingImages.value.filter((p) => p.id !== id);
  };

  const setModel = (model: string) => {
    selectedModel.value = model;
    send({ type: 'set_model', model });
  };

  // Upload "definitivo" come asset del sito: passa per il server che salva (e
  // comprime per le immagini) il file in assets/ (html) o public/ (astro). Da usare
  // per loghi, immagini di sezione, ecc. Per screenshot effimeri usa addPendingImage.
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

  // Forza un nuovo tentativo immediato di WS (utile per il bottone "Riprova"
  // nel pannello chat offline). Differente dal retry automatico ogni 3s che
  // continua comunque in background.
  const reconnect = () => {
    disconnect();
    if (slug.value) connect();
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
    disconnect();
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
    historyNonce,
    auth,
    pendingImages,
    sendPrompt,
    setModel,
    uploadFile,
    addPendingImage,
    removePendingImage,
    clearChat,
    reconnect,
    reloadIframe,
    onAfterMessage,
  };
}
