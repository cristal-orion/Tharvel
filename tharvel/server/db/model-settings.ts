import { getDb } from './index.js';

export function getDefaultModelKey(): string | null {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = 'default_model'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

// Call only after resolving the model and checking the provider credentials.
export function setDefaultModelKey(model: string): void {
  getDb().prepare(`
    INSERT INTO app_settings (key, value) VALUES ('default_model', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(model);
}
