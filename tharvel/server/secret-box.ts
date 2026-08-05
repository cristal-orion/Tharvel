// Cifratura reversibile per i segreti che devono restare RILEGGIBILI in chiaro.
// Oggi un solo caso d'uso: la password del pannello cliente, che l'admin deve poter
// rigirare al cliente anche mesi dopo l'onboarding.
//
// Perché non basta l'hash Argon2id del login: un hash non è reversibile. L'admin ha
// bisogno di rimandare al cliente LA password che ha in mano, non una nuova (che
// invaliderebbe quella già consegnata).
//
// Perché non in chiaro nel DB: tharvel.db sta su un volume che finisce nei backup, e
// una copia del file darebbe accesso ai pannelli di TUTTI i clienti. Qui il DB
// contiene solo ciphertext: la chiave vive nell'env del container.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';

let cachedKey: Buffer | null = null;

// Chiave derivata da THARVEL_SECRET_KEY se presente, altrimenti dal JWT_SECRET che è
// già configurato su ogni istanza: così la feature non richiede una env var nuova.
// L'HKDF con `info` dedicata garantisce che questa chiave NON coincida con quella che
// firma le sessioni: comprometterne una non regala l'altra.
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.THARVEL_SECRET_KEY || process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'Nessun segreto disponibile per cifrare (THARVEL_SECRET_KEY o JWT_SECRET, min 16 caratteri).',
    );
  }
  cachedKey = Buffer.from(hkdfSync('sha256', secret, 'tharvel-secret-box', 'password-recovery-v1', 32));
  return cachedKey;
}

// Formato: v1.<iv>.<authTag>.<ciphertext>, tutto base64url.
// Il prefisso di versione serve a poter cambiare algoritmo senza ambiguità sui dati
// già scritti.
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

// Ritorna null invece di lanciare: un segreto illeggibile (JWT_SECRET ruotato, riga
// scritta prima di questa feature, dato corrotto) non deve rompere la schermata che
// lo mostra. L'admin vedrà "non recuperabile" e potrà rigenerare la password.
export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

// Wrapper non fatale: cifrare è un "nice to have" rispetto al salvare l'hash. Se il
// segreto manca preferiamo una password non recuperabile a un reset che falla.
export function trySeal(plain: string): string | null {
  try {
    return seal(plain);
  } catch (e: any) {
    console.warn(`[secret-box] impossibile cifrare il segreto: ${e?.message ?? e}`);
    return null;
  }
}
