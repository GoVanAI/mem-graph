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

export interface MemoryAddInput {
  category: string;
  title: string;
  content: string;
  layer?: string;
  project_id?: string;
  summary?: string;
  tags?: string[];
  lifecycle?: string;
  confidence?: number;
  importance_score?: number;
  session_id?: string;
  source?: string;
}

export interface MemoryUpdateInput {
  id: number;
  title?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  category?: string;
  project_id?: string;
  layer?: string;
  lifecycle?: string;
  confidence?: number;
  importance_score?: number;
}

export class MemoryWriteError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'NO_CHANGES', message: string) {
    super(message);
  }
}

/** Shared add pipeline: persistence, tags, wikilinks, and auto-linking are one transaction. */
export function runMemoryAdd(db: Database.Database, input: MemoryAddInput): Record<string, unknown> {
  const layer = input.layer ?? 'episodic';
  const project_id = input.project_id ?? '_global';
  const lifecycle = input.lifecycle ?? 'milestone';
  const confidence = input.confidence ?? 1;
  const importance_score = input.importance_score ?? 1;
  const source = input.source ?? 'session';
  return db.transaction(() => {
    const insertResult = db.prepare(
      `INSERT INTO memories (
        layer, title, slug, content, project_id, category, lifecycle, status,
        confidence, boost, summary, session_id, source, importance_score
      ) VALUES (
        @layer, @title, @slug, @content, @project_id, @category, @lifecycle, 'active',
        @confidence, 0.0, @summary, @session_id, @source, @importance_score
      )`,
    ).run({
      layer, title: input.title, slug: slugify(input.title), content: input.content, project_id,
      category: input.category, lifecycle, confidence, summary: input.summary ?? null,
      session_id: input.session_id ?? null, source, importance_score,
    });
    const id = Number(insertResult.lastInsertRowid);
    for (const tag of input.tags ?? []) {
      db.prepare('INSERT OR IGNORE INTO memory_tag (memory_id, tag) VALUES (?, ?)').run(id, tag);
    }
    const resolved: Array<{ ref: string; target_id: number; matched_by: string }> = [];
    const broken: string[] = [];
    for (const ref of extractWikilinks(input.content)) {
      const target = resolveWikilink(db, ref, project_id);
      if (target) {
        upsertWikilinkSynapse(db, id, target.id);
        resolved.push({ ref, target_id: target.id, matched_by: target.matched_by });
      } else {
        broken.push(ref);
      }
    }
    return {
      id, layer, project_id, title: input.title, summary: input.summary ?? null,
      tags: input.tags ?? [], lifecycle, confidence, importance_score,
      session_id: input.session_id ?? null, source, created_at: new Date().toISOString(),
      wikilinks_resolved: resolved, broken_wikilinks: broken,
      auto_links: autoLinkOnInsert(db, id, input.content, project_id),
    };
  })();
}

/** Shared update pipeline. `allowTagsOnly` retains the scoped family contract. */
export function runMemoryUpdate(
  db: Database.Database,
  input: MemoryUpdateInput,
  options: { allowTagsOnly?: boolean } = {},
): { id: number; changes: number; wikilinks_updated: { resolved: Array<{ ref: string; target_id: number; matched_by: string }>; removed: number } | null; auto_links: { created: number; updated: number } | null } {
  const existing = db.prepare('SELECT id, project_id FROM memories WHERE id = ?').get(input.id) as { id: number; project_id: string } | undefined;
  if (!existing) throw new MemoryWriteError('NOT_FOUND', `No memory found with id ${input.id}.`);

  const fields = ['title', 'content', 'summary', 'category', 'project_id', 'layer', 'lifecycle', 'confidence', 'importance_score'] as const;
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  for (const field of fields) {
    if (input[field] !== undefined) {
      sets.push(`${field} = ?`);
      params.push(input[field] as string | number);
    }
  }
  if (input.title !== undefined) {
    sets.push('slug = ?');
    params.push(slugify(input.title));
  }
  if (sets.length === 0 && (input.tags === undefined || !options.allowTagsOnly)) {
    throw new MemoryWriteError('NO_CHANGES', 'No fields provided to update.');
  }

  return db.transaction(() => {
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params, input.id);
    }
    if (input.tags !== undefined) {
      db.prepare('DELETE FROM memory_tag WHERE memory_id = ?').run(input.id);
      for (const tag of input.tags) {
        db.prepare('INSERT OR IGNORE INTO memory_tag (memory_id, tag) VALUES (?, ?)').run(input.id, tag);
      }
    }
    let wikilinks_updated: { resolved: Array<{ ref: string; target_id: number; matched_by: string }>; removed: number } | null = null;
    let auto_links: { created: number; updated: number } | null = null;
    if (input.content !== undefined) {
      const projectId = input.project_id ?? existing.project_id;
      const refs = extractWikilinks(input.content);
      const pruned = pruneStaleWikilinks(db, input.id, refs, projectId);
      for (const ref of refs) {
        const target = resolveWikilink(db, ref, projectId);
        if (target && target.id !== input.id) upsertWikilinkSynapse(db, input.id, target.id);
      }
      wikilinks_updated = pruned;
      auto_links = autoLinkOnInsert(db, input.id, input.content, projectId);
    }
    return { id: input.id, changes: sets.length > 0 ? 1 : 0, wikilinks_updated, auto_links };
  })();
}

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

/** Shared status mutation used by the legacy and scoped family adapters. */
export function runMemoryMark(
  db: Database.Database,
  id: number,
  status: 'active' | 'superseded' | 'archived' | 'invalid',
): boolean {
  return db.prepare("UPDATE memories SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id).changes > 0;
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
        return textResult(JSON.stringify(runMemoryAdd(db, { category, title, content, layer, project_id, summary, tags, lifecycle, confidence, importance_score, session_id, source }), null, 2));
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
        const result = runMemoryUpdate(db, { id, title, content, summary, tags, category, project_id, layer, lifecycle, confidence, importance_score });
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        if (e instanceof MemoryWriteError) return errorResult(e.message);
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
        if (!runMemoryMark(db, id, status)) {
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
