import { describe, it, expect, beforeEach } from 'vitest';
import { runSupersede } from '../src/tools/memory-write.js';
import { createInMemoryDb, seedMemory, getMemoryStatus } from './helpers.js';

describe('runSupersede', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('marks old entry as superseded AND inserts wikilink synapse to new entry', () => {
    const oldId = seedMemory(db, { title: 'old decision', content: 'old' });
    const newId = seedMemory(db, { title: 'new decision', content: 'new' });

    const result = runSupersede(db, oldId, newId, 'flipped on review');
    expect(result.status).toBe('superseded');
    expect(result.old_id).toBe(oldId);
    expect(result.new_id).toBe(newId);
    expect(result.reason).toBe('flipped on review');

    expect(getMemoryStatus(db, oldId)).toBe('superseded');

    const synapse = db
      .prepare(
        "SELECT weight FROM synapses WHERE source_id = ? AND target_id = ? AND connection_type = 'wikilink'",
      )
      .get(oldId, newId) as { weight: number } | undefined;
    expect(synapse).toBeDefined();
    expect(synapse!.weight).toBe(1.0);
  });

  it('rejects self-supersede', () => {
    const id = seedMemory(db, { title: 'x', content: 'y' });
    expect(() => runSupersede(db, id, id, 'self')).toThrow(/must be different/);
  });

  it('throws if old_id does not exist', () => {
    const newId = seedMemory(db, { title: 'new', content: 'new content' });
    expect(() => runSupersede(db, 999, newId, 'missing')).toThrow(/old_id/);
  });

  it('throws if new_id does not exist', () => {
    const oldId = seedMemory(db, { title: 'old', content: 'old content' });
    expect(() => runSupersede(db, oldId, 999, 'missing')).toThrow(/new_id/);
  });

  it('does not change the new entry status', () => {
    const oldId = seedMemory(db, { title: 'old', content: 'old content' });
    const newId = seedMemory(db, { title: 'new', content: 'new content' });
    runSupersede(db, oldId, newId);
    expect(getMemoryStatus(db, newId)).toBe('active');
  });

  it('handles a missing reason gracefully', () => {
    const oldId = seedMemory(db, { title: 'old', content: 'old' });
    const newId = seedMemory(db, { title: 'new', content: 'new' });
    const result = runSupersede(db, oldId, newId);
    expect(result.reason).toBeNull();
  });
});
