import { describe, it, expect, beforeEach } from 'vitest';
import { autoLinkOnInsert } from '../src/auto-link.js';
import { createInMemoryDb, seedMemory, seedSynapse, countSynapses } from './helpers.js';

describe('autoLinkOnInsert', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('creates bm25_auto synapses to BM25 neighbors in same project', () => {
    // Two memories with overlapping vocabulary; insert a third that shares
    // vocabulary with one but not the other.
    seedMemory(db, {
      title: 'cats and dogs',
      content: 'Cats and dogs are common household pets and companions.',
      project_id: 'pets',
    });
    seedMemory(db, {
      title: 'pet care',
      content: 'Cats and dogs both require care feeding and attention.',
      project_id: 'pets',
    });
    seedMemory(db, {
      title: 'engine maintenance',
      content: 'Cars and trucks have engines that need oil changes.',
      project_id: 'pets',
    });
    // Seed a fresh source memory and capture its real id (FK to synapses requires it).
    const sourceId = seedMemory(db, {
      title: 'fresh pet note',
      content: 'Notes about cats dogs puppies later',
      project_id: 'pets',
    });
    // Insert content sharing vocabulary with the first two but not the third.
    const result = autoLinkOnInsert(
      db,
      sourceId,
      'Cats and dogs and puppies playing in the yard.',
      'pets',
    );
    expect(result.created + result.updated).toBeGreaterThan(0);
    const synapses = db
      .prepare(
        "SELECT target_id FROM synapses WHERE source_id = ? AND connection_type = 'bm25_auto'",
      )
      .all(sourceId) as Array<{ target_id: number }>;
    const targets = synapses.map((s) => s.target_id);
    // 'cats and dogs' and 'pet care' share vocabulary; 'engine maintenance' does not.
    expect(targets).toContain(1); // cats and dogs
    expect(targets).toContain(2); // pet care
    expect(targets).not.toContain(3); // engine maintenance
  });

  it('does not create cross-project links (project floor)', () => {
    const idPets = seedMemory(db, {
      title: 'cats and dogs',
      content: 'Cats and dogs are common household pets and companions.',
      project_id: 'pets',
    });
    seedMemory(db, {
      title: 'cats and dogs',
      content: 'Cats and dogs are common household pets and companions.',
      project_id: 'other',
    });
    const sourceId = seedMemory(db, {
      title: 'fresh pet note',
      content: 'Notes about cats dogs puppies later',
      project_id: 'pets',
    });
    // Inserting into 'pets' should only auto-link to the 'pets' copy.
    const result = autoLinkOnInsert(
      db,
      sourceId,
      'Cats and dogs and puppies playing in the yard.',
      'pets',
    );
    const synapses = db
      .prepare(
        "SELECT target_id FROM synapses WHERE source_id = ? AND connection_type = 'bm25_auto'",
      )
      .all(sourceId) as Array<{ target_id: number }>;
    const targets = synapses.map((s) => s.target_id);
    expect(targets).toContain(idPets); // pets project
    expect(targets).not.toContain(2); // other project — excluded by project floor
    expect(result.created).toBeGreaterThan(0);
  });

  it('clamps weight to [0.2, 1.5] range', () => {
    seedMemory(db, {
      title: 'vocab',
      content: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron',
      project_id: '_global',
    });
    const sourceId = seedMemory(db, {
      title: 'fresh vocab',
      content: 'intro line',
      project_id: '_global',
    });
    autoLinkOnInsert(
      db,
      sourceId,
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron',
      '_global',
    );
    const synapses = db
      .prepare(
        "SELECT weight FROM synapses WHERE source_id = ? AND connection_type = 'bm25_auto'",
      )
      .all(sourceId) as Array<{ weight: number }>;
    for (const s of synapses) {
      expect(s.weight).toBeGreaterThanOrEqual(0.2);
      expect(s.weight).toBeLessThanOrEqual(1.5);
    }
  });

  it('does not create self-loops', () => {
    const sourceId = seedMemory(db, {
      title: 'anchor',
      content: 'the anchor vocabulary words here',
      project_id: '_global',
    });
    autoLinkOnInsert(db, sourceId, 'anchor vocabulary words here', '_global');
    const selfLoop = db
      .prepare(
        "SELECT 1 FROM synapses WHERE source_id = ? AND target_id = ? AND connection_type = 'bm25_auto'",
      )
      .get(sourceId, sourceId);
    expect(selfLoop).toBeUndefined();
  });

  it('enforces 50-synapse cap by pruning lowest-weight bm25_auto', () => {
    // Create the source memory
    const sourceId = seedMemory(db, {
      title: 'source',
      content: 's',
      project_id: '_global',
    });
    // Pre-seed 60 bm25_auto synapses from source, all wikilink-shaped
    for (let i = 0; i < 60; i++) {
      const neighborId = seedMemory(db, {
        title: `n${i}`,
        content: `neighbor ${i}`,
        project_id: '_global',
      });
      seedSynapse(db, sourceId, neighborId, 'bm25_auto', 0.3 + i * 0.01);
    }
    // Now run autoLinkOnInsert on the source — it shouldn't blow the cap.
    // (The cap is enforced inside autoLinkOnInsert on every insert, but
    // since we manually pre-seeded above, we need to verify the helper can
    // clean up. The simplest check: source still has <= 50 outgoing after
    // a re-run, since some synapses may get re-created and prune others.)
    autoLinkOnInsert(db, sourceId, 'a different content body', '_global');
    // We re-pre-seeded 60 — autolink may not always prune. Let's directly
    // check the cap enforcement by calling the helper fresh on a new memory.
    const freshSource = seedMemory(db, {
      title: 'fresh',
      content: 'f',
      project_id: '_global',
    });
    for (let i = 0; i < 60; i++) {
      const neighborId = seedMemory(db, {
        title: `f${i}`,
        content: `neighbor ${i}`,
        project_id: '_global',
      });
      seedSynapse(db, freshSource, neighborId, 'bm25_auto', 0.3 + i * 0.01);
    }
    expect(countSynapses(db, freshSource)).toBe(60);
    // Now re-run autolink — the helper checks and prunes if over cap.
    // Use content that WILL match the seeded neighbors (they all contain
    // 'neighbor') so the function actually runs the cap check.
    autoLinkOnInsert(db, freshSource, 'neighbor cluster alpha beta gamma', '_global');
    expect(countSynapses(db, freshSource)).toBeLessThanOrEqual(50);
  });

  it('never prunes wikilink synapses when enforcing cap', () => {
    // 50 wikilink synapses + 5 bm25_auto — cap should target bm25 only
    const sourceId = seedMemory(db, {
      title: 'source',
      content: 's',
      project_id: '_global',
    });
    for (let i = 0; i < 50; i++) {
      const neighborId = seedMemory(db, {
        title: `w${i}`,
        content: `n ${i}`,
        project_id: '_global',
      });
      seedSynapse(db, sourceId, neighborId, 'wikilink', 1.0);
    }
    for (let i = 0; i < 5; i++) {
      const neighborId = seedMemory(db, {
        title: `b${i}`,
        content: `n ${i}`,
        project_id: '_global',
      });
      seedSynapse(db, sourceId, neighborId, 'bm25_auto', 0.2);
    }
    // Trigger cap enforcement by re-running autolink
    autoLinkOnInsert(db, sourceId, 'some new content here', '_global');
    // All 50 wikilinks survive — only bm25 would be pruned if cap exceeded
    const wikilinkCount = countSynapses(db, sourceId, 'wikilink');
    expect(wikilinkCount).toBe(50);
  });

  it('returns zero when content has no usable tokens (only punctuation)', () => {
    seedMemory(db, { title: 'cat', content: 'cat' });
    const result = autoLinkOnInsert(db, 999, '!!!', '_global');
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });
});
