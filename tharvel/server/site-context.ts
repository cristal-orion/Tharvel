// Contesto persistente di un sito, iniettato nel prompt dell'agente a ogni sessione.
//
// PERCHÉ ESISTE
// La session dell'SDK è `SessionManager.inMemory()`: alla disconnessione il
// modello dimentica tutto. Quando il cliente torna il giorno dopo per la seconda
// modifica, l'agente riparte da zero e deve riesplorare il progetto (turni sprecati)
// oppure — peggio — crea markup nuovo senza sapere che il sito ha già un suo
// design system, e il risultato stona col resto delle pagine.
//
// Questo modulo produce un digest markdown che risponde a "com'è fatto questo sito
// e cosa ci è stato fatto finora", da anteporre al prompt. Due sorgenti:
//   1. SCANNER DETERMINISTICO sul filesystem — nessuna chiamata al modello, ~30ms.
//      Estrae solo fatti verificabili (token CSS, classi, componenti, sezioni),
//      quindi non "deriva" mai: è sempre lo stato di adesso, non un ricordo.
//   2. STORICO dal DB (site_chat_messages + site_revisions) — cosa ha chiesto
//      l'utente nelle sessioni precedenti e quali file sono stati toccati.
//
// I detector sono organizzati per TECNOLOGIA (custom properties, Tailwind, ...)
// e non per framework, così Astro e Vite/React ne condividono la maggior parte e
// aggiungere Next/SvelteKit domani costa una riga nella mappa delle convenzioni.
//
// NON copre tono di voce, lingua e dominio del cliente: quelli non sono deducibili
// dal codice e sono compito di uno strato LLM successivo (una sola chiamata in
// onboarding, da persistere in DB).

import fs from 'node:fs';
import path from 'node:path';
import type { SiteFramework } from './db/sites.js';
import { listChatMessages } from './db/activity.js';
import { listRevisionsBySite } from './db/revisions.js';

// Tetto complessivo del digest. Su un sito con 80 componenti la lista integrale
// mangerebbe il context e PEGGIORA le risposte invece di migliorarle: ogni sezione
// ha un budget suo e il totale viene troncato come backstop.
const CHAR_BUDGET = 9000; // ~2500 token

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.git', '.astro', '.svelte-kit', '.next',
  '.vercel', '.netlify', 'coverage', '.cache', '.pi',
]);
const SRC_EXT = new Set([
  '.astro', '.vue', '.svelte', '.jsx', '.tsx', '.js', '.ts', '.css', '.scss', '.html', '.md', '.mdx',
]);
// Estensioni che contano come "asset" elencabili all'agente.
const ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.pdf', '.mp4', '.webm',
]);

interface ScanFile {
  abs: string;
  rel: string;
  ext: string;
  mtimeMs: number;
  src: string;
}

// ─────────────────────────────────────────────────────────────── filesystem

function walk(dir: string, sitePath: string, acc: ScanFile[], depth: number): void {
  if (depth > 6 || acc.length > 400) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, sitePath, acc, depth + 1);
      continue;
    }
    if (!SRC_EXT.has(path.extname(e.name))) continue;
    try {
      const st = fs.statSync(abs);
      // File enormi (bundle committati, dump) non aiutano e costano I/O.
      if (st.size > 1_500_000) continue;
      acc.push({
        abs,
        rel: path.relative(sitePath, abs),
        ext: path.extname(e.name),
        mtimeMs: st.mtimeMs,
        src: fs.readFileSync(abs, 'utf-8'),
      });
    } catch {
      /* file sparito o illeggibile: ignora */
    }
  }
}

function listAssets(sitePath: string): string[] {
  const roots = ['public', 'assets', 'static'].filter((d) => fs.existsSync(path.join(sitePath, d)));
  const out: string[] = [];
  for (const r of roots) {
    const base = path.join(sitePath, r);
    const rec = (dir: string, depth: number) => {
      if (depth > 3 || out.length > 200) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) rec(abs, depth + 1);
        else if (ASSET_EXT.has(path.extname(e.name).toLowerCase())) {
          out.push('/' + path.relative(base, abs).split(path.sep).join('/'));
        }
      }
    };
    rec(base, 0);
  }
  return out;
}

// ─────────────────────────────────────────────────────────── detector: stack

interface Stack {
  framework: SiteFramework;
  name: string;
  buildCmd: string;
  ui: string[];
  cssLibs: string[];
}

function detectStack(sitePath: string, framework: SiteFramework): Stack {
  const out: Stack = {
    framework,
    name: path.basename(sitePath),
    buildCmd: '',
    ui: [],
    cssLibs: [],
  };
  let pkg: any = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(sitePath, 'package.json'), 'utf-8'));
  } catch {
    return out;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  out.name = pkg.name || out.name;
  out.buildCmd = pkg.scripts?.build ?? '';
  out.ui = ['react', 'vue', 'svelte', 'preact', 'solid-js', '@astrojs/react', '@astrojs/vue'].filter((d) => deps[d]);
  out.cssLibs = ['tailwindcss', 'unocss', 'bootstrap', 'bulma', 'sass', 'styled-components', '@emotion/react']
    .filter((d) => deps[d]);
  return out;
}

// ──────────────────────────────────────────── detector: design token (CSS vars)
// È il caso più frequente sui siti reali dei clienti: niente framework CSS, ma
// un blocco `:root { --color-... }` dentro un layout o un css globale.

interface TokenGroup {
  label: string;
  prefix: string;
  vars: Array<{ name: string; value: string }>;
}

function detectCssVars(files: ScanFile[]): { source: string; groups: TokenGroup[]; total: number } {
  const seen = new Map<string, string>();
  let source = '';
  for (const f of files) {
    for (const block of f.src.match(/:root[^{]*\{[^}]*\}/g) ?? []) {
      for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        if (seen.has(m[1])) continue;
        seen.set(m[1], m[2].trim());
        if (!source) source = f.rel;
      }
    }
  }
  const groups: TokenGroup[] = [
    { label: 'Colori', prefix: '--color', vars: [] },
    { label: 'Tipografia', prefix: '--font', vars: [] },
    { label: 'Spaziature', prefix: '--space', vars: [] },
    { label: 'Raggi', prefix: '--radius', vars: [] },
    { label: 'Ombre', prefix: '--shadow', vars: [] },
    { label: 'Transizioni', prefix: '--ease', vars: [] },
  ];
  const other: TokenGroup = { label: 'Altri token', prefix: '', vars: [] };
  for (const [name, value] of seen) {
    const g = groups.find((x) => name.startsWith(x.prefix));
    (g ?? other).vars.push({ name, value });
  }
  if (other.vars.length) groups.push(other);
  return { source, groups: groups.filter((g) => g.vars.length > 0), total: seen.size };
}

function detectTailwind(sitePath: string): { file: string; theme: string } | null {
  const cfg = ['tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs', 'tailwind.config.ts']
    .find((c) => fs.existsSync(path.join(sitePath, c)));
  if (!cfg) return null;
  let src = '';
  try {
    src = fs.readFileSync(path.join(sitePath, cfg), 'utf-8');
  } catch {
    return null;
  }
  // `theme` intero: è lì che vivono i token del brand (colors, fontFamily, spacing).
  const start = src.search(/theme\s*:\s*\{/);
  let theme = '';
  if (start >= 0) {
    let depth = 0;
    let i = src.indexOf('{', start);
    const from = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    theme = src.slice(from, i + 1);
  }
  return { file: cfg, theme: theme.slice(0, 1500) };
}

function detectFonts(files: ScanFile[]): string[] {
  const fonts = new Set<string>();
  const generic = /^(inherit|initial|unset|system-ui|sans-serif|serif|monospace|cursive|ui-sans-serif|ui-serif|ui-monospace|-apple-system)$/;
  for (const f of files) {
    for (const m of f.src.matchAll(/fonts\.googleapis\.com\/css2\?family=([^&"'\s]+)/g)) {
      fonts.add(decodeURIComponent(m[1]).split(':')[0].replace(/\+/g, ' '));
    }
    for (const m of f.src.matchAll(/font-family\s*:\s*([^;{]+)[;}]/g)) {
      const first = m[1].split(',')[0].trim().replace(/["']/g, '');
      if (first && !first.startsWith('var(') && !generic.test(first)) fonts.add(first);
    }
  }
  return [...fonts].slice(0, 6);
}

// ───────────────────────────────────── detector: componenti / layout riusabili

interface ComponentInfo {
  rel: string;
  name: string;
  props: string[];
}

function detectComponents(files: ScanFile[]): ComponentInfo[] {
  const out: ComponentInfo[] = [];
  for (const f of files) {
    const unix = f.rel.split(path.sep).join('/');
    if (!/(^|\/)(components|layouts|widgets|blocks|sections|partials)\//i.test(unix)) continue;
    if (!['.astro', '.vue', '.svelte', '.jsx', '.tsx'].includes(f.ext)) continue;
    const props: string[] = [];
    const iface = f.src.match(/interface\s+Props\s*\{([^}]*)\}/);
    if (iface) {
      for (const line of iface[1].split('\n')) {
        const t = line.trim().replace(/;$/, '').replace(/\/\/.*$/, '').trim();
        if (t) props.push(t);
      }
    } else {
      // Vue/Svelte/React: defineProps({...}) o destructuring delle props.
      const dp = f.src.match(/defineProps<?\s*[({<]([^)}>]*)/);
      if (dp) {
        for (const t of dp[1].split(',')) {
          const c = t.trim().replace(/:.*$/, '').replace(/["']/g, '');
          if (c) props.push(c);
        }
      }
    }
    out.push({ rel: unix, name: path.basename(f.rel, f.ext), props: props.slice(0, 8) });
  }
  return out.slice(0, 40);
}

// ──────────────────────────────────────────────────── detector: route/pagine

interface RouteInfo {
  route: string;
  rel: string;
  title: string;
  lines: number;
}

function detectRoutes(files: ScanFile[], framework: SiteFramework): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const f of files) {
    const unix = f.rel.split(path.sep).join('/');
    let route = '';
    if ((framework === 'astro' || framework === 'vite') && /^src\/pages\//.test(unix)) {
      route = '/' + unix.replace(/^src\/pages\//, '').replace(/(^|\/)index\.(astro|md|mdx|html)$/, '$1').replace(/\.(astro|md|mdx|html)$/, '');
    } else if (framework === 'html' && /^[^/]*\.html$/.test(unix)) {
      route = '/' + unix.replace(/index\.html$/, '');
    } else {
      continue;
    }
    // Il titolo va cercato SOLO in <title> o nella prop del layout: un
    // `title = ...` generico peschebbe la prima assegnazione JS della pagina
    // (es. una stringa di template dentro uno <script>), che non è il titolo.
    const title =
      f.src.match(/<title>([^<{]+)<\/title>/)?.[1] ??
      f.src.match(/<Layout[^>]*\stitle=["']([^"']+)["']/)?.[1] ??
      '';
    out.push({
      route: route.length > 1 ? route.replace(/\/$/, '') : '/',
      rel: unix,
      title: title.trim(),
      lines: f.src.split('\n').length,
    });
  }
  return out.sort((a, b) => a.route.localeCompare(b.route)).slice(0, 30);
}

// ────────────────────────────── detector: vocabolario delle classi CSS
// Distinzione importante: una classe usata in PIÙ pagine è vocabolario condiviso
// (`.container`, `.btn`) e va riusata; una usata in una pagina sola è specifica di
// quella pagina. Senza questa separazione le classi di una dashboard interna
// finiscono nei suggerimenti per la home, inducendo riuso sbagliato.

interface ClassVocabulary {
  shared: Array<{ name: string; uses: number; pages: number }>;
  perFile: Array<{ rel: string; classes: string[] }>;
}

function detectClassVocabulary(files: ScanFile[], routes: RouteInfo[]): ClassVocabulary {
  const definedGlobally = new Set<string>();
  const usageByFile = new Map<string, Map<string, number>>();

  for (const f of files) {
    // Classi DEFINITE: in un .css qualsiasi, o in <style is:global>.
    if (f.ext === '.css' || f.ext === '.scss') {
      for (const m of f.src.matchAll(/\.([a-zA-Z][\w-]*)\s*[,{:.\s]/g)) definedGlobally.add(m[1]);
    }
    for (const m of f.src.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)) {
      if (!/is:global|global/.test(m[1])) continue;
      for (const c of m[2].matchAll(/\.([a-zA-Z][\w-]*)\s*[,{:.\s]/g)) definedGlobally.add(c[1]);
    }
    // Classi USATE nel markup (fuori dai blocchi <style>/<script>).
    const markup = f.src.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    const perFile = new Map<string, number>();
    for (const m of markup.matchAll(/class(?:Name)?=["']([^"']+)["']/g)) {
      for (const c of m[1].split(/\s+/)) {
        if (!c || c.includes('{') || c.includes('$')) continue;
        perFile.set(c, (perFile.get(c) ?? 0) + 1);
      }
    }
    if (perFile.size) usageByFile.set(f.rel.split(path.sep).join('/'), perFile);
  }

  const totals = new Map<string, { uses: number; pages: number }>();
  for (const [, perFile] of usageByFile) {
    for (const [c, n] of perFile) {
      const cur = totals.get(c) ?? { uses: 0, pages: 0 };
      cur.uses += n;
      cur.pages += 1;
      totals.set(c, cur);
    }
  }

  const shared = [...totals.entries()]
    .filter(([c, t]) => t.pages >= 2 && definedGlobally.has(c))
    .map(([name, t]) => ({ name, uses: t.uses, pages: t.pages }))
    .sort((a, b) => b.pages - a.pages || b.uses - a.uses)
    .slice(0, 30);

  const sharedNames = new Set(shared.map((s) => s.name));
  const perFile = routes
    .map((r) => {
      const u = usageByFile.get(r.rel);
      if (!u) return { rel: r.rel, classes: [] as string[] };
      const own = [...u.entries()]
        .filter(([c, n]) => !sharedNames.has(c) && n >= 2 && definedGlobally.has(c))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([c]) => c);
      return { rel: r.rel, classes: own };
    })
    .filter((x) => x.classes.length > 0);

  return { shared, perFile };
}

// ─────────────────────────── detector: stampo di una sezione rappresentativa
// È il pezzo che serve davvero quando l'utente dice "aggiungi una sezione":
// senza uno stampo il modello inventa un <section> con classi proprie, che sul
// sito appare largo tutto schermo e senza animazione di entrata.

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'path', 'circle', 'polygon', 'use']);

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

// Firma di un elemento per riconoscere fratelli ripetuti. I suffissi numerici
// vengono normalizzati, altrimenti `reveal-delay-1` e `reveal-delay-2` sembrano
// blocchi diversi e la lista non collassa mai.
function signatureOf(line: string): string {
  const tag = line.trim().match(/^<\/?([a-zA-Z][\w-]*)/)?.[1] ?? '?';
  const cls = line.match(/class(?:Name)?=["']([^"']*)["']/)?.[1] ?? '';
  return tag + '|' + cls.replace(/\d+/g, 'N');
}

function normalizeMarkup(src: string): string[] {
  let s = src
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Le icone SVG inline sono decine di righe di path: struttura zero, rumore molto.
    .replace(/<svg[\s\S]*?<\/svg>/g, '<svg><!-- icona --></svg>');
  const out: string[] = [];
  let pending = '';
  for (const raw of s.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    // Tag aperto su più righe (attributi incolonnati): ricompattalo in una riga.
    const joined = pending ? pending + ' ' + line.trim() : line;
    const opens = (joined.match(/</g) ?? []).length;
    const closes = (joined.match(/>/g) ?? []).length;
    if (opens > closes) {
      pending = joined;
      continue;
    }
    pending = '';
    out.push(joined);
  }
  if (pending) out.push(pending);
  return out;
}

function blockEnd(lines: string[], i: number, limit: number): number {
  const line = lines[i].trim();
  const depth = indentOf(lines[i]);
  if (line.startsWith('</') || line.endsWith('/>')) return i;
  const tag = line.match(/^<([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase() ?? '';
  if (VOID_TAGS.has(tag)) return i;
  if (new RegExp(`</${tag}>`).test(line)) return i; // apre e chiude sulla stessa riga
  for (let j = i + 1; j <= limit; j++) {
    const d = indentOf(lines[j]);
    if (d < depth) return j - 1;
    if (d === depth && lines[j].trim().startsWith('</')) return j;
  }
  return limit;
}

function collapseSiblings(lines: string[], from: number, to: number, out: string[], depthLeft: number): void {
  let i = from;
  while (i <= to) {
    const end = Math.min(blockEnd(lines, i, to), to);
    const sig = signatureOf(lines[i]);
    const ind = indentOf(lines[i]);
    // Quanti fratelli consecutivi identici seguono?
    let count = 1;
    let j = end + 1;
    while (j <= to && indentOf(lines[j]) === ind && signatureOf(lines[j]) === sig) {
      j = Math.min(blockEnd(lines, j, to), to) + 1;
      count++;
    }
    out.push(lines[i]);
    if (end > i) {
      if (depthLeft > 0) collapseSiblings(lines, i + 1, end - 1, out, depthLeft - 1);
      else out.push(' '.repeat(ind + 2) + '<!-- … -->');
      if (lines[end].trim().startsWith('</')) out.push(lines[end]);
    }
    if (count > 1) out.push(' '.repeat(ind) + `<!-- ↑ ×${count} blocchi uguali -->`);
    i = j;
  }
}

function extractSectionSkeleton(files: ScanFile[], routes: RouteInfo[]): { rel: string; count: number; skeleton: string } | null {
  // La pagina più lunga è quasi sempre la home / landing: è lì che vive il pattern.
  const target = routes.slice().sort((a, b) => b.lines - a.lines)[0];
  if (!target) return null;
  const file = files.find((f) => f.rel.split(path.sep).join('/') === target.rel);
  if (!file) return null;

  const lines = normalizeMarkup(file.src);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*<section[\s>]/.test(l)) starts.push(i);
  });
  if (!starts.length) return null;

  const ranges = starts
    .map((s) => ({ s, e: blockEnd(lines, s, lines.length - 1) }))
    .map((r) => ({ ...r, len: r.e - r.s }))
    .filter((r) => r.len > 3)
    .sort((a, b) => a.len - b.len);
  if (!ranges.length) return null;
  const pick = ranges[Math.floor(ranges.length / 2)]; // la sezione "mediana" = la più tipica

  const body: string[] = [];
  collapseSiblings(lines, pick.s + 1, pick.e - 1, body, 4);

  const stripText = (l: string) =>
    l.replace(/>([^<>]{2,})</g, (_m, t) => '>' + (t.trim().length > 24 ? '…' : t.trim()) + '<');

  const skeleton = [lines[pick.s], ...body, lines[pick.e]]
    .map(stripText)
    .map((l) => (l.length > 160 ? l.slice(0, 157) + '…' : l))
    .join('\n');

  return { rel: target.rel, count: starts.length, skeleton: skeleton.slice(0, 2200) };
}

// ───────────────────────────────────────────────── storico (DB, non filesystem)
// Risponde a "cosa è già stato fatto qui": è ciò che permette all'utente che
// torna dopo giorni di dire "riprendi quella cosa di ieri" senza rispiegarla.

function buildHistory(siteId: number): string[] {
  const L: string[] = [];
  let prompts: Array<{ content: string; created_at: string }> = [];
  let revisions: Array<{ summary: string | null; user_prompt: string; files_changed: string; created_at: string }> = [];
  try {
    prompts = listChatMessages(siteId, 60).filter((m) => m.role === 'user');
    revisions = listRevisionsBySite(siteId, 20) as any;
  } catch {
    return L; // DB non disponibile: il digest resta valido senza storico
  }
  if (!prompts.length && !revisions.length) return L;

  L.push('## Storico del sito');
  L.push('');
  L.push(
    'Sessioni precedenti (la chat non viene conservata tra una sessione e l\'altra: questo è il riassunto).',
  );
  L.push('');

  if (prompts.length) {
    L.push('**Ultime richieste dell\'utente**, dalla più recente:');
    for (const p of prompts.slice(0, 8)) {
      const day = (p.created_at || '').slice(0, 10);
      const text = p.content.replace(/\s+/g, ' ').trim();
      L.push(`- ${day} — "${text.length > 120 ? text.slice(0, 117) + '…' : text}"`);
    }
    L.push('');
  }

  if (revisions.length) {
    const touched = new Map<string, number>();
    for (const r of revisions) {
      let files: string[] = [];
      try {
        files = JSON.parse(r.files_changed || '[]');
      } catch {
        files = [];
      }
      for (const f of files) touched.set(f, (touched.get(f) ?? 0) + 1);
    }
    const top = [...touched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) {
      L.push('**File modificati più spesso:** ' + top.map(([f, n]) => `\`${f}\` (${n})`).join(', ') + '.');
      L.push('');
    }
    const last = revisions[0];
    if (last) {
      L.push(`**Ultima modifica applicata** (${(last.created_at || '').slice(0, 10)}): ${last.summary || last.user_prompt}`);
      L.push('');
    }
  }
  return L;
}

// ─────────────────────────────────────────────────────────────────── digest

export interface SiteContextInput {
  sitePath: string;
  siteId: number;
  slug: string;
  framework: SiteFramework;
}

export interface SiteContextResult {
  markdown: string;
  cached: boolean;
  filesScanned: number;
  chars: number;
  ms: number;
}

// Cache per-sito: il digest è deterministico, quindi va ricalcolato solo se
// qualcosa è cambiato. Chiave = mtime massimo + numero file + ultimo id di
// chat/revisione. Costo del check: una walk del filesystem (già fatta), niente
// di più — è il parsing e il rendering che ci si risparmia.
const cache = new Map<string, { key: string; markdown: string; filesScanned: number }>();

function historyKey(siteId: number): string {
  try {
    const c = listChatMessages(siteId, 1)[0];
    const r = listRevisionsBySite(siteId, 1)[0];
    return `${c ? c.id : 0}:${r ? r.id : 0}`;
  } catch {
    return '0:0';
  }
}

export function buildSiteContext(input: SiteContextInput): SiteContextResult {
  const t0 = Date.now();
  const files: ScanFile[] = [];
  walk(input.sitePath, input.sitePath, files, 0);

  const maxMtime = files.reduce((m, f) => (f.mtimeMs > m ? f.mtimeMs : m), 0);
  const key = `${files.length}:${Math.round(maxMtime)}:${historyKey(input.siteId)}`;
  const hit = cache.get(input.slug);
  if (hit && hit.key === key) {
    return { markdown: hit.markdown, cached: true, filesScanned: hit.filesScanned, chars: hit.markdown.length, ms: Date.now() - t0 };
  }

  const stack = detectStack(input.sitePath, input.framework);
  const tailwind = detectTailwind(input.sitePath);
  const cssVars = detectCssVars(files);
  const fonts = detectFonts(files);
  const components = detectComponents(files);
  const routes = detectRoutes(files, input.framework);
  const vocabulary = detectClassVocabulary(files, routes);
  const skeleton = extractSectionSkeleton(files, routes);
  const assets = listAssets(input.sitePath);

  const L: string[] = [];
  L.push(`# Contesto del sito "${input.slug}"`);
  L.push('');
  L.push(
    'Scheda generata automaticamente dai file del progetto a ogni sessione: è lo stato di ADESSO. ' +
      'Leggila prima di modificare o creare qualcosa, evita di riesplorare da capo ciò che è già scritto qui.',
  );
  L.push('');
  L.push(
    `Progetto **${stack.name}** · framework **${stack.framework}**` +
      (stack.ui.length ? ` · UI: ${stack.ui.join(', ')}` : '') +
      (stack.buildCmd ? ` · build: \`${stack.buildCmd}\`` : ''),
  );
  L.push('');

  // ── Sistema di stile (la sezione più importante: guida ogni scelta visiva)
  L.push('## Sistema di stile');
  L.push('');
  if (tailwind) {
    L.push(`Tailwind CSS, configurato in \`${tailwind.file}\`. Usa **solo** le utility e i token del theme:`);
    if (tailwind.theme) {
      L.push('```js');
      L.push(tailwind.theme);
      L.push('```');
    }
    L.push('Non scrivere CSS custom se esiste già la utility Tailwind equivalente.');
  } else if (cssVars.total > 0) {
    L.push(
      `Nessun framework CSS. Il design system è fatto di **CSS custom properties** definite in \`${cssVars.source}\` ` +
        `(${cssVars.total} token).`,
    );
    L.push('');
    L.push('**Usa sempre `var(--nome)`, mai colori o misure hardcoded.**');
    for (const g of cssVars.groups) {
      L.push('');
      L.push(`*${g.label}*`);
      L.push('```css');
      for (const v of g.vars.slice(0, 24)) L.push(`${v.name}: ${v.value};`);
      if (g.vars.length > 24) L.push(`/* … +${g.vars.length - 24} */`);
      L.push('```');
    }
  } else if (stack.cssLibs.length) {
    L.push(`Librerie CSS in uso: ${stack.cssLibs.join(', ')}. Attieniti alle loro convenzioni.`);
  } else {
    L.push(
      'Nessun design system rilevato (né Tailwind né custom properties). Prima di scrivere stile nuovo, ' +
        'leggi un file esistente e imita le convenzioni che trovi lì.',
    );
  }
  if (fonts.length) {
    L.push('');
    L.push(`**Font del sito:** ${fonts.join(', ')}. Non introdurne altri.`);
  }
  L.push('');

  // ── Componenti
  L.push('## Componenti e layout riusabili');
  L.push('');
  if (components.length) {
    for (const c of components.slice(0, 25)) {
      L.push(`- \`${c.rel}\` — **${c.name}**` + (c.props.length ? ` · props: ${c.props.join(', ')}` : ''));
    }
    if (components.length > 25) L.push(`- … +${components.length - 25} altri`);
    L.push('');
    L.push('Riusa questi componenti invece di riscrivere markup equivalente a mano.');
  } else {
    L.push(
      'Il progetto non ha una cartella di componenti: le pagine sono monolitiche. ' +
        'Segui questa convenzione, **non** introdurre una struttura a componenti di tua iniziativa.',
    );
  }
  L.push('');

  // ── Vocabolario classi
  if (vocabulary.shared.length) {
    L.push('## Classi CSS condivise tra più pagine');
    L.push('');
    L.push(vocabulary.shared.map((c) => `\`.${c.name}\``).join(' · '));
    L.push('');
    L.push('Questo è il vocabolario del sito: riusalo invece di inventare nomi nuovi o scrivere stile inline.');
    L.push('');
  }
  if (vocabulary.perFile.length) {
    if (!vocabulary.shared.length) {
      L.push('## Classi CSS già definite, per pagina');
      L.push('');
    }
    L.push(
      'Classi usate da una sola pagina: quando modifichi quella pagina riusa le sue, ' +
        'e non trasferirle su altre pagine.',
    );
    L.push('');
    for (const p of vocabulary.perFile.slice(0, 6)) {
      L.push(`- \`${p.rel}\`: ${p.classes.map((c) => `\`.${c}\``).join(', ')}`);
    }
    L.push('');
  }

  // ── Pagine
  if (routes.length) {
    L.push('## Pagine');
    L.push('');
    for (const r of routes) {
      L.push(`- \`${r.route}\` → \`${r.rel}\`` + (r.title ? ` — "${r.title}"` : '') + ` (${r.lines} righe)`);
    }
    L.push('');
  }

  // ── Stampo di sezione
  if (skeleton) {
    L.push('## Struttura tipica di una sezione');
    L.push('');
    L.push(
      `\`${skeleton.rel}\` contiene ${skeleton.count} sezioni. Quando devi **aggiungere una sezione**, ` +
        'ricalca questo stampo (stesso annidamento, stesse classi di struttura e di animazione):',
    );
    L.push('```html');
    L.push(skeleton.skeleton);
    L.push('```');
    L.push('');
  }

  // ── Asset
  if (assets.length) {
    L.push(`## Immagini e asset già presenti (${assets.length})`);
    L.push('');
    L.push(assets.slice(0, 20).map((a) => `\`${a}\``).join(' · ') + (assets.length > 20 ? ` · … +${assets.length - 20}` : ''));
    L.push('');
    L.push('Prima di generare un\'immagine nuova, verifica se una di queste va già bene.');
    L.push('');
  }

  // ── Storico
  L.push(...buildHistory(input.siteId));

  let markdown = L.join('\n').replace(/\n{3,}/g, '\n\n');
  if (markdown.length > CHAR_BUDGET) {
    markdown = markdown.slice(0, CHAR_BUDGET) + '\n\n*(scheda troncata: sito molto grande)*\n';
  }

  cache.set(input.slug, { key, markdown, filesScanned: files.length });
  return { markdown, cached: false, filesScanned: files.length, chars: markdown.length, ms: Date.now() - t0 };
}

// Copia ispezionabile della scheda dentro il sito, così l'agenzia può leggere
// (e verificare) esattamente ciò che l'agente sa. NON deve finire nei commit del
// cliente: esclusa via `.git/info/exclude`, che è locale al clone e — a differenza
// di .gitignore — non è un file tracciato, quindi non sporca i diff né il publish.
export function writeSiteContextFile(sitePath: string, markdown: string): void {
  try {
    const dir = path.join(sitePath, '.tharvel');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'context.md'), markdown, 'utf-8');

    const excludePath = path.join(sitePath, '.git', 'info', 'exclude');
    if (fs.existsSync(path.dirname(excludePath))) {
      let current = '';
      try {
        current = fs.readFileSync(excludePath, 'utf-8');
      } catch {
        current = '';
      }
      if (!current.split('\n').some((l) => l.trim() === '.tharvel/')) {
        fs.writeFileSync(excludePath, current + (current.endsWith('\n') || !current ? '' : '\n') + '.tharvel/\n', 'utf-8');
      }
    }
  } catch (e) {
    console.warn('[CONTEXT] impossibile scrivere .tharvel/context.md:', e);
  }
}
