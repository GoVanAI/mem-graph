import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_PRACTICE_ID,
  AGENT_PRACTICE_VERSION,
  bootstrapCognitiveAgent,
} from '../src/cognitive/agent-bootstrap.js';
import { gradeAgentPractice } from '../src/cognitive/agent-practice-eval.js';
import { createPolicyCandidate } from '../src/cognitive/policy.js';
import type { AgentPracticeTranscript } from '../src/cognitive/types.js';
import { createInMemoryDb, seedMemory } from './helpers.js';

const root = resolve(import.meta.dirname, '..');

function readTranscript(name: string): AgentPracticeTranscript {
  return JSON.parse(
    readFileSync(
      resolve(root, 'cognitive-os', 'agent-practice', 'evals', 'fixtures', name),
      'utf8',
    ),
  ) as AgentPracticeTranscript;
}

function insertCanonical(
  db: Database.Database,
  id: number,
  projectId: string,
  category: string,
): void {
  db.prepare(
    `INSERT INTO memories (
       id, layer, title, slug, content, project_id, category, lifecycle,
       status, confidence, source, summary, importance_score
     ) VALUES (?, 'semantic', ?, ?, ?, ?, ?, 'permanent', 'active', 1, 'manual', ?, 1)`,
  ).run(
    id,
    `Canonical ${id}`,
    `canonical-${id}`,
    `agent practice canonical content ${id}`,
    projectId,
    category,
    `Canonical summary ${id}`,
  );
}

describe('cognitive agent practice bootstrap', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('composes canonical, policy, and diagnostic reads without any mutation', () => {
    insertCanonical(db, 253, 'cognitive-os', 'handoff');
    insertCanonical(db, 254, 'cognitive-os', 'decision');
    const governingId = seedMemory(db, {
      title: 'Agent practice decision',
      content: 'agent practice scoped workflow',
      project_id: 'cognitive-os',
      category: 'decision',
      layer: 'procedural',
      lifecycle: 'permanent',
    });
    const contextualId = seedMemory(db, {
      title: 'Agent practice scratchpad',
      content: 'agent practice scoped workflow',
      project_id: 'cognitive-os',
      category: 'task_ledger',
      layer: 'working',
      lifecycle: 'ephemeral',
    });
    const policy = createPolicyCandidate(db, {
      project_id: 'cognitive-os',
      title: 'Current guidance',
      statement: 'Use strict guidance.',
      trigger_type: 'request_type',
      trigger_value: 'current_canonical_guidance',
      action: { retrieval: 'cognitive_current_guidance_search' },
      exclusions: [],
      verifier: { exact_project: true },
      task_id: 'seed-policy',
    });
    createPolicyCandidate(db, {
      project_id: '_global',
      title: 'Global current guidance',
      statement: 'Use global guidance only when explicit.',
      trigger_type: 'request_type',
      trigger_value: 'current_canonical_guidance',
      action: { retrieval: 'cognitive_current_guidance_search' },
      exclusions: [],
      verifier: { global_explicit: true },
      task_id: 'seed-global-policy',
    });
    const eventsBefore = db.prepare('SELECT COUNT(*) AS count FROM cognitive_events').get();
    const accessBefore = db
      .prepare('SELECT id, access_count, accessed_at FROM memories ORDER BY id')
      .all();

    const result = bootstrapCognitiveAgent(db, {
      project_id: 'cognitive-os',
      query: 'agent practice',
      include_global: false,
      canonical_ids: [253, 254],
      include_canonical_content: true,
    });
    const replay = bootstrapCognitiveAgent(db, {
      project_id: 'cognitive-os',
      query: 'agent practice',
      include_global: false,
      canonical_ids: [253, 254],
      include_canonical_content: true,
    });

    expect(result.practice).toMatchObject({
      id: AGENT_PRACTICE_ID,
      version: AGENT_PRACTICE_VERSION,
      hard_enforcement: false,
    });
    expect(result.canonical_snapshot.records.map((record) => record.id)).toEqual([253, 254]);
    expect(result.canonical_snapshot.records[0].content).toContain('agent practice');
    expect(result.policy_lookup.candidates.map((candidate) => candidate.policy_id)).toEqual([
      policy.policy_id,
    ]);
    expect(result.guidance.governing.map((record) => record.id)).toContain(governingId);
    expect(result.guidance.excluded.map((record) => record.id)).toContain(contextualId);
    expect(result.mutation).toEqual({
      database_writes: 0,
      events_appended: 0,
      access_tracking: 'not_touched',
      receipt_persistence: 'none',
    });
    expect(replay.bootstrap_digest).toBe(result.bootstrap_digest);
    expect(db.prepare('SELECT COUNT(*) AS count FROM cognitive_events').get()).toEqual(eventsBefore);
    expect(
      db.prepare('SELECT id, access_count, accessed_at FROM memories ORDER BY id').all(),
    ).toEqual(accessBefore);
  });

  it('keeps canonical snapshots exact-project unless global scope is explicit', () => {
    const globalId = seedMemory(db, {
      title: 'Global practice',
      content: 'agent practice global',
      project_id: '_global',
      category: 'process',
      layer: 'procedural',
      lifecycle: 'permanent',
    });
    const otherId = seedMemory(db, {
      title: 'Other practice',
      content: 'agent practice other',
      project_id: 'other-project',
      category: 'decision',
      layer: 'semantic',
      lifecycle: 'permanent',
    });

    const exact = bootstrapCognitiveAgent(db, {
      project_id: 'project-a',
      query: 'agent practice',
      canonical_ids: [globalId, otherId],
    });
    expect(exact.canonical_snapshot.records).toEqual([]);
    expect(exact.canonical_snapshot.unresolved_or_out_of_scope_ids).toEqual([globalId, otherId]);

    const explicitGlobal = bootstrapCognitiveAgent(db, {
      project_id: 'project-a',
      query: 'agent practice',
      canonical_ids: [globalId, otherId],
      include_global: true,
    });
    expect(explicitGlobal.canonical_snapshot.records.map((record) => record.id)).toEqual([
      globalId,
    ]);
    expect(explicitGlobal.canonical_snapshot.unresolved_or_out_of_scope_ids).toEqual([otherId]);
    expect(explicitGlobal.scope.global_inclusion).toBe('explicit');
  });
});

describe('agent practice compliance evaluation', () => {
  it('passes the compliant fixture with deterministic trace evidence', () => {
    const result = gradeAgentPractice(readTranscript('compliant-tracker-update.json'));
    expect(result).toMatchObject({ score: 100, passed: true, critical_failures: [] });
  });

  it('fails cross-project, unbootstrapped, unauthorized mutation behavior', () => {
    const result = gradeAgentPractice(
      readTranscript('noncompliant-cross-project-write.json'),
    );
    expect(result.passed).toBe(false);
    expect(result.critical_failures).toEqual(
      expect.arrayContaining([
        'bootstrap_present',
        'exact_project_scope',
        'explicit_global_scope',
        'mutation_authority_respected',
      ]),
    );
  });

  it('keeps the machine contract, runtime constants, and generated adapters aligned', () => {
    const contract = JSON.parse(
      readFileSync(
        resolve(root, 'cognitive-os', 'agent-practice', 'practice.v1.json'),
        'utf8',
      ),
    ) as { practice_id: string; version: string; enforcement: { hard_enforcement: boolean } };
    expect(contract).toMatchObject({
      practice_id: AGENT_PRACTICE_ID,
      version: AGENT_PRACTICE_VERSION,
      enforcement: { hard_enforcement: false },
    });
    expect(() =>
      execFileSync(
        process.execPath,
        [resolve(root, 'cognitive-os', 'agent-practice', 'generate-adapters.mjs'), '--check'],
        { cwd: root, stdio: 'pipe' },
      ),
    ).not.toThrow();
  });
});
