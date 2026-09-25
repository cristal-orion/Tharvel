import type { Api, Model } from '@mariozechner/pi-ai';
import type { ModelRegistry } from '@mariozechner/pi-coding-agent';
import { getCustomModel } from './db/custom-models.js';
import { getDefaultModelKey, setDefaultModelKey } from './db/model-settings.js';
import { buildCodexModel } from './model-testing.js';

type Registry = Pick<ModelRegistry, 'find'>;
export type ModelChoice = { key: string; model: Model<Api> };

export function resolveModel(registry: Registry, key: unknown): ModelChoice | null {
  if (typeof key !== 'string') return null;
  const [provider, ...rest] = key.trim().split('/');
  const id = rest.join('/');
  if (!provider || !id) return null;
  const builtin = registry.find(provider, id);
  if (builtin) return { key: `${provider}/${id}`, model: builtin };
  const custom = provider === 'openai-codex' ? getCustomModel(provider, id) : null;
  if (!custom) return null;
  return { key: `${provider}/${id}`, model: buildCodexModel(registry, {
    modelId: custom.model_id, label: custom.label,
    contextWindow: custom.context_window, maxTokens: custom.max_tokens,
  }) };
}

export function getSessionModel(registry: Registry): ModelChoice {
  const configured = getDefaultModelKey();
  if (configured) {
    const choice = resolveModel(registry, configured);
    if (!choice) throw new Error(`Il modello predefinito ${configured} non è disponibile. Ripristinalo nelle impostazioni o scegli un altro modello: la scelta salvata non è stata modificata.`);
    return choice;
  }
  // Bootstrap only for installations where no admin has ever chosen a model.
  const initial = resolveModel(registry, 'openai-codex/gpt-5.6-sol')
    ?? resolveModel(registry, 'openai-codex/gpt-5.5');
  if (!initial) throw new Error('Nessun modello disponibile. Configura un modello nelle impostazioni.');
  return initial;
}

export interface ModelSession {
  readonly isStreaming: boolean;
  setModel(model: Model<Api>): Promise<void>;
}

// Used by both the picker and /model. Operations are ordered so a prompt cannot
// race a pending selection, and a rejected selection never becomes the default.
export function createModelSelection(registry: Registry, session: ModelSession, initial: ModelChoice) {
  let active = initial;
  let queue: Promise<unknown> = Promise.resolve();
  function ordered<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }
  async function apply(choice: ModelChoice) {
    if (session.isStreaming) throw new Error('Attendi la fine della richiesta prima di cambiare modello.');
    const previous = active;
    try {
      await session.setModel(choice.model);
    } catch (error) {
      // SDK extensions may reject after changing the in-memory model.
      try { await session.setModel(previous.model); } catch { /* retain original error */ }
      throw error;
    }
    active = choice;
    return previous;
  }
  return {
    get active() { return active; },
    change(role: string, key: unknown) {
      return ordered(async () => {
        if (role !== 'admin') throw new Error('Solo l’amministratore può cambiare il modello AI.');
        const choice = resolveModel(registry, key);
        if (!choice) throw new Error(`Modello non trovato: ${typeof key === 'string' ? key : 'id non valido'}`);
        const previous = await apply(choice);
        try { setDefaultModelKey(choice.key); }
        catch (error) {
          await apply(previous);
          throw error;
        }
        return choice;
      });
    },
    sync() {
      return ordered(async () => {
        const choice = getSessionModel(registry);
        if (choice.key !== active.key) await apply(choice);
        return active;
      });
    },
  };
}
