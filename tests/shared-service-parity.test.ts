import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { closeAllDatabases, getDatabase, initDatabase } from '../src/db.js';
import { registerToolsForProfile } from '../src/tool-profiles.js';
import { seedMemory, seedSynapse } from './helpers.js';

type Entry = { schema: { parse?: (input: unknown) => unknown }; cb: (input: any) => Promise<any> | any };

function fakeServer() {
  const entries = new Map<string, Entry>();
  const add = (name: string, configOrDescription: any, schemaOrHandler: any, maybeHandler?: any) => {
    const modern = typeof configOrDescription === 'object' && 'inputSchema' in configOrDescription;
    entries.set(name, { schema: modern ? configOrDescription.inputSchema : schemaOrHandler, cb: modern ? schemaOrHandler : maybeHandler });
  };
  return { entries, server: { tool: add, registerTool: add } as unknown as McpServer };
}

async function call(entries: Map<string, Entry>, name: string, input: unknown) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`missing tool ${name}`);
  const result = await entry.cb(entry.schema.parse ? entry.schema.parse(input) : input);
  const text = result.content[0].text;
  try {
    return { envelope: result, data: JSON.parse(text) };
  } catch {
    return { envelope: result, data: text };
  }
}

function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['operation', 'revision_id', 'current_revision_id', 'source_event_id', 'created_at', 'updated_at'].includes(key))
      .map(([key, nested]) => [key, semantic(nested)]));
  }
  return value;
}

async function withFixture<T>(profile: 'full' | 'agent', run: (entries: Map<string, Entry>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `shared-service-${profile}-`));
  const previous = process.env.MEM_GRAPH_DIR;
  try {
    process.env.MEM_GRAPH_DIR = dir;
    initDatabase('memory');
    const setup = fakeServer();
    registerToolsForProfile(setup.server, profile);
    return await run(setup.entries);
  } finally {
    closeAllDatabases();
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MEM_GRAPH_DIR;
    else process.env.MEM_GRAPH_DIR = previous;
  }
}

describe('legacy and agent family shared-service parity', () => {
  it('matches memory reads, link semantics, failure isolation, and D7 access effects on independent fixtures', async () => {
    async function exercise(profile: 'full' | 'agent') {
      return withFixture(profile, async (entries) => {
        const db = getDatabase('memory');
        const mine = seedMemory(db, { title: 'mine', content: 'private', project_id: 'p' });
        const peer = seedMemory(db, { title: 'peer', content: 'peer', project_id: 'p' });
        const foreign = seedMemory(db, { title: 'foreign', content: 'foreign', project_id: 'q' });
        seedSynapse(db, mine, peer, 'bm25_auto');
        seedSynapse(db, mine, foreign, 'wikilink');
        const get = profile === 'full'
          ? await call(entries, 'memory_get', { id: mine, include_synapses: false })
          : await call(entries, 'memory_read', { operation: 'get', id: mine, project_id: 'p' });
        const links = profile === 'full'
          ? await call(entries, 'memory_synapse_traverse', { id: mine, direction: 'both', min_weight: 0, limit: 50 })
          : await call(entries, 'memory_read', { operation: 'links', id: mine, project_id: 'p', direction: 'both', min_weight: 0, limit: 50 });
        const missing = profile === 'full'
          ? await call(entries, 'memory_get', { id: 999, include_synapses: false })
          : await call(entries, 'memory_read', { operation: 'get', id: 999, project_id: 'p' });
        const access = db.prepare('SELECT access_count FROM memories WHERE id = ?').get(mine) as { access_count: number };
        const synapseAccess = db.prepare('SELECT access_count FROM synapses WHERE source_id = ?').all(mine) as Array<{ access_count: number }>;
        return { get: profile === 'full' ? get.data : get.data.memory, links: links.data, missing, access, synapseAccess, peer, foreign };
      });
    }

    const legacy = await exercise('full');
    const family = await exercise('agent');
    expect(family.get).toEqual(legacy.get);
    expect(family.access).toEqual(legacy.access);
    expect(family.synapseAccess).toEqual(legacy.synapseAccess);
    expect(legacy.missing.envelope.isError).toBe(true);
    expect(family.missing.data.code).toBe('OUT_OF_SCOPE');
    const legacyPeers = legacy.links.filter((row: { other_project_id: string }) => row.other_project_id === 'p');
    expect(family.links.links.filter((row: { foreign_stub: boolean }) => !row.foreign_stub).map((row: { id: number }) => row.id)).toEqual(legacyPeers.map((row: { other_id: number }) => row.other_id));
    expect(family.links.links).toContainEqual(expect.objectContaining({ foreign_stub: true, target: expect.objectContaining({ project_id: 'q' }) }));
  });

  it('matches add/update persistence, wikilinks, and failure paths on independent fixtures', async () => {
    async function exercise(profile: 'full' | 'agent') {
      return withFixture(profile, async (entries) => {
        const db = getDatabase('memory');
        const target = seedMemory(db, { title: 'target', content: 'target', project_id: 'p' });
        const addInput = { category: 'note', title: 'new', content: 'new [[target]]', project_id: 'p', tags: ['one'], layer: 'episodic', lifecycle: 'milestone', confidence: 1, importance_score: 1, source: 'session' };
        const added = profile === 'full'
          ? await call(entries, 'memory_add', addInput)
          : await call(entries, 'memory_write', { operation: 'add', ...addInput });
        const id = profile === 'full' ? added.data.id : added.data.result.id;
        const updateInput = { id, title: 'renamed', content: 'updated [[target]]', tags: ['two'], category: 'finding' };
        const updated = profile === 'full'
          ? await call(entries, 'memory_update', updateInput)
          : await call(entries, 'memory_write', { operation: 'update', project_id: 'p', ...updateInput });
        const missing = profile === 'full'
          ? await call(entries, 'memory_update', { id: 999, title: 'missing' })
          : await call(entries, 'memory_write', { operation: 'update', project_id: 'p', id: 999, title: 'missing' });
        const row = db.prepare('SELECT title, slug, content, project_id, category, layer, lifecycle, confidence, importance_score FROM memories WHERE id = ?').get(id);
        const tags = db.prepare('SELECT tag FROM memory_tag WHERE memory_id = ? ORDER BY tag').all(id);
        const links = db.prepare('SELECT target_id, connection_type FROM synapses WHERE source_id = ? ORDER BY target_id, connection_type').all(id);
        return { added: profile === 'full' ? added.data : added.data.result, updated: profile === 'full' ? updated.data : updated.data, missing, row, tags, links, target };
      });
    }

    const legacy = await exercise('full');
    const family = await exercise('agent');
    expect(family.added).toEqual(expect.objectContaining({ project_id: legacy.added.project_id, wikilinks_resolved: legacy.added.wikilinks_resolved, broken_wikilinks: legacy.added.broken_wikilinks, auto_links: legacy.added.auto_links }));
    expect(family.row).toEqual(legacy.row);
    expect(family.tags).toEqual(legacy.tags);
    expect(family.links).toEqual(legacy.links);
    expect(legacy.updated).toEqual(expect.objectContaining({ id: legacy.added.id, changes: 1 }));
    expect(family.updated).toEqual(expect.objectContaining({ ok: true, operation: 'update', id: family.added.id }));
    expect(legacy.missing.envelope.isError).toBe(true);
    expect(family.missing.data.code).toBe('OUT_OF_SCOPE');
  });

  it('matches epistemic get/query/diff semantics, retraction handling, and scope failures on independent fixtures', async () => {
    async function exercise(profile: 'full' | 'agent') {
      return withFixture(profile, async (entries) => {
        const admitted = await call(entries, 'epistemic_admit', { idempotency_key: `parity-${profile}-1`, project_id: 'p', scope: 'exact-project', statement: 'first', epistemic_status: 'inferred', verification_level: 'direct', source_quality: 'observed', confidence: 0.5, valid_from: '2026-01-01T00:00:00.000Z', task_id: 't' });
        await call(entries, 'epistemic_admit', { idempotency_key: `parity-${profile}-2`, record_id: admitted.data.record_id, expected_revision: 1, previous_revision_id: admitted.data.revision_id, project_id: 'p', scope: 'exact-project', statement: 'withdrawn', epistemic_status: 'retracted', verification_level: 'direct', source_quality: 'observed', confidence: 0.5, valid_from: '2026-06-01T00:00:00.000Z', task_id: 't' });
        const getInput = { record_id: admitted.data.record_id, project_id: 'p', as_of: '2026-04-01T00:00:00.000Z' };
        const get = profile === 'full' ? await call(entries, 'epistemic_get', getInput) : await call(entries, 'epistemic_inspect', { operation: 'get', ...getInput });
        const query = profile === 'full' ? await call(entries, 'epistemic_query', { project_id: 'p', limit: 50 }) : await call(entries, 'epistemic_inspect', { operation: 'query', project_id: 'p', limit: 50 });
        const diffInput = { record_id: admitted.data.record_id, project_id: 'p', from_as_of: '2026-04-01T00:00:00.000Z', to_as_of: '2026-08-01T00:00:00.000Z' };
        const diff = profile === 'full' ? await call(entries, 'epistemic_concept_diff', diffInput) : await call(entries, 'epistemic_inspect', { operation: 'diff', ...diffInput });
        const denied = profile === 'full' ? await call(entries, 'epistemic_get', { record_id: admitted.data.record_id, project_id: 'q' }) : await call(entries, 'epistemic_inspect', { operation: 'get', record_id: admitted.data.record_id, project_id: 'q' });
        return { get: get.data, query: query.data, diff: diff.data, denied: denied.data };
      });
    }

    const legacy = await exercise('full');
    const family = await exercise('agent');
    expect(semantic(family.get)).toEqual(semantic(legacy.get));
    expect(semantic(family.query)).toEqual(semantic(legacy.query));
    expect(semantic(family.diff)).toEqual(semantic(legacy.diff));
    expect(legacy.diff.diff.to_state).toBeNull();
    expect(legacy.denied.code).toBe('OUT_OF_SCOPE');
    expect(family.denied.code).toBe('OUT_OF_SCOPE');
  });
});
