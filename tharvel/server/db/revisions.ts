import { getDb } from './index.js';

export type RevisionKind = 'turn' | 'publish';

export interface SiteRevision {
  id: number;
  site_id: number;
  commit_sha: string;
  parent_sha: string | null;
  user_prompt: string;
  summary: string | null;
  files_changed: string;
  kind: RevisionKind;
  superseded_at: string | null;
  created_at: string;
}

export interface NewRevision {
  site_id: number;
  commit_sha: string;
  parent_sha?: string | null;
  user_prompt: string;
  summary?: string | null;
  files_changed: string[];
  kind?: RevisionKind;
}

export function insertRevision(input: NewRevision): SiteRevision {
  const stmt = getDb().prepare(`
    INSERT INTO site_revisions
      (site_id, commit_sha, parent_sha, user_prompt, summary, files_changed, kind)
    VALUES
      (@site_id, @commit_sha, @parent_sha, @user_prompt, @summary, @files_changed, @kind)
    RETURNING *
  `);
  return stmt.get({
    site_id: input.site_id,
    commit_sha: input.commit_sha,
    parent_sha: input.parent_sha ?? null,
    user_prompt: input.user_prompt,
    summary: input.summary ?? null,
    files_changed: JSON.stringify(input.files_changed),
    kind: input.kind ?? 'turn',
  }) as SiteRevision;
}

export function listRevisionsBySite(siteId: number, limit = 100): SiteRevision[] {
  return getDb()
    .prepare(
      `SELECT * FROM site_revisions
       WHERE site_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(siteId, limit) as SiteRevision[];
}

export function getRevisionById(id: number, siteId: number): SiteRevision | null {
  return (
    (getDb()
      .prepare('SELECT * FROM site_revisions WHERE id = ? AND site_id = ?')
      .get(id, siteId) as SiteRevision | undefined) ?? null
  );
}

// L'ultima revisione 'turn' ancora ripristinabile (no superseded_at, kind=turn).
export function getLastTurnRevision(siteId: number): SiteRevision | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM site_revisions
         WHERE site_id = ? AND kind = 'turn' AND superseded_at IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(siteId) as SiteRevision | undefined) ?? null
  );
}

// Cancella TUTTE le revisioni 'turn' con id >= fromId (incluso). Usato per
// restore esplicito: dopo `git reset --hard` allo stato precedente a fromId,
// le revisioni successive non esistono più nel git tree e vanno via dal DB.
export function deleteTurnsFromId(siteId: number, fromId: number): number {
  const res = getDb()
    .prepare(
      `DELETE FROM site_revisions
       WHERE site_id = ? AND kind = 'turn' AND id >= ?`,
    )
    .run(siteId, fromId);
  return res.changes;
}

// Dopo `git reset --hard` all'ultimo commit (annulla ultimo turn): cancella SOLO
// la riga della revisione che è stata buttata.
export function deleteRevisionById(id: number, siteId: number): boolean {
  const res = getDb()
    .prepare('DELETE FROM site_revisions WHERE id = ? AND site_id = ?')
    .run(id, siteId);
  return res.changes > 0;
}

// Al publish: marca come archiviate (non più ripristinabili da preview, perché
// preview viene resettato al main aggiornato) tutte le revisioni 'turn' pending
// del sito. Resta visibile in UI come storico pre-publish.
export function markTurnsAsSuperseded(siteId: number): number {
  const res = getDb()
    .prepare(
      `UPDATE site_revisions
       SET superseded_at = datetime('now')
       WHERE site_id = ? AND kind = 'turn' AND superseded_at IS NULL`,
    )
    .run(siteId);
  return res.changes;
}
