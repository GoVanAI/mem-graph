import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServer as RealMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeAllDatabases, getDatabase, initDatabase } from '../src/db.js';
import { AGENT_TOOL_NAMES, MAINTENANCE_TOOL_NAMES, parseMcpProfile, registerToolsForProfile } from '../src/tool-profiles.js';
import { seedMemory, seedSynapse } from './helpers.js';

type Entry = { description: string; schema: { parse: (value: unknown) => unknown }; cb: (value: any) => Promise<any> | any };
function fakeServer() {
  const entries = new Map<string, Entry>();
  const add = (name: string, descriptionOrConfig: any, schemaOrHandler: any, maybeHandler?: any) => {
    const modern = typeof descriptionOrConfig === 'object' && 'inputSchema' in descriptionOrConfig;
    entries.set(name, {
      description: modern ? descriptionOrConfig.description : descriptionOrConfig,
      schema: modern ? descriptionOrConfig.inputSchema : schemaOrHandler,
      cb: modern ? schemaOrHandler : maybeHandler,
    });
  };
  return { entries, server: { tool: add, registerTool: add } as unknown as McpServer };
}
function names(entries: Map<string, Entry>) { return [...entries.keys()].sort(); }
async function invoke(entries: Map<string, Entry>, name: string, input: unknown) {
  const entry = entries.get(name)!;
  return entry.cb(typeof entry.schema?.parse === 'function' ? entry.schema.parse(input) : input);
}

let tempDir = '';
let previous: string | undefined;
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'mcp-profile-')); previous = process.env.MEM_GRAPH_DIR; process.env.MEM_GRAPH_DIR = tempDir; initDatabase('memory'); });
afterEach(() => { closeAllDatabases(); rmSync(tempDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.MEM_GRAPH_DIR; else process.env.MEM_GRAPH_DIR = previous; });

describe('MCP profiles', () => {
  it('defaults to the exact 41 legacy tools and preserves legacy metadata', () => {
    const legacy = fakeServer(); registerToolsForProfile(legacy.server, 'full');
    const again = fakeServer(); registerToolsForProfile(again.server, parseMcpProfile(undefined));
    expect(legacy.entries.size).toBe(41);
    expect(names(again.entries)).toEqual(names(legacy.entries));
    expect(again.entries.get('memory_get')!.description).toBe(legacy.entries.get('memory_get')!.description);
    expect(Object.keys(again.entries.get('memory_get')!.schema)).toEqual(Object.keys(legacy.entries.get('memory_get')!.schema));
  });

  it('has exact restricted memberships without duplicate registration', () => {
    const agent = fakeServer(); registerToolsForProfile(agent.server, 'agent');
    const maintenance = fakeServer(); registerToolsForProfile(maintenance.server, 'maintenance');
    expect(names(agent.entries)).toEqual([...AGENT_TOOL_NAMES].sort());
    expect(agent.entries.size).toBe(10);
    expect(names(maintenance.entries)).toEqual([...MAINTENANCE_TOOL_NAMES].sort());
    expect(maintenance.entries.size).toBe(18);
  });

  it('rejects unknown nonempty profiles before a database is required', () => {
    closeAllDatabases();
    expect(() => parseMcpProfile('wrong')).toThrow(/Invalid MCP_PROFILE/);
    expect(() => getDatabase('memory')).toThrow(/not initialized/);
  });

  it('enforces discriminated agent variants and exact project reads', async () => {
    const db = getDatabase('memory');
    const mine = seedMemory(db, { title: 'mine', content: 'needle', project_id: 'p' });
    const global = seedMemory(db, { title: 'global', content: 'needle', project_id: '_global' });
    const foreign = seedMemory(db, { title: 'foreign', content: 'needle', project_id: 'q' });
    seedSynapse(db, mine, foreign, 'wikilink'); seedSynapse(db, mine, global, 'bm25_auto');
    const setup = fakeServer(); registerToolsForProfile(setup.server, 'agent');
    const malformed = await invoke(setup.entries, 'memory_find', { operation: 'search', project_id: 'p', since: 'bad' });
    expect(malformed.isError).toBe(true);
    const search = JSON.parse((await invoke(setup.entries, 'memory_find', { operation: 'search', project_id: 'p', query: 'needle' })).content[0].text);
    expect(search.results.map((r: { id: number }) => r.id)).toEqual([mine]);
    const before = db.prepare('SELECT access_count FROM memories WHERE id=?').get(foreign) as { access_count: number };
    const denied = JSON.parse((await invoke(setup.entries, 'memory_read', { operation: 'get', id: foreign, project_id: 'p' })).content[0].text);
    expect(denied.code).toBe('OUT_OF_SCOPE');
    expect(db.prepare('SELECT access_count FROM memories WHERE id=?').get(foreign)).toEqual(before);
    const allowed = JSON.parse((await invoke(setup.entries, 'memory_read', { operation: 'get', id: mine, project_id: 'p' })).content[0].text);
    expect(allowed.touched).toBe(true);
    const links = JSON.parse((await invoke(setup.entries, 'memory_read', { operation: 'links', id: mine, project_id: 'p' })).content[0].text);
    expect(links.links).toContainEqual(expect.objectContaining({ foreign_stub: true, target: expect.objectContaining({ id: foreign, project_id: 'q' }) }));
    expect(links.links).not.toContainEqual(expect.objectContaining({ id: global }));
    const related = JSON.parse((await invoke(setup.entries, 'memory_find', { operation: 'related', project_id: 'p', query: 'needle' })).content[0].text);
    expect(related.results).toEqual(expect.arrayContaining([expect.objectContaining({ id: mine, project_id: 'p' })]));
    expect(related.results).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: foreign })]));
  });

  it('keeps agent writes explicit, scope-checked, and supports event reads', async () => {
    const db = getDatabase('memory'); const existing = seedMemory(db, { title: 'existing', content: 'old', project_id: 'p' }); const foreign = seedMemory(db, { title: 'foreign', content: 'old', project_id: 'q' });
    const setup = fakeServer(); registerToolsForProfile(setup.server, 'agent');
    const added = JSON.parse((await invoke(setup.entries, 'memory_write', { operation: 'add', project_id: 'p', category: 'note', title: 'new', content: 'content', tags: ['x'] })).content[0].text);
    expect(added.ok).toBe(true);
    const denied = JSON.parse((await invoke(setup.entries, 'memory_write', { operation: 'mark', project_id: 'p', id: foreign, status: 'archived' })).content[0].text);
    expect(denied.code).toBe('OUT_OF_SCOPE');
    const global = JSON.parse((await invoke(setup.entries, 'memory_write', { operation: 'add', project_id: '_global', category: 'note', title: 'g', content: 'g' })).content[0].text);
    expect(global.code).toBe('GLOBAL_CONFIRMATION_REQUIRED');
    await invoke(setup.entries, 'cognitive_event_append', { event_type: 'ExecutionObserved', task_id: 't', project_id: 'p', payload: {} });
    const events = JSON.parse((await invoke(setup.entries, 'cognitive_event_read', { project_id: 'p' })).content[0].text);
    expect(events.events).toHaveLength(1);
    expect(events.integrity.valid).toBe(true);
    expect(existing).toBeGreaterThan(0);
  });

  it('primes only the exact project unless global is explicitly enabled', async () => {
    const db = getDatabase('memory');
    const mine = seedMemory(db, { title: 'mine', content: 'private', project_id: 'p', importance_score: 0.9 });
    const global = seedMemory(db, { title: 'global', content: 'shared', project_id: '_global', importance_score: 0.9 });
    const foreign = seedMemory(db, { title: 'foreign', content: 'other', project_id: 'q', importance_score: 1 });
    const setup = fakeServer(); registerToolsForProfile(setup.server, 'agent');
    const exact = JSON.parse((await invoke(setup.entries, 'memory_prime', { project_id: 'p', max_tokens: 1000 })).content[0].text);
    expect(exact.entries.map((entry: { id: number }) => entry.id)).toContain(mine);
    expect(exact.entries.map((entry: { id: number }) => entry.id)).not.toContain(global);
    expect(exact.entries.map((entry: { id: number }) => entry.id)).not.toContain(foreign);
    const globalEnabled = JSON.parse((await invoke(setup.entries, 'memory_prime', { project_id: 'p', include_global: true, max_tokens: 1000 })).content[0].text);
    expect(globalEnabled.entries.map((entry: { id: number }) => entry.id)).toContain(global);
  });

  it('keeps epistemic admission/receipt direct and inspection scoped', async () => {
    const setup = fakeServer(); registerToolsForProfile(setup.server, 'agent');
    const admitted = JSON.parse((await invoke(setup.entries, 'epistemic_admit', {
      idempotency_key: 'profile-admit', project_id: 'p', scope: 'exact-project', statement: 'Observed profile evidence.', epistemic_status: 'inferred', verification_level: 'direct', source_quality: 'observed', confidence: 0.7, valid_from: '2026-09-07T00:00:00.000Z', task_id: 't',
    })).content[0].text);
    expect(admitted.ok).toBe(true);
    const read = JSON.parse((await invoke(setup.entries, 'epistemic_inspect', { operation: 'get', project_id: 'p', record_id: admitted.record_id })).content[0].text);
    expect(read.record.statement).toBe('Observed profile evidence.');
    const denied = JSON.parse((await invoke(setup.entries, 'epistemic_inspect', { operation: 'get', project_id: 'q', record_id: admitted.record_id })).content[0].text);
    expect(denied.code).toBe('OUT_OF_SCOPE');
    const receipt = JSON.parse((await invoke(setup.entries, 'epistemic_append_receipt', { idempotency_key: 'profile-receipt', record_id: admitted.record_id, revision_id: admitted.revision_id, receipt_type: 'BeliefUseReceipt', receipt_payload: { used: true }, observed_at: '2026-09-07T00:01:00.000Z', task_id: 't', project_id: 'p' })).content[0].text);
    expect(receipt.ok).toBe(true);
    const global = JSON.parse((await invoke(setup.entries, 'epistemic_admit', {
      idempotency_key: 'profile-global', project_id: 'p', scope: '_global', statement: 'Global only with opt-in.', epistemic_status: 'reported', verification_level: 'direct', source_quality: 'observed', confidence: 0.7, valid_from: '2026-09-07T00:00:00.000Z', task_id: 't',
    })).content[0].text);
    const globalDenied = JSON.parse((await invoke(setup.entries, 'epistemic_inspect', { operation: 'get', project_id: 'p', record_id: global.record_id })).content[0].text);
    expect(globalDenied.code).toBe('OUT_OF_SCOPE');
    const globalAllowed = JSON.parse((await invoke(setup.entries, 'epistemic_inspect', { operation: 'get', project_id: 'q', include_global: true, record_id: global.record_id })).content[0].text);
    expect(globalAllowed.ok).toBe(true);
  });

  it('advertises real family schemas and rejects malformed variants through MCP', async () => {
    const server = new RealMcpServer({ name: 'profile-test', version: '1' });
    registerToolsForProfile(server, 'agent');
    const client = new Client({ name: 'profile-client', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
      for (const name of ['memory_find', 'memory_read', 'memory_write', 'epistemic_inspect']) {
        const tool = listed.tools.find((candidate) => candidate.name === name)!;
        expect(tool.inputSchema.properties).toHaveProperty('operation');
      }
      expect(listed.tools.find((tool) => tool.name === 'memory_find')!.inputSchema.properties).toHaveProperty('query');
      expect(listed.tools.find((tool) => tool.name === 'memory_read')!.inputSchema.properties).toHaveProperty('direction');
      const malformed = await client.callTool({ name: 'memory_find', arguments: { operation: 'search', project_id: 'p', since: 'unexpected' } });
      expect(malformed.isError).toBe(true);
    } finally { await Promise.all([client.close(), server.close()]); }
  });

  it('returns exact profile memberships through real MCP tools/list', async () => {
    for (const [profile, expected] of [
      ['full', undefined], ['agent', [...AGENT_TOOL_NAMES]], ['maintenance', [...MAINTENANCE_TOOL_NAMES]],
    ] as const) {
      const server = new RealMcpServer({ name: `profile-${profile}`, version: '1' });
      registerToolsForProfile(server, profile);
      const client = new Client({ name: 'profile-client', version: '1' });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const actual = (await client.listTools()).tools.map((tool) => tool.name).sort();
        if (profile === 'full') expect(actual).toHaveLength(41);
        else expect(actual).toEqual([...expected!].sort());
      } finally { await Promise.all([client.close(), server.close()]); }
    }
  });
});
