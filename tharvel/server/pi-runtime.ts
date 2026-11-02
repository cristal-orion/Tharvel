// ModelRuntime di Pi (catalogo modelli + credenziali di ~/.pi/agent/auth.json).
//
// Da Pi 0.80 sostituisce la coppia AuthStorage + ModelRegistry che creavamo a
// ogni connessione. Ne teniamo uno solo per processo: tutte le sessioni e gli
// endpoint admin vedono le stesse credenziali, e il rinnovo del token OAuth di
// Codex non viene fatto in parallelo da più istanze.

import { ModelRuntime } from '@earendil-works/pi-coding-agent';

let runtime: Promise<ModelRuntime> | null = null;

export function getModelRuntime(): Promise<ModelRuntime> {
  // Se la creazione fallisce (auth.json illeggibile, ecc.) non resta in cache
  // il rifiuto: la prossima connessione riprova.
  runtime ??= ModelRuntime.create().catch((error) => {
    runtime = null;
    throw error;
  });
  return runtime;
}
