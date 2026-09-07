import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { closeAllDatabases, getDatabase, initDatabase } from '../src/db.js';
import { registerMemoryOrientTools } from '../src/tools/memory-orient.js';
import { seedMemory } from './helpers.js';

type ToolEntry = { cb: (input: unknown) => Promise<{ content: Array<{ text: string }> }> };
type PrimeResult = {
  prime: { max_tokens: number; entry_count: number; fresh_entry_count: number; fresh_ids: number[] };
  entries: Array<{ id: number; title: string; summary: string | null }>;
};

let tempDir = '';
let originalDir: string | undefined;

function fakeServer(): { tools: Map<string, ToolEntry>; server: McpServer } {
  const tools = new Map<string, ToolEntry>();
  const server = { tool: (name: string, _description: string, _schema: unknown, cb: ToolEntry['cb']) => tools.set(name, { cb }) } as unknown as McpServer;
  return { tools, server };
}

function setTimestamps(id: number, createdOffset: string, updatedOffset = createdOffset): void {
  getDatabase('memory')
    .prepare("UPDATE memories SET created_at = datetime('now', ?), updated_at = datetime('now', ?) WHERE id = ?")
    .run(createdOffset, updatedOffset, id);
}

function setBoost(id: number, boost: number): void {
  getDatabase('memory').prepare('UPDATE memories SET boost = ? WHERE id = ?').run(boost, id);
}

async function prime(input: Record<string, unknown>): Promise<PrimeResult> {
  const { tools, server } = fakeServer();
  registerMemoryOrientTools(server);
  const result = await tools.get('memory_prime')!.cb(input);
  return JSON.parse(result.content[0]!.text) as PrimeResult;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'memory-prime-'));
  originalDir = process.env.MEM_GRAPH_DIR;
  process.env.MEM_GRAPH_DIR = tempDir;
  initDatabase('memory');
});

afterEach(() => {
  closeAllDatabases();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.MEM_GRAPH_DIR;
  else process.env.MEM_GRAPH_DIR = originalDir;
});

describe('memory_prime freshness lane', () => {
  it('places fresh records first by effective timestamp, importance, and ID without duplicate normal entries', async () => {
    const db = getDatabase('memory');
    const freshHighFirst = seedMemory(db, { title: 'fresh high first', content: 'hidden full content', project_id: 'project-a', importance_score: 0.95 });
    const freshHighSecond = seedMemory(db, { title: 'fresh high second', content: 'hidden full content', project_id: 'project-a', importance_score: 0.95 });
    const freshLow = seedMemory(db, { title: 'fresh low', content: 'hidden full content', project_id: 'project-a', importance_score: 0.8 });
    const freshOlder = seedMemory(db, { title: 'fresh older', content: 'hidden full content', project_id: 'project-a', importance_score: 1.0 });
    const ordinary = seedMemory(db, { title: 'ordinary boosted', content: 'ordinary', project_id: 'project-a', importance_score: 1.0 });
    setTimestamps(freshHighFirst, '-1 hour');
    setTimestamps(freshHighSecond, '-1 hour');
    setTimestamps(freshLow, '-1 hour');
    setTimestamps(freshOlder, '-8 days', '-2 hours');
    setTimestamps(ordinary, '-8 days');
    setBoost(freshLow, 100);
    setBoost(ordinary, 1000);

    const result = await prime({ project: 'project-a', max_tokens: 3000 });
    const ids = result.entries.map((entry) => entry.id);

    expect(result.prime.fresh_ids).toEqual([freshHighFirst, freshHighSecond, freshLow, freshOlder]);
    expect(ids.slice(0, 4)).toEqual([freshHighFirst, freshHighSecond, freshLow, freshOlder]);
    expect(ids.filter((id) => id === freshLow)).toHaveLength(1);
    expect(ids[4]).toBe(ordinary);
  });

  it('caps the lane at five entries and uses returned entry shape rather than omitted content for its budget', async () => {
    const db = getDatabase('memory');
    const ids = Array.from({ length: 6 }, (_, index) => {
      const id = seedMemory(db, {
        title: `fresh ${index}`,
        content: 'x'.repeat(20_000),
        project_id: 'project-a',
        importance_score: 0.8,
      });
      setTimestamps(id, `-${index + 1} hours`);
      return id;
    });

    const roomy = await prime({ project: 'project-a', max_tokens: 4000 });
    expect(roomy.prime.fresh_entry_count).toBe(5);
    expect(roomy.prime.fresh_ids).toEqual(ids.slice(0, 5));

    const constrained = await prime({ project: 'project-a', max_tokens: 750 });
    expect(constrained.prime.fresh_entry_count).toBe(1);
    expect(constrained.prime.fresh_ids).toEqual([ids[0]]);
    expect(constrained.entries[0]?.summary).toBeNull();
    const freshCost = constrained.entries
      .filter((entry) => constrained.prime.fresh_ids.includes(entry.id))
      .reduce((total, entry) => total + JSON.stringify(entry).length + 200, 0);
    expect(freshCost).toBeLessThanOrEqual(750 * 4 * 0.25);
  });

  it('backfills deterministically after newer oversized freshness candidates cannot fit the lane budget', async () => {
    const db = getDatabase('memory');
    const oversized = Array.from({ length: 5 }, (_, index) => {
      const id = seedMemory(db, {
        title: `oversized ${index} ${'x'.repeat(1_500)}`,
        content: 'hidden',
        project_id: 'project-a',
        importance_score: 0.8,
      });
      setTimestamps(id, '-1 hour');
      return id;
    });
    const backfill = seedMemory(db, {
      title: 'eligible deterministic backfill',
      content: 'hidden',
      project_id: 'project-a',
      importance_score: 0.8,
    });
    setTimestamps(backfill, '-2 hours');

    const result = await prime({ project: 'project-a', max_tokens: 1000 });

    expect(result.prime.fresh_ids).toEqual([backfill]);
    expect(result.entries[0]?.id).toBe(backfill);
    expect(result.prime.fresh_ids).not.toContain(oversized[0]);
  });

  it('falls back for stale records, preserves project/global selection, and performs no writes', async () => {
    const db = getDatabase('memory');
    const mine = seedMemory(db, { title: 'mine fresh', content: 'mine', project_id: 'project-a', importance_score: 0.8 });
    const global = seedMemory(db, { title: 'global fresh', content: 'global', project_id: '_global', importance_score: 0.8 });
    const other = seedMemory(db, { title: 'other fresh', content: 'other', project_id: 'project-b', importance_score: 1.0 });
    const stale = seedMemory(db, { title: 'stale high', content: 'stale', project_id: 'project-a', importance_score: 1.0 });
    const belowThreshold = seedMemory(db, { title: 'below threshold recent', content: 'low', project_id: 'project-a', importance_score: 0.79 });
    const archived = seedMemory(db, { title: 'archived recent', content: 'archived', project_id: 'project-a', importance_score: 1.0, status: 'archived' });
    setTimestamps(mine, '-1 hour');
    setTimestamps(global, '-2 hours');
    setTimestamps(other, '-30 minutes');
    setTimestamps(stale, '-8 days');
    setTimestamps(belowThreshold, '-30 minutes');
    setTimestamps(archived, '-15 minutes');
    setBoost(stale, 20);
    setBoost(archived, 100);
    const before = db.prepare('SELECT id, status, lifecycle, boost, access_count, accessed_at, created_at, updated_at FROM memories ORDER BY id').all();
    const eventsBefore = db.prepare('SELECT COUNT(*) AS count FROM cognitive_events').get();

    const scoped = await prime({ project: 'project-a', max_tokens: 1000 });
    const includingArchived = await prime({ project: 'project-a', include_archived: true, max_tokens: 1000 });
    const globalOnly = await prime({ max_tokens: 1000 });
    const after = db.prepare('SELECT id, status, lifecycle, boost, access_count, accessed_at, created_at, updated_at FROM memories ORDER BY id').all();
    const eventsAfter = db.prepare('SELECT COUNT(*) AS count FROM cognitive_events').get();

    expect(scoped.prime.fresh_ids).toEqual([mine, global]);
    expect(scoped.prime.fresh_ids).not.toContain(belowThreshold);
    expect(includingArchived.prime.fresh_ids).not.toContain(archived);
    expect(includingArchived.entries.map((entry) => entry.id)).toContain(archived);
    expect(scoped.entries.map((entry) => entry.id)).not.toContain(other);
    expect(scoped.entries.map((entry) => entry.id)).toContain(stale);
    expect(globalOnly.prime.fresh_ids).toEqual([global]);
    expect(globalOnly.entries.map((entry) => entry.id)).not.toContain(mine);
    expect(after).toEqual(before);
    expect(eventsAfter).toEqual(eventsBefore);
  });
});
