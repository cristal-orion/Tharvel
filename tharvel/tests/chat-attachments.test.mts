import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { saveChatAttachments } from '../server/chat-attachments.js';

const temp = mkdtempSync(join(tmpdir(), 'tharvel-attach-test-'));
after(() => rmSync(temp, { recursive: true, force: true }));

const png = async () =>
  (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fc0' } }).png().toBuffer()).toString('base64');

test('salva gli allegati come webp in .tharvel/attachments, fuori dai commit', async () => {
  const site = join(temp, 'site');
  execFileSync('git', ['init', '-q', site]);
  const saved = await saveChatAttachments(site, [{ data: await png(), mimeType: 'image/png' }]);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /^\.tharvel\/attachments\/chat-\d{14}-1\.webp$/);
  assert.equal((await sharp(join(site, saved[0])).metadata()).format, 'webp');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: site, encoding: 'utf8' }), '');
});

test('svg resta svg, allegati più vecchi di un giorno vengono rimossi', async () => {
  const site = join(temp, 'site2');
  const dir = join(site, '.tharvel', 'attachments');
  mkdirSync(dir, { recursive: true });
  const old = join(dir, 'chat-old.webp');
  writeFileSync(old, 'x');
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
  utimesSync(old, twoDaysAgo, twoDaysAgo);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
  const saved = await saveChatAttachments(site, [{ data: svg, mimeType: 'image/svg+xml' }]);
  assert.match(saved[0], /\.svg$/);
  assert.deepEqual(readdirSync(dir), [saved[0].split('/').pop()]);
});
