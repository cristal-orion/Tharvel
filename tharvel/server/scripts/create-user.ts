// CLI `tharvel create-user` — crea un account Tharvel.
//
// Strato 4 della roadmap security. Per Beta privata gli utenti li crea il
// developer da terminale (niente signup self-service).
//
// Esempi:
//   npm run create-user --workspace=server -- \
//     --email admin@tharvel.local --role admin --password "mySecret123"
//
//   npm run create-user --workspace=server -- \
//     --email cliente@industrial.it --role client --slug industrial
//   (password omessa → ne viene generata una random e stampata UNA volta)
//
// Per role=admin: slug DEVE essere omesso (admin vede tutti i siti).
// Per role=client: slug è obbligatorio e deve esistere in tabella `sites`.

import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db/index.js';
import { createUser, getUserByEmail } from '../db/users.js';
import { getSiteBySlug } from '../db/sites.js';
import { hashPassword } from '../auth.js';

function fail(msg: string): never {
  console.error(`Errore: ${msg}`);
  process.exit(1);
}

function printUsage(): void {
  console.log(`Uso: create-user --email <email> --role <admin|client> [--slug <slug>] [--password <pwd>]

Argomenti:
  --email <email>           Email univoca (lowercase consigliato)
  --role <admin|client>     admin → accesso a tutti i siti; client → un solo slug
  --slug <slug>             Solo per role=client. Deve esistere già in tabella sites.
  --password <pwd>          Password in chiaro (verrà hash-ata con argon2id).
                            Se omessa, ne viene generata una random e stampata.
  -h, --help                Mostra questo messaggio
`);
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    role: { type: 'string' },
    slug: { type: 'string' },
    password: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (values.help) {
  printUsage();
  process.exit(0);
}

if (!values.email) fail('--email obbligatorio.');
if (!values.role) fail('--role obbligatorio (admin|client).');

const email = values.email.trim().toLowerCase();
const role = values.role as 'admin' | 'client';
if (role !== 'admin' && role !== 'client') fail(`--role "${role}" non valido (admin|client).`);

if (role === 'admin' && values.slug) {
  fail('--slug non va passato per role=admin (admin vede tutti i siti).');
}
if (role === 'client' && !values.slug) {
  fail('--slug obbligatorio per role=client.');
}

// Apre DB + assicura che lo schema esista (users può non esserci se DB pre-Strato 4).
getDb();

if (role === 'client') {
  const site = getSiteBySlug(values.slug!);
  if (!site) {
    fail(
      `Sito "${values.slug}" non esiste. Lancia prima onboard/register:site, poi ritenta.`,
    );
  }
}

if (getUserByEmail(email)) {
  fail(`Email "${email}" già registrata. Per reset password modifica direttamente il DB o aggiungi uno script update-password.`);
}

// Password: arg esplicito oppure generata. Generata = 24 byte base64url, ~32 char
// stampabili → robusta e copiabile.
let plainPassword = values.password;
let passwordGenerated = false;
if (!plainPassword) {
  plainPassword = randomBytes(18).toString('base64url');
  passwordGenerated = true;
}

const hash = await hashPassword(plainPassword);
const user = createUser({
  email,
  password_hash: hash,
  role,
  slug: role === 'client' ? values.slug : null,
});

console.log('\n[create-user] ✓ utente creato:');
console.log({
  id: user.id,
  email: user.email,
  role: user.role,
  slug: user.slug,
  created_at: user.created_at,
});

if (passwordGenerated) {
  console.log(`\nPassword generata (mostrata UNA volta, salvala adesso):\n  ${plainPassword}\n`);
} else {
  console.log('\nPassword: quella passata via --password (non viene ristampata).\n');
}
