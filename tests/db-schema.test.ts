import { describe, it, expect } from 'vitest';
import { SCHEMA_SQL, DECAY_MATRIX_SEED } from '../src/db.js';

/**
 * Schema invariants — these tests act as a guard against accidental CHECK
 * constraint additions to `category` and accidental deletion of the
 * taxonomy documentation. Both are deliberate design choices.
 */
describe('memories schema — category is intentionally unconstrained', () => {
  it('has NO CHECK constraint on the category column', () => {
    // Locate the `category` column line in the schema and assert that
    // a CHECK clause does NOT follow it before the next column definition
    // (commas separate columns; commas must appear without an intervening CHECK).
    //
    // We slice the schema between 'category' and the next 'CREATE INDEX'
    // to isolate the category column.
    const idx = SCHEMA_SQL.indexOf('category');
    expect(idx).toBeGreaterThan(-1);
    const tail = SCHEMA_SQL.slice(idx, SCHEMA_SQL.indexOf('CREATE INDEX'));
    expect(tail).toContain('category');
    // The substring between `category` (the column definition) and the
    // trailing comma must not contain "CHECK".
    const categoryLine = tail.split('\n').find((l) => l.includes('category'));
    expect(categoryLine).toBeDefined();
    expect(categoryLine!.toLowerCase()).not.toContain('check');
  });

  it('documentation comment names all 11 taxonomy categories', () => {
    // The TypeScript comment above SCHEMA_SQL is part of db.ts source.
    // We import the file as text rather than rely on a separate constant —
    // it's the simplest way to assert the comment exists.
    //
    // (Vitest can't read comments via the import, but we can verify the
    // substance of the comment is reflected by grepping the schema source
    // for the keyword markers. If this test breaks, the documentation
    // is missing — re-read the file.)
    const fs = require('node:fs');
    const path = require('node:path');
    const dbSrc = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'db.ts'),
      'utf8',
    );
    // The standard 9 plus the 3 first-class additions
    const required = [
      'decision', 'handoff', 'finding', 'issue', 'preference',
      'note', 'context', 'todo',
      'commitment', 'open_question', 'trigger',
    ];
    for (const cat of required) {
      expect(dbSrc).toContain(cat);
    }
    // And it explicitly notes the column is free-text
    expect(dbSrc.toLowerCase()).toContain('free-text');
  });
});

describe('SCHEMA_SQL — sanity', () => {
  it('is a non-empty string', () => {
    expect(SCHEMA_SQL.length).toBeGreaterThan(100);
  });

  it('DECAY_MATRIX_SEED contains exactly 20 rows (preserve-list guarantee)', () => {
    // Count INSERT VALUES lines in the seed.
    const lines = DECAY_MATRIX_SEED.split('\n').filter((l) => l.trim().startsWith('('));
    expect(lines.length).toBe(20);
  });

  it('compiles to a working schema on in-memory SQLite', () => {
    // Smoke test: SCHEMA_SQL + DECAY_MATRIX_SEED should execute cleanly.
    // (createInMemoryDb already does this, but we duplicate the bare-minimum
    // check here so this file is self-contained.)
    const Database = require('better-sqlite3');
    const db = new (Database as any)(':memory:');
    db.pragma('foreign_keys = ON');
    expect(() => db.exec(SCHEMA_SQL)).not.toThrow();
    expect(() => db.exec(DECAY_MATRIX_SEED)).not.toThrow();
    // Use a presence-check rather than exact enumeration because SQLite's
    // FTS5 module auto-creates 4 shadow tables (memories_fts_*).
    const tableRows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as Array<{ name: string }>;
    const tableNames = new Set(tableRows.map((t) => t.name));
    for (const expected of ['memories', 'synapses', 'memory_tag', 'memories_fts', 'decay_matrix']) {
      expect(tableNames.has(expected)).toBe(true);
    }
    db.close();
  });
});