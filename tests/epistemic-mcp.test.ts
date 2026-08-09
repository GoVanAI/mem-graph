/**
 * Epistemic MCP tool tests — Step 7 of EPB-001.
 *
 * Verifies the 5 Slice 1 tools register correctly and that each adapter
 * delegates to the underlying domain logic with the right input/output
 * shape. Read tools are verified zero-write by snapshotting DB state
 * before/after invocation.
 *
 * Domain logic itself is covered by epistemic-admission.test.ts and
 * epistemic-projections.test.ts. This file is the integration layer
 * that proves the adapters are wired correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDatabase, initDatabase, closeAllDatabases } from '../src/db.js';
import { registerEpistemicTools } from '../src/tools/epistemic.js';

interface ToolEntry {
  name: string;
  description: string;
  schema: unknown;
  cb: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function createFakeServer(): { server: McpServer; tools: Map<string, ToolEntry> } {
  const tools = new Map<string, ToolEntry>();
  const server = {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      cb: ToolEntry['cb'],
    ) => {
      tools.set(name, { name, description, schema, cb });
    },
  } as unknown as McpServer;
  return { server, tools };
}

async function callTool(
  tools: Map<string, ToolEntry>,
  name: string,
  input: unknown,
): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const result = await tool.cb(input);
  const text = result.content[0]?.text ?? '{}';
  return JSON.parse(text);
}

function countRows(table: string): number {
  const row = getDatabase('memory')
    .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
    .get() as { c: number };
  return row.c;
}

let tmpDir: string;
let originalDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'epistemic-mcp-'));
  originalDir = process.env.MEM_GRAPH_DIR;
  process.env.MEM_GRAPH_DIR = tmpDir;
  // initDatabase runs the migration runner, so v1 + v2 are applied.
  initDatabase('memory');
});

afterEach(() => {
  closeAllDatabases();
  if (tmpDir && rmSync && tmpDir.length > 0) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (originalDir === undefined) {
    delete process.env.MEM_GRAPH_DIR;
  } else {
    process.env.MEM_GRAPH_DIR = originalDir;
  }
});

describe('registerEpistemicTools — Slice 1 surface', () => {
  it('registers exactly 5 tools with the adopted Slice 1 names', () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const names = Array.from(tools.keys()).sort();
    expect(names).toEqual([
      'epistemic_admit',
      'epistemic_append_receipt',
      'epistemic_get',
      'epistemic_integrity_check',
      'epistemic_query',
    ]);
  });

  it('every registered tool has a non-empty description', () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    for (const tool of tools.values()) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});

describe('epistemic_admit (mutation)', () => {
  it('admits a record and returns record_id, revision_id, sequence', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const r = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'mcp-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'Activation is contextual.',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.8,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't-1',
    })) as { ok: boolean; record_id: number; revision_id: string; sequence: number; idempotent_replay: boolean };
    expect(r.ok).toBe(true);
    expect(r.record_id).toBeGreaterThan(0);
    expect(r.revision_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.sequence).toBeGreaterThan(0);
    expect(r.idempotent_replay).toBe(false);
  });

  it('returns stable RELATION_PERSISTENCE_NOT_ADOPTED on non-empty relations', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const r = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'mcp-2',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'x',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't-1',
      relations: [{ type: 'supports', target_id: 'r-1' }],
    })) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RELATION_PERSISTENCE_NOT_ADOPTED');
  });
});

describe('epistemic_query (read, zero-write)', () => {
  it('returns matching records and never mutates any table', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    // Seed two records.
    await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'q-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'a',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't',
    });
    await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'q-2',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'b',
      epistemic_status: 'corroborated',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.7,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't',
    });

    const beforeCounts = {
      events: countRows('cognitive_events'),
      revisions: countRows('epistemic_revisions'),
      provenance: countRows('epistemic_provenance'),
      records: countRows('epistemic_records'),
      receipts: countRows('epistemic_receipts'),
    };

    const r = (await callTool(tools, 'epistemic_query', {
      project_id: 'cognitive-os',
      limit: 10,
    })) as { ok: boolean; total_matched: number; returned: number; records: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.total_matched).toBe(2);
    expect(r.returned).toBe(2);

    const afterCounts = {
      events: countRows('cognitive_events'),
      revisions: countRows('epistemic_revisions'),
      provenance: countRows('epistemic_provenance'),
      records: countRows('epistemic_records'),
      receipts: countRows('epistemic_receipts'),
    };
    expect(afterCounts).toEqual(beforeCounts);
  });

  it('caps results at the requested limit', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    for (let i = 0; i < 5; i += 1) {
      await callTool(tools, 'epistemic_admit', {
        idempotency_key: `cap-${i}`,
        project_id: 'cognitive-os',
        scope: 'exact-project',
        statement: `r${i}`,
        epistemic_status: 'inferred',
        verification_level: 'direct',
        source_quality: 'observed',
        confidence: 0.5,
        valid_from: '2026-08-09T00:00:00.000Z',
        task_id: 't',
      });
    }
    const r = (await callTool(tools, 'epistemic_query', {
      project_id: 'cognitive-os',
      limit: 2,
    })) as { returned: number; total_matched: number };
    expect(r.returned).toBe(2);
    expect(r.total_matched).toBe(5);
  });
});

describe('epistemic_get (read, zero-write)', () => {
  it('returns the current projection state', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'g-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'g',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };

    const before = countRows('cognitive_events');
    const r = (await callTool(tools, 'epistemic_get', {
      record_id: admitted.record_id,
      project_id: 'cognitive-os',
    })) as { ok: boolean; mode: string; record: { statement: string } };
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('current');
    expect(r.record.statement).toBe('g');
    expect(countRows('cognitive_events')).toBe(before);
  });

  it('returns OUT_OF_SCOPE for cross-project request without include_global', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'scope-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 's',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };
    const r = (await callTool(tools, 'epistemic_get', {
      record_id: admitted.record_id,
      project_id: 'other-project',
    })) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('OUT_OF_SCOPE');
  });

  it('supports as_of query', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const first = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'asof-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'first',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number; revision_id: string };
    await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'asof-2',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'second',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.7,
      valid_from: '2026-06-01T00:00:00.000Z',
      task_id: 't',
      expected_revision: 1,
      previous_revision_id: first.revision_id,
    });
    const r = (await callTool(tools, 'epistemic_get', {
      record_id: first.record_id,
      project_id: 'cognitive-os',
      as_of: '2026-04-01T00:00:00.000Z',
    })) as { ok: boolean; mode: string; record: { statement: string } };
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('as_of');
    expect(r.record.statement).toBe('first');
  });
});

describe('epistemic_append_receipt (mutation)', () => {
  it('appends a ChallengeReceipt and links it to a revision', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'r-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'r',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number; revision_id: string };
    const r = (await callTool(tools, 'epistemic_append_receipt', {
      idempotency_key: 'receipt-1',
      record_id: admitted.record_id,
      revision_id: admitted.revision_id,
      receipt_type: 'ChallengeReceipt',
      receipt_payload: { challenge: 'clean retrieval' },
      observed_at: '2026-08-09T01:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    })) as { ok: boolean; receipt_id: string };
    expect(r.ok).toBe(true);
    expect(r.receipt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(countRows('epistemic_receipts')).toBe(1);
  });
});

describe('epistemic_integrity_check (read)', () => {
  it('returns ok=true on a clean projection', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'i-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'i',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't',
    });
    const r = (await callTool(tools, 'epistemic_integrity_check', {})) as {
      ok: boolean;
      total_revisions: number;
      total_records: number;
      issues: unknown[];
    };
    expect(r.ok).toBe(true);
    expect(r.total_revisions).toBe(1);
    expect(r.total_records).toBe(1);
    expect(r.issues).toEqual([]);
  });
});
