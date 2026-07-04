import { describe, it, expect, beforeEach } from 'vitest';
import { runTagAdd, runTagRemove } from '../src/tools/memory-tags.js';
import { createInMemoryDb, seedMemory, seedSynapse } from './helpers.js';

describe('runTagAdd', () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let id: number;

  beforeEach(() => {
    db = createInMemoryDb();
    id = seedMemory(db, { title: 'note', content: 'x' });
  });

  it('adds a new tag and reports added:true', () => {
    const result = runTagAdd(db, id, 'mem-graph');
    expect(result).toEqual({ memory_id: id, tag: 'mem-graph', added: true });
    const tags = db
      .prepare('SELECT tag FROM memory_tag WHERE memory_id = ?')
      .all(id) as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(['mem-graph']);
  });

  it('is idempotent — adding twice does not create duplicates', () => {
    runTagAdd(db, id, 'mem-graph');
    const result = runTagAdd(db, id, 'mem-graph');
    expect(result.added).toBe(false);
    const tags = db
      .prepare('SELECT tag FROM memory_tag WHERE memory_id = ?')
      .all(id) as Array<{ tag: string }>;
    expect(tags.length).toBe(1);
  });

  it('trims whitespace from the tag value', () => {
    runTagAdd(db, id, '  spaced-tag  ');
    const tags = db
      .prepare('SELECT tag FROM memory_tag WHERE memory_id = ?')
      .all(id) as Array<{ tag: string }>;
    expect(tags[0].tag).toBe('spaced-tag');
  });

  it('rejects empty / whitespace-only tags', () => {
    expect(() => runTagAdd(db, id, '')).toThrow(/non-empty/);
    expect(() => runTagAdd(db, id, '   ')).toThrow(/non-empty/);
  });

  it('rejects adding to a non-existent memory with a clean message', () => {
    expect(() => runTagAdd(db, 9999, 'foo')).toThrow(/No memory found with id 9999/);
  });

  it('does NOT bump access_count or accessed_at (quiet contract)', () => {
    const before = db
      .prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?')
      .get(id) as { access_count: number; accessed_at: string | null };
    expect(before.access_count).toBe(0);
    expect(before.accessed_at).toBeNull();

    runTagAdd(db, id, 'foo');

    const after = db
      .prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?')
      .get(id) as { access_count: number; accessed_at: string | null };
    expect(after.access_count).toBe(0);
    expect(after.accessed_at).toBeNull();
  });

  it('does NOT re-extract wikilinks or trigger auto-link (quiet contract)', () => {
    const before = (db
      .prepare('SELECT COUNT(*) AS c FROM synapses WHERE source_id = ?')
      .get(id) as { c: number }).c;
    runTagAdd(db, id, 'new-tag');
    const after = (db
      .prepare('SELECT COUNT(*) AS c FROM synapses WHERE source_id = ?')
      .get(id) as { c: number }).c;
    expect(after).toBe(before);
  });

  it('does NOT touch the content or title of the memory', () => {
    const before = db
      .prepare('SELECT title, content FROM memories WHERE id = ?')
      .get(id) as { title: string; content: string };
    runTagAdd(db, id, 'foo');
    const after = db
      .prepare('SELECT title, content FROM memories WHERE id = ?')
      .get(id) as { title: string; content: string };
    expect(after).toEqual(before);
  });

  it('accepts many tags on one memory', () => {
    for (const t of ['alpha', 'beta', 'gamma', 'delta']) {
      runTagAdd(db, id, t);
    }
    const tags = db
      .prepare('SELECT tag FROM memory_tag WHERE memory_id = ? ORDER BY tag')
      .all(id) as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });
});

describe('runTagRemove', () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let id: number;

  beforeEach(() => {
    db = createInMemoryDb();
    id = seedMemory(db, { title: 'note', content: 'x' });
    runTagAdd(db, id, 'a');
    runTagAdd(db, id, 'b');
    runTagAdd(db, id, 'c');
  });

  it('removes an existing tag and reports removed:true', () => {
    const result = runTagRemove(db, id, 'b');
    expect(result).toEqual({ memory_id: id, tag: 'b', removed: true });
    const tags = db
      .prepare('SELECT tag FROM memory_tag WHERE memory_id = ? ORDER BY tag')
      .all(id) as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(['a', 'c']);
  });

  it('returns removed:false when the tag is not present (idempotent)', () => {
    const result = runTagRemove(db, id, 'nonexistent');
    expect(result.removed).toBe(false);
    const tags = db
      .prepare('SELECT tag FROM memory_tag WHERE memory_id = ?')
      .all(id) as Array<{ tag: string }>;
    expect(tags.length).toBe(3);
  });

  it('removes tag rows but leaves other memories alone', () => {
    const id2 = seedMemory(db, { title: 'other', content: 'y' });
    runTagAdd(db, id2, 'a');
    runTagRemove(db, id, 'a');
    const tags2 = db
      .prepare('SELECT tag FROM memory_tag WHERE memory_id = ?')
      .all(id2) as Array<{ tag: string }>;
    expect(tags2.map((t) => t.tag)).toEqual(['a']);
  });

  it('matches the tag case-sensitively after trim', () => {
    // SQLite's TEXT comparison is case-sensitive by default for `=`
    runTagRemove(db, id, 'A'); // uppercase doesn't match the lowercase 'a' we added
    const tags = db
      .prepare('SELECT tag FROM memory_tag WHERE memory_id = ? ORDER BY tag')
      .all(id) as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(['a', 'b', 'c']);
  });

  it('does NOT bump access_count or accessed_at (quiet contract)', () => {
    const before = db
      .prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?')
      .get(id) as { access_count: number; accessed_at: string | null };
    runTagRemove(db, id, 'a');
    const after = db
      .prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?')
      .get(id) as { access_count: number; accessed_at: string | null };
    expect(after.access_count).toBe(before.access_count);
    expect(after.accessed_at).toBe(before.accessed_at);
  });

  it('does NOT affect synapses on the memory', () => {
    const id2 = seedMemory(db, { title: 'b-target', content: 'y' });
    seedSynapse(db, id, id2, 'wikilink', 1.0);
    runTagRemove(db, id, 'a');
    const synCount = (db
      .prepare('SELECT COUNT(*) AS c FROM synapses WHERE source_id = ?')
      .get(id) as { c: number }).c;
    expect(synCount).toBe(1);
  });

  it('rejects empty / whitespace-only tags', () => {
    expect(() => runTagRemove(db, id, '')).toThrow(/non-empty/);
    expect(() => runTagRemove(db, id, '   ')).toThrow(/non-empty/);
  });
});
