import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import type { Site } from '../server/db/sites.js';
import { syncPreviewWithRemote, fetchUpstream } from '../server/remote-sync.js';

// "GitHub" è un repo bare locale. Il token dell'installation è finto: l'URL
// autenticato che ne esce viene rimappato sul bare con `url.insteadOf`, mentre
// `origin` resta puntato a un URL con un token scaduto, come nei clone veri.
const TOKEN = 'fresh-token';
const REPO_URL = 'https://github.com/acme/site.git';
const temp = mkdtempSync(join(tmpdir(), 'tharvel-sync-test-'));
const remote = join(temp, 'remote.git');
process.env.THARVEL_DB_PATH = join(temp, 'test.db');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let n = 0;
function makeSite(): { site: Site; cwd: string; ext: string } {
  n++;
  const cwd = join(temp, `site-${n}`);
  const ext = join(temp, `ext-${n}`);
  rmSync(remote, { recursive: true, force: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  const seed = join(temp, `seed-${n}`);
  execFileSync('git', ['init', '-b', 'main', seed]);
  writeFileSync(join(seed, 'index.html'), '<h1>v1</h1>\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'push', remote, 'main');
  execFileSync('git', ['clone', remote, cwd], { stdio: 'ignore' });
  git(cwd, 'remote', 'set-url', 'origin', 'https://x-access-token:expired@github.com/acme/site.git');
  execFileSync('git', ['clone', remote, ext], { stdio: 'ignore' });
  const site = { id: n, slug: `s${n}`, repo_url: REPO_URL, framework: 'html', cwd_path: cwd } as unknown as Site;
  return { site, cwd, ext };
}

function pushExternal(ext: string, file: string, content: string) {
  writeFileSync(join(ext, file), content);
  git(ext, 'add', '-A');
  git(ext, 'commit', '-m', `external ${file}`);
  git(ext, 'push', 'origin', 'main');
}

function commitOnPreview(cwd: string, file: string, content: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', `turn ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

const realFetch = globalThis.fetch;
before(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_INSTALLATION_ID = '1';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token: TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
      status: 201,
    })) as typeof fetch;
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://x-access-token:${TOKEN}@github.com/acme/site.git`,
  });
});
after(() => {
  globalThis.fetch = realFetch;
  rmSync(temp, { recursive: true, force: true });
});

test('fetchUpstream usa un token fresco anche se origin ha quello scaduto', async () => {
  const { site, cwd, ext } = makeSite();
  pushExternal(ext, 'about.html', 'about\n');
  const res = await fetchUpstream(site, cwd, 'main');
  assert.equal(res.ok, true, res.message);
  assert.equal(git(cwd, 'rev-parse', 'origin/main'), git(ext, 'rev-parse', 'HEAD'));
  assert.match(git(cwd, 'remote', 'get-url', 'origin'), /expired/, 'il token non va salvato in .git/config');
});

test('nessuna novità su GitHub → up-to-date', async () => {
  const { site, cwd } = makeSite();
  const res = await syncPreviewWithRemote(site, cwd);
  assert.equal(res.outcome, 'up-to-date');
  assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'preview');
});

test('preview senza modifiche proprie → fast-forward alle modifiche esterne', async () => {
  const { site, cwd, ext } = makeSite();
  await syncPreviewWithRemote(site, cwd); // crea preview
  pushExternal(ext, 'index.html', '<h1>v2 da fuori</h1>\n');
  const res = await syncPreviewWithRemote(site, cwd);
  assert.equal(res.outcome, 'updated');
  assert.equal(res.incoming, 1);
  assert.deepEqual(res.filesChanged, ['index.html']);
  assert.equal(readFileSync(join(cwd, 'index.html'), 'utf8'), '<h1>v2 da fuori</h1>\n');
  assert.equal(git(cwd, 'rev-parse', 'preview'), git(ext, 'rev-parse', 'HEAD'));
  assert.equal(git(cwd, 'rev-parse', 'main'), git(ext, 'rev-parse', 'HEAD'));
});

test('turn non pubblicati + modifiche esterne → merge, sha dei turn conservati', async () => {
  const { site, cwd, ext } = makeSite();
  await syncPreviewWithRemote(site, cwd);
  const turnSha = commitOnPreview(cwd, 'contatti.html', 'contatti\n');
  pushExternal(ext, 'about.html', 'about\n');
  const res = await syncPreviewWithRemote(site, cwd);
  assert.equal(res.outcome, 'updated');
  assert.equal(readFileSync(join(cwd, 'about.html'), 'utf8'), 'about\n');
  assert.equal(readFileSync(join(cwd, 'contatti.html'), 'utf8'), 'contatti\n');
  git(cwd, 'merge-base', '--is-ancestor', turnSha, 'preview');
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});

test('conflitto con i turn non pubblicati → blocked, preview intatto', async () => {
  const { site, cwd, ext } = makeSite();
  await syncPreviewWithRemote(site, cwd);
  const turnSha = commitOnPreview(cwd, 'index.html', '<h1>da Tharvel</h1>\n');
  pushExternal(ext, 'index.html', '<h1>da fuori</h1>\n');
  const res = await syncPreviewWithRemote(site, cwd);
  assert.equal(res.outcome, 'blocked');
  assert.match(res.message, /conflitto/);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), turnSha);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});

test('working tree sporco → blocked senza toccare i file', async () => {
  const { site, cwd, ext } = makeSite();
  await syncPreviewWithRemote(site, cwd);
  writeFileSync(join(cwd, 'index.html'), '<h1>a metà</h1>\n');
  pushExternal(ext, 'about.html', 'about\n');
  const res = await syncPreviewWithRemote(site, cwd);
  assert.equal(res.outcome, 'blocked');
  assert.equal(readFileSync(join(cwd, 'index.html'), 'utf8'), '<h1>a metà</h1>\n');
});

test('due sessioni insieme condividono la stessa sincronizzazione', async () => {
  const { site, cwd, ext } = makeSite();
  await syncPreviewWithRemote(site, cwd);
  pushExternal(ext, 'about.html', 'about\n');
  const [a, b] = [syncPreviewWithRemote(site, cwd), syncPreviewWithRemote(site, cwd)];
  assert.equal(a, b);
  assert.equal((await a).outcome, 'updated');
});

test('publish con GitHub avanzato fuori da Tharvel: push ok, nessuna modifica persa', async () => {
  const { publishSite } = await import('../server/publish.js');
  const { site, cwd, ext } = makeSite();
  await syncPreviewWithRemote(site, cwd);
  commitOnPreview(cwd, 'contatti.html', 'contatti\n');
  pushExternal(ext, 'about.html', 'about\n');
  const res = await publishSite(site, temp, 'Aggiunta pagina contatti');
  assert.equal(res.pushed, true, res.message);
  git(ext, 'pull', '--ff-only', 'origin', 'main');
  assert.equal(readFileSync(join(ext, 'about.html'), 'utf8'), 'about\n');
  assert.equal(readFileSync(join(ext, 'contatti.html'), 'utf8'), 'contatti\n');
});
