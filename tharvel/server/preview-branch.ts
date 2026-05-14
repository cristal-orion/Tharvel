// Helper centralizzato per gestire il branch `preview` di un sito.
// Modello: l'agente Tharvel lavora SEMPRE su `preview`. La pubblicazione fa
// squash merge `preview` → branch upstream (main/master) e poi riallinea
// preview al nuovo upstream.
//
// Per i siti onboardati prima dell'introduzione del flusso preview, la prima
// volta che viene chiamato ensurePreviewBranch() viene creato `preview` a
// partire dal branch attualmente checked out.

import { spawn } from 'node:child_process';

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

export interface BranchInfo {
  current: string;
  hasPreview: boolean;
  upstreamBranch: string; // main, master, …
}

// Rileva il branch di default upstream (= dove pushiamo al publish).
// Strategia: prima 'origin/HEAD' (corretto se il clone l'ha settato), poi
// preferenza main → master → branch corrente come fallback.
async function detectUpstreamBranch(cwd: string): Promise<string> {
  const head = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (head.code === 0) {
    const ref = head.stdout.trim(); // es. "origin/main"
    const slash = ref.indexOf('/');
    if (slash >= 0) return ref.slice(slash + 1);
  }
  for (const candidate of ['main', 'master']) {
    const check = await run('git', ['rev-parse', '--verify', `refs/remotes/origin/${candidate}`], cwd);
    if (check.code === 0) return candidate;
  }
  // Fallback: branch locale corrente.
  const cur = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return cur.stdout.trim() || 'main';
}

export async function getBranchInfo(cwd: string): Promise<BranchInfo> {
  const cur = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const current = cur.stdout.trim();
  const previewCheck = await run('git', ['rev-parse', '--verify', 'refs/heads/preview'], cwd);
  const upstreamBranch = await detectUpstreamBranch(cwd);
  return {
    current,
    hasPreview: previewCheck.code === 0,
    upstreamBranch,
  };
}

// Idempotente: garantisce che esista branch `preview` e che HEAD sia su preview.
// Se preview non esiste, lo crea dal branch corrente. Se la working tree è dirty
// durante lo switch, NON forziamo: lasciamo il chiamante gestire (in pratica,
// l'agente lavorerà sul branch corrente e l'auto-commit fallirà gracefully).
export async function ensurePreviewBranch(cwd: string): Promise<{ ok: boolean; message: string }> {
  const info = await getBranchInfo(cwd);
  if (info.current === 'preview') {
    return { ok: true, message: 'già su preview' };
  }
  if (!info.hasPreview) {
    const createRes = await run('git', ['checkout', '-b', 'preview'], cwd);
    if (createRes.code !== 0) {
      return { ok: false, message: `creazione preview fallita: ${createRes.stderr.trim()}` };
    }
    return { ok: true, message: `branch preview creato da ${info.current}` };
  }
  // preview esiste ma non siamo lì: switch.
  const switchRes = await run('git', ['checkout', 'preview'], cwd);
  if (switchRes.code !== 0) {
    return { ok: false, message: `checkout preview fallito: ${switchRes.stderr.trim()}` };
  }
  return { ok: true, message: `switched a preview da ${info.current}` };
}
