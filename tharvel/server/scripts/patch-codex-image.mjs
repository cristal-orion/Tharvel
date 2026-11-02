// Adatta @hewliyang/pi-codex-image@0.1.0 (tool `generate_image`) a Pi 1.x.
//
// L'estensione è ferma a maggio 2026 e usa `AuthStorage`, rimosso da Pi 0.80:
// caricata così, `AuthStorage` è undefined e la generazione immagini si rompe.
// Pi 1.x risolve ancora gli import `@mariozechner/*` sui propri moduli, quindi
// basta sostituire le tre chiamate alle credenziali:
//   - presenza del login Codex → readStoredCredential()
//   - access token (con refresh) → ctx.modelRegistry.getApiKeyForProvider()
//   - accountId del credential  → readStoredCredential()
//
// Uso (build Docker, dopo `pi install`): node patch-codex-image.mjs <dir-estensione>
// Fallisce se il sorgente non è quello atteso, così un aggiornamento del
// pacchetto non passa in silenzio con la patch applicata a metà.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('uso: node patch-codex-image.mjs <dir @hewliyang/pi-codex-image>');
  process.exit(1);
}
const file = join(dir, 'index.ts');
let src = readFileSync(file, 'utf8');

const replacements = [
  [
    'import { AuthStorage } from "@mariozechner/pi-coding-agent";',
    'import { readStoredCredential } from "@mariozechner/pi-coding-agent";',
  ],
  [
    'const hasCodex = AuthStorage.create().hasAuth("openai-codex");',
    'const hasCodex = readStoredCredential("openai-codex") !== undefined;',
  ],
  [
    '({ token, accountId } = await getCodexAuth());',
    '({ token, accountId } = await getCodexAuth(ctx));',
  ],
  [
    'async function getCodexAuth(): Promise<{ token: string; accountId: string }> {\n\tconst storage = AuthStorage.create();\n\tconst token = await storage.getApiKey("openai-codex");',
    'async function getCodexAuth(ctx: ExtensionContext): Promise<{ token: string; accountId: string }> {\n\tconst token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");',
  ],
  [
    'const cred = storage.get("openai-codex") as',
    'const cred = readStoredCredential("openai-codex") as',
  ],
];

for (const [from, to] of replacements) {
  const count = src.split(from).length - 1;
  if (count !== 1) {
    console.error(`patch-codex-image: atteso 1 match, trovati ${count}:\n  ${from.split('\n')[0]}`);
    process.exit(1);
  }
  src = src.replace(from, to);
}
if (src.includes('AuthStorage')) {
  console.error('patch-codex-image: restano riferimenti ad AuthStorage, patch incompleta');
  process.exit(1);
}
writeFileSync(file, src);
console.log(`patch-codex-image: ${replacements.length} sostituzioni applicate a ${file}`);
