import { getDb } from './index.js';

export type SiteFramework = 'html' | 'astro';

export interface Site {
  id: number;
  slug: string;
  domain: string | null;
  cwd_path: string;
  framework: SiteFramework;
  repo_url: string | null;
  preview_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewSite {
  slug: string;
  domain?: string | null;
  cwd_path: string;
  framework?: SiteFramework;
  repo_url?: string | null;
  preview_url?: string | null;
}

export function getSiteBySlug(slug: string): Site | null {
  return (getDb().prepare('SELECT * FROM sites WHERE slug = ?').get(slug) as Site | undefined) ?? null;
}

export function getSiteByDomain(domain: string): Site | null {
  return (getDb().prepare('SELECT * FROM sites WHERE domain = ?').get(domain) as Site | undefined) ?? null;
}

export function listSites(): Site[] {
  return getDb().prepare('SELECT * FROM sites ORDER BY id ASC').all() as Site[];
}

export function createSite(input: NewSite): Site {
  const stmt = getDb().prepare(`
    INSERT INTO sites (slug, domain, cwd_path, framework, repo_url, preview_url)
    VALUES (@slug, @domain, @cwd_path, @framework, @repo_url, @preview_url)
    RETURNING *
  `);
  return stmt.get({
    slug: input.slug,
    domain: input.domain ?? null,
    cwd_path: input.cwd_path,
    framework: input.framework ?? 'html',
    repo_url: input.repo_url ?? null,
    preview_url: input.preview_url ?? null,
  }) as Site;
}

export function upsertSiteBySlug(input: NewSite): Site {
  const existing = getSiteBySlug(input.slug);
  if (existing) return existing;
  return createSite(input);
}
