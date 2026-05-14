// Auto-commit per turn dell'agente Tharvel (vedi §6.4.1 progetto-tharvel.md).
//
// Triggerato da `agent_end` dentro il WS handler. Criterio di commit:
// working tree dirty (l'agente ha davvero toccato file utente).
//
// NB: avevamo provato anche un criterio "nessun tool_execution_end con isError",
// ma in pratica gli agenti esplorano con bash (`ls path-inesistente`) e fanno
// fallire comandi senza che sia un vero fallimento del turno — finchè il file
// finale è stato editato e l'utente lo vede in preview, vogliamo committarlo
// in modo da poter offrire Annulla/Ripristina. Il `dirty-check` è il singolo
// criterio di verità: niente modifiche → niente revisione.
//
// Se il check passa: stage + commit su branch `preview` con template
// "<Verbo> <prompt 60 char>" + INSERT in tabella site_revisions.

import { spawn } from 'node:child_process';
import type { Site } from './db/sites.js';
import { insertRevision } from './db/revisions.js';
import { ensurePreviewBranch } from './preview-branch.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// Costruisce messaggio dal prompt utente, senza chiamata LLM extra.
// "cambia il titolo" → "Cambia il titolo della home..." (tronca a 60 char).
export function buildCommitMessage(userPrompt: string): string {
  const trimmed = userPrompt.trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'Modifica';
  const firstWord = trimmed.split(' ')[0];
  const rest = trimmed.slice(firstWord.length).trim();
  const verb = firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
  const tail = rest ? ` ${rest}` : '';
  const full = (verb + tail).slice(0, 72);
  return full.length < (verb + tail).length ? full.replace(/\s+\S*$/, '') + '…' : full;
}

export interface AutoCommitResult {
  committed: boolean;
  reason: string;
  commitSha?: string;
  parentSha?: string | null;
  filesChanged?: string[];
}

export interface AutoCommitContext {
  site: Site;
  sitePath: string;
  userPrompt: string;
  // Conservato solo per logging diagnostico: NON blocca più il commit (vedi
  // commento in cima al file).
  turnHadError: boolean;
}

export async function autoCommitTurn(ctx: AutoCommitContext): Promise<AutoCommitResult> {
  if (!ctx.userPrompt.trim()) {
    return { committed: false, reason: 'no user prompt to derive message from' };
  }
  if (ctx.turnHadError) {
    console.log(`[AUTO-COMMIT] '${ctx.site.slug}': turn aveva errori tool, committo lo stesso se dirty`);
  }

  // Non è un repo git → skip silenzioso (es. sito 'demo' senza .git).
  const isRepo = await run('git', ['rev-parse', '--is-inside-work-tree'], ctx.sitePath);
  if (isRepo.code !== 0) {
    return { committed: false, reason: 'not a git repo' };
  }

  const branchRes = await ensurePreviewBranch(ctx.sitePath);
  if (!branchRes.ok) {
    return { committed: false, reason: `ensurePreviewBranch failed: ${branchRes.message}` };
  }

  // C'è davvero qualcosa di nuovo?
  const statusRes = await run('git', ['status', '--porcelain'], ctx.sitePath);
  if (statusRes.stdout.trim().length === 0) {
    return { committed: false, reason: 'working tree clean' };
  }

  // Identità autore: usa env GIT_AUTHOR_NAME/EMAIL già settate nel Dockerfile.
  await run('git', ['add', '-A'], ctx.sitePath);

  // Cattura parent prima del commit.
  const parentRes = await run('git', ['rev-parse', 'HEAD'], ctx.sitePath);
  const parentSha = parentRes.code === 0 ? parentRes.stdout.trim() : null;

  const message = buildCommitMessage(ctx.userPrompt);
  const fullMessage = `${message}\n\nTharvel auto-commit (turn).`;
  const commitRes = await run('git', ['commit', '-m', fullMessage], ctx.sitePath);
  if (commitRes.code !== 0) {
    return { committed: false, reason: `git commit failed: ${commitRes.stderr.trim()}` };
  }

  const shaRes = await run('git', ['rev-parse', 'HEAD'], ctx.sitePath);
  const commitSha = shaRes.stdout.trim();

  // File modificati rispetto al parent (per popolare la lista in UI).
  let filesChanged: string[] = [];
  if (parentSha) {
    const diffRes = await run('git', ['diff', '--name-only', parentSha, commitSha], ctx.sitePath);
    if (diffRes.code === 0) {
      filesChanged = diffRes.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }

  insertRevision({
    site_id: ctx.site.id,
    commit_sha: commitSha,
    parent_sha: parentSha,
    user_prompt: ctx.userPrompt,
    summary: message,
    files_changed: filesChanged,
    kind: 'turn',
  });

  return {
    committed: true,
    reason: 'ok',
    commitSha,
    parentSha,
    filesChanged,
  };
}
