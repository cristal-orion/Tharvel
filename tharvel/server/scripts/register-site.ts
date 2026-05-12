// CLI per registrare un sito nella tabella `sites`.
// Uso (workspace npm script):
//   npm run register:site --workspace=server -- \
//     --slug industrial-service \
//     --cwd  industrial-service \
//     --framework astro
//
// `cwd` può essere relativo (risolto contro THARVEL_SITES_ROOT, default tharvel/sites/)
// oppure assoluto. Lo slug è univoco: se già presente lo script lo riporta e non
// modifica nulla (l'update va fatto a mano per ora, idempotenza-prima-di-tutto).

import { parseArgs } from 'node:util';
import { getDb } from '../db/index.js';
import { createSite, getSiteBySlug, type SiteFramework } from '../db/sites.js';

const SUPPORTED_FRAMEWORKS: SiteFramework[] = ['html', 'astro'];

function printUsage(): void {
  console.log(`Uso: register-site --slug <slug> --cwd <path> [opzioni]

Argomenti obbligatori:
  --slug <slug>             Identificatore univoco del sito (es. industrial-service)
  --cwd <path>              cwd_path: relativo a THARVEL_SITES_ROOT oppure assoluto

Opzioni:
  --framework <html|astro>  Default: html
  --domain <host>           Dominio per lookup via Host header (es. clientesito.com)
  --repo-url <url>          URL del repo Git (informativo)
  --preview-url <url>       URL della preview esterna (informativo)
  -h, --help                Mostra questo messaggio
`);
}

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    cwd: { type: 'string' },
    framework: { type: 'string' },
    domain: { type: 'string' },
    'repo-url': { type: 'string' },
    'preview-url': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (values.help) {
  printUsage();
  process.exit(0);
}

if (!values.slug || !values.cwd) {
  console.error('Errore: --slug e --cwd sono obbligatori.\n');
  printUsage();
  process.exit(1);
}

const framework = (values.framework ?? 'html') as SiteFramework;
if (!SUPPORTED_FRAMEWORKS.includes(framework)) {
  console.error(
    `Errore: framework "${framework}" non supportato. Valori validi: ${SUPPORTED_FRAMEWORKS.join(', ')}`
  );
  process.exit(1);
}

// Inizializza schema se non esiste (apre il DB e applica la create-table).
getDb();

const existing = getSiteBySlug(values.slug);
if (existing) {
  console.log(`[register-site] slug "${values.slug}" già registrato:`);
  console.log(existing);
  console.log('\nNessuna modifica applicata. Per aggiornare i campi modificare a mano per ora.');
  process.exit(0);
}

const site = createSite({
  slug: values.slug,
  cwd_path: values.cwd,
  framework,
  domain: values.domain ?? null,
  repo_url: values['repo-url'] ?? null,
  preview_url: values['preview-url'] ?? null,
});

console.log('[register-site] registrato:');
console.log(site);
