// Allineamento del branch `preview` con il repo GitHub del cliente.
//
// Il sito può cambiare anche fuori da Tharvel (push da locale, edit da GitHub,
// altri tool). Senza questo passaggio l'agente lavora su file vecchi e il drift
// emerge solo al publish, come push rifiutato o conflitto. Viene chiamato
// all'apertura di ogni sessione WS, prima di costruire la scheda contesto, così
// agente e anteprima partono dall'ultima versione online.
//
// Strategia (mai distruttiva per il lavoro non pubblicato):
//   - preview non ha modifiche proprie → fast-forward a origin/<upstream>
//   - preview ha turn non pubblicati    → merge di origin/<upstream> in preview;
//     se va in conflitto si annulla tutto e si avvisa l'utente
//   - working tree sporco               → non si tocca nulla

import { spawn } from 'node:child_process';
import type { Site } from './db/sites.js';
import { getInstallationToken, authenticatedRepoUrl } from './github-app.js';
import { ensurePreviewBranch, getBranchInfo } from './preview-branch.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 0): Promise<RunResult> {
  return new Promise((resolve) => {
    // GIT_TERMINAL_PROMPT=0: con credenziali rifiutate git non deve restare
    // appeso ad aspettare una password che nessuno digiterà.
    const child = spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          stderr += `\ntimeout dopo ${timeoutMs}ms`;
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const sanitize = (s: string) => s.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@').trim();

// Aggiorna `origin/<upstream>` con un token GitHub App fresco. Il remote `origin`
// del clone contiene il token usato all'onboarding, che scade dopo un'ora: un
// `git fetch origin` nudo fallisce e lascia origin/<upstream> fermo al clone.
// L'URL autenticato è passato solo da riga di comando, non finisce in .git/config.
export async function fetchUpstream(
  site: Site,
  cwd: string,
  upstream: string,
): Promise<{ ok: boolean; message: string }> {
  if (!site.repo_url) return { ok: false, message: `Sito '${site.slug}' non ha repo_url configurato.` };
  let url: string;
  try {
    url = authenticatedRepoUrl(site.repo_url, await getInstallationToken());
  } catch (e: any) {
    return { ok: false, message: `token GitHub non disponibile: ${e?.message ?? e}` };
  }
  const res = await run(
    'git',
    ['fetch', '--no-tags', url, `+refs/heads/${upstream}:refs/remotes/origin/${upstream}`],
    cwd,
    30_000,
  );
  if (res.code !== 0) return { ok: false, message: `git fetch fallito: ${sanitize(res.stderr)}` };
  return { ok: true, message: 'ok' };
}

export type SyncOutcome =
  | 'up-to-date' // niente di nuovo su GitHub
  | 'updated' //    preview allineato
  | 'blocked' //    novità su GitHub ma allineamento impossibile (conflitto, tree sporco)
  | 'failed' //     impossibile verificare (rete, token, repo)
  | 'skipped'; //   sito senza repo / non git

export interface SyncResult {
  outcome: SyncOutcome;
  message: string;
  upstream?: string;
  // Commit arrivati da GitHub che preview non aveva.
  incoming?: number;
  filesChanged?: string[];
  // package.json/lock cambiati → serve `npm install` prima del build.
  depsChanged?: boolean;
}

async function count(cwd: string, range: string): Promise<number> {
  const res = await run('git', ['rev-list', '--count', range], cwd);
  return res.code === 0 ? parseInt(res.stdout.trim(), 10) || 0 : 0;
}

async function doSync(site: Site, cwd: string): Promise<SyncResult> {
  if (!site.repo_url) return { outcome: 'skipped', message: 'nessun repo_url' };
  const isRepo = await run('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  if (isRepo.code !== 0) return { outcome: 'skipped', message: 'non è un repo git' };

  const ensure = await ensurePreviewBranch(cwd);
  if (!ensure.ok) return { outcome: 'failed', message: ensure.message };
  const { upstreamBranch: upstream } = await getBranchInfo(cwd);

  const fetched = await fetchUpstream(site, cwd, upstream);
  if (!fetched.ok) return { outcome: 'failed', message: fetched.message, upstream };

  const incoming = await count(cwd, `preview..origin/${upstream}`);
  if (incoming === 0) return { outcome: 'up-to-date', message: 'preview già allineato', upstream };

  // File modificati e non committati (auto-commit fallito, sessione parallela a
  // metà turn, edit manuali sul server): fondere ora rischia di mescolarli.
  const status = await run('git', ['status', '--porcelain'], cwd);
  if (status.stdout.trim().length > 0) {
    return {
      outcome: 'blocked',
      message: 'ci sono file modificati non ancora salvati nello storico',
      upstream,
      incoming,
    };
  }

  const before = (await run('git', ['rev-parse', 'HEAD'], cwd)).stdout.trim();
  const ahead = await count(cwd, `origin/${upstream}..preview`);
  if (ahead === 0) {
    const ff = await run('git', ['merge', '--ff-only', `origin/${upstream}`], cwd);
    if (ff.code !== 0) {
      return { outcome: 'failed', message: `fast-forward fallito: ${ff.stderr.trim()}`, upstream, incoming };
    }
  } else {
    // Merge e non rebase: i commit dei turn mantengono lo sha salvato in
    // site_revisions, quindi Annulla/Ripristina continuano a funzionare.
    const merge = await run(
      'git',
      ['merge', '--no-edit', '-m', `Allinea preview con ${upstream} (modifiche fatte fuori da Tharvel)`, `origin/${upstream}`],
      cwd,
    );
    if (merge.code !== 0) {
      await run('git', ['merge', '--abort'], cwd);
      const conflicts = (merge.stdout.match(/CONFLICT[^\n]*/g) ?? []).join('; ');
      return {
        outcome: 'blocked',
        message: `conflitto con le modifiche non pubblicate${conflicts ? `: ${conflicts}` : ''}`,
        upstream,
        incoming,
      };
    }
  }
  // Anche il branch upstream locale, così chi lo legge senza fetch non parte da
  // una base vecchia (publish e rollback lo resettano comunque a origin).
  await run('git', ['branch', '-f', upstream, `origin/${upstream}`], cwd);

  const diff = await run('git', ['diff', '--name-only', before, 'HEAD'], cwd);
  const filesChanged = diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    outcome: 'updated',
    message: ahead === 0 ? 'fast-forward' : 'merge con le modifiche non pubblicate',
    upstream,
    incoming,
    filesChanged,
    depsChanged: filesChanged.some((f) => /(^|\/)package(-lock)?\.json$/.test(f)),
  };
}

// Una sola sincronizzazione per sito alla volta: due sessioni aperte insieme
// (admin + cliente) condividono lo stesso risultato invece di farsi a gara
// sull'index git.
const inflight = new Map<number, Promise<SyncResult>>();

export function syncPreviewWithRemote(site: Site, cwd: string): Promise<SyncResult> {
  const running = inflight.get(site.id);
  if (running) return running;
  const p = doSync(site, cwd)
    .catch((e: any): SyncResult => ({ outcome: 'failed', message: e?.message ?? String(e) }))
    .finally(() => inflight.delete(site.id));
  inflight.set(site.id, p);
  return p;
}
