import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getDatabase } from '../db.js';
import { textResult, errorResult } from '../util.js';

/**
 * Quietly add a tag to a memory.
 *
 * Quiet means: no wikilink re-extraction, no BM25 auto-link re-run, no
 * `accessed_at` / `access_count` touch. Tag curation should not look like
 * a read — `memory_activate` is what counts toward access stats; tag
 * edits are housekeeping.
 *
 * Idempotent: if the tag is already on this memory, returns
 * `{added: false, ...}` and makes no DB write.
 */
export function runTagAdd(
  db: Database.Database,
  memoryId: number,
  tag: string,
): { memory_id: number; tag: string; added: boolean } {
  if (!tag || tag.trim().length === 0) {
    throw new Error('tag must be non-empty.');
  }
  const cleaned = tag.trim();

  // Verify the memory exists. FK would catch this, but a clean error
  // message is more helpful than "FOREIGN KEY constraint failed".
  const mem = db.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId);
  if (!mem) {
    throw new Error(`No memory found with id ${memoryId}.`);
  }

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO memory_tag (memory_id, tag) VALUES (?, ?)`,
    )
    .run(memoryId, cleaned);

  return {
    memory_id: memoryId,
    tag: cleaned,
    added: result.changes > 0,
  };
}

/**
 * Quietly remove a tag from a memory.
 *
 * Same quietness contract as `runTagAdd` — only touches the `memory_tag`
 * junction table. Idempotent: returns `{removed: false, ...}` if the tag
 * wasn't there.
 */
export function runTagRemove(
  db: Database.Database,
  memoryId: number,
  tag: string,
): { memory_id: number; tag: string; removed: boolean } {
  if (!tag || tag.trim().length === 0) {
    throw new Error('tag must be non-empty.');
  }
  const cleaned = tag.trim();
  const result = db
    .prepare('DELETE FROM memory_tag WHERE memory_id = ? AND tag = ?')
    .run(memoryId, cleaned);
  return {
    memory_id: memoryId,
    tag: cleaned,
    removed: result.changes > 0,
  };
}

export function registerMemoryTagTools(server: McpServer): void {
  server.tool(
    'memory_tag_add',
    'Add a tag to a memory entry. Quiet: does NOT re-run wikilink extraction or BM25 auto-link, does NOT bump access_count. Use this for tag curation without side effects. Idempotent — returns added:false if the tag already exists.',
    {
      id: z.number().int().positive().describe('Memory entry id.'),
      tag: z.string().min(1).describe('Tag to add (will be trimmed).'),
    },
    async ({ id, tag }) => {
      try {
        const result = runTagAdd(getDatabase('memory'), id, tag);
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResult(`Tag add error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'memory_tag_remove',
    'Remove a tag from a memory entry. Quiet: does NOT re-run wikilink extraction or BM25 auto-link, does NOT bump access_count. Idempotent — returns removed:false if the tag was not present.',
    {
      id: z.number().int().positive().describe('Memory entry id.'),
      tag: z.string().min(1).describe('Tag to remove (matched exactly after trim).'),
    },
    async ({ id, tag }) => {
      try {
        const result = runTagRemove(getDatabase('memory'), id, tag);
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResult(`Tag remove error: ${(e as Error).message}`);
      }
    },
  );
}
