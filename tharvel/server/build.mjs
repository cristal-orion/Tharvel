// Build TS → JS via esbuild, equivalente al transform che `tsx` fa a runtime.
// Ignora i tipi (no type-check) — comportamento intenzionalmente identico a `tsx`,
// così il deploy non si rompe per errori di tipo non bloccanti che esistono già nel codice.
// Per il type-check usare l'IDE o `npx tsc --noEmit` separatamente.
import { build } from 'esbuild';
import { readdirSync, statSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const IGNORE = new Set(['node_modules', 'dist']);
// Estensioni dei file statici letti a runtime via readFileSync (schema.sql,
// overlay.html, etc.). Copiati 1:1 in dist/ mantenendo la struttura cartelle
// così __dirname relativo continua a funzionare.
const COPY_EXT = new Set(['.sql', '.html']);

function walk(dir, out = { ts: [], assets: [] }) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (entry.endsWith('.ts')) out.ts.push(full);
    else if (COPY_EXT.has(entry.slice(entry.lastIndexOf('.')))) out.assets.push(full);
  }
  return out;
}

rmSync('dist', { recursive: true, force: true });

const { ts, assets } = walk('.');

await build({
  entryPoints: ts,
  outdir: 'dist',
  outbase: '.',
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  logLevel: 'info',
});

for (const src of assets) {
  const dest = join('dist', src);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`  copied  ${dest}`);
}
