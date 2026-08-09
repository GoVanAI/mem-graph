import { beforeEach, describe, expect, it } from 'vitest';
import {
  diagnoseCurrentGuidance,
  searchCurrentGuidance,
  searchGoverningGuidance,
} from '../src/cognitive/retrieval.js';
import { createInMemoryDb, seedMemory } from './helpers.js';

describe('searchCurrentGuidance', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('returns only active memories from the exact project by default', () => {
    const current = seedMemory(db, {
      title: 'Current guidance',
      content: 'canonical deployment procedure',
      project_id: 'alpha',
    });
    for (const status of ['superseded', 'archived', 'invalid'] as const) {
      seedMemory(db, {
        title: `${status} guidance`,
        content: 'canonical deployment procedure',
        project_id: 'alpha',
        status,
      });
    }
    seedMemory(db, {
      title: 'Other project guidance',
      content: 'canonical deployment procedure',
      project_id: 'beta',
    });
    seedMemory(db, {
      title: 'Global guidance',
      content: 'canonical deployment procedure',
      project_id: '_global',
    });

    expect(searchCurrentGuidance(db, { query: 'canonical deployment', project_id: 'alpha' })).toEqual(
      [
        expect.objectContaining({ id: current, project_id: 'alpha', status: 'active' }),
      ],
    );
  });

  it('excludes global guidance by default and includes it after exact-project results when requested', () => {
    const global = seedMemory(db, {
      title: 'Global guidance',
      content: 'canonical deployment procedure',
      project_id: '_global',
      importance_score: 1,
    });
    const exact = seedMemory(db, {
      title: 'Project guidance',
      content: 'canonical deployment procedure',
      project_id: 'alpha',
      importance_score: 1,
    });

    expect(searchCurrentGuidance(db, { query: 'canonical deployment', project_id: 'alpha' })).toEqual([
      expect.objectContaining({ id: exact }),
    ]);
    expect(
      searchCurrentGuidance(db, {
        query: 'canonical deployment',
        project_id: 'alpha',
        include_global: true,
      }).map((row) => row.id),
    ).toEqual([exact, global]);
  });

  it('applies category and layer filters and clamps the requested limit', () => {
    const expected = seedMemory(db, {
      title: 'Expected guidance',
      content: 'filterable canonical guidance',
      project_id: 'alpha',
      category: 'decision',
      layer: 'procedural',
    });
    seedMemory(db, {
      title: 'Wrong category',
      content: 'filterable canonical guidance',
      project_id: 'alpha',
      category: 'note',
      layer: 'procedural',
    });
    seedMemory(db, {
      title: 'Wrong layer',
      content: 'filterable canonical guidance',
      project_id: 'alpha',
      category: 'decision',
      layer: 'semantic',
    });
    for (let i = 0; i < 105; i += 1) {
      seedMemory(db, {
        title: `Limit guidance ${i}`,
        content: 'limit canonical guidance',
        project_id: 'alpha',
      });
    }

    expect(
      searchCurrentGuidance(db, {
        query: 'filterable canonical',
        project_id: 'alpha',
        category: 'decision',
        layer: 'procedural',
      }).map((row) => row.id),
    ).toEqual([expected]);
    expect(
      searchCurrentGuidance(db, { query: 'limit canonical', project_id: 'alpha', limit: 999 }),
    ).toHaveLength(100);
  });

  it('handles malformed FTS syntax, hyphens, and ordinary punctuation as plain text', () => {
    const id = seedMemory(db, {
      title: 'Build guidance',
      content: 'use the pre-release build system safely',
      project_id: 'alpha',
    });

    expect(() =>
      searchCurrentGuidance(db, { query: 'pre-release, build!', project_id: 'alpha' }),
    ).not.toThrow();
    expect(
      searchCurrentGuidance(db, { query: 'pre-release, build!', project_id: 'alpha' }).map(
        (row) => row.id,
      ),
    ).toEqual([id]);
    expect(() =>
      searchCurrentGuidance(db, { query: '"unterminated (AND OR):*', project_id: 'alpha' }),
    ).not.toThrow();
  });

  it('bumps access tracking only for returned memories', () => {
    const returned = seedMemory(db, {
      title: 'Returned guidance',
      content: 'access tracking guidance',
      project_id: 'alpha',
    });
    const excluded = seedMemory(db, {
      title: 'Excluded guidance',
      content: 'access tracking guidance',
      project_id: 'beta',
    });

    searchCurrentGuidance(db, { query: 'access tracking', project_id: 'alpha' });

    expect(
      db.prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?').get(returned),
    ).toEqual(expect.objectContaining({ access_count: 1, accessed_at: expect.any(String) }));
    expect(
      db.prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?').get(excluded),
    ).toEqual({ access_count: 0, accessed_at: null });
  });
});

describe('searchGoverningGuidance', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('excludes the row-4 working task ledger even when lexical ranking favors it', () => {
    const canonical = seedMemory(db, {
      title: 'MVP-001 proof contract',
      content: 'mvp 001 proof contract',
      project_id: 'cognitive-os',
      category: 'policy',
      layer: 'procedural',
      lifecycle: 'milestone',
    });
    const taskLedger = seedMemory(db, {
      title: 'Task Ledger',
      content: 'mvp 001 mvp 001 mvp 001 mvp 001',
      project_id: 'cognitive-os',
      category: 'task_ledger',
      layer: 'working',
      lifecycle: 'ephemeral',
    });

    expect(searchCurrentGuidance(db, { query: 'mvp 001', project_id: 'cognitive-os' })[0]).toEqual(
      expect.objectContaining({ id: taskLedger }),
    );
    expect(searchGoverningGuidance(db, { query: 'mvp 001', project_id: 'cognitive-os' })).toEqual([
      expect.objectContaining({
        id: canonical,
        category: 'policy',
        eligibility: 'governing_eligible',
      }),
    ]);
  });

  it('preserves an episodic milestone handoff as a current-state projection', () => {
    const tracker = seedMemory(db, {
      title: 'Program current state',
      content: 'program current state tracker',
      project_id: 'cognitive-os',
      category: 'handoff',
      layer: 'episodic',
      lifecycle: 'milestone',
    });

    expect(
      searchGoverningGuidance(db, { query: 'program current state', project_id: 'cognitive-os' }),
    ).toEqual([expect.objectContaining({ id: tracker, eligibility: 'governing_eligible' })]);
  });

  it('excludes findings, audits, contextual categories, and unknown categories', () => {
    for (const category of ['finding', 'audit', 'note', 'context', 'todo', 'open_question', 'custom']) {
      seedMemory(db, {
        title: `${category} material`,
        content: 'eligibility boundary material',
        project_id: 'alpha',
        category,
        layer: 'episodic',
        lifecycle: 'milestone',
      });
    }
    const decision = seedMemory(db, {
      title: 'Decision material',
      content: 'eligibility boundary material',
      project_id: 'alpha',
      category: ' Decision ',
      layer: 'semantic',
      lifecycle: 'permanent',
    });
    expect(
      searchGoverningGuidance(db, { query: 'eligibility boundary material', project_id: 'alpha' }),
    ).toEqual([expect.objectContaining({ id: decision, category: ' Decision ' })]);
  });

  it('independently excludes working and ephemeral otherwise eligible records', () => {
    const eligible = seedMemory(db, {
      title: 'Eligible policy material',
      content: 'independent eligibility controls',
      project_id: 'alpha',
      category: 'policy',
      layer: 'procedural',
      lifecycle: 'permanent',
    });
    seedMemory(db, {
      title: 'Working policy material',
      content: 'independent eligibility controls',
      project_id: 'alpha',
      category: 'policy',
      layer: 'working',
      lifecycle: 'permanent',
    });
    seedMemory(db, {
      title: 'Ephemeral policy material',
      content: 'independent eligibility controls',
      project_id: 'alpha',
      category: 'policy',
      layer: 'procedural',
      lifecycle: 'ephemeral',
    });

    expect(
      searchGoverningGuidance(db, { query: 'independent eligibility', project_id: 'alpha' }),
    ).toEqual([expect.objectContaining({ id: eligible })]);
  });

  it('keeps exact-project precedence and explicit global inclusion', () => {
    const global = seedMemory(db, {
      title: 'Global policy',
      content: 'governing deployment guidance',
      project_id: '_global',
      category: 'policy',
      layer: 'procedural',
    });
    const exact = seedMemory(db, {
      title: 'Project decision',
      content: 'governing deployment guidance',
      project_id: 'alpha',
      category: 'decision',
      layer: 'semantic',
    });

    expect(
      searchGoverningGuidance(db, { query: 'governing deployment', project_id: 'alpha' }).map(
        (row) => row.id,
      ),
    ).toEqual([exact]);
    expect(
      searchGoverningGuidance(db, {
        query: 'governing deployment',
        project_id: 'alpha',
        include_global: true,
      }).map((row) => row.id),
    ).toEqual([exact, global]);
  });

  it('bumps access only for governing-eligible returned rows', () => {
    const returned = seedMemory(db, {
      title: 'Returned decision',
      content: 'governing access tracking',
      project_id: 'alpha',
      category: 'decision',
      layer: 'procedural',
    });
    const excluded = seedMemory(db, {
      title: 'Excluded audit',
      content: 'governing access tracking',
      project_id: 'alpha',
      category: 'audit',
      layer: 'episodic',
    });

    searchGoverningGuidance(db, { query: 'governing access', project_id: 'alpha' });

    expect(
      db.prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?').get(returned),
    ).toEqual(expect.objectContaining({ access_count: 1, accessed_at: expect.any(String) }));
    expect(
      db.prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?').get(excluded),
    ).toEqual({ access_count: 0, accessed_at: null });
  });
});

describe('diagnoseCurrentGuidance', () => {
  let db: ReturnType<typeof createInMemoryDb>;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  it('splits bounded row-4-like candidates into governing and excluded lanes with all reasons', () => {
    const canonical = seedMemory(db, {
      title: 'MVP-001 proof contract',
      content: 'mvp 001 proof contract',
      project_id: 'cognitive-os',
      category: 'policy',
      layer: 'procedural',
      lifecycle: 'milestone',
    });
    const taskLedger = seedMemory(db, {
      title: 'Task Ledger',
      content: 'mvp 001 mvp 001 mvp 001 mvp 001',
      project_id: 'cognitive-os',
      category: 'task_ledger',
      layer: 'working',
      lifecycle: 'ephemeral',
    });
    const custom = seedMemory(db, {
      title: 'Custom analysis',
      content: 'mvp 001 custom analysis',
      project_id: 'cognitive-os',
      category: 'custom',
      layer: 'semantic',
      lifecycle: 'permanent',
    });

    const diagnostic = diagnoseCurrentGuidance(db, {
      query: 'mvp 001',
      project_id: 'cognitive-os',
    });

    expect(diagnostic.scope).toEqual({
      project_id: 'cognitive-os',
      include_global: false,
      active_only: true,
      graph_expansion: false,
      candidate_limit: 20,
    });
    expect(diagnostic.access_tracking).toBe('not_touched');
    expect(diagnostic.governing).toEqual([
      expect.objectContaining({ id: canonical, category: 'policy', eligibility: 'governing_eligible' }),
    ]);
    expect(diagnostic.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: taskLedger,
          category: 'task_ledger',
          eligibility: 'contextual_ineligible',
          exclusion_reasons: ['working_layer', 'ephemeral_lifecycle', 'category_not_governing'],
        }),
        expect.objectContaining({
          id: custom,
          category: 'custom',
          eligibility: 'contextual_ineligible',
          exclusion_reasons: ['category_not_governing'],
        }),
      ]),
    );

    expect(
      diagnoseCurrentGuidance(db, { query: 'mvp 001', project_id: 'cognitive-os', limit: 1 }),
    ).toMatchObject({
      scope: { candidate_limit: 1 },
      governing: [],
      excluded: [expect.objectContaining({ id: taskLedger })],
    });
  });

  it('preserves exact-project scope and includes global candidates only when requested', () => {
    const exact = seedMemory(db, {
      title: 'Project decision',
      content: 'diagnostic scope guidance',
      project_id: 'alpha',
      category: 'decision',
      layer: 'semantic',
    });
    const global = seedMemory(db, {
      title: 'Global policy',
      content: 'diagnostic scope guidance',
      project_id: '_global',
      category: 'policy',
      layer: 'procedural',
    });

    expect(
      diagnoseCurrentGuidance(db, { query: 'diagnostic scope', project_id: 'alpha' }).governing.map(
        (row) => row.id,
      ),
    ).toEqual([exact]);
    expect(
      diagnoseCurrentGuidance(db, {
        query: 'diagnostic scope',
        project_id: 'alpha',
        include_global: true,
      }).governing.map((row) => row.id),
    ).toEqual([exact, global]);
  });

  it('does not change access tracking for either diagnostic lane', () => {
    const governing = seedMemory(db, {
      title: 'Governing decision',
      content: 'diagnostic access tracking',
      project_id: 'alpha',
      category: 'decision',
      layer: 'procedural',
    });
    const excluded = seedMemory(db, {
      title: 'Working audit',
      content: 'diagnostic access tracking',
      project_id: 'alpha',
      category: 'audit',
      layer: 'working',
      lifecycle: 'ephemeral',
    });

    const diagnostic = diagnoseCurrentGuidance(db, {
      query: 'diagnostic access',
      project_id: 'alpha',
    });

    expect(diagnostic.governing).toEqual([expect.objectContaining({ id: governing })]);
    expect(diagnostic.excluded).toEqual([expect.objectContaining({ id: excluded })]);
    for (const id of [governing, excluded]) {
      expect(db.prepare('SELECT access_count, accessed_at FROM memories WHERE id = ?').get(id)).toEqual({
        access_count: 0,
        accessed_at: null,
      });
    }
  });
});
