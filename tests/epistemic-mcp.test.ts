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
  it('registers exactly 6 tools with the adopted Slice 1 names plus concept_diff', () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const names = Array.from(tools.keys()).sort();
    expect(names).toEqual([
      'epistemic_admit',
      'epistemic_append_receipt',
      'epistemic_concept_diff',
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

  it('returns OUT_OF_SCOPE for cross-project as_of request (Sol H8-1 regression)', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'scope-asof-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'asof-scope',
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
      as_of: '2026-08-10T00:00:00.000Z',
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

  it('returns OUT_OF_SCOPE for foreign exact-project record even with include_global=true (current and as_of)', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'scope-foreign-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'exact private',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };

    // Current path
    const rCurrent = (await callTool(tools, 'epistemic_get', {
      record_id: admitted.record_id,
      project_id: 'other-project',
      include_global: true,
    })) as { ok: boolean; code: string };
    expect(rCurrent.ok).toBe(false);
    expect(rCurrent.code).toBe('OUT_OF_SCOPE');

    // as_of path
    const rAsOf = (await callTool(tools, 'epistemic_get', {
      record_id: admitted.record_id,
      project_id: 'other-project',
      include_global: true,
      as_of: '2026-06-01T00:00:00.000Z',
    })) as { ok: boolean; code: string };
    expect(rAsOf.ok).toBe(false);
    expect(rAsOf.code).toBe('OUT_OF_SCOPE');
  });

  it('_global-scope record fails when global inclusion is disabled (current and as_of)', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'scope-global-disabled-1',
      project_id: 'cognitive-os',
      scope: '_global',
      statement: 'global belief',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };

    // Current path without include_global
    const rCurrent = (await callTool(tools, 'epistemic_get', {
      record_id: admitted.record_id,
      project_id: 'cognitive-os',
    })) as { ok: boolean; code: string };
    expect(rCurrent.ok).toBe(false);
    expect(rCurrent.code).toBe('OUT_OF_SCOPE');

    // as_of path without include_global
    const rAsOf = (await callTool(tools, 'epistemic_get', {
      record_id: admitted.record_id,
      project_id: 'cognitive-os',
      as_of: '2026-06-01T00:00:00.000Z',
    })) as { ok: boolean; code: string };
    expect(rAsOf.ok).toBe(false);
    expect(rAsOf.code).toBe('OUT_OF_SCOPE');
  });

  it('_global-scope record succeeds when global inclusion is enabled (current and as_of)', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'scope-global-enabled-1',
      project_id: 'cognitive-os',
      scope: '_global',
      statement: 'global belief active',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };

    // Current path with include_global: true from foreign project
    const rCurrent = (await callTool(tools, 'epistemic_get', {
      record_id: admitted.record_id,
      project_id: 'other-project',
      include_global: true,
    })) as { ok: boolean; mode: string; record: { statement: string } };
    expect(rCurrent.ok).toBe(true);
    expect(rCurrent.mode).toBe('current');
    expect(rCurrent.record.statement).toBe('global belief active');

    // as_of path with include_global: true
    const rAsOf = (await callTool(tools, 'epistemic_get', {
      record_id: admitted.record_id,
      project_id: 'other-project',
      include_global: true,
      as_of: '2026-06-01T00:00:00.000Z',
    })) as { ok: boolean; mode: string; record: { statement: string } };
    expect(rAsOf.ok).toBe(true);
    expect(rAsOf.mode).toBe('as_of');
    expect(rAsOf.record.statement).toBe('global belief active');
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

  it('returns RECORD_REVISION_MISMATCH for record_id mismatch (Sol H8-2 regression)', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const a = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'mismatch-rec-a',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'a',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number; revision_id: string };
    const b = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'mismatch-rec-b',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'b',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };
    const r = (await callTool(tools, 'epistemic_append_receipt', {
      idempotency_key: 'receipt-mismatch-rec',
      record_id: b.record_id, // different record
      revision_id: a.revision_id, // revision of record a
      receipt_type: 'ChallengeReceipt',
      receipt_payload: { challenge: 'wrong record' },
      observed_at: '2026-08-09T01:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    })) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RECORD_REVISION_MISMATCH');
  });

  it('returns RECORD_REVISION_MISMATCH for project_id mismatch (Sol H8-2 regression)', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'mismatch-proj',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'proj',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-08-09T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number; revision_id: string };
    const r = (await callTool(tools, 'epistemic_append_receipt', {
      idempotency_key: 'receipt-mismatch-proj',
      record_id: admitted.record_id,
      revision_id: admitted.revision_id,
      receipt_type: 'ChallengeReceipt',
      receipt_payload: { challenge: 'wrong project' },
      observed_at: '2026-08-09T01:00:00.000Z',
      task_id: 't',
      project_id: 'other-project', // different project
    })) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RECORD_REVISION_MISMATCH');
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

describe('epistemic_concept_diff (read, zero-write) — Item 9 Goal 8', () => {
  it('1. happy path: detects a field-level change between two revisions', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const first = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'original',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number; revision_id: string };
    await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-2',
      record_id: first.record_id,
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'revised',
      epistemic_status: 'corroborated',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.9,
      valid_from: '2026-06-01T00:00:00.000Z',
      task_id: 't',
      expected_revision: 1,
      previous_revision_id: first.revision_id,
    });
    const r = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: first.record_id,
      project_id: 'cognitive-os',
      from_as_of: '2026-04-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
    })) as {
      ok: boolean;
      diff: {
        record_change: string;
        changes: Array<{ field: string; change_type: string }>;
        revision_delta: { from_revision: number | null; to_revision: number | null };
      };
    };
    expect(r.ok).toBe(true);
    expect(r.diff.record_change).toBe('changed');
    expect(r.diff.revision_delta).toEqual({ from_revision: 1, to_revision: 2 });
    const changedFields = r.diff.changes.map((c) => c.field);
    expect(changedFields).toContain('statement');
    expect(changedFields).toContain('epistemic_status');
    expect(changedFields).toContain('confidence');
  });

  it('2. default retraction gating (Sol H1): hides retracted to-state', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const first = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-ret-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'to be retracted',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number; revision_id: string };
    await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-ret-2',
      record_id: first.record_id,
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'to be retracted',
      epistemic_status: 'retracted',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-06-01T00:00:00.000Z',
      task_id: 't',
      expected_revision: 1,
      previous_revision_id: first.revision_id,
    });
    const r = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: first.record_id,
      project_id: 'cognitive-os',
      from_as_of: '2026-04-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
    })) as {
      ok: boolean;
      diff: { record_change: string; to_state: unknown };
    };
    expect(r.ok).toBe(true);
    expect(r.diff.record_change).toBe('removed');
    expect(r.diff.to_state).toBeNull();
  });

  it('3. include_retracted=true surfaces retracted content', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const first = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-ret3-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'pre-retraction',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number; revision_id: string };
    await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-ret3-2',
      record_id: first.record_id,
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'pre-retraction',
      epistemic_status: 'retracted',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-06-01T00:00:00.000Z',
      task_id: 't',
      expected_revision: 1,
      previous_revision_id: first.revision_id,
    });
    const r = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: first.record_id,
      project_id: 'cognitive-os',
      from_as_of: '2026-04-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
      include_retracted: true,
    })) as {
      ok: boolean;
      diff: {
        record_change: string;
        to_state: { epistemic_status: string } | null;
      };
    };
    expect(r.ok).toBe(true);
    expect(r.diff.record_change).toBe('changed');
    expect(r.diff.to_state).not.toBeNull();
    expect(r.diff.to_state?.epistemic_status).toBe('retracted');
  });

  it('4. include_unchanged=true surfaces unchanged fields', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const first = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-inc-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'unchanged statement',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number; revision_id: string };
    await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-inc-2',
      record_id: first.record_id,
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'unchanged statement',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.9, // only confidence changes
      valid_from: '2026-06-01T00:00:00.000Z',
      task_id: 't',
      expected_revision: 1,
      previous_revision_id: first.revision_id,
    });
    const r = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: first.record_id,
      project_id: 'cognitive-os',
      from_as_of: '2026-04-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
      include_unchanged: true,
    })) as {
      ok: boolean;
      diff: { changes: Array<{ field: string; change_type: string }> };
    };
    expect(r.ok).toBe(true);
    const unchangedFields = r.diff.changes
      .filter((c) => c.change_type === 'unchanged')
      .map((c) => c.field);
    expect(unchangedFields.length).toBeGreaterThan(0);
    expect(unchangedFields).toContain('statement');
    expect(unchangedFields).toContain('verification_level');
  });

  it('5. record added in window: from_state=null, record_change=added', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-add-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'late admission',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-06-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };
    const r = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: admitted.record_id,
      project_id: 'cognitive-os',
      from_as_of: '2026-01-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
    })) as {
      ok: boolean;
      diff: { record_change: string; from_state: unknown };
    };
    expect(r.ok).toBe(true);
    expect(r.diff.record_change).toBe('added');
    expect(r.diff.from_state).toBeNull();
  });

  it('6. project_id scope: returns OUT_OF_SCOPE on cross-project request', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-scope-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'scoped record',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };
    const r = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: admitted.record_id,
      project_id: 'other-project',
      from_as_of: '2026-04-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
    })) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('OUT_OF_SCOPE');
  });

  it('7. foreign exact-project record fails even with include_global=true', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-global-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'cross-project readable',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };
    const r = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: admitted.record_id,
      project_id: 'other-project',
      include_global: true,
      from_as_of: '2026-04-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
    })) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('OUT_OF_SCOPE');
  });

  it('7b. _global-scope record fails in concept diff when global inclusion is disabled', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-global-dis-1',
      project_id: 'cognitive-os',
      scope: '_global',
      statement: 'global diff target',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };
    const r = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: admitted.record_id,
      project_id: 'cognitive-os',
      include_global: false,
      from_as_of: '2026-04-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
    })) as { ok: boolean; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('OUT_OF_SCOPE');
  });

  it('7c. _global-scope record succeeds in concept diff when global inclusion is enabled', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-global-en-1',
      project_id: 'cognitive-os',
      scope: '_global',
      statement: 'global diff target active',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };
    const r = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: admitted.record_id,
      project_id: 'other-project',
      include_global: true,
      from_as_of: '2026-04-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it('7d. concept diff validates both from_state and to_state endpoints', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    // Case 1: Record added in window (from_state: null, to_state: non-null)
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-endpoints-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'endpoint test',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-06-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };

    // from_as_of is before creation -> from_state is null, to_state is non-null.
    // Querying from 'other-project' with include_global=true must fail because to_state is foreign exact-project!
    const rToState = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: admitted.record_id,
      project_id: 'other-project',
      include_global: true,
      from_as_of: '2026-01-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
    })) as { ok: boolean; code: string };
    expect(rToState.ok).toBe(false);
    expect(rToState.code).toBe('OUT_OF_SCOPE');

    // Case 2: Record retracted in window without include_retracted (from_state: non-null, to_state: null)
    const admitted2 = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-endpoints-2a',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'endpoint test 2',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number; revision_id: string };
    await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-endpoints-2b',
      record_id: admitted2.record_id,
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'endpoint test 2',
      epistemic_status: 'retracted',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-06-01T00:00:00.000Z',
      task_id: 't',
      expected_revision: 1,
      previous_revision_id: admitted2.revision_id,
    });
    // to_as_of is after retraction; without include_retracted, to_state is null, from_state is non-null.
    // Querying from 'other-project' with include_global=true must fail because from_state is foreign exact-project!
    const rFromState = (await callTool(tools, 'epistemic_concept_diff', {
      record_id: admitted2.record_id,
      project_id: 'other-project',
      include_global: true,
      from_as_of: '2026-04-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
    })) as { ok: boolean; code: string };
    expect(rFromState.ok).toBe(false);
    expect(rFromState.code).toBe('OUT_OF_SCOPE');
  });

  it('8. zero-write: never mutates any table', async () => {
    const { server, tools } = createFakeServer();
    registerEpistemicTools(server);
    const admitted = (await callTool(tools, 'epistemic_admit', {
      idempotency_key: 'diff-zero-1',
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'zero-write target',
      epistemic_status: 'inferred',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-01-01T00:00:00.000Z',
      task_id: 't',
    })) as { record_id: number };

    const beforeCounts = {
      events: countRows('cognitive_events'),
      revisions: countRows('epistemic_revisions'),
      provenance: countRows('epistemic_provenance'),
      records: countRows('epistemic_records'),
      receipts: countRows('epistemic_receipts'),
    };

    await callTool(tools, 'epistemic_concept_diff', {
      record_id: admitted.record_id,
      project_id: 'cognitive-os',
      from_as_of: '2026-04-01T00:00:00.000Z',
      to_as_of: '2026-08-01T00:00:00.000Z',
    });

    const afterCounts = {
      events: countRows('cognitive_events'),
      revisions: countRows('epistemic_revisions'),
      provenance: countRows('epistemic_provenance'),
      records: countRows('epistemic_records'),
      receipts: countRows('epistemic_receipts'),
    };
    expect(afterCounts).toEqual(beforeCounts);
  });
});
