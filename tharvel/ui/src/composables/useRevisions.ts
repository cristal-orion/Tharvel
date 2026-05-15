import { ref, watch, computed, type Ref } from 'vue';
import { apiUrl } from '../site';

export interface Revision {
  id: number;
  commit_sha: string;
  parent_sha: string | null;
  user_prompt: string;
  summary: string | null;
  files_changed: string[];
  kind: 'turn' | 'publish';
  superseded: boolean;
  created_at: string;
}

// Fetcha lo storico per uno slug e ricalcola al variare del nonce (che il
// server bumpa via WS event `history_updated` dopo ogni auto-commit). I
// componenti che lo usano condividono il ref dell'istanza che hanno creato,
// quindi più di una chiamata = più di un fetch — accettabile per ora.
export function useRevisions(slug: Ref<string | null>, nonce: Ref<number>) {
  const revisions = ref<Revision[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchHistory() {
    if (!slug.value) {
      revisions.value = [];
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch(apiUrl(`/api/session/${slug.value}/history`), {
        credentials: 'include',
      });
      if (!res.ok) {
        error.value = `Errore ${res.status}`;
        revisions.value = [];
        return;
      }
      const body = await res.json();
      revisions.value = body.revisions;
    } catch (e: any) {
      error.value = e?.message ?? 'errore di rete';
    } finally {
      loading.value = false;
    }
  }

  // Modifiche pendenti = revisioni di tipo `turn` non superseded e successive
  // all'ultima `publish`. Il publish azzera il contatore.
  const pendingChanges = computed(() => {
    let count = 0;
    for (const r of revisions.value) {
      if (r.kind === 'publish') break; // revisions ordinate dal più recente
      if (r.kind === 'turn' && !r.superseded) count++;
    }
    return count;
  });

  // File toccati nelle modifiche pendenti (dedupe, per il dialog di conferma).
  const pendingFiles = computed(() => {
    const set = new Set<string>();
    for (const r of revisions.value) {
      if (r.kind === 'publish') break;
      if (r.kind === 'turn' && !r.superseded) {
        for (const f of r.files_changed) set.add(f);
      }
    }
    return Array.from(set);
  });

  watch(slug, fetchHistory, { immediate: true });
  watch(nonce, () => {
    if (nonce.value > 0) fetchHistory();
  });

  return {
    revisions,
    loading,
    error,
    pendingChanges,
    pendingFiles,
    fetchHistory,
  };
}
