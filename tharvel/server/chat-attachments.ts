// Immagini allegate a un messaggio in chat (canale distinto dall'upload "+").
//
// Il modello le riceve come input visivo, ma da sole non bastano: per "metti
// questa foto al posto di…" l'agente ha bisogno di un file vero da copiare nel
// sito. Le salviamo in `.tharvel/attachments/`, che è esclusa da git (vedi
// ensureTharvelDirExcluded) e non è servita dalla preview (dotfile): non finiscono
// negli Assets né nei commit finché l'agente non le copia lui dove servono.

import fs from 'fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ensureTharvelDirExcluded } from './site-context.js';

const ATTACHMENTS_REL = '.tharvel/attachments';

// Gli allegati servono per il turno in cui arrivano: oltre un giorno sono solo
// spazio occupato.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ChatImage {
  data: string; // base64
  mimeType: string;
}

async function pruneOld(dir: string): Promise<void> {
  const now = Date.now();
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile() && now - stat.mtimeMs > MAX_AGE_MS) await fs.rm(file, { force: true });
  }
}

// Ritorna i path relativi al sito dei file salvati (stesso ordine delle immagini).
export async function saveChatAttachments(sitePath: string, images: ChatImage[]): Promise<string[]> {
  const dir = path.join(sitePath, ATTACHMENTS_REL);
  await fs.mkdir(dir, { recursive: true });
  ensureTharvelDirExcluded(sitePath);
  await pruneOld(dir);

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const saved: string[] = [];
  for (const [i, img] of images.entries()) {
    const buffer = Buffer.from(img.data, 'base64');
    const base = `chat-${stamp}-${i + 1}`;
    // Raster → webp come l'upload "+", così la copia nel sito è già leggera.
    // SVG e GIF restano come sono (vettoriale / animazione).
    const keepAsIs = /svg|gif/.test(img.mimeType);
    const ext = keepAsIs ? (img.mimeType.includes('svg') ? 'svg' : 'gif') : 'webp';
    const file = path.join(dir, `${base}.${ext}`);
    if (keepAsIs) await fs.writeFile(file, buffer);
    else await sharp(buffer).webp({ quality: 80 }).toFile(file);
    saved.push(`${ATTACHMENTS_REL}/${base}.${ext}`);
  }
  return saved;
}
