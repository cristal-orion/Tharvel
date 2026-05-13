// Single source of truth per slug e URLs lato UI.
// Lo slug viene letto dalla query string della pagina admin (es. /?site=acme),
// con fallback su 'demo' per dev rapido.

const params = new URLSearchParams(window.location.search);
export const SITE_SLUG = params.get('site') || 'demo';

// In dev (vite :5173) il server gira su :3000 → fallback hardcoded.
// In prod (single-container Coolify) UI e API stanno sullo stesso origin.
// Override esplicito possibile via VITE_SERVER_BASE.
const isDev = import.meta.env.DEV;
const envBase = import.meta.env.VITE_SERVER_BASE as string | undefined;
export const SERVER_BASE = envBase || (isDev ? 'http://localhost:3000' : window.location.origin);

// Prefix su cui Tharvel è montato sul dominio del cliente (vedi server/index.ts
// e ui/vite.config.ts: deve coincidere ovunque). In dev punta allo stesso path
// perché lo stesso server Express applica il mount anche con :3000.
const BASE_PATH = '/tharveladmin';
export const SITE_BASE = `${SERVER_BASE}${BASE_PATH}/site/${SITE_SLUG}`;

const wsProto = SERVER_BASE.startsWith('https') ? 'wss' : 'ws';
const wsHost = SERVER_BASE.replace(/^https?:\/\//, '');
export const WS_URL = `${wsProto}://${wsHost}${BASE_PATH}/?site=${encodeURIComponent(SITE_SLUG)}`;
