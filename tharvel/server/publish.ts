// Pipeline publish per un sito Tharvel: stage tutto, commit con messaggio
// generato dall'agente (passato come argomento del tool), push autenticato via
// GitHub App installation token.
//
// Branch: usa il branch CORRENTE del checkout. Non facciamo strategy preview/main
// per il MVP — il doc §6.4.1 prevede branch `preview` ma non è implementato
// ancora; finché non lo è, push diretto sul branch attivo (per Industrial: master).

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Site } from './db/sites.js';
import { getInstallationToken, authenticatedRepoUrl } from './github-app.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function resolveSiteCwd(site: Site, sitesRoot: string): string {
  return path.isAbsolute(site.cwd_path) ? site.cwd_path : path.join(sitesRoot, site.cwd_path);
}

export interface PublishResult {
  ok: boolean;
  message: string;
  commitSha?: string;
  pushed: boolean;
}

// Esegue il publish per il sito. Sicurezza: il caller (custom tool nell'agente)
// passa già lo `site` risolto dal contesto sessione, quindi non c'è rischio
// cross-tenant. Il commit message è autoritativo (lo decide l'agente che ha
// letto le modifiche), il timestamp viene aggiunto.
export async function publishSite(
  site: Site,
  sitesRoot: string,
  commitMessage: string,
): Promise<PublishResult> {
  if (!site.repo_url) {
    return { ok: false, message: `Sito '${site.slug}' non ha repo_url configurato.`, pushed: false };
  }
  const cwd = resolveSiteCwd(site, sitesRoot);

  // 1) Stage tutto.
  const addRes = await run('git', ['add', '-A'], { cwd });
  if (addRes.code !== 0) {
    return { ok: false, message: `git add fallito: ${addRes.stderr.trim()}`, pushed: false };
  }

  // 2) Verifica se c'è qualcosa da committare (status --porcelain vuoto → niente).
  const statusRes = await run('git', ['status', '--porcelain'], { cwd });
  if (statusRes.stdout.trim().length === 0) {
    return {
      ok: true,
      message: 'Nessuna modifica da pubblicare (working tree pulito).',
      pushed: false,
    };
  }

  // 3) Commit.
  const cleanMsg = commitMessage.trim() || 'Tharvel publish';
  const commitRes = await run('git', ['commit', '-m', cleanMsg], { cwd });
  if (commitRes.code !== 0) {
    return { ok: false, message: `git commit fallito: ${commitRes.stderr.trim()}`, pushed: false };
  }
  const shaRes = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd });
  const commitSha = shaRes.stdout.trim();

  // 4) Push: token fresco, URL temporaneo come argomento (non lo salviamo in
  //    .git/config per evitare token persistente dopo che è scaduto).
  const token = await getInstallationToken();
  const pushUrl = authenticatedRepoUrl(site.repo_url, token);
  // HEAD push: spinge il branch corrente sulla sua upstream (es. master → master).
  const pushRes = await run('git', ['push', pushUrl, 'HEAD'], { cwd });
  if (pushRes.code !== 0) {
    // Importante: NON logghiamo pushUrl perché contiene il token.
    const sanitized = pushRes.stderr.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
    return {
      ok: false,
      message: `git push fallito (commit locale ${commitSha} OK): ${sanitized.trim()}`,
      commitSha,
      pushed: false,
    };
  }

  return {
    ok: true,
    message: `Pubblicato. Commit ${commitSha} pushato. Coolify avvierà il deploy del sito a breve.`,
    commitSha,
    pushed: true,
  };
}
