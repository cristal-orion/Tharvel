// Log attività per sito: transcript della chat + comandi eseguiti dall'agente.
//
// Perché esiste, in breve: `site_revisions` registra solo i turni che producono
// un commit, e la session dell'SDK è `SessionManager.inMemory()`. Messe insieme,
// le due cose fanno sì che oggi non resti traccia di cosa il cliente ha chiesto
// quando il turno non ha cambiato file, è fallito, o era una domanda.
// Questo modulo colma il buco ed è la fonte del pannello attività admin.
//
// `site_commands` è la "modalità osservazione" del piano sicurezza: registra i
// comandi SENZA bloccarli, per ricavare dall'uso reale la whitelist da tenere
// quando il tool bash verrà sostituito con un terminale virtuale.

import { getDb } from './index.js';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: number;
  site_id: number;
  user_id: number | null;
  turn_id: string;
  role: ChatRole;
  content: string;
  had_error: number;
  created_at: string;
}

export interface CommandLog {
  id: number;
  site_id: number;
  turn_id: string | null;
  tool: string;
  command: string;
  is_error: number;
  created_at: string;
}

export function insertChatMessage(input: {
  site_id: number;
  user_id?: number | null;
  turn_id: string;
  role: ChatRole;
  content: string;
  had_error?: boolean;
}): void {
  getDb()
    .prepare(
      `INSERT INTO site_chat_messages (site_id, user_id, turn_id, role, content, had_error)
       VALUES (@site_id, @user_id, @turn_id, @role, @content, @had_error)`,
    )
    .run({
      site_id: input.site_id,
      user_id: input.user_id ?? null,
      turn_id: input.turn_id,
      role: input.role,
      content: input.content,
      had_error: input.had_error ? 1 : 0,
    });
}

export function insertCommandLog(input: {
  site_id: number;
  turn_id?: string | null;
  tool: string;
  command: string;
  is_error?: boolean;
}): void {
  getDb()
    .prepare(
      `INSERT INTO site_commands (site_id, turn_id, tool, command, is_error)
       VALUES (@site_id, @turn_id, @tool, @command, @is_error)`,
    )
    .run({
      site_id: input.site_id,
      turn_id: input.turn_id ?? null,
      tool: input.tool,
      command: input.command,
      is_error: input.is_error ? 1 : 0,
    });
}

export function listChatMessages(siteId: number, limit = 200): ChatMessage[] {
  return getDb()
    .prepare(
      `SELECT * FROM site_chat_messages
       WHERE site_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(siteId, limit) as ChatMessage[];
}

export function listCommandLogs(siteId: number, limit = 200): CommandLog[] {
  return getDb()
    .prepare(
      `SELECT * FROM site_commands
       WHERE site_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(siteId, limit) as CommandLog[];
}

// Riepilogo per la modalità osservazione: quante volte è stato usato ciascun
// comando. È questa la lista che diventerà la whitelist — va letta prima di
// attivare qualsiasi blocco.
export function summarizeCommands(siteId?: number): Array<{
  command: string;
  uses: number;
  errors: number;
  last_used: string;
}> {
  // Raggruppiamo sui primi due token (`npm run`, `git pull`, `ls`) invece che
  // sulla riga intera: la whitelist si ragiona a quel livello, e la riga intera
  // (con path e argomenti) produrrebbe centinaia di gruppi da uno.
  const where = siteId ? 'WHERE site_id = ?' : '';
  const params = siteId ? [siteId] : [];
  return getDb()
    .prepare(
      `SELECT
         TRIM(
           SUBSTR(command, 1, INSTR(command || ' ', ' ') - 1) || ' ' ||
           CASE
             WHEN INSTR(SUBSTR(command, INSTR(command || ' ', ' ') + 1) || ' ', ' ') > 1
               THEN SUBSTR(
                 SUBSTR(command, INSTR(command || ' ', ' ') + 1),
                 1,
                 INSTR(SUBSTR(command, INSTR(command || ' ', ' ') + 1) || ' ', ' ') - 1
               )
             ELSE ''
           END
         ) AS command,
         COUNT(*) AS uses,
         SUM(is_error) AS errors,
         MAX(created_at) AS last_used
       FROM site_commands
       ${where}
       GROUP BY command
       ORDER BY uses DESC`,
    )
    .all(...params) as Array<{ command: string; uses: number; errors: number; last_used: string }>;
}
