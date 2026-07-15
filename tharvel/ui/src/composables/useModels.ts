// Store condiviso dei modelli custom (aggiunti a mano dall'admin oltre ai
// built-in). Singleton a livello di modulo: sia SettingsModal (che li gestisce)
// sia ProviderPicker (che li mostra) leggono lo stesso ref reattivo, così un
// modello appena aggiunto compare subito nel picker.
import { ref } from 'vue';
import { apiUrl } from '../site';

export interface CustomModel {
  provider: string;
  id: string;
  label: string;
  contextWindow: number | null;
  maxTokens: number | null;
}

export interface ModelActionPayload {
  provider: string;
  modelId: string;
  label?: string;
  contextWindow?: number | null;
  maxTokens?: number | null;
}

export type ActionResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

const customModels = ref<CustomModel[]>([]);
let loaded = false;

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

export function useModels() {
  async function loadModels(force = false): Promise<void> {
    if (loaded && !force) return;
    try {
      const res = await fetch(apiUrl('/api/models'), { credentials: 'include' });
      if (res.ok) {
        const body = await readJson(res);
        customModels.value = Array.isArray(body.models) ? body.models : [];
        loaded = true;
      }
    } catch {
      /* offline / non loggato: lascia la lista com'è, riproveremo */
    }
  }

  function customFor(providerId: string): CustomModel[] {
    return customModels.value.filter((m) => m.provider === providerId);
  }

  // Test di connessione (non persiste). Ritorna { ok, sample? } | { ok:false, error }.
  async function testModel(
    payload: ModelActionPayload,
  ): Promise<{ ok: true; sample: string } | { ok: false; error: string }> {
    try {
      const res = await fetch(apiUrl('/api/admin/models/test'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (!res.ok) return { ok: false, error: body.error || `Errore ${res.status}` };
      if (body.ok) return { ok: true, sample: body.sample || '' };
      return { ok: false, error: body.error || 'Test fallito' };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Rete non raggiungibile' };
    }
  }

  async function addModel(payload: ModelActionPayload): Promise<ActionResult<CustomModel>> {
    try {
      const res = await fetch(apiUrl('/api/admin/models/custom'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (!res.ok) return { ok: false, error: body.error || `Errore ${res.status}` };
      const m = body.model as CustomModel;
      const idx = customModels.value.findIndex((x) => x.provider === m.provider && x.id === m.id);
      if (idx >= 0) customModels.value[idx] = m;
      else customModels.value.push(m);
      return { ok: true, data: m };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Rete non raggiungibile' };
    }
  }

  async function deleteModel(provider: string, id: string): Promise<ActionResult> {
    try {
      const res = await fetch(
        apiUrl(`/api/admin/models/custom/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`),
        { method: 'DELETE', credentials: 'include' },
      );
      if (res.ok) {
        customModels.value = customModels.value.filter((m) => !(m.provider === provider && m.id === id));
        return { ok: true };
      }
      const body = await readJson(res);
      return { ok: false, error: body.error || `Errore ${res.status}` };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Rete non raggiungibile' };
    }
  }

  return { customModels, loadModels, customFor, testModel, addModel, deleteModel };
}
