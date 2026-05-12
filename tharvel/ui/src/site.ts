// Single source of truth per slug e URLs lato UI.
// Lo slug viene letto dalla query string della pagina admin (es. http://localhost:5173/?site=acme),
// con fallback su 'demo' per dev rapido.

const params = new URLSearchParams(window.location.search);
export const SITE_SLUG = params.get('site') || 'demo';

export const SERVER_BASE = 'http://localhost:3000';
export const SITE_BASE = `${SERVER_BASE}/site/${SITE_SLUG}`;
export const WS_URL = `ws://localhost:3000/?site=${encodeURIComponent(SITE_SLUG)}`;
