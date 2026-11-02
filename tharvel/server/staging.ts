// Ambiente di staging (THARVEL_STAGING=1): copia di produzione che gira con le
// stesse credenziali GitHub App e Coolify. Tutto ciò che scriverebbe su sistemi
// esterni viene simulato:
//   - push sui repo dei clienti (= deploy dei loro siti) → `git push --dry-run`,
//     che verifica credenziali e fast-forward senza aggiornare il remote
//   - domini e restart dell'app Tharvel su Coolify → solo log
// Il resto (fetch da GitHub, commit locali, DB) lavora sulla copia dello staging.

export const IS_STAGING = process.env.THARVEL_STAGING === '1';

export const STAGING_PUBLISH_NOTE =
  'STAGING: pubblicazione simulata (git push --dry-run), il sito online non è cambiato.';
