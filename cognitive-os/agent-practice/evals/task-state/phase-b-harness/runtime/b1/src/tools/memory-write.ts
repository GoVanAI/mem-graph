import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getDatabase } from '../db.js';
import { textResult, errorResult, rowsResult } from '../util.js';
import {
  extractWikilinks,
  resolveWikilink,
  upsertWikilinkSynapse,
  pruneStaleWikilinks,
  slugify,
} from '../wikilink.js';
import { autoLinkOnInsert } from '../auto-link.js';

/**
 * Atomic supersession: mark an old entry as superseded (status) and create
 * a wikilink synapse from old to new. Pure function so tests can call it
 * directly without going through the MCP server.
 *
 * Throws if old_id === new_id, if either id is missing, or if the DB
 * operation fails. The two writes are wrapped in a transaction so both
 * succeed or neither does.
 */
export function runSupersede(
  db: Database.Database,
  old_id: number,
  new_id: number,
  reason?: string,
): { old_id: number; new_id: number; status: 'superseded'; reason: string | null } {
  if (old_id === new_id) {
    throw new Error('old_id and new_id must be different.');
  }
  const oldRow = db.prepare('SELECT id FROM memories WHERE id = ?').get(old_id);
  const newRow = db.prepare('SELECT id FROM memories WHERE id = ?').get(new_id);
  if (!oldRow) throw new Error(`No memory found with old_id ${old_id}.`);
  if (!newRow) throw new Error(`No memory found with new_id ${new_id}.`);
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id = ?",
    ).run(old_id);
    db.prepare(
      `INSERT OR REPLACE INTO synapses (source_id, target_id, connection_type, weight)
       VALUES (?, ?, 'wikilink', 1.0)`,
    ).run(old_id, new_id);
  });
  tx();
  return { old_id, new_id, status: 'superseded', reason: reason ?? null };
}

export function registerMemoryWriteTools(server: McpServer): void {
  server.tool(
    'memory_add',
    'Add a new memory entry. Pipeline: insert into memories (FTS5 triggers fire) → insert tags into memory_tag → extract [[wikilinks]] from content and upsert synapses → run BM25 auto-link with project floor → enforce 50-outgoing-synapse cap. Returns the new id, resolved wikilinks, broken wikilinks, and auto-link counts.',
    {
      category: z.string().describe('Category: decision, handoff, finding, issue, preference, note, context, todo, or custom.'),
      title: z.string().describe('Short summary title.'),
      content: z.string().describe('Full content of the memory. Supports [[wikilinks]] (id, title, or slug).'),
      layer: z
        .enum(['working', 'episodic', 'procedural', 'semantic', 'partner'])
        .optional()
        .default('episodic')
        .describe('Memory layer. Default episodic.'),
      project_id: z.string().optional().default('_global').describe('Project scope. Default _global.'),
      summary: z.string().optional().describe('One-sentence summary for cheap priming.'),
      tags: z.array(z.string()).optional().describe('Tags for search. 2-5 recommended. Stored in memory_tag junction table.'),
      lifecycle: z.enum(['permanent', 'milestone', 'ephemeral']).optional().default('milestone').describe('Lifecycle. Default milestone.'),
      confidence: z.number().min(0).max(1).optional().default(1.0).describe('Confidence 0..1. Default 1.0.'),
      importance_score: z.number().min(0).max(1).optional().default(1.0).describe('Importance 0..1; multiplies effective_weight in spreading activation. Default 1.0.'),
      session_id: z.string().optional().describe('Optional session identifier.'),
      source: z.enum(['session', 'import', 'manual', 'derived']).optional().default('session').describe('Origin of the entry.'),
    },
    async ({
      category,
      title,
      content,
      layer,
      project_id,
      summary,
      tags,
      lifecycle,
      confidence,
      importance_score,
      session_id,
      source,
    }) => {
      const db = getDatabase('memory');
      try {
        // 1. Insert into memories (FTS5 triggers fire automatically)
        const insertResult = db
          .prepare(
            `INSERT INTO memories (
              layer, title, slug, content, project_id, category, lifecycle, status,
              confidence, boost, summary, session_id, source, importance_score
            ) VALUES (
              @layer, @title, @slug, @content, @project_id, @category, @lifecycle, 'active',
              @confidence, 0.0, @summary, @session_id, @source, @importance_score
            )`,
          )
          .run({
            layer,
            title,
            slug: slugify(title),
            content,
            project_id,
            category,
            lifecycle,
            confidence,
            summary: summary ?? null,
            session_id: session_id ?? null,
            source,
            importance_score,
          });
        const id = Number(insertResult.lastInsertRowid);

        // 2. Insert tags
        if (tags && tags.length > 0) {
          const insertTag = db.prepare(
            'INSERT OR IGNORE INTO memory_tag (memory_id, tag) VALUES (?, ?)',
          );
          for (const tag of tags) insertTag.run(id, tag);
        }

        // 3. Extract wikilinks and upsert
        const refs = extractWikilinks(content);
        const resolved: Array<{ ref: string; target_id: number; matched_by: string }> = [];
        const broken: string[] = [];
        for (const ref of refs) {
          const r = resolveWikilink(db, ref, project_id);
          if (r) {
            upsertWikilinkSynapse(db, id, r.id);
            resolved.push({ ref, target_id: r.id, matched_by: r.matched_by });
          } else {
            broken.push(ref);
          }
        }

        // 4. BM25 auto-link with project floor
        const autoResult = autoLinkOnInsert(db, id, content, project_id);

        return textResult(
          JSON.stringify(
            {
              id,
              layer,
              project_id,
              title,
              summary: summary ?? null,
              tags: tags ?? [],
              lifecycle,
              confidence,
              importance_score,
              session_id: session_id ?? null,
              source,
              created_at: new Date().toISOString(),
              wikilinks_resolved: resolved,
              broken_wikilinks: broken,
              auto_links: autoResult,
            },
            null,
            2,
          ),
        );
      } catch (e) {
        return errorResult(`Insert error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_update',
    'Update an existing memory entry. Only the fields provided are changed; updated_at is bumped. If content or title changes, wikilinks are re-extracted (stale removed, new added) and BM25 auto-link is re-run. Slug is recomputed when title changes.',
    {
      id: z.number().int().positive().describe('Memory entry id.'),
      title: z.string().optional().describe('New title. Recomputes slug.'),
      content: z.string().optional().describe('New content. Re-extracts wikilinks and re-runs auto-link.'),
      summary: z.string().optional().describe('New summary.'),
      tags: z.array(z.string()).optional().describe('New tags. Replaces the tag set for this memory.'),
      category: z.string().optional().describe('New category.'),
      project_id: z.string().optional().describe('New project_id.'),
      layer: z
        .enum(['working', 'episodic', 'procedural', 'semantic', 'partner'])
        .optional()
        .describe('New layer.'),
      lifecycle: z.enum(['permanent', 'milestone', 'ephemeral']).optional().describe('New lifecycle.'),
      confidence: z.number().min(0).max(1).optional().describe('New confidence.'),
      importance_score: z.number().min(0).max(1).optional().describe('New importance_score.'),
    },
    async ({
      id,
      title,
      content,
      summary,
      tags,
      category,
      project_id,
      layer,
      lifecycle,
      confidence,
      importance_score,
    }) => {
      const db = getDatabase('memory');
      try {
        const existing = db
          .prepare('SELECT id, title, content, project_id, summary FROM memories WHERE id = ?')
          .get(id) as
          | { id: number; title: string; content: string; project_id: string; summary: string | null }
          | undefined;
        if (!existing) {
          return errorResult(`No memory found with id ${id}.`);
        }

        const sets: string[] = [];
        const params: (string | number | null)[] = [];
        if (title !== undefined) {
          sets.push('title = ?');
          params.push(title);
          sets.push('slug = ?');
          params.push(slugify(title));
        }
        if (content !== undefined) {
          sets.push('content = ?');
          params.push(content);
        }
        if (summary !== undefined) {
          sets.push('summary = ?');
          params.push(summary);
        }
        if (category !== undefined) {
          sets.push('category = ?');
          params.push(category);
        }
        if (project_id !== undefined) {
          sets.push('project_id = ?');
          params.push(project_id);
        }
        if (layer !== undefined) {
          sets.push('layer = ?');
          params.push(layer);
        }
        if (lifecycle !== undefined) {
          sets.push('lifecycle = ?');
          params.push(lifecycle);
        }
        if (confidence !== undefined) {
          sets.push('confidence = ?');
          params.push(confidence);
        }
        if (importance_score !== undefined) {
          sets.push('importance_score = ?');
          params.push(importance_score);
        }
        if (sets.length === 0) {
          return errorResult('No fields provided to update.');
        }
        sets.push("updated_at = datetime('now')");
        params.push(id);
        db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);

        // Handle tags replacement
        if (tags !== undefined) {
          db.prepare('DELETE FROM memory_tag WHERE memory_id = ?').run(id);
          const insertTag = db.prepare(
            'INSERT OR IGNORE INTO memory_tag (memory_id, tag) VALUES (?, ?)',
          );
          for (const tag of tags) insertTag.run(id, tag);
        }

        // Re-extract wikilinks and re-run auto-link if content changed
        let wikilinksUpdated: {
          resolved: Array<{ ref: string; target_id: number; matched_by: string }>;
          removed: number;
        } | null = null;
        let autoLinksUpdated: { created: number; updated: number } | null = null;
        if (content !== undefined) {
          const newRefs = extractWikilinks(content);
          const finalProject = project_id ?? existing.project_id;
          const { removed, resolved } = pruneStaleWikilinks(db, id, newRefs, finalProject);
          // Upsert the new ones
          for (const ref of newRefs) {
            const r = resolveWikilink(db, ref, finalProject);
            if (r && r.id !== id) {
              upsertWikilinkSynapse(db, id, r.id);
            }
          }
          wikilinksUpdated = { resolved, removed };
          autoLinksUpdated = autoLinkOnInsert(db, id, content, finalProject);
        }

        return textResult(
          JSON.stringify(
            {
              id,
              changes: 1,
              wikilinks_updated: wikilinksUpdated,
              auto_links: autoLinksUpdated,
            },
            null,
            2,
          ),
        );
      } catch (e) {
        return errorResult(`Update error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_supersede',
    'Atomic supersession: mark an old entry as superseded (status) and create a supersedes synapse to the new entry. Use this when a decision is reversed or an entry is replaced — never delete, never edit-in-place.',
    {
      old_id: z.number().int().positive().describe('Id of the entry being replaced.'),
      new_id: z.number().int().positive().describe('Id of the entry that replaces it.'),
      reason: z.string().optional().describe('Why the old entry is being superseded.'),
    },
    async ({ old_id, new_id, reason }) => {
      try {
        const result = runSupersede(getDatabase('memory'), old_id, new_id, reason);
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResult(`Supersede error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_mark',
    'Flip a memory entry\'s status (active/superseded/archived/invalid). Use this to retire information without deleting it.',
    {
      id: z.number().int().positive().describe('Memory entry id.'),
      status: z.enum(['active', 'superseded', 'archived', 'invalid']).describe('New status.'),
      reason: z.string().optional().describe('Why the status is changing.'),
    },
    async ({ id, status, reason }) => {
      const db = getDatabase('memory');
      try {
        const result = db
          .prepare("UPDATE memories SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .run(status, id);
        if (result.changes === 0) {
          return errorResult(`No memory found with id ${id}.`);
        }
        return textResult(JSON.stringify({ id, status, reason: reason ?? null }, null, 2));
      } catch (e) {
        return errorResult(`Mark error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_boost',
    'Adjust the boost on a memory entry. Boost values are rank elevation; entries with boost > 0 surface preferentially in primes and searches. The delta is added to the current boost (negative values lower it).',
    {
      id: z.number().int().positive().describe('Memory entry id.'),
      delta: z.number().describe('Amount to add to the current boost. Can be negative to lower.'),
      reason: z.string().optional().describe('Why the boost is being adjusted.'),
    },
    async ({ id, delta, reason }) => {
      const db = getDatabase('memory');
      try {
        const row = db
          .prepare('SELECT boost FROM memories WHERE id = ?')
          .get(id) as { boost: number } | undefined;
        if (!row) {
          return errorResult(`No memory found with id ${id}.`);
        }
        const newBoost = row.boost + delta;
        db.prepare("UPDATE memories SET boost = ?, updated_at = datetime('now') WHERE id = ?").run(
          newBoost,
          id,
        );
        return textResult(
          JSON.stringify(
            { id, old_boost: row.boost, new_boost: newBoost, reason: reason ?? null },
            null,
            2,
          ),
        );
      } catch (e) {
        return errorResult(`Boost error: ${(e as Error).message}`);
      }
    },
  );
}
