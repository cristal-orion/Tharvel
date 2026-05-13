// URL builder per il backend Tharvel.
//
// In prod il proxy Coolify/Traefik intercetta /tharveladmin/* e lo strippa prima
// di inoltrare al container; in dev parliamo direttamente con Express :3000 senza
// proxy, quindi nessun prefisso.
//
// Lo slug attivo NON è più letto dalla query string (era una vulnerabilità: un
// client poteva cambiarlo a mano). Vedi Strato 4 (auth) in
// progetto-tharvel-security.md: lo slug viene dal token di sessione via useAuth.

const isDev = import.meta.env.DEV;
const envBase = import.meta.env.VITE_SERVER_BASE as string | undefined;
export const SERVER_BASE = envBase || (isDev ? 'http://localhost:3000' : window.location.origin);
export const BASE_PATH = isDev ? '' : '/tharveladmin';

export function buildSiteBase(slug: string): string {
  return `${SERVER_BASE}${BASE_PATH}/site/${slug}`;
}

export function buildWsUrl(slug: string): string {
  const wsProto = SERVER_BASE.startsWith('https') ? 'wss' : 'ws';
  const wsHost = SERVER_BASE.replace(/^https?:\/\//, '');
  // WS auth via cookie httpOnly automaticamente inviato dal browser sullo stesso origin.
  // Lo slug nella query è informativo (il server lo ignora per role=client a favore del
  // token); resta utile per debug nei log del server e per il flow admin.
  return `${wsProto}://${wsHost}${BASE_PATH}/?site=${encodeURIComponent(slug)}`;
}

export function apiUrl(path: string): string {
  return `${SERVER_BASE}${BASE_PATH}${path}`;
}
