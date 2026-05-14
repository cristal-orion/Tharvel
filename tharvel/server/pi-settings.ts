// Helper per garantire la config Pi per-sito.
//
// Modello: il container Tharvel ha UN install di pi-package condiviso in
// /opt/pi-extensions/.pi/ (creato a build-time nel Dockerfile). Per ogni sito
// creiamo .pi/ con:
//   - .pi/npm  → SYMLINK a /opt/pi-extensions/.pi/npm (condivide node_modules)
//   - .pi/settings.json → FILE per-sito (può divergere in futuro)
//
// Override via env THARVEL_PI_SHARED_DIR per testing locale fuori dal container.

import fs from 'node:fs/promises';
import path from 'node:path';

const SHARED_PI_DIR = process.env.THARVEL_PI_SHARED_DIR || '/opt/pi-extensions/.pi';

interface PiSettings {
  packages: string[];
  [key: string]: unknown;
}

const DEFAULT_PACKAGES = ['npm:@capyup/pi-codex-image'];

// Idempotente. Da chiamare al boot della sessione di un sito + nell'onboarding.
// Ritorna { ok, message } per logging diagnostico, non lancia eccezioni:
// se il shared dir non esiste (es. dev locale senza Dockerfile), logga warning
// e continua — l'agente funzionerà senza il tool image_generation.
export async function ensurePiSettings(sitePath: string): Promise<{ ok: boolean; message: string }> {
  const sitePiDir = path.join(sitePath, '.pi');
  const sitePiSettings = path.join(sitePiDir, 'settings.json');
  const sitePiNpm = path.join(sitePiDir, 'npm');

  await fs.mkdir(sitePiDir, { recursive: true });

  // settings.json: scrivi se manca, mai sovrascrivere (così domani si può
  // tweakare per-sito senza che lo helper rilavi sopra).
  try {
    await fs.access(sitePiSettings);
  } catch {
    const settings: PiSettings = { packages: DEFAULT_PACKAGES };
    await fs.writeFile(sitePiSettings, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  // Symlink npm dir → shared install. Verifica che il target esista.
  try {
    await fs.access(SHARED_PI_DIR);
  } catch {
    return {
      ok: false,
      message: `shared pi dir ${SHARED_PI_DIR} non trovato — image_generation non disponibile`,
    };
  }
  const sharedNpmDir = path.join(SHARED_PI_DIR, 'npm');
  try {
    await fs.access(sharedNpmDir);
  } catch {
    return {
      ok: false,
      message: `${sharedNpmDir} non trovato — re-runare pi install nel build`,
    };
  }

  // Se esiste già un symlink, leggilo e validalo; se è un dir vera (es. legacy
  // pi install -l fatto a mano), salta — non sovrascriviamo lavoro manuale.
  try {
    const stat = await fs.lstat(sitePiNpm);
    if (stat.isSymbolicLink()) {
      const current = await fs.readlink(sitePiNpm);
      if (current === sharedNpmDir) {
        return { ok: true, message: 'già pronto' };
      }
      // Symlink punta altrove: ri-link.
      await fs.unlink(sitePiNpm);
      await fs.symlink(sharedNpmDir, sitePiNpm);
      return { ok: true, message: `symlink riallineato a ${sharedNpmDir}` };
    }
    // Directory reale: lascia stare, l'utente/onboarding ha fatto pi install -l.
    return { ok: true, message: '.pi/npm esiste come directory, skip symlink' };
  } catch {
    // Non esiste: crea symlink.
    await fs.symlink(sharedNpmDir, sitePiNpm);
    return { ok: true, message: `symlink creato → ${sharedNpmDir}` };
  }
}
