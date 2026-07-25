import { describe, it, expect, beforeEach } from 'vitest';
import { runActivate } from '../src/activate.js';
import { createInMemoryDb, seedMemory, seedSynapse } from './helpers.js';

describe('runActivate — FTS5 anchor', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('returns hits for FTS5 query', () => {
    seedMemory(db, { title: 'tax policy', content: 'Tax policy on capital gains' });
    const result = runActivate(db, { query: 'capital gains' });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].max_relevance).toBeGreaterThan(0);
  });

  it('returns empty result for unmatched query', () => {
    seedMemory(db, { title: 'x', content: 'y' });
    const result = runActivate(db, { query: 'xyzzyplugh' });
    expect(result).toEqual([]);
  });
});

describe('runActivate — depth bound', () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let idA: number, idB: number, idC: number, idD: number;

  beforeEach(() => {
    db = createInMemoryDb();
    idA = seedMemory(db, { title: 'anchor', content: 'zebra zebra zebra' });
    idB = seedMemory(db, { title: 'b', content: 'other topic B' });
    idC = seedMemory(db, { title: 'c', content: 'other topic C' });
    idD = seedMemory(db, { title: 'd', content: 'other topic D' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    seedSynapse(db, idB, idC, 'wikilink', 1.0);
    seedSynapse(db, idC, idD, 'wikilink', 1.0);
  });

  it('depth=1 reaches anchor + 1 hop (B) but not 2-hop (C)', () => {
    const result = runActivate(db, { query: 'zebra', max_hop_depth: 1 });
    const ids = result.map((r) => r.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    expect(ids).not.toContain(idC);
    expect(ids).not.toContain(idD);
  });

  it('depth=2 reaches anchor + 2 hops (B, C) but not 3-hop (D)', () => {
    const result = runActivate(db, { query: 'zebra', max_hop_depth: 2 });
    const ids = result.map((r) => r.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    expect(ids).toContain(idC);
    expect(ids).not.toContain(idD);
  });

  it('depth=3 reaches the entire chain', () => {
    const result = runActivate(db, { query: 'zebra', max_hop_depth: 3 });
    const ids = result.map((r) => r.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    expect(ids).toContain(idC);
    expect(ids).toContain(idD);
  });
});

describe('runActivate — weight bound', () => {
  it('skips synapses below min_synapse_weight', () => {
    const db = createInMemoryDb();
    const idA = seedMemory(db, { title: 'anchor', content: 'quokka quokka quokka' });
    const idB = seedMemory(db, { title: 'weak neighbor', content: 'irrelevant' });
    seedSynapse(db, idA, idB, 'wikilink', 0.1); // below default 0.3

    const result = runActivate(db, { query: 'quokka', min_synapse_weight: 0.5 });
    const ids = result.map((r) => r.id);
    expect(ids).toContain(idA);
    expect(ids).not.toContain(idB);
  });
});

describe('runActivate — layer filtering', () => {
  it('respects land_on_layers (with pass_through_layers excluding the anchor)', () => {
    // A is semantic (the FTS5 anchor). B is working, reachable via wikilink.
    // Default pass_through_layers=['semantic'] lets A act as a pass-through,
    // which would let B land even with land_on_layers=['semantic']. To test
    // land_on_layers in isolation, set pass_through_layers to a layer that
    // excludes semantic — then B can't be reached and only A lands.
    const db = createInMemoryDb();
    const idA = seedMemory(db, {
      title: 'anchor',
      content: 'narwhal narwhal narwhal',
      layer: 'semantic',
    });
    const idB = seedMemory(db, {
      title: 'working neighbor',
      content: 'other',
      layer: 'working',
    });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);

    const result = runActivate(db, {
      query: 'narwhal',
      land_on_layers: ['semantic'],
      pass_through_layers: ['partner'], // exclude semantic from pass-through
    });
    const ids = result.map((r) => r.id);
    expect(ids).toContain(idA);
    expect(ids).not.toContain(idB);
  });
});

describe('runActivate — access tracking', () => {
  it('updates access_count and accessed_at on retrieved memories', () => {
    const db = createInMemoryDb();
    const idA = seedMemory(db, { title: 'anchor', content: 'platypus platypus platypus' });
    runActivate(db, { query: 'platypus' });
    const mem = db
      .prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?')
      .get(idA) as { access_count: number; accessed_at: string | null };
    expect(mem.access_count).toBe(1);
    expect(mem.accessed_at).not.toBeNull();
  });

  it('increments access_count on subsequent retrieves', () => {
    const db = createInMemoryDb();
    const idA = seedMemory(db, { title: 'anchor', content: 'echidna echidna echidna' });
    runActivate(db, { query: 'echidna' });
    runActivate(db, { query: 'echidna' });
    runActivate(db, { query: 'echidna' });
    const mem = db
      .prepare('SELECT access_count FROM memories WHERE id = ?')
      .get(idA) as { access_count: number };
    expect(mem.access_count).toBe(3);
  });
});

describe('runActivate — project scoping', () => {
  it('scopes by project_id', () => {
    const db = createInMemoryDb();
    seedMemory(db, {
      title: 'in another',
      content: 'pangolin pangolin pangolin',
      project_id: 'other',
    });
    const idMine = seedMemory(db, {
      title: 'in mine',
      content: 'pangolin pangolin pangolin',
      project_id: 'mine',
    });

    const result = runActivate(db, { query: 'pangolin', project_id: 'mine' });
    const ids = result.map((r) => r.id);
    expect(ids).toContain(idMine);
    expect(ids).not.toContain(1); // the 'other' project memory
  });

  it('returns _global entries for any project', () => {
    const db = createInMemoryDb();
    const idGlobal = seedMemory(db, {
      title: 'global',
      content: 'armadillo armadillo armadillo',
      project_id: '_global',
    });
    const result = runActivate(db, {
      query: 'armadillo',
      project_id: 'whatever-project',
    });
    const ids = result.map((r) => r.id);
    expect(ids).toContain(idGlobal);
  });
});

/**
 * Regression: synapse access_count is bumped on the result-set's edges (id 90).
 *
 * Bug: only memory_get(include_synapses=true) wrote to synapses.access_count.
 * memory_activate, the headline retrieval path, never bumped synapses, so the
 * decay's access-based exemption (src/decay.ts:48-59) was effectively dead.
 * Fix: runActivate now bumps synapses whose either endpoint is in the
 * result set.
 */
describe('runActivate — synapse access tracking (regression: id 90)', () => {
  it('increments synapse access_count when either endpoint lands in the result set', () => {
    const db = createInMemoryDb();
    const idA = seedMemory(db, {
      title: 'a',
      content: 'capybara capybara capybara',
      layer: 'procedural',
    });
    const idB = seedMemory(db, {
      title: 'b',
      content: 'capybara b',
      layer: 'procedural',
    });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);

    // Confirm baseline: synapse starts at access_count = 0
    const before = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idA) as { access_count: number };
    expect(before.access_count).toBe(0);

    runActivate(db, { query: 'capybara' });

    const after = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idA) as { access_count: number };
    expect(after.access_count).toBeGreaterThan(0);
  });

  it('does not bump synapses whose endpoints are not in the result set', () => {
    const db = createInMemoryDb();
    const idA = seedMemory(db, { title: 'a', content: 'aardvark aardvark aardvark' });
    const idB = seedMemory(db, { title: 'b', content: 'aardvark b' });
    const idX = seedMemory(db, { title: 'x', content: 'unrelated content' });
    const idY = seedMemory(db, { title: 'y', content: 'unrelated content' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    seedSynapse(db, idX, idY, 'wikilink', 1.0);

    runActivate(db, { query: 'aardvark' });

    const touched = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idA) as { access_count: number };
    const untouched = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idX) as { access_count: number };
    expect(touched.access_count).toBeGreaterThan(0);
    expect(untouched.access_count).toBe(0);
  });
});
