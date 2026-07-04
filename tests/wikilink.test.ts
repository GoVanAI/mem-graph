import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractWikilinks,
  slugify,
  resolveWikilink,
  pruneStaleWikilinks,
  upsertWikilinkSynapse,
} from '../src/wikilink.js';
import { createInMemoryDb, seedMemory } from './helpers.js';

describe('slugify', () => {
  it('lowercases and replaces underscores and spaces with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('Hello_World')).toBe('hello-world');
  });

  it('strips non-alphanumeric chars except hyphens', () => {
    expect(slugify('Foo & Bar!')).toBe('foo-bar');
    expect(slugify('Foo.Bar/Baz')).toBe('foobarbaz');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('foo---bar')).toBe('foo-bar');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--foo bar--')).toBe('foo-bar');
  });

  it('preserves numbers', () => {
    expect(slugify('Item 42 test')).toBe('item-42-test');
  });

  it('handles empty-ish input', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
  });
});

describe('extractWikilinks', () => {
  it('extracts a single wikilink', () => {
    expect(extractWikilinks('see [[Note A]] for context')).toEqual(['Note A']);
  });

  it('extracts multiple wikilinks and preserves order', () => {
    expect(extractWikilinks('[[A]] then [[B]] then [[A]]')).toEqual(['A', 'B', 'A']);
  });

  it('returns empty array when no wikilinks present', () => {
    expect(extractWikilinks('plain text without links')).toEqual([]);
  });

  it('trims whitespace inside wikilinks', () => {
    expect(extractWikilinks('see [[ Spaced Title ]] please')).toEqual(['Spaced Title']);
  });

  it('does not match single-bracket refs', () => {
    expect(extractWikilinks('[not a wikilink] and {also not}')).toEqual([]);
  });
});

describe('resolveWikilink', () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let idA: number, idB: number;

  beforeEach(() => {
    db = createInMemoryDb();
    idA = seedMemory(db, { title: 'Note A', content: 'about a', project_id: 'foo' });
    idB = seedMemory(db, { title: 'Note B', content: 'about b', project_id: 'bar' });
  });

  it('resolves by raw id when ref is numeric and exists', () => {
    const result = resolveWikilink(db, String(idA), '_global');
    expect(result?.id).toBe(idA);
    expect(result?.matched_by).toBe('id');
  });

  it('resolves by title within the same project', () => {
    const result = resolveWikilink(db, 'Note A', 'foo');
    expect(result?.id).toBe(idA);
    expect(result?.matched_by).toBe('title');
  });

  it('resolves by slug within the same project', () => {
    const result = resolveWikilink(db, 'note-a', 'foo');
    expect(result?.id).toBe(idA);
    expect(result?.matched_by).toBe('slug');
  });

  it('falls back to cross-project title match', () => {
    // idA is in 'foo'; ask from project 'unrelated' — should still find via cross-project title match
    const result = resolveWikilink(db, 'Note A', 'unrelated');
    expect(result?.id).toBe(idA);
    expect(result?.matched_by).toBe('title');
  });

  it('is case-insensitive on title match', () => {
    const result = resolveWikilink(db, 'note a', 'foo');
    expect(result?.id).toBe(idA);
  });

  it('returns null when reference does not exist anywhere', () => {
    const result = resolveWikilink(db, 'Nonexistent Thing', 'foo');
    expect(result).toBeNull();
  });

  it('prefers same-project over cross-project when both match', () => {
    // Same title in two projects — same-project should win
    const idLocalA = seedMemory(db, {
      title: 'Shared',
      content: 'in foo',
      project_id: 'foo',
    });
    const idForeignA = seedMemory(db, {
      title: 'Shared',
      content: 'in bar',
      project_id: 'bar',
    });
    const result = resolveWikilink(db, 'Shared', 'foo');
    expect(result?.id).toBe(idLocalA);
    expect(result?.id).not.toBe(idForeignA);
  });
});

describe('pruneStaleWikilinks', () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let idSource: number, idA: number, idB: number;

  beforeEach(() => {
    db = createInMemoryDb();
    idSource = seedMemory(db, { title: 'source', content: 'src', project_id: 'foo' });
    idA = seedMemory(db, { title: 'A', content: 'a', project_id: 'foo' });
    idB = seedMemory(db, { title: 'B', content: 'b', project_id: 'foo' });
    upsertWikilinkSynapse(db, idSource, idA);
    upsertWikilinkSynapse(db, idSource, idB);
  });

  it('removes wikilinks not in new refs', () => {
    const result = pruneStaleWikilinks(db, idSource, ['A'], 'foo');
    expect(result.removed).toBe(1);
    const remaining = db
      .prepare(
        "SELECT target_id FROM synapses WHERE source_id = ? AND connection_type = 'wikilink'",
      )
      .all(idSource) as Array<{ target_id: number }>;
    expect(remaining.map((r) => r.target_id)).toEqual([idA]);
  });

  it('does not remove wikilinks still in new refs', () => {
    pruneStaleWikilinks(db, idSource, ['A', 'B'], 'foo');
    const remaining = db
      .prepare(
        "SELECT target_id FROM synapses WHERE source_id = ? AND connection_type = 'wikilink'",
      )
      .all(idSource) as Array<{ target_id: number }>;
    expect(remaining.map((r) => r.target_id).sort()).toEqual([idA, idB].sort());
  });

  it('does not touch bm25_auto synapses', () => {
    db.prepare(
      "INSERT INTO synapses (source_id, target_id, connection_type, weight) VALUES (?, ?, 'bm25_auto', 0.7)",
    ).run(idSource, idB);
    pruneStaleWikilinks(db, idSource, ['A'], 'foo');
    const bm25 = db
      .prepare(
        "SELECT target_id FROM synapses WHERE source_id = ? AND connection_type = 'bm25_auto'",
      )
      .all(idSource) as Array<{ target_id: number }>;
    expect(bm25.map((r) => r.target_id)).toEqual([idB]);
  });
});
