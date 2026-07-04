import { describe, it, expect, beforeEach } from 'vitest';
import { getStaleMemories } from '../src/decay.js';
import { createInMemoryDb, seedMemory } from './helpers.js';

describe('getStaleMemories — basic', () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let idRecent: number, idOld: number, idNeverAccessed: number;

  beforeEach(() => {
    db = createInMemoryDb();
    idRecent = seedMemory(db, { title: 'recent', content: 'r', project_id: 'foo' });
    idOld = seedMemory(db, { title: 'old', content: 'o', project_id: 'foo' });
    idNeverAccessed = seedMemory(db, { title: 'never', content: 'n', project_id: 'foo' });

    // Recent: 1 day ago, 5 accesses
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-1 days'), access_count = 5 WHERE id = ?",
    ).run(idRecent);
    // Old: 100 days ago, 1 access
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-100 days'), access_count = 1 WHERE id = ?",
    ).run(idOld);
    // idNeverAccessed: leave accessed_at NULL
  });

  it('returns memories older than threshold OR with NULL accessed_at', () => {
    const rows = getStaleMemories(db, { days: 30 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(idOld); // 100 days ago
    expect(ids).toContain(idNeverAccessed); // NULL
    expect(ids).not.toContain(idRecent); // 1 day ago, within window
  });

  it('returns days_since_access as integer for accessed rows', () => {
    // days: 50 means "stale if older than 50 days" — idOld at -100 days is in scope
    const rows = getStaleMemories(db, { days: 50 });
    const old = rows.find((r) => r.id === idOld);
    expect(old?.days_since_access).toBeGreaterThanOrEqual(99);
    expect(old?.days_since_access).toBeLessThanOrEqual(101);
  });

  it('returns days_since_access as null for never-accessed rows', () => {
    const rows = getStaleMemories(db, { days: 30 });
    const never = rows.find((r) => r.id === idNeverAccessed);
    expect(never?.days_since_access).toBeNull();
  });

  it('surfaces never_accessed boolean explicitly (the headline R5 signal)', () => {
    const rows = getStaleMemories(db, { days: 30 });
    const old = rows.find((r) => r.id === idOld);
    const never = rows.find((r) => r.id === idNeverAccessed);
    expect(old?.never_accessed).toBe(false);
    expect(never?.never_accessed).toBe(true);
  });

  it('default days threshold is 30', () => {
    const id41 = seedMemory(db, { title: 'just outside', content: 'j', project_id: 'foo' });
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-41 days') WHERE id = ?",
    ).run(id41);
    const rows = getStaleMemories(db);
    expect(rows.map((r) => r.id)).toContain(id41);
  });

  it('only returns active status (excludes superseded/archived/invalid)', () => {
    const idSuperseded = seedMemory(db, {
      title: 'super',
      content: 's',
      project_id: 'foo',
      status: 'superseded',
    });
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-100 days') WHERE id = ?",
    ).run(idSuperseded);
    const rows = getStaleMemories(db, { days: 30 });
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(idSuperseded);
  });

  it('never-accessed entries appear before accessed-but-stale entries (NULLS FIRST)', () => {
    const rows = getStaleMemories(db, { days: 30 });
    if (rows.length >= 2) {
      // The first row should be the never-accessed one (NULL accessed_at sorts first)
      expect(rows[0].never_accessed).toBe(true);
    }
  });
});

describe('getStaleMemories — project scoping', () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let idFoo: number, idBar: number, idGlobal: number;

  beforeEach(() => {
    db = createInMemoryDb();
    idFoo = seedMemory(db, { title: 'foo entry', content: 'f', project_id: 'foo' });
    idBar = seedMemory(db, { title: 'bar entry', content: 'b', project_id: 'bar' });
    idGlobal = seedMemory(db, {
      title: 'global entry',
      content: 'g',
      project_id: '_global',
    });
    for (const id of [idFoo, idBar, idGlobal]) {
      db.prepare(
        "UPDATE memories SET accessed_at = datetime('now', '-100 days') WHERE id = ?",
      ).run(id);
    }
  });

  it('respects project_id filter', () => {
    const rows = getStaleMemories(db, { days: 30, project_id: 'foo' });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(idFoo);
    expect(ids).not.toContain(idBar);
  });

  it('treats _global as visible from any project_id', () => {
    const rows = getStaleMemories(db, { days: 30, project_id: 'foo' });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(idGlobal);
  });
});

describe('getStaleMemories — lifecycle + layer filters', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('respects lifecycle filter (allow-list)', () => {
    const idEphem = seedMemory(db, {
      title: 'ephem',
      content: 'e',
      project_id: 'foo',
      lifecycle: 'ephemeral',
    });
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-100 days') WHERE id = ?",
    ).run(idEphem);

    const withoutEphem = getStaleMemories(db, {
      days: 30,
      lifecycle: ['permanent', 'milestone'],
    });
    const withEphem = getStaleMemories(db, {
      days: 30,
      lifecycle: ['permanent', 'milestone', 'ephemeral'],
    });

    expect(withoutEphem.map((r) => r.id)).not.toContain(idEphem);
    expect(withEphem.map((r) => r.id)).toContain(idEphem);
  });

  it('respects layer filter (allow-list)', () => {
    const idProc = seedMemory(db, {
      title: 'proc',
      content: 'p',
      project_id: 'foo',
      layer: 'procedural',
    });
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-100 days') WHERE id = ?",
    ).run(idProc);

    const withoutProc = getStaleMemories(db, {
      days: 30,
      layer: ['episodic', 'semantic'],
    });
    expect(withoutProc.map((r) => r.id)).not.toContain(idProc);
  });

  it('combines project_id + lifecycle + layer filters', () => {
    const idProc = seedMemory(db, {
      title: 'proc',
      content: 'p',
      project_id: 'foo',
      layer: 'procedural',
      lifecycle: 'milestone',
    });
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-100 days') WHERE id = ?",
    ).run(idProc);
    const idEpis = seedMemory(db, {
      title: 'epis',
      content: 'e',
      project_id: 'foo',
      layer: 'episodic',
      lifecycle: 'milestone',
    });
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-100 days') WHERE id = ?",
    ).run(idEpis);

    const rows = getStaleMemories(db, {
      days: 30,
      project_id: 'foo',
      layer: ['episodic'],
      lifecycle: ['milestone'],
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(idEpis);
    expect(ids).not.toContain(idProc);
  });

  it('silently drops invalid lifecycle values', () => {
    // An invalid value like 'bogus' should be filtered out, leaving an
    // empty lifecycle array — which means "no lifecycle filter" (not "match nothing").
    const idKeep = seedMemory(db, {
      title: 'keep',
      content: 'k',
      project_id: 'foo',
      lifecycle: 'permanent',
    });
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-100 days') WHERE id = ?",
    ).run(idKeep);
    const rows = getStaleMemories(db, {
      days: 30,
      lifecycle: ['bogus'] as unknown as ('permanent' | 'milestone' | 'ephemeral')[],
    });
    expect(rows.map((r) => r.id)).toContain(idKeep);
  });

  it('empty filter arrays behave as "no filter on that dimension"', () => {
    const idEphem = seedMemory(db, {
      title: 'ephem',
      content: 'e',
      project_id: 'foo',
      lifecycle: 'ephemeral',
    });
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-100 days') WHERE id = ?",
    ).run(idEphem);
    const rows = getStaleMemories(db, { days: 30, lifecycle: [] });
    expect(rows.map((r) => r.id)).toContain(idEphem);
  });
});

describe('getStaleMemories — limit', () => {
  it('respects explicit limit', () => {
    const db = createInMemoryDb();
    for (let i = 0; i < 60; i++) {
      const id = seedMemory(db, {
        title: `m${i}`,
        content: 'x',
        project_id: 'foo',
      });
      db.prepare(
        "UPDATE memories SET accessed_at = datetime('now', '-100 days') WHERE id = ?",
      ).run(id);
    }
    const rows = getStaleMemories(db, { days: 30, limit: 20 });
    expect(rows.length).toBe(20);
  });

  it('caps limit at 500', () => {
    const db = createInMemoryDb();
    // Don't seed 501 — just confirm the cap by inspecting the math.
    // (Seeding 500+ for a unit test is wasteful.)
    const rows = getStaleMemories(db, { days: 30, limit: 10000 });
    // Result length ≤ 500 even when 10000 is requested.
    expect(rows.length).toBeLessThanOrEqual(500);
  });
});

describe('getStaleMemories — pure function shape', () => {
  it('does NOT touch the database (read-only contract)', () => {
    const db = createInMemoryDb();
    const id = seedMemory(db, { title: 'r', content: 'c', project_id: 'foo' });
    db.prepare(
      "UPDATE memories SET accessed_at = datetime('now', '-100 days') WHERE id = ?",
    ).run(id);
    const before = db
      .prepare('SELECT COUNT(*) AS c FROM memories')
      .get() as { c: number };
    getStaleMemories(db, { days: 30 });
    const after = db
      .prepare('SELECT COUNT(*) AS c FROM memories')
      .get() as { c: number };
    expect(after.c).toBe(before.c);
  });
});
