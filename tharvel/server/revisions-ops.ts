// Operazioni di ripristino sul branch `preview` di un sito.
//
// Strategia: `git reset --hard <sha>`. Siamo sempre su preview (branch locale
// non pushato), quindi riscrivere la storia è sicuro. Per ripristinare lo stato
// "prima della revisione N" si fa reset al `parent_sha` salvato nella tabella.

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

export async function resetPreviewTo(cwd: string, sha: string): Promise<{ ok: boolean; message: string }> {
  // Controllo che il commit target esista (paranoia: parent_sha potrebbe essere
  // stale se il repo è stato force-pushato da fuori).
  const check = await run('git', ['cat-file', '-e', sha], cwd);
  if (check.code !== 0) {
    return { ok: false, message: `commit ${sha.slice(0, 8)} non trovato nel repo` };
  }
  // Assicuriamo di essere su preview (l'ensure è già stato chiamato altrove,
  // ma rifarlo è idempotente e ci protegge da edge case).
  const switchRes = await run('git', ['checkout', 'preview'], cwd);
  if (switchRes.code !== 0) {
    return { ok: false, message: `checkout preview fallito: ${switchRes.stderr.trim()}` };
  }
  const resetRes = await run('git', ['reset', '--hard', sha], cwd);
  if (resetRes.code !== 0) {
    return { ok: false, message: `git reset --hard fallito: ${resetRes.stderr.trim()}` };
  }
  return { ok: true, message: `preview riportato a ${sha.slice(0, 8)}` };
}

// Rebuild del sito dopo restore. Solo per framework con build step (astro/vite).
// Non-blocking dell'output al chiamante: ritorna ok/fallito + log breve.
export async function rebuildSite(cwd: string, framework: 'html' | 'astro' | 'vite'): Promise<{ ok: boolean; message: string }> {
  if (framework === 'html') return { ok: true, message: 'no build per html' };
  const res = await run('npm', ['run', 'build'], cwd);
  if (res.code !== 0) {
    const tail = res.stderr.split('\n').slice(-5).join('\n').trim();
    return { ok: false, message: `npm run build fallito: ${tail}` };
  }
  return { ok: true, message: 'rebuild ok' };
}
