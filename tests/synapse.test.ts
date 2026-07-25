import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, seedMemory, seedSynapse } from './helpers.js';
import { runSynapseTraverse } from '../src/access.js';

/**
 * Regression tests for memory_synapse_traverse (id 178).
 *
 * Original bug (2026-07-25): the inline MCP tool handler built params as
 * [min_weight, connection_type, id, limit] but the SQL's `?` placeholders
 * appear in order [JOIN.source_id, WHERE.weight, WHERE.connection_type,
 * LIMIT]. min_weight (default 0) bound to JOIN.source_id filtered every
 * synapse to source_id=0, returning [] for every call.
 *
 * The helper `runSynapseTraverse` builds params in the same order as the
 * SQL placeholders. These tests lock that ordering by exercising every
 * direction/connection_type/min_weight combination — if anyone reorders
 * the param appendage out of step with the SQL, the matching test fails.
 */
describe('runSynapseTraverse — outgoing', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('returns outgoing wikilink synapses for the source', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idC = seedMemory(db, { title: 'c', content: 'cc' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    seedSynapse(db, idA, idC, 'wikilink', 1.0);

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'outgoing',
      connection_type: 'wikilink',
    });
    expect(rows.length).toBe(2);
    const targets = rows.map((r) => r.target_id).sort();
    expect(targets).toEqual([idB, idC].sort());
  });

  it('does NOT include incoming edges in outgoing direction', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    seedSynapse(db, idB, idA, 'wikilink', 1.0); // B -> A, A is target

    const rows = runSynapseTraverse(db, { id: idA, direction: 'outgoing' });
    expect(rows.length).toBe(0);
  });

  it('returns empty when the source has no outgoing edges', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    seedMemory(db, { title: 'b', content: 'bb' });
    const rows = runSynapseTraverse(db, { id: idA, direction: 'outgoing' });
    expect(rows).toEqual([]);
  });
});

describe('runSynapseTraverse — incoming', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('returns incoming wikilink synapses for the target', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idC = seedMemory(db, { title: 'c', content: 'cc' });
    seedSynapse(db, idB, idA, 'wikilink', 1.0);
    seedSynapse(db, idC, idA, 'wikilink', 1.0);

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'incoming',
      connection_type: 'wikilink',
    });
    expect(rows.length).toBe(2);
    const sources = rows.map((r) => r.source_id).sort();
    expect(sources).toEqual([idB, idC].sort());
  });

  it('does NOT include outgoing edges in incoming direction', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0); // A -> B, B is target

    const rows = runSynapseTraverse(db, { id: idA, direction: 'incoming' });
    expect(rows.length).toBe(0);
  });
});

describe('runSynapseTraverse — both directions', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('returns both outgoing and incoming edges with direction="both"', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idC = seedMemory(db, { title: 'c', content: 'cc' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0); // outgoing
    seedSynapse(db, idC, idA, 'wikilink', 1.0); // incoming

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'both',
      connection_type: 'wikilink',
    });
    expect(rows.length).toBe(2);
  });

  it('defaults to direction="both" when omitted', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idC = seedMemory(db, { title: 'c', content: 'cc' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    seedSynapse(db, idC, idA, 'wikilink', 1.0);

    const rows = runSynapseTraverse(db, {
      id: idA,
      connection_type: 'wikilink',
    });
    expect(rows.length).toBe(2);
  });
});

describe('runSynapseTraverse — connection_type filter', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('filters by connection_type="wikilink" only', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idC = seedMemory(db, { title: 'c', content: 'cc' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    seedSynapse(db, idA, idC, 'bm25_auto', 1.0);

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'outgoing',
      connection_type: 'wikilink',
    });
    expect(rows.length).toBe(1);
    expect(rows[0].target_id).toBe(idB);
    expect(rows[0].connection_type).toBe('wikilink');
  });

  it('filters by connection_type="bm25_auto" only', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idC = seedMemory(db, { title: 'c', content: 'cc' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    seedSynapse(db, idA, idC, 'bm25_auto', 1.5);

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'outgoing',
      connection_type: 'bm25_auto',
    });
    expect(rows.length).toBe(1);
    expect(rows[0].target_id).toBe(idC);
  });

  it('returns all connection types when filter is omitted', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idC = seedMemory(db, { title: 'c', content: 'cc' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    seedSynapse(db, idA, idC, 'bm25_auto', 1.5);

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'outgoing',
    });
    expect(rows.length).toBe(2);
  });
});

describe('runSynapseTraverse — min_weight filter', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('excludes synapses below min_weight', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idC = seedMemory(db, { title: 'c', content: 'cc' });
    const idD = seedMemory(db, { title: 'd', content: 'dd' });
    seedSynapse(db, idA, idB, 'wikilink', 0.3);
    seedSynapse(db, idA, idC, 'wikilink', 0.7);
    seedSynapse(db, idA, idD, 'wikilink', 1.5);

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'outgoing',
      connection_type: 'wikilink',
      min_weight: 0.5,
    });
    expect(rows.length).toBe(2);
    const targets = rows.map((r) => r.target_id).sort();
    expect(targets).toEqual([idC, idD].sort());
  });

  it('regression for the original bug: even with min_weight=0, synapses should be visible', () => {
    // The original bug filtered every synapse to source_id=0 because
    // min_weight (default 0) was bound to the JOIN.source_id placeholder.
    // This test ensures min_weight=0 still returns all synapses (the
    // default) — locking the placeholder/param order via behavior.
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'outgoing',
      connection_type: 'wikilink',
      min_weight: 0,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe(idA);
    expect(rows[0].target_id).toBe(idB);
  });
});

describe('runSynapseTraverse — limit', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('respects limit', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const targets: number[] = [];
    for (let i = 0; i < 5; i++) {
      targets.push(seedMemory(db, { title: `t${i}`, content: `t${i}` }));
      seedSynapse(db, idA, targets[i], 'wikilink', 1.0);
    }

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'outgoing',
      connection_type: 'wikilink',
      limit: 3,
    });
    expect(rows.length).toBe(3);
  });

  it('defaults to limit=50', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    for (let i = 0; i < 3; i++) {
      const tid = seedMemory(db, { title: `t${i}`, content: `t${i}` });
      seedSynapse(db, idA, tid, 'wikilink', 1.0);
    }
    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'outgoing',
      connection_type: 'wikilink',
    });
    expect(rows.length).toBe(3);
  });
});

describe('runSynapseTraverse — error cases', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('throws when the source memory does not exist', () => {
    expect(() =>
      runSynapseTraverse(db, { id: 99999, direction: 'outgoing' }),
    ).toThrow(/No memory found with id 99999/);
  });
});

describe('runSynapseTraverse — result shape', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('returns full row shape including other memory metadata', () => {
    const idA = seedMemory(db, {
      title: 'src',
      content: 'src content',
      layer: 'semantic',
    });
    const idB = seedMemory(db, {
      title: 'target title',
      content: 'target content',
      layer: 'episodic',
    });
    seedSynapse(db, idA, idB, 'wikilink', 1.5);

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'outgoing',
      connection_type: 'wikilink',
    });
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.source_id).toBe(idA);
    expect(row.target_id).toBe(idB);
    expect(row.connection_type).toBe('wikilink');
    expect(row.weight).toBe(1.5);
    expect(row.other_id).toBe(idB);
    expect(row.other_title).toBe('target title');
    expect(row.other_layer).toBe('episodic');
    expect(row.other_status).toBe('active');
    expect(typeof row.created_at).toBe('string');
    expect(typeof row.updated_at).toBe('string');
  });

  it('orders results by weight DESC, updated_at DESC', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idC = seedMemory(db, { title: 'c', content: 'cc' });
    const idD = seedMemory(db, { title: 'd', content: 'dd' });
    seedSynapse(db, idA, idB, 'wikilink', 0.5);
    seedSynapse(db, idA, idC, 'wikilink', 2.0);
    seedSynapse(db, idA, idD, 'wikilink', 1.0);

    const rows = runSynapseTraverse(db, {
      id: idA,
      direction: 'outgoing',
      connection_type: 'wikilink',
    });
    expect(rows.map((r) => r.target_id)).toEqual([idC, idD, idB]);
  });
});