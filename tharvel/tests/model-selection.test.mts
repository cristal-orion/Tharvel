import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { Api, Model } from '@mariozechner/pi-ai';
import { getDb } from '../server/db/index.js';
import { getDefaultModelKey, setDefaultModelKey } from '../server/db/model-settings.js';
import { upsertCustomModel, deleteCustomModel } from '../server/db/custom-models.js';
import { createModelSelection, getSessionModel, resolveModel } from '../server/model-selection.js';

const OLD = 'openai-codex/gpt-5.5';
const CUSTOM = 'openai-codex/gpt-6-sol'; // Test fixture, not a production model setting.
const temp = mkdtempSync(join(tmpdir(), 'tharvel-model-test-'));
const dbPath = join(temp, 'test.db');
process.env.THARVEL_DB_PATH = dbPath;
const builtin: Model<Api> = {
  id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai-codex', api: 'openai-codex-responses',
  baseUrl: 'https://example.test', reasoning: true, input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000,
};
const registry = { find: (provider: string, id: string) => provider === builtin.provider && id === builtin.id ? builtin : undefined };
function fakeSession() {
  return {
    current: builtin, isStreaming: false, denied: '',
    async setModel(model: Model<Api>) {
      if (model.id === this.denied) throw new Error('Credenziali non disponibili');
      this.current = model;
    },
  };
}
const restartRead = () => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
  "import {getDefaultModelKey} from './db/model-settings.ts'; console.log('MODEL:' + getDefaultModelKey());"],
  { cwd: fileURLToPath(new URL('../server/', import.meta.url)), env: { ...process.env, THARVEL_DB_PATH: dbPath }, encoding: 'utf8' });

before(() => {
  // A legacy installation: choices differ per site, no global preference yet.
  const db = new Database(dbPath);
  db.exec(readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  const insert = db.prepare('INSERT INTO sites (slug, cwd_path, model, updated_at) VALUES (?, ?, ?, ?)');
  insert.run('older-site', 'unused', OLD, '2026-01-01 00:00:00');
  insert.run('recent-site', 'unused', CUSTOM, '2026-02-01 00:00:00');
  db.close();
  getDb();
  upsertCustomModel({ provider: 'openai-codex', model_id: 'gpt-6-sol', label: 'Custom Sol', context_window: 200000, max_tokens: 50000 });
});
after(() => { getDb().close(); rmSync(temp, { recursive: true, force: true }); });

test('migration recovers the most recent admin selection and never overwrites a global default', () => {
  assert.equal(getDefaultModelKey(), CUSTOM);
  assert.equal(getSessionModel(registry).key, CUSTOM);
  setDefaultModelKey(OLD);
  assert.match(restartRead(), /MODEL:openai-codex\/gpt-5\.5/);
});

test('admin choice persists across process restart and is used for new sessions on every site', async () => {
  setDefaultModelKey(OLD);
  const session = fakeSession();
  const selection = createModelSelection(registry, session, getSessionModel(registry));
  await selection.change('admin', CUSTOM);
  assert.equal(session.current.id, 'gpt-6-sol');
  assert.equal(getDefaultModelKey(), CUSTOM);
  assert.equal(getSessionModel(registry).key, CUSTOM);
  // The legacy old site's model remains stored but can no longer override the global selection.
  assert.equal((getDb().prepare('SELECT model FROM sites WHERE slug = ?').get('older-site') as any).model, OLD);
  assert.match(restartRead(), /MODEL:openai-codex\/gpt-6-sol/);
});

test('an already connected client adopts the new default before its next prompt', async () => {
  setDefaultModelKey(OLD);
  const clientAgent = fakeSession();
  const client = createModelSelection(registry, clientAgent, getSessionModel(registry));
  const admin = createModelSelection(registry, fakeSession(), getSessionModel(registry));
  await admin.change('admin', CUSTOM);
  assert.equal(clientAgent.current.id, 'gpt-5.5');
  await client.sync();
  assert.equal(clientAgent.current.id, 'gpt-6-sol');
});

test('clients cannot change the persistent default through either command path', async () => {
  setDefaultModelKey(OLD);
  const session = fakeSession();
  const selection = createModelSelection(registry, session, getSessionModel(registry));
  await assert.rejects(selection.change('client', CUSTOM), /amministratore/);
  assert.equal(getDefaultModelKey(), OLD);
  assert.equal(session.current.id, 'gpt-5.5');
});

test('invalid ids and unavailable credentials do not change the model or preference', async () => {
  setDefaultModelKey(OLD);
  const session = fakeSession();
  session.denied = 'gpt-6-sol';
  const selection = createModelSelection(registry, session, getSessionModel(registry));
  await assert.rejects(selection.change('admin', CUSTOM), /Credenziali/);
  await assert.rejects(selection.change('admin', 'openai-codex/nonexistent'), /non trovato/);
  await assert.rejects(selection.change('admin', { model: CUSTOM }), /non trovato/);
  assert.equal(getDefaultModelKey(), OLD);
  assert.equal(session.current.id, 'gpt-5.5');
  assert.equal(selection.active.key, OLD);
});

test('database write failure restores the session and keeps the last confirmed preference', async () => {
  setDefaultModelKey(OLD);
  const session = fakeSession();
  const selection = createModelSelection(registry, session, getSessionModel(registry));
  getDb().exec("CREATE TEMP TRIGGER reject_model_write BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
  try {
    await assert.rejects(selection.change('admin', CUSTOM), /test write failure/);
    assert.equal(session.current.id, 'gpt-5.5');
    assert.equal(getDefaultModelKey(), OLD);
  } finally { getDb().exec('DROP TRIGGER reject_model_write'); }
});

test('a saved but missing custom model never silently falls back to GPT-5.5', () => {
  setDefaultModelKey(CUSTOM);
  deleteCustomModel('openai-codex', 'gpt-6-sol');
  assert.throws(() => getSessionModel(registry), /predefinito.*non è disponibile/);
  assert.equal(getDefaultModelKey(), CUSTOM);
  upsertCustomModel({ provider: 'openai-codex', model_id: 'gpt-6-sol', label: 'Custom Sol' });
});

test('the fallback is used only before any admin preference exists', () => {
  getDb().prepare('DELETE FROM app_settings').run();
  assert.equal(getSessionModel(registry).key, OLD);
  setDefaultModelKey(CUSTOM);
  assert.equal(getSessionModel(registry).key, CUSTOM);
});

test('a running turn is not switched mid-stream', async () => {
  setDefaultModelKey(OLD);
  const session = fakeSession();
  const selection = createModelSelection(registry, session, getSessionModel(registry));
  session.isStreaming = true;
  await assert.rejects(selection.change('admin', CUSTOM), /fine della richiesta/);
  assert.equal(getDefaultModelKey(), OLD);
});

test('concurrent selections and prompt synchronization are ordered', async () => {
  setDefaultModelKey(OLD);
  const selection = createModelSelection(registry, fakeSession(), getSessionModel(registry));
  const first = selection.change('admin', CUSTOM);
  const second = selection.change('admin', OLD);
  const beforePrompt = selection.sync();
  await Promise.all([first, second]);
  assert.equal((await beforePrompt).key, OLD);
  assert.equal(getDefaultModelKey(), OLD);
});

test('custom model resolution preserves the exact provider/id and configured limits', () => {
  upsertCustomModel({ provider: 'openai-codex', model_id: 'gpt-6-sol', label: 'Custom Sol', context_window: 200000, max_tokens: 50000 });
  const chosen = resolveModel(registry, CUSTOM)!;
  assert.equal(chosen.key, CUSTOM);
  assert.equal(chosen.model.id, 'gpt-6-sol');
  assert.equal(chosen.model.contextWindow, 200000);
  assert.equal(chosen.model.maxTokens, 50000);
});
