// Pipeline publish per un sito Tharvel.
//
// Modello: l'agente lavora sempre su branch `preview`. Al publish:
//   1. ensurePreviewBranch (paranoia)
//   2. eventuale commit del working tree dirty (se l'auto-commit non ha girato)
//   3. checkout <upstream>  (main / master)
//   4. git merge --squash preview
//   5. git commit -m <commitMessage>
//   6. git push origin <upstream>
//   7. checkout preview, reset --hard <upstream>  → preview riallineato
//   8. markTurnsAsSuperseded(site.id) → le revisioni storiche restano in DB
//      come archivio "pubblicato il X", ma non più ripristinabili

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Site } from './db/sites.js';
import { getInstallationToken, authenticatedRepoUrl } from './github-app.js';
import { ensurePreviewBranch, getBranchInfo } from './preview-branch.js';
import { insertRevision, markTurnsAsSuperseded } from './db/revisions.js';

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

export async function publishSite(
  site: Site,
  sitesRoot: string,
  commitMessage: string,
): Promise<PublishResult> {
  if (!site.repo_url) {
    return { ok: false, message: `Sito '${site.slug}' non ha repo_url configurato.`, pushed: false };
  }
  const cwd = resolveSiteCwd(site, sitesRoot);

  // 1) Assicura branch preview (idempotente).
  const ensureRes = await ensurePreviewBranch(cwd);
  if (!ensureRes.ok) {
    return { ok: false, message: `Setup branch preview fallito: ${ensureRes.message}`, pushed: false };
  }
  const info = await getBranchInfo(cwd);
  const upstream = info.upstreamBranch; // main / master

  // 2) Eventuale commit working tree dirty su preview (se auto-commit non ha
  //    girato o l'utente ha modificato file manualmente da CLI).
  await run('git', ['add', '-A'], { cwd });
  const dirty = (await run('git', ['status', '--porcelain'], { cwd })).stdout.trim().length > 0;
  if (dirty) {
    const fallback = commitMessage.trim() || 'Tharvel publish';
    const commitRes = await run('git', ['commit', '-m', fallback], { cwd });
    if (commitRes.code !== 0) {
      return { ok: false, message: `git commit (preview) fallito: ${commitRes.stderr.trim()}`, pushed: false };
    }
  }

  // 3) Niente da pubblicare? Confronto preview vs upstream remoto.
  // Strategia: vediamo se preview e origin/<upstream> divergono.
  await run('git', ['fetch', 'origin', upstream], { cwd });
  const diffRes = await run(
    'git',
    ['rev-list', '--count', `origin/${upstream}..preview`],
    { cwd },
  );
  const aheadCount = diffRes.code === 0 ? parseInt(diffRes.stdout.trim(), 10) || 0 : 0;
  if (aheadCount === 0) {
    return {
      ok: true,
      message: 'Nessuna modifica da pubblicare (preview allineato al remoto).',
      pushed: false,
    };
  }

  // 4) Checkout upstream + fast-forward a origin (così squash parte da base aggiornata).
  const coUp = await run('git', ['checkout', upstream], { cwd });
  if (coUp.code !== 0) {
    return { ok: false, message: `checkout ${upstream} fallito: ${coUp.stderr.trim()}`, pushed: false };
  }
  // Fast-forward upstream locale a origin (resetta drift locale se presente,
  // ma manteniamo soft-error perché il push poi può fallire per non-ff).
  await run('git', ['reset', '--hard', `origin/${upstream}`], { cwd });

  // 5) Squash merge da preview.
  const squashRes = await run('git', ['merge', '--squash', 'preview'], { cwd });
  if (squashRes.code !== 0) {
    // Torna su preview per non lasciare l'utente in stato strano.
    await run('git', ['checkout', 'preview'], { cwd });
    return {
      ok: false,
      message: `git merge --squash fallito (probabile conflitto con ${upstream}): ${squashRes.stderr.trim()}`,
      pushed: false,
    };
  }

  // 6) Commit dello squash. `merge --squash` lascia tutto staged senza creare
  //    commit, quindi serve git commit esplicito.
  const cleanMsg = commitMessage.trim() || 'Tharvel publish';
  const commitRes = await run('git', ['commit', '-m', cleanMsg], { cwd });
  if (commitRes.code !== 0) {
    // Nessun cambio? (caso teorico: preview era già allineato pur con ahead != 0)
    if (/nothing to commit/i.test(commitRes.stdout + commitRes.stderr)) {
      await run('git', ['checkout', 'preview'], { cwd });
      return {
        ok: true,
        message: 'Nessuna modifica effettiva da pubblicare.',
        pushed: false,
      };
    }
    return { ok: false, message: `git commit (squash) fallito: ${commitRes.stderr.trim()}`, pushed: false };
  }
  const shaRes = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd });
  const commitSha = shaRes.stdout.trim();
  const fullShaRes = await run('git', ['rev-parse', 'HEAD'], { cwd });
  const fullSha = fullShaRes.stdout.trim();

  // 7) Push autenticato.
  const token = await getInstallationToken();
  const pushUrl = authenticatedRepoUrl(site.repo_url, token);
  const pushRes = await run('git', ['push', pushUrl, `HEAD:${upstream}`], { cwd });
  if (pushRes.code !== 0) {
    const sanitized = pushRes.stderr.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
    // Lascia il commit locale su upstream così il prossimo Pubblica può ritentare.
    await run('git', ['checkout', 'preview'], { cwd });
    return {
      ok: false,
      message: `git push fallito (commit ${commitSha} su ${upstream} locale OK): ${sanitized.trim()}`,
      commitSha,
      pushed: false,
    };
  }

  // 8) Torna su preview e riallinea al nuovo upstream (storia preview azzerata,
  //    ripartiamo puliti per i prossimi turn).
  await run('git', ['checkout', 'preview'], { cwd });
  await run('git', ['reset', '--hard', upstream], { cwd });

  // 9) Marca le revisioni 'turn' del sito come archiviate + INSERT riga 'publish'
  //    come marker nella history.
  markTurnsAsSuperseded(site.id);
  try {
    insertRevision({
      site_id: site.id,
      commit_sha: fullSha,
      parent_sha: null,
      user_prompt: '[pubblicazione]',
      summary: cleanMsg,
      files_changed: [],
      kind: 'publish',
    });
  } catch (e) {
    // Non-blocking: il push è già fatto, una riga di history mancante non rompe nulla.
    console.warn(`[publish] insertRevision(publish) fallito:`, e);
  }

  return {
    ok: true,
    message: `Pubblicato. Commit ${commitSha} su ${upstream}. Coolify avvierà il deploy del sito a breve.`,
    commitSha,
    pushed: true,
  };
}
