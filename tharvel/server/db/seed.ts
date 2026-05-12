import { upsertSiteBySlug, listSites } from './sites.js';

// Seed idempotente per dev. In prod i siti si registrano via UI/CLI dedicata
// (ancora da costruire). Eseguibile via `npm run seed --workspace=server`.

const demo = upsertSiteBySlug({
  slug: 'demo',
  domain: 'localhost',
  cwd_path: 'demo', // relativo a THARVEL_SITES_ROOT
  framework: 'html',
  repo_url: null,
  preview_url: null,
});
console.log(`[SEED] demo site: id=${demo.id}, slug=${demo.slug}, framework=${demo.framework}`);

const restaurant = upsertSiteBySlug({
  slug: 'restaurant',
  domain: null,
  cwd_path: 'restaurant-astro',
  framework: 'astro',
  repo_url: 'https://github.com/jrgonzalez3/astro-site-example.git',
  preview_url: null,
});
console.log(`[SEED] restaurant site: id=${restaurant.id}, slug=${restaurant.slug}, framework=${restaurant.framework}`);

console.log(`[SEED] totale sites in DB: ${listSites().length}`);
