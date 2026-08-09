// Ripristino di un sito a una pubblicazione precedente (admin).
//
// Perché non riusa il restore delle revisioni: quello lavora sul branch `preview`
// e i suoi commit spariscono al publish (squash), infatti le revisioni 'turn'
// vengono marcate `superseded`. Qui il target è invece un commit su `main`, cioè
// una riga `site_revisions` con kind='publish'.
//
// Strategia: NON force-push. Creiamo un commit NUOVO in cima a upstream il cui
// contenuto è identico a quello del publish scelto:
//
//   git read-tree -u --reset <targetSha>   → index + working tree = albero del target
//   git commit                             → commit con parent = tip di upstream
//   git push origin <upstream>             → fast-forward normale
//
// Vantaggi rispetto a `reset --hard` + force push:
//  - la storia del repo del cliente non viene riscritta (è il SUO repo);
//  - Coolify vede un push normale e ridispiega come sempre;
//  - il ripristino è a sua volta annullabile, perché resta nella storia.

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Site } from './db/sites.js';
import { getInstallationToken, authenticatedRepoUrl } from './github-app.js';
import { getBranchInfo } from './preview-branch.js';
import { insertRevision } from './db/revisions.js';

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

function resolveSiteCwd(site: Site, sitesRoot: string): string {
  return path.isAbsolute(site.cwd_path) ? site.cwd_path : path.join(sitesRoot, site.cwd_path);
}

export interface RollbackResult {
  ok: boolean;
  message: string;
  commitSha?: string;
  pushed: boolean;
}

export async function rollbackToPublish(
  site: Site,
  sitesRoot: string,
  targetSha: string,
  label: string,
): Promise<RollbackResult> {
  if (!site.repo_url) {
    return { ok: false, message: `Sito '${site.slug}' non ha repo_url configurato.`, pushed: false };
  }
  const cwd = resolveSiteCwd(site, sitesRoot);
  const info = await getBranchInfo(cwd);
  const upstream = info.upstreamBranch;

  // 1) Il commit target deve esistere davvero in locale. Se il repo è stato
  //    ri-clonato o il publish è antecedente al clone, lo sha in DB è stale.
  const exists = await run('git', ['cat-file', '-e', `${targetSha}^{commit}`], cwd);
  if (exists.code !== 0) {
    return {
      ok: false,
      message: `Il commit ${targetSha.slice(0, 8)} non esiste in questo clone: impossibile ripristinarlo.`,
      pushed: false,
    };
  }

  // 2) Partiamo da upstream allineato al remoto, altrimenti il push fallirebbe
  //    per non-fast-forward.
  const fetchRes = await run('git', ['fetch', 'origin', upstream], cwd);
  if (fetchRes.code !== 0) {
    return { ok: false, message: `git fetch fallito: ${fetchRes.stderr.trim()}`, pushed: false };
  }
  const coUp = await run('git', ['checkout', upstream], cwd);
  if (coUp.code !== 0) {
    return { ok: false, message: `checkout ${upstream} fallito: ${coUp.stderr.trim()}`, pushed: false };
  }
  await run('git', ['reset', '--hard', `origin/${upstream}`], cwd);

  // 3) Se il target è già il tip, non c'è niente da ripristinare.
  const tipRes = await run('git', ['rev-parse', 'HEAD'], cwd);
  if (tipRes.stdout.trim() === targetSha) {
    await run('git', ['checkout', 'preview'], cwd);
    return { ok: true, message: 'Il sito è già a questa pubblicazione.', pushed: false };
  }

  // 4) Porta index + working tree all'albero del target, lasciando HEAD dov'è.
  const readTree = await run('git', ['read-tree', '-u', '--reset', targetSha], cwd);
  if (readTree.code !== 0) {
    await run('git', ['checkout', 'preview'], cwd);
    return { ok: false, message: `git read-tree fallito: ${readTree.stderr.trim()}`, pushed: false };
  }

  const msg = `Ripristino alla pubblicazione ${targetSha.slice(0, 8)}${label ? ` — ${label}` : ''}`;
  const commitRes = await run('git', ['commit', '-m', msg], cwd);
  if (commitRes.code !== 0) {
    if (/nothing to commit/i.test(commitRes.stdout + commitRes.stderr)) {
      await run('git', ['checkout', 'preview'], cwd);
      return {
        ok: true,
        message: 'Il contenuto online è già identico a quella pubblicazione.',
        pushed: false,
      };
    }
    await run('git', ['reset', '--hard', `origin/${upstream}`], cwd);
    await run('git', ['checkout', 'preview'], cwd);
    return { ok: false, message: `git commit fallito: ${commitRes.stderr.trim()}`, pushed: false };
  }

  const fullSha = (await run('git', ['rev-parse', 'HEAD'], cwd)).stdout.trim();
  const shortSha = fullSha.slice(0, 7);

  // 5) Push autenticato, identico al publish.
  const token = await getInstallationToken();
  const pushUrl = authenticatedRepoUrl(site.repo_url, token);
  const pushRes = await run('git', ['push', pushUrl, `HEAD:${upstream}`], cwd);
  if (pushRes.code !== 0) {
    const sanitized = pushRes.stderr.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
    await run('git', ['checkout', 'preview'], cwd);
    return {
      ok: false,
      message: `git push fallito (commit ${shortSha} su ${upstream} locale OK): ${sanitized.trim()}`,
      commitSha: shortSha,
      pushed: false,
    };
  }

  // 6) Riallinea preview al nuovo upstream: l'agente deve ripartire da ciò che
  //    è online adesso, non dallo stato che abbiamo appena annullato.
  await run('git', ['checkout', 'preview'], cwd);
  await run('git', ['reset', '--hard', upstream], cwd);

  // 7) Il ripristino è a sua volta una pubblicazione: va nella history come tale,
  //    così è annullabile allo stesso modo.
  try {
    insertRevision({
      site_id: site.id,
      commit_sha: fullSha,
      parent_sha: null,
      user_prompt: '[ripristino]',
      summary: msg,
      files_changed: [],
      kind: 'publish',
    });
  } catch (e) {
    console.warn(`[rollback] insertRevision fallito:`, e);
  }

  return {
    ok: true,
    message: `Sito ripristinato alla pubblicazione ${targetSha.slice(0, 8)}. Commit ${shortSha} su ${upstream}, Coolify ridispiega a breve.`,
    commitSha: shortSha,
    pushed: true,
  };
}
