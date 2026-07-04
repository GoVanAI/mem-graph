import { describe, it, expect, beforeEach } from 'vitest';
import { runDecayCycle } from '../src/decay.js';
import { createInMemoryDb, seedMemory, seedSynapse } from './helpers.js';

describe('runDecayCycle — matrix lookup', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('uses specific row when matched, not the wildcard', () => {
    // The matrix has ('semantic', 'semantic', 'wikilink', 0.99) and
    // ('semantic', '*', 'wikilink', 0.95). A semantic->semantic wikilink
    // should use 0.99, not 0.95. This is the v1-review critical issue 3 fix.
    const idA = seedMemory(db, { title: 'src', content: 'x', layer: 'semantic' });
    const idB = seedMemory(db, { title: 'tgt', content: 'y', layer: 'semantic' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    // Backdate updated_at so the synapse is decay-eligible; access_count=0
    // so the access-based exemption doesn't override the matrix rate.
    db.prepare(
      "UPDATE synapses SET updated_at = datetime('now', '-30 days'), access_count = 0 WHERE source_id = ?",
    ).run(idA);

    const before = (db.prepare('SELECT weight FROM synapses WHERE source_id = ?').get(idA) as {
      weight: number;
    }).weight;
    runDecayCycle(db, { decayDays: 7 });
    const after = (db.prepare('SELECT weight FROM synapses WHERE source_id = ?').get(idA) as {
      weight: number;
    }).weight;

    expect(before).toBe(1.0);
    // Expected: 1.0 * 0.99 = 0.99 (specific row), not 1.0 * 0.95 = 0.95 (wildcard).
    expect(after).toBeCloseTo(0.99, 2);
    expect(after).not.toBeCloseTo(0.95, 2);
  });

  it('falls back to wildcard when no specific row matches', () => {
    // The matrix has ('semantic', '*', 'wikilink', 0.95) but no specific
    // ('semantic', 'procedural', 'wikilink') row. The wildcard 0.95 applies.
    const idA = seedMemory(db, { title: 'src', content: 'x', layer: 'semantic' });
    const idB = seedMemory(db, { title: 'tgt', content: 'y', layer: 'procedural' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    db.prepare(
      "UPDATE synapses SET updated_at = datetime('now', '-30 days'), access_count = 0 WHERE source_id = ?",
    ).run(idA);

    runDecayCycle(db, { decayDays: 7 });
    const after = (db.prepare('SELECT weight FROM synapses WHERE source_id = ?').get(idA) as {
      weight: number;
    }).weight;
    // Wildcard 0.95 * access_count=0 (no exemption) = 0.95.
    expect(after).toBeCloseTo(0.95, 2);
  });

  it('does NOT decay synapses within the decayDays window', () => {
    const idA = seedMemory(db, { title: 'src', content: 'x', layer: 'semantic' });
    const idB = seedMemory(db, { title: 'tgt', content: 'y', layer: 'semantic' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    // updated_at = now (default) — within 7-day window

    runDecayCycle(db, { decayDays: 7 });
    const after = (db.prepare('SELECT weight FROM synapses WHERE source_id = ?').get(idA) as {
      weight: number;
    }).weight;
    expect(after).toBe(1.0);
  });

  it('applies the fallback rate when no matrix row exists at all', () => {
    // 'partner' -> 'working' has no matrix entry — but the schema has a wildcard row.
    // The real "no row at all" case is hard to construct because the matrix
    // has wildcards for most pairs. Test the fallback rate is reachable by
    // directly constructing a synapse with connection_type='parent_child',
    // for which no decay_matrix row exists. The COALESCE in decay.ts returns
    // the fallback rate (0.85) for unmatched cases.
    const idA = seedMemory(db, { title: 'src', content: 'x', layer: 'semantic' });
    const idB = seedMemory(db, { title: 'tgt', content: 'y', layer: 'semantic' });
    seedSynapse(db, idA, idB, 'parent_child', 1.0);
    db.prepare(
      "UPDATE synapses SET updated_at = datetime('now', '-30 days'), access_count = 0 WHERE source_id = ?",
    ).run(idA);

    runDecayCycle(db, { decayDays: 7 });
    const after = (db.prepare('SELECT weight FROM synapses WHERE source_id = ?').get(idA) as {
      weight: number;
    }).weight;
    // 1.0 * 0.85 (fallback) = 0.85
    expect(after).toBeCloseTo(0.85, 2);
  });
});

describe('runDecayCycle — pruning', () => {
  it('prunes synapses below the floor', () => {
    const db = createInMemoryDb();
    const idA = seedMemory(db, { title: 'src', content: 'x', layer: 'semantic' });
    const idB = seedMemory(db, { title: 'tgt', content: 'y', layer: 'semantic' });
    seedSynapse(db, idA, idB, 'wikilink', 0.05); // already below default floor 0.1

    runDecayCycle(db);
    const remaining = db
      .prepare('SELECT COUNT(*) AS c FROM synapses WHERE source_id = ?')
      .get(idA) as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('does not prune synapses above the floor', () => {
    const db = createInMemoryDb();
    const idA = seedMemory(db, { title: 'src', content: 'x', layer: 'semantic' });
    const idB = seedMemory(db, { title: 'tgt', content: 'y', layer: 'semantic' });
    seedSynapse(db, idA, idB, 'wikilink', 0.5);

    runDecayCycle(db);
    const remaining = db
      .prepare('SELECT COUNT(*) AS c FROM synapses WHERE source_id = ?')
      .get(idA) as { c: number };
    expect(remaining.c).toBe(1);
  });

  it('respects custom prune_floor', () => {
    const db = createInMemoryDb();
    const idA = seedMemory(db, { title: 'src', content: 'x', layer: 'semantic' });
    const idB = seedMemory(db, { title: 'tgt', content: 'y', layer: 'semantic' });
    seedSynapse(db, idA, idB, 'wikilink', 0.4);
    db.prepare(
      "UPDATE synapses SET updated_at = datetime('now', '-30 days'), access_count = 0 WHERE source_id = ?",
    ).run(idA);

    // With prune_floor = 0.5, the synapse (weight 0.4 after decay) is pruned.
    runDecayCycle(db, { pruneFloor: 0.5 });
    const remaining = db
      .prepare('SELECT COUNT(*) AS c FROM synapses WHERE source_id = ?')
      .get(idA) as { c: number };
    expect(remaining.c).toBe(0);
  });
});

describe('runDecayCycle — return shape', () => {
  it('returns counts of decayed, pruned, and access-exempted synapses', () => {
    const db = createInMemoryDb();
    const idA = seedMemory(db, { title: 'src', content: 'x', layer: 'semantic' });
    const idB = seedMemory(db, { title: 'tgt', content: 'y', layer: 'semantic' });
    seedSynapse(db, idA, idB, 'wikilink', 0.05); // will be pruned
    db.prepare(
      "UPDATE synapses SET updated_at = datetime('now', '-30 days'), access_count = 0 WHERE source_id = ?",
    ).run(idA);

    const result = runDecayCycle(db);
    expect(result).toHaveProperty('decayed');
    expect(result).toHaveProperty('pruned');
    expect(result).toHaveProperty('access_exempted');
    expect(result.pruned).toBe(1);
    expect(typeof result.decayed).toBe('number');
    expect(typeof result.access_exempted).toBe('number');
  });
});
