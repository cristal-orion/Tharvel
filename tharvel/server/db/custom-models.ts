import { getDb } from './index.js';

// Modelli aggiunti a mano dall'admin oltre ai built-in dell'SDK.
// Scope globale (subscription condivisa). Vedi schema.sql per il razionale.
export interface CustomModel {
  id: number;
  provider: string;
  model_id: string;
  label: string;
  context_window: number | null;
  max_tokens: number | null;
  created_at: string;
}

export interface NewCustomModel {
  provider: string;
  model_id: string;
  label: string;
  context_window?: number | null;
  max_tokens?: number | null;
}

export function listCustomModels(): CustomModel[] {
  return getDb()
    .prepare('SELECT * FROM custom_models ORDER BY provider ASC, model_id ASC')
    .all() as CustomModel[];
}

export function listCustomModelsByProvider(provider: string): CustomModel[] {
  return getDb()
    .prepare('SELECT * FROM custom_models WHERE provider = ? ORDER BY model_id ASC')
    .all(provider) as CustomModel[];
}

export function getCustomModel(provider: string, modelId: string): CustomModel | null {
  return (
    (getDb()
      .prepare('SELECT * FROM custom_models WHERE provider = ? AND model_id = ?')
      .get(provider, modelId) as CustomModel | undefined) ?? null
  );
}

// Upsert per (provider, model_id): ri-salvare lo stesso id aggiorna label/limiti
// invece di fallire sul vincolo UNIQUE.
export function upsertCustomModel(input: NewCustomModel): CustomModel {
  const stmt = getDb().prepare(`
    INSERT INTO custom_models (provider, model_id, label, context_window, max_tokens)
    VALUES (@provider, @model_id, @label, @context_window, @max_tokens)
    ON CONFLICT(provider, model_id) DO UPDATE SET
      label = excluded.label,
      context_window = excluded.context_window,
      max_tokens = excluded.max_tokens
    RETURNING *
  `);
  return stmt.get({
    provider: input.provider,
    model_id: input.model_id,
    label: input.label,
    context_window: input.context_window ?? null,
    max_tokens: input.max_tokens ?? null,
  }) as CustomModel;
}

export function deleteCustomModel(provider: string, modelId: string): boolean {
  const info = getDb()
    .prepare('DELETE FROM custom_models WHERE provider = ? AND model_id = ?')
    .run(provider, modelId);
  return info.changes > 0;
}
