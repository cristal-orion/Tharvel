// Costruzione di un Model Codex "custom" e test di connessione.
//
// Perché serve: il catalogo built-in di pi-coding-agent si ferma alla versione
// installata. Quando esce un modello nuovo, `ModelRuntime.getModel()` ritorna
// undefined e il modello è inselezionabile.
// Ma il transport OAuth di Codex (`openai-codex-responses`) inoltra semplicemente
// l'id del modello come stringa al backend ChatGPT: basta costruire un oggetto
// Model con quell'id (clonando la forma di un modello Codex già noto) e funziona.
//
// Il test di connessione risolve l'auth OAuth già salvata (stessa strada che usa
// una sessione reale) e fa una completion minima: se non lancia, il modello è
// valido e raggiungibile.

import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

// Modelli Codex noti da cui clonare la "forma" (cost/contextWindow/api/baseUrl,
// compat, limiti immagini). Ordine di preferenza: il primo presente nel catalogo
// vince. Pi 1.x ha tolto gpt-5.x ≤ 5.5 dal catalogo, quindi i primi sono i
// modelli attuali; se nessuno c'è (SDK cambia i built-in), si usa il fallback
// literale sotto.
const CODEX_TEMPLATE_IDS = ['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.5', 'gpt-5.4'];

// Fallback allineato alla forma dei modelli openai-codex di pi-ai.
const CODEX_FALLBACK: Omit<Model<Api>, 'id' | 'name'> = {
  api: 'openai-codex-responses' as Api,
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  contextWindow: 272000,
  maxTokens: 128000,
} as Omit<Model<Api>, 'id' | 'name'>;

export interface BuildCodexModelOpts {
  modelId: string;
  label?: string | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
}

// Clona il template Codex e sovrascrive id/name (+ limiti opzionali).
export function buildCodexModel(registry: Pick<ModelRuntime, 'getModel'>, opts: BuildCodexModelOpts): Model<Api> {
  let template: Model<Api> | undefined;
  for (const id of CODEX_TEMPLATE_IDS) {
    template = registry.getModel('openai-codex', id);
    if (template) break;
  }

  const base: Model<Api> = template
    ? { ...template }
    : ({ ...CODEX_FALLBACK, id: opts.modelId, name: opts.modelId } as Model<Api>);

  const model = {
    ...base,
    // Forza sempre provider/api/baseUrl del transport Codex, a prescindere dal template.
    provider: 'openai-codex',
    api: 'openai-codex-responses' as Api,
    baseUrl: (base as Model<Api>).baseUrl || 'https://chatgpt.com/backend-api',
    id: opts.modelId,
    name: opts.label?.trim() || opts.modelId,
  } as Model<Api>;

  if (opts.contextWindow != null) model.contextWindow = opts.contextWindow;
  if (opts.maxTokens != null) model.maxTokens = opts.maxTokens;

  return model;
}

function extractText(msg: AssistantMessage): string {
  try {
    return msg.content
      .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
      .map((c) => c.text)
      .join('')
      .trim()
      .slice(0, 200);
  } catch {
    return '';
  }
}

// Forma singola (niente discriminated union): il tsconfig ha strict:false e il
// narrowing su `ok` non è affidabile lato consumer.
export interface TestResult {
  ok: boolean;
  sample?: string;
  error?: string;
}

// Fa un ping con le credenziali salvate: il runtime risolve l'auth del provider
// (OAuth con refresh automatico, o API key) come in una sessione vera. Non
// lancia: ritorna sempre { ok, ... } per un feedback pulito in UI.
export async function testModelConnection(
  runtime: ModelRuntime,
  model: Model<Api>,
  timeoutMs = 30000,
): Promise<TestResult> {
  if (!runtime.hasConfiguredAuth(model.provider)) {
    return { ok: false, error: `nessuna credenziale trovata per "${model.provider}" — fai il login` };
  }
  try {
    const result = await runtime.complete(
      model,
      { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] },
      { maxTokens: 64, signal: AbortSignal.timeout(timeoutMs) },
    );
    return { ok: true, sample: extractText(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
