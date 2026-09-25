import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Real iframe bridge + legacy selector together; all backend traffic is mocked.
// These tests never run an AI request, publish, or mutate a registered site.
const pointer = readFileSync(new URL('../../server/preview-pointer.html', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../../server/preview-bootstrap.html', import.meta.url), 'utf8');
const revision = { id: 1, commit_sha: 'abc', parent_sha: 'def', user_prompt: 'Cambia titolo', summary: 'Titolo aggiornato', files_changed: ['index.html'], kind: 'turn', superseded: false, created_at: '2026-09-25 10:00:00' };
const image = { name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') };

async function setup(page: Page, role: 'admin' | 'client' = 'admin', loggedIn = true) {
  let socket: WebSocketRoute;
  let previewLoads = 0;
  let socketCount = 0;
  const sent: any[] = [];
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}`);
    const user = { id: 1, email: `${role}@example.test`, role, slug: role === 'client' ? 'demo-site' : null };
    let body: unknown = {};
    if (url.pathname === '/api/me') {
      if (!loggedIn) return route.fulfill({ status: 401, json: {} });
      body = { user };
    } else if (url.pathname === '/api/login') body = { user };
    else if (url.pathname === '/api/sites') body = { sites: [
      { id: 1, slug: 'demo-site', domain: 'example.test', framework: 'html' },
      { id: 2, slug: 'second-site', domain: 'second.test', framework: 'astro' },
    ] };
    else if (url.pathname.endsWith('/history')) body = { revisions: [revision] };
    else if (url.pathname.endsWith('/access')) body = { adminUrl: 'https://example.test/tharveladmin', users: [{ id: 2, email: 'client@example.test', password: 'test-only-password' }] };
    else if (url.pathname.endsWith('/commands-summary')) body = { commands: [{ command: 'a'.repeat(180), uses: 1, errors: 0, last_used: '2026-09-25 10:00:00' }] };
    else if (url.pathname.endsWith('/models')) body = { models: [] };
    else if (url.pathname.endsWith('/publishes')) body = { publishes: [] };
    else if (url.pathname.endsWith('/activity')) body = { events: [] };
    return route.fulfill({ json: body });
  });
  await page.route('**/site/**', route => {
    previewLoads++;
    const url = new URL(route.request().url());
    const match = url.pathname.match(/\/site\/([^/]+)(.*)/)!;
    const prefix = `/site/${match[1]}`;
    const path = match[2] || '/';
    const boot = bootstrap.replace(/__THARVEL_PREFIX__/g, JSON.stringify(prefix)).replace(/__THARVEL_ROUTE__/g, JSON.stringify(path))
      .replace(/__THARVEL_VIRTUALIZE_ROUTE__/g, String(match[1] !== 'demo-site'));
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${pointer}${boot}
      <style>*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:#f7f3ed;color:#262a24}header{padding:28px;background:#244736;color:white}main{padding:24px}button,a{display:inline-block;padding:12px;margin:8px 0}section{height:1000px;background:linear-gradient(#e4e9e0,#f7f3ed)}</style></head><body>
      <header><h1 id="hero">Il tuo sito</h1><p>Anteprima responsive</p></header><main><a id="nav" href="${prefix}/about">Pagina interna</a><button id="action" onclick="this.textContent='Funziona'">Prova sito</button><svg width="40" height="40"><circle id="svg-target" cx="20" cy="20" r="15" fill="green"/></svg><section>Contenuto scorrevole</section></main>
      <script>window.legacySelections=0;document.addEventListener('click',e=>{if(e.altKey){window.legacySelections++;parent.postMessage({type:'THARVEL_ELEMENT_SELECTED',info:{tag:'legacy'}},'*')}},true)</script></body></html>` });
  });
  await page.routeWebSocket(/\?site=/, ws => {
    socket = ws;
    socketCount++;
    ws.send(JSON.stringify({ type: 'model_active', model: 'openai-codex/gpt-5.6-sol' }));
    ws.send(JSON.stringify({ type: 'files_list', files: [{ name: 'logo.png', path: 'assets/logo.png', isImage: true }] }));
    ws.onMessage(data => sent.push(JSON.parse(String(data))));
  });
  await page.goto('/tharveladmin/');
  return {
    sent, errors, requests,
    get previewLoads() { return previewLoads; },
    get socketCount() { return socketCount; },
    reply(content: string) { socket.send(JSON.stringify({ type: 'stream', content })); },
    done() { socket.send(JSON.stringify({ type: 'done' })); },
    disconnect() { socket.close({ code: 1011, reason: 'test disconnect' }); },
  };
}

async function ready(page: Page) {
  await expect(page.getByRole('button', { name: 'Apri chat', exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Il tuo sito' })).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function inViewport(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('mobile login and role-specific entry', async ({ page }) => {
  const app = await setup(page, 'client', false);
  await expect(page.getByRole('heading', { name: 'Accedi' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('client@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-only');
  await page.getByRole('button', { name: 'Accedi', exact: true }).click();
  await ready(page);
  await page.getByRole('button', { name: 'Apri strumenti' }).click();
  await expect(page.getByRole('button', { name: 'Aggiungi sito…' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Chiudi strumenti' }).click();
  await page.getByRole('button', { name: 'Apri chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Scegli modello AI' })).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test('chat overlays the iframe, preserves draft and attachments, streams while collapsed', async ({ page }) => {
  const app = await setup(page);
  await ready(page);
  const initialLoads = app.previewLoads;
  const initialFrame = await page.locator('iframe').boundingBox();
  await page.getByRole('button', { name: 'Apri chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Messaggio per Tharvel' }).fill('Aggiorna il titolo');
  await page.locator('.chat input[type=file]').setInputFiles(image);
  await expect(page.locator('.pending-chip')).toBeVisible();
  await page.getByRole('button', { name: 'Nascondi chat' }).click();
  await page.getByRole('button', { name: 'Apri chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Messaggio per Tharvel' })).toHaveValue('Aggiorna il titolo');
  await expect(page.locator('.pending-chip')).toBeVisible();
  expect(await page.locator('iframe').boundingBox()).toEqual(initialFrame);
  expect(app.previewLoads).toBe(initialLoads);
  await page.getByRole('button', { name: 'Invia messaggio' }).click();
  await expect.poll(() => app.sent.filter(p => p.type === 'prompt').length).toBe(1);
  expect(app.sent.find(p => p.type === 'prompt').images).toHaveLength(1);
  await page.getByRole('button', { name: 'Nascondi chat' }).click();
  app.reply('Titolo aggiornato');
  app.done();
  await expect(page.getByRole('button', { name: 'Apri chat · Nuova risposta' })).toBeVisible();
  await expect.poll(() => app.previewLoads).toBe(initialLoads + 1);
  await page.getByRole('button', { name: 'Apri chat · Nuova risposta' }).click();
  await expect(page.locator('.msg.ai')).toContainText('Titolo aggiornato');
  expect(app.socketCount).toBe(1);
  expect(app.errors).toEqual([]);
});

test('touch selection is one-shot, normal navigation and SVG selection still work', async ({ page }) => {
  const app = await setup(page);
  await ready(page);
  const frame = page.frameLocator('iframe');
  await page.getByRole('button', { name: 'Seleziona elemento', exact: true }).click();
  // Link is selected without navigating. Scroll remains usable in inspect mode.
  await frame.locator('#nav').tap();
  await expect(page.locator('.element-chip code')).toHaveText('a#nav');
  await expect(page.getByRole('button', { name: 'Seleziona elemento', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await frame.locator('#nav').tap();
  await expect(page.locator('.mobile-site-status')).toContainText('/about');
  expect(new URL(page.frames()[1].url()).pathname).toBe('/site/demo-site/about');
  await page.getByRole('button', { name: 'Seleziona elemento', exact: true }).click();
  await frame.locator('#svg-target').tap();
  await expect(page.locator('.element-chip code')).toHaveText('circle#svg-target');
  await page.getByRole('button', { name: 'Apri chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Messaggio per Tharvel' }).fill('Cambia colore');
  await page.getByRole('button', { name: 'Invia messaggio' }).click();
  await expect.poll(() => app.sent.some(p => p.content?.includes('tag: circle'))).toBe(true);
  expect(app.errors).toEqual([]);
});

test('iframe messages from other windows are ignored and legacy Alt-click is not duplicated', async ({ page }) => {
  const app = await setup(page);
  await ready(page);
  await page.evaluate(() => window.postMessage({ type: 'THARVEL_ELEMENT_SELECTED', info: { tag: 'fake', id: '', classes: '', text: '', xpath: '' } }, location.origin));
  await expect(page.locator('.element-chip')).toHaveCount(0);
  await page.frameLocator('iframe').locator('#hero').click({ modifiers: ['Alt'] });
  await expect(page.locator('.element-chip code')).toHaveText('h1#hero');
  expect(await page.frames()[1].evaluate(() => (window as any).legacySelections)).toBe(0);
  await page.locator('.chip-x').click();
  await expect(page.frameLocator('iframe').locator('.tharvel-highlight')).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test('all admin tools and dialogs fit narrow phones', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const app = await setup(page);
  await ready(page);
  await page.getByRole('button', { name: 'Apri strumenti' }).click();
  await inViewport(page, '.sidebar-shell');
  await page.getByRole('button', { name: 'Annulla ultima' }).click();
  await expect.poll(() => app.requests.includes('POST /api/session/demo-site/undo')).toBe(true);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Ripristina qui' }).click();
  await expect.poll(() => app.requests.includes('POST /api/session/demo-site/restore/1')).toBe(true);
  await page.locator('.section-action').click();
  await page.locator('.sidebar input[type=file]').setInputFiles(image);
  await expect.poll(() => app.sent.some(p => p.type === 'upload_file')).toBe(true);
  await page.getByRole('button', { name: 'Attività —', exact: false }).first().click();
  await page.getByRole('dialog', { name: 'Attività del sito' }).getByRole('button', { name: /^Comandi/ }).click();
  await inViewport(page, '.dialog-card');
  await noOverflow(page);
  await page.getByRole('button', { name: 'Chiudi attività' }).click();
  await page.getByRole('button', { name: 'Chiavi di accesso —', exact: false }).first().click();
  await inViewport(page, '.dialog-card');
  await page.getByRole('button', { name: 'Chiudi chiavi di accesso' }).click();
  await page.getByRole('button', { name: 'Aggiungi sito…' }).click();
  await inViewport(page, '.dialog-card');
  await page.getByRole('button', { name: 'Chiudi aggiunta sito' }).click();
  await page.getByRole('button', { name: 'Impostazioni', exact: true }).click();
  await inViewport(page, '.dialog-card');
  await noOverflow(page);
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click();
  await page.getByRole('button', { name: 'Chiudi strumenti' }).click();
  await page.getByRole('button', { name: /^Pubblica/ }).click();
  await inViewport(page, '.dialog-card');
  await page.getByRole('button', { name: 'Pubblica ora' }).click();
  await expect.poll(() => app.sent.some(p => p.content === 'Pubblica le modifiche al sito.')).toBe(true);
  expect(app.errors).toEqual([]);
});

test('preview sizes simulate real viewports without remounting or losing the route', async ({ page }) => {
  const app = await setup(page);
  await ready(page);
  const loads = app.previewLoads;
  await page.getByRole('button', { name: 'Opzioni anteprima' }).click();
  await page.getByLabel('Dimensioni anteprima').selectOption('desktop');
  await expect.poll(() => page.frames()[1].evaluate(() => window.innerWidth)).toBe(1280);
  expect(app.previewLoads).toBe(loads);
  await page.getByLabel('Pagina del sito').fill('/contacts');
  await page.getByRole('button', { name: 'Vai', exact: true }).click();
  await expect(page.locator('.mobile-site-status')).toContainText('/contacts');
  await page.getByRole('button', { name: 'Opzioni anteprima' }).click();
  await page.getByLabel('Dimensioni anteprima').selectOption('fit');
  await page.getByRole('button', { name: 'Ricarica pagina' }).click();
  await expect(page.locator('.mobile-site-status')).toContainText('/contacts');
  await expect.poll(() => page.frames()[1].evaluate(() => window.innerWidth)).toBe(page.viewportSize()!.width);
  expect(app.errors).toEqual([]);
});

test('bubble dragging snaps to an edge and stays reachable after rotation', async ({ page }) => {
  await setup(page);
  await ready(page);
  const bubble = page.locator('.chat-bubble');
  await bubble.hover();
  const box = (await bubble.boundingBox())!;
  await page.mouse.move(box.x + 28, box.y + 28);
  await page.mouse.down();
  await page.mouse.move(25, 230, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.chat')).toBeHidden();
  await expect.poll(async () => (await bubble.boundingBox())!.x).toBe(12);
  await page.setViewportSize({ width: 844, height: 390 });
  await inViewport(page, '.chat-bubble');
  await bubble.click();
  await inViewport(page, '.chat');
});

test('chat handles a reduced visual viewport and preserves its draft across breakpoints', async ({ page }) => {
  const app = await setup(page);
  await ready(page);
  await page.getByRole('button', { name: 'Apri chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Messaggio per Tharvel' }).fill('Una bozza');
  // Emulate the geometry reported by iOS visualViewport when a keyboard opens.
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--visual-height', '400px');
    document.documentElement.style.setProperty('--visual-top', '20px');
    document.documentElement.classList.add('keyboard-open');
  });
  const composer = (await page.locator('.composer').boundingBox())!;
  expect(composer.y + composer.height).toBeLessThanOrEqual(421);
  const loads = app.previewLoads;
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.chat')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Messaggio per Tharvel' })).toHaveValue('Una bozza');
  await noOverflow(page);
  expect(app.previewLoads).toBe(loads);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('textbox', { name: 'Messaggio per Tharvel' })).toHaveValue('Una bozza');
  expect(app.errors).toEqual([]);
});

test('changing site clears the previous tenant draft and selection', async ({ page }) => {
  const app = await setup(page);
  await ready(page);
  await page.getByRole('button', { name: 'Apri chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Messaggio per Tharvel' }).fill('Bozza sito precedente');
  await page.getByRole('button', { name: 'Nascondi chat' }).click();
  await page.getByRole('button', { name: 'Apri strumenti' }).click();
  await page.getByRole('button', { name: 'second-site' }).click();
  await expect(page.locator('.mobile-site-name')).toHaveText('second-site');
  await page.getByRole('button', { name: 'Apri chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Messaggio per Tharvel' })).toHaveValue('');
  expect(app.socketCount).toBe(2);
  expect(app.errors).toEqual([]);
});

test('offline state reconnects and dialogs support keyboard dismissal', async ({ page }) => {
  const app = await setup(page);
  await ready(page);
  app.disconnect();
  await expect(page.getByRole('button', { name: 'Apri chat · Non connessa' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('button', { name: 'Apri chat', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apri strumenti' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar-shell')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Apri strumenti' })).toBeFocused();
  expect(app.errors).toEqual([]);
});

test('desktop entry retains resizable panels, collapse controls and draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const app = await setup(page);
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Il tuo sito' })).toBeVisible();
  await expect(page.locator('.chat')).toBeVisible();
  await expect(page.locator('.chat-bubble')).toHaveCount(0);
  const loads = app.previewLoads;
  await page.getByRole('textbox', { name: 'Messaggio per Tharvel' }).fill('Bozza desktop');
  await page.getByRole('button', { name: 'Nascondi chat', exact: true }).click();
  await page.getByRole('button', { name: 'Mostra chat' }).click();
  await expect(page.getByRole('textbox', { name: 'Messaggio per Tharvel' })).toHaveValue('Bozza desktop');
  await page.locator('.collapse-btn').click();
  await expect(page.locator('.sidebar')).toHaveClass(/collapsed/);
  expect(app.previewLoads).toBe(loads);
  await noOverflow(page);
  await page.getByRole('button', { name: 'Scegli modello AI' }).click();
  await page.locator('.prov-row').first().click();
  await page.locator('.model-row').first().click();
  await expect.poll(() => app.sent.some(p => p.type === 'set_model')).toBe(true);
  expect(app.errors).toEqual([]);
});

for (const width of [360, 390, 430, 768, 1024]) {
  test(`preview and expanded chat fit ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await ready(page);
    await noOverflow(page);
    await inViewport(page, 'iframe');
    await page.getByRole('button', { name: 'Apri chat', exact: true }).click();
    await page.locator('.chat-actions').getByRole('button', { name: 'Espandi chat' }).click();
    await inViewport(page, '.chat');
    await inViewport(page, '.send');
    await page.getByRole('button', { name: 'Scegli modello AI' }).click();
    await inViewport(page, '.popup');
    await page.screenshot({ path: testInfo.outputPath(`mobile-${width}.png`) });
  });
}
