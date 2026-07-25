import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, seedMemory, seedSynapse } from './helpers.js';
import { bumpMemoryAccess, bumpSynapseAccess } from '../src/access.js';

describe('bumpMemoryAccess', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('sets accessed_at and increments access_count on first call', () => {
    const id = seedMemory(db, { title: 'x', content: 'y' });
    bumpMemoryAccess(db, id);
    const row = db
      .prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?')
      .get(id) as { access_count: number; accessed_at: string | null };
    expect(row.access_count).toBe(1);
    expect(row.accessed_at).not.toBeNull();
  });

  it('is additive across multiple calls', () => {
    const id = seedMemory(db, { title: 'x', content: 'y' });
    bumpMemoryAccess(db, id);
    bumpMemoryAccess(db, id);
    bumpMemoryAccess(db, id);
    const row = db
      .prepare('SELECT access_count FROM memories WHERE id = ?')
      .get(id) as { access_count: number };
    expect(row.access_count).toBe(3);
  });

  it('no-ops for an unknown memory id (no row to update)', () => {
    expect(() => bumpMemoryAccess(db, 99999)).not.toThrow();
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM memories WHERE id = ?')
      .get(99999) as { c: number };
    expect(row.c).toBe(0);
  });
});

describe('bumpSynapseAccess', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('increments access_count on a synapse connecting the memory as source', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa', layer: 'procedural' });
    const idB = seedMemory(db, { title: 'b', content: 'bb', layer: 'procedural' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);

    bumpSynapseAccess(db, [idA]);
    const row = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idA) as { access_count: number };
    expect(row.access_count).toBe(1);
  });

  it('increments access_count on a synapse connecting the memory as target', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa', layer: 'procedural' });
    const idB = seedMemory(db, { title: 'b', content: 'bb', layer: 'procedural' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);

    bumpSynapseAccess(db, [idB]);
    const row = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idA) as { access_count: number };
    expect(row.access_count).toBe(1);
  });

  it('increments all synapses touching any endpoint in the list', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idC = seedMemory(db, { title: 'c', content: 'cc' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    seedSynapse(db, idB, idC, 'wikilink', 1.0);

    bumpSynapseAccess(db, [idB]);
    const s1 = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idA) as { access_count: number };
    const s2 = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idB) as { access_count: number };
    expect(s1.access_count).toBe(1); // A→B touched via B (target)
    expect(s2.access_count).toBe(1); // B→C touched via B (source)
  });

  it('does not touch synapses between two unrelated memories', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    const idX = seedMemory(db, { title: 'x', content: 'xx' });
    const idY = seedMemory(db, { title: 'y', content: 'yy' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);
    seedSynapse(db, idX, idY, 'wikilink', 1.0);

    bumpSynapseAccess(db, [idA]);
    const s1 = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idA) as { access_count: number };
    const s2 = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idX) as { access_count: number };
    expect(s1.access_count).toBe(1);
    expect(s2.access_count).toBe(0);
  });

  it('is a no-op on empty input (does not throw, does not write)', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);

    expect(() => bumpSynapseAccess(db, [])).not.toThrow();
    const row = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idA) as { access_count: number };
    expect(row.access_count).toBe(0);
  });

  it('is additive across multiple calls', () => {
    const idA = seedMemory(db, { title: 'a', content: 'aa' });
    const idB = seedMemory(db, { title: 'b', content: 'bb' });
    seedSynapse(db, idA, idB, 'wikilink', 1.0);

    bumpSynapseAccess(db, [idA]);
    bumpSynapseAccess(db, [idA]);
    bumpSynapseAccess(db, [idA]);
    const row = db
      .prepare('SELECT access_count FROM synapses WHERE source_id = ?')
      .get(idA) as { access_count: number };
    expect(row.access_count).toBe(3);
  });
});
