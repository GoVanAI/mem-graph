import type Database from 'better-sqlite3';

const WIKILINK_RE = /\[\[([^\[\]]+?)\]\]/g;

/**
 * Extract all [[wikilink]] references from content. Returns raw references
 * as they appear in text (preserving original casing).
 */
export function extractWikilinks(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    out.push(m[1].trim());
  }
  return out;
}

/**
 * Generate a slug from a title. Lowercase, spaces and underscores to hyphens,
 * strip non-alphanumeric-hyphen chars.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Resolve a [[ref]] to a memory id, or null if broken.
 *
 * Resolution order:
 *  1. Raw id (if ref is numeric and exists)
 *  2. Case-insensitive title within the same project
 *  3. Case-insensitive slug within the same project
 *
 * Cross-project resolution is also tried as a final fallback, but the
 * same-project check is preferred.
 */
export function resolveWikilink(
  db: Database.Database,
  ref: string,
  currentProject: string,
): { id: number; project_id: string; matched_by: 'id' | 'title' | 'slug' } | null {
  // Step 1: raw id (if numeric)
  if (/^\d+$/.test(ref)) {
    const row = db
      .prepare('SELECT id, project_id FROM memories WHERE id = ?')
      .get(Number(ref)) as { id: number; project_id: string } | undefined;
    if (row) return { id: row.id, project_id: row.project_id, matched_by: 'id' };
  }

  // Step 2: title within current project
  const titleRow = db
    .prepare(
      'SELECT id, project_id FROM memories WHERE project_id = ? AND LOWER(title) = LOWER(?)',
    )
    .get(currentProject, ref) as { id: number; project_id: string } | undefined;
  if (titleRow) return { id: titleRow.id, project_id: titleRow.project_id, matched_by: 'title' };

  // Step 3: slug within current project
  const slug = slugify(ref);
  if (slug) {
    const slugRow = db
      .prepare(
        'SELECT id, project_id FROM memories WHERE project_id = ? AND slug = ?',
      )
      .get(currentProject, slug) as { id: number; project_id: string } | undefined;
    if (slugRow) return { id: slugRow.id, project_id: slugRow.project_id, matched_by: 'slug' };
  }

  // Step 4: cross-project fallback (title or slug) — wikilinks can reach across projects
  const crossTitle = db
    .prepare('SELECT id, project_id FROM memories WHERE LOWER(title) = LOWER(?) LIMIT 1')
    .get(ref) as { id: number; project_id: string } | undefined;
  if (crossTitle) return { id: crossTitle.id, project_id: crossTitle.project_id, matched_by: 'title' };

  if (slug) {
    const crossSlug = db
      .prepare('SELECT id, project_id FROM memories WHERE slug = ? LIMIT 1')
      .get(slug) as { id: number; project_id: string } | undefined;
    if (crossSlug) return { id: crossSlug.id, project_id: crossSlug.project_id, matched_by: 'slug' };
  }

  return null;
}

/**
 * Upsert a wikilink synapse. The composite PK is (source_id, target_id, connection_type),
 * so calling this multiple times for the same pair simply bumps the weight.
 *
 * Weights: insert at 1.0, on conflict add 0.5 (capped at 5.0).
 */
export function upsertWikilinkSynapse(
  db: Database.Database,
  sourceId: number,
  targetId: number,
  addition = 0.5,
): void {
  if (sourceId === targetId) return; // no self-loops
  db.prepare(
    `INSERT INTO synapses (source_id, target_id, connection_type, weight)
     VALUES (?, ?, 'wikilink', 1.0)
     ON CONFLICT(source_id, target_id, connection_type) DO UPDATE SET
         weight = MIN(5.0, weight + ?),
         updated_at = CURRENT_TIMESTAMP`,
  ).run(sourceId, targetId, addition);
}

/**
 * Remove wikilink synapses that no longer appear in the content.
 * Called from memory_update when content changes — keeps the synapse set
 * in sync with the explicit [[wikilinks]] the operator wrote.
 */
export function pruneStaleWikilinks(
  db: Database.Database,
  sourceId: number,
  newRefs: string[],
  currentProject: string,
): { removed: number; resolved: Array<{ ref: string; target_id: number; matched_by: string }> } {
  // Resolve the new refs to ids
  const keepIds = new Set<number>();
  const resolved: Array<{ ref: string; target_id: number; matched_by: string }> = [];
  for (const ref of newRefs) {
    const r = resolveWikilink(db, ref, currentProject);
    if (r && r.id !== sourceId) {
      keepIds.add(r.id);
      resolved.push({ ref, target_id: r.id, matched_by: r.matched_by });
    }
  }

  // Find existing wikilink synapses from this source
  const existing = db
    .prepare(
      `SELECT target_id FROM synapses WHERE source_id = ? AND connection_type = 'wikilink'`,
    )
    .all(sourceId) as { target_id: number }[];
  const existingIds = new Set(existing.map((e) => e.target_id));

  // Delete synapses whose target is no longer in keepIds
  let removed = 0;
  const del = db.prepare(
    `DELETE FROM synapses WHERE source_id = ? AND target_id = ? AND connection_type = 'wikilink'`,
  );
  for (const ex of existingIds) {
    if (!keepIds.has(ex)) {
      del.run(sourceId, ex);
      removed++;
    }
  }

  return { removed, resolved };
}
