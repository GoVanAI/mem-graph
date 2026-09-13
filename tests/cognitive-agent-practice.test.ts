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
import { AGENT_TOOL_NAMES, MAINTENANCE_TOOL_NAMES } from '../src/tool-profiles.js';

const root = resolve(import.meta.dirname, '..');
const syntheticTrackerId = 9001;
const syntheticBoundaryId = 9002;

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
    insertCanonical(db, syntheticTrackerId, 'cognitive-os', 'handoff');
    insertCanonical(db, syntheticBoundaryId, 'cognitive-os', 'decision');
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
      canonical_ids: [syntheticTrackerId, syntheticBoundaryId],
      include_canonical_content: true,
    });
    const replay = bootstrapCognitiveAgent(db, {
      project_id: 'cognitive-os',
      query: 'agent practice',
      include_global: false,
      canonical_ids: [syntheticTrackerId, syntheticBoundaryId],
      include_canonical_content: true,
    });

    expect(result.practice).toMatchObject({
      id: AGENT_PRACTICE_ID,
      version: AGENT_PRACTICE_VERSION,
      hard_enforcement: false,
    });
    expect(result.canonical_snapshot.records.map((record) => record.id)).toEqual([
      syntheticTrackerId,
      syntheticBoundaryId,
    ]);
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

  it('does not assume installation-specific canonical IDs when none are configured', () => {
    insertCanonical(db, syntheticTrackerId, 'cognitive-os', 'handoff');
    insertCanonical(db, syntheticBoundaryId, 'cognitive-os', 'decision');

    const result = bootstrapCognitiveAgent(db, {
      project_id: 'cognitive-os',
      query: 'agent practice',
      include_global: false,
      include_canonical_content: true,
    });

    expect(result.canonical_snapshot).toMatchObject({
      requested_ids: [],
      unresolved_or_out_of_scope_ids: [],
      records: [],
    });
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

  it('fails closed when a required tracker update has no configured tracker ID', () => {
    const transcript = readTranscript('compliant-tracker-update.json');
    delete transcript.scenario.tracker_id;

    const result = gradeAgentPractice(transcript);

    expect(result.passed).toBe(false);
    expect(result.critical_failures).toContain('tracker_guard_sequence');
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

  it('keeps the machine contract and generated adapters aligned', () => {
    const contract = JSON.parse(
      readFileSync(
        resolve(root, 'cognitive-os', 'agent-practice', 'practice.v1.json'),
        'utf8',
      ),
    ) as { practice_id: string; version: string; enforcement: { hard_enforcement: boolean } };
    expect(contract.practice_id).toBe(AGENT_PRACTICE_ID);
    expect(contract.version).toBe('1.2.0');
    expect(contract.enforcement.hard_enforcement).toBe(false);
    expect(() =>
      execFileSync(
        process.execPath,
        [resolve(root, 'cognitive-os', 'agent-practice', 'generate-adapters.mjs'), '--check'],
        { cwd: root, stdio: 'pipe' },
      ),
    ).not.toThrow();
  });
});

describe('profile-aware agent practice guidance (Step 4 Phase 4B)', () => {
  function loadContract(): any {
    return JSON.parse(
      readFileSync(
        resolve(root, 'cognitive-os', 'agent-practice', 'practice.v1.json'),
        'utf8',
      ),
    );
  }

  it('contains profile-aware configuration in canonical practice', () => {
    const contract = loadContract();
    expect(contract.profiles).toBeDefined();
    expect(contract.profiles.preferred_everyday_profile).toBe('agent');
    expect(contract.profiles.compatibility_profile).toBe('full');
    expect(contract.profiles.maintenance_profile).toBe('maintenance');
    expect(contract.profiles.discovery_rule).toContain('active profile');
    expect(contract.profiles.discovery_rule).toContain('Never request a tool absent from the active profile');
  });

  it('selects compact mode and the ten workflow tools for agent profile', () => {
    const contract = loadContract();
    const agentProfile = contract.profiles.agent;
    expect(agentProfile.preferred_bootstrap_response_mode).toBe('compact');
    expect(agentProfile.tool_names).toHaveLength(10);
    expect(agentProfile.tool_names).toEqual(Array.from(AGENT_TOOL_NAMES));
    expect(agentProfile.typed_routing).toEqual({
      memory_find: ['search', 'recent', 'changes', 'related'],
      memory_read: ['get', 'links'],
      memory_write: ['add', 'update', 'mark', 'supersede', 'tag_add', 'tag_remove'],
      epistemic_inspect: ['get', 'query', 'diff'],
    });
    const prohibited = agentProfile.prohibited_tool_names_or_families;
    // Exactly 36 current full-profile tools not exposed in the agent profile
    expect(prohibited).toHaveLength(36);
    // All MAINTENANCE_TOOL_NAMES must be prohibited
    for (const tool of MAINTENANCE_TOOL_NAMES) {
      expect(prohibited).toContain(tool);
    }
    // Prohibited list must be completely disjoint from AGENT_TOOL_NAMES
    const prohibitedSet = new Set(prohibited);
    for (const tool of AGENT_TOOL_NAMES) {
      expect(prohibitedSet.has(tool)).toBe(false);
    }
  });

  it('retains legacy compatibility in full profile', () => {
    const contract = loadContract();
    expect(contract.profiles.full.default_bootstrap_response_mode).toBe('legacy');
    expect(contract.profiles.full.tool_count).toBe(41);
    expect(contract.bootstrap.response_modes.server_default).toBe('legacy');
  });

  it('ensures global scope remains strictly opt-in', () => {
    const contract = loadContract();
    expect(contract.scope.include_global_default).toBe(false);
    expect(contract.scope.exact_project_default).toBe(true);
    expect(contract.scope.global_inclusion_modes).toEqual(['disabled', 'explicit']);
    expect(contract.scope.rule).toContain('Global scope must be explicitly required and reported');
    expect(contract.scope.rule).toContain('Never hydrate foreign projects');
  });

  it('permits exactly one retry for unsupported compact mode, forbidding repeated retries', () => {
    const contract = loadContract();
    expect(contract.bootstrap.recovery_unsupported_compact.max_retries).toBe(1);
    expect(contract.bootstrap.recovery_unsupported_compact.rule).toContain('retry exactly once');
    expect(contract.bootstrap.recovery_unsupported_compact.rule).toContain('Never repeatedly retry compact mode');
  });

  it('constrains fallback selection to the active tool surface', () => {
    const contract = loadContract();
    expect(contract.bootstrap.fallback_constraints).toContain('select fallback tools strictly from the active profile');
    expect(contract.bootstrap.fallback_constraints).toContain('Never call hidden legacy tools');

    // Agent profile fallback must only use tools in the agent profile
    const agentFallbackText = contract.bootstrap.profile_fallbacks.agent.join(' ');
    expect(contract.bootstrap.profile_fallbacks.agent).toBeDefined();
    expect(agentFallbackText).toContain('memory_find');
    expect(agentFallbackText).toContain('memory_read');
    expect(agentFallbackText).not.toContain('memory_get');
    expect(agentFallbackText).not.toContain('cognitive_policy_lookup');
    expect(agentFallbackText).not.toContain('cognitive_current_guidance_search');
  });

  it('requires available route, valid typed arguments, and preserved scope for expansion', () => {
    const contract = loadContract();
    expect(contract.retrieval_and_expansion.route_availability_required).toBe(true);
    expect(contract.retrieval_and_expansion.active_profile_tool_required).toBe(true);
    expect(contract.retrieval_and_expansion.typed_arguments_validation_required).toBe(true);
    expect(contract.retrieval_and_expansion.preserve_originating_scope).toBe(true);
  });

  it('reports unavailable expansion honestly without silent substitution', () => {
    const contract = loadContract();
    expect(contract.retrieval_and_expansion.no_silent_substitution).toContain('Do not silently substitute another tool');
    expect(contract.retrieval_and_expansion.no_foreign_hydration).toContain('Foreign wikilinks remain bounded reference stubs');
  });

  it('honestly declares access-tracking effects for expansion operations', () => {
    const contract = loadContract();
    expect(contract.retrieval_and_expansion.access_tracking_honesty).toContain('memory_read:get');
    expect(contract.retrieval_and_expansion.access_tracking_honesty).toContain('memory_find:related');
    expect(contract.retrieval_and_expansion.access_tracking_honesty).toContain('Do not portray expansion as zero-touch');
    expect(contract.bootstrap.effects.writes_database).toBe(false);
    expect(contract.bootstrap.effects.touches_access_tracking).toBe(false);
  });

  it('preserves search-before-create and mutation boundaries', () => {
    const contract = loadContract();
    expect(contract.mutation.search_before_create).toBe(true);
    expect(contract.mutation.global_mutation_confirmation_required).toBe(true);
    expect(contract.mutation.epistemic_boundaries).toContain('epistemic_admit');
    expect(contract.mutation.epistemic_boundaries).toContain('epistemic_append_receipt');
    expect(contract.mutation.event_boundaries).toContain('cognitive_event_append');
    expect(contract.mutation.event_boundaries).toContain('cognitive_event_read');
  });

  it('forbids fabricated refresh/version conclusions unconditionally for pd-06 known gap', () => {
    const contract = loadContract();
    const gap = contract.known_gaps.pd_06_cross_call_version_comparison;
    expect(gap.status).toBe('unavailable_honest');
    const rulesText = gap.rules.join(' ');
    expect(rulesText).toContain('Unconditionally do not fabricate version_mismatch');
    expect(rulesText).toContain('Unconditionally do not fabricate refresh_required');
    expect(rulesText).toContain('Report cross-call version comparison as unavailable');
    expect(rulesText).not.toContain('without trusted input');
  });

  it('verifies all generated adapters contain the essential compact/profile/fallback rules', () => {
    const adaptersDir = resolve(root, 'cognitive-os', 'agent-practice', 'adapters');
    const fragmentNames = [
      'AGENTS.fragment.md',
      'CLAUDE.fragment.md',
      'GEMINI.fragment.md',
      'generic-system-prompt.md',
    ];

    for (const name of fragmentNames) {
      const content = readFileSync(resolve(adaptersDir, name), 'utf8');
      expect(content).toContain('agent profile is the preferred everyday surface');
      expect(content).toContain('10 workflow tools');
      expect(content).toContain('response_mode="compact"');
      expect(content).toContain('1 retry max; no repeated retries');
      expect(content).toContain('include_global=false');
      expect(content).toContain('route_available=true');
      expect(content).toContain('Never request a tool absent from the active profile');
      expect(content).toContain('pd-06 cross-call version comparison is unavailable');
      expect(content).toContain('before non-trivial mem-graph or Cognitive OS work');
      expect(content).toContain('FTS5 searches use AND semantics by default');
    }

    const mainDoc = readFileSync(
      resolve(root, 'cognitive-os', 'agent-practice', 'MEM_GRAPH_AGENT_PRACTICE.md'),
      'utf8',
    );
    expect(mainDoc).toContain('## Profile discovery and tool routing');
    expect(mainDoc).toContain('Agent profile (10 workflow tools)');
    expect(mainDoc).toContain('Full compatibility profile (41 legacy tools)');
    expect(mainDoc).toContain('Maintenance profile (18 specialist tools)');
    expect(mainDoc).toContain('pd-06 product gap');
    expect(mainDoc).toContain('before non-trivial mem-graph or Cognitive OS work');
    expect(mainDoc).toContain('FTS5 searches use AND semantics by default');
  });

  it('asserts generated guidance does not call memory_find results governing merely because search returned them', () => {
    const mainDoc = readFileSync(
      resolve(root, 'cognitive-os', 'agent-practice', 'MEM_GRAPH_AGENT_PRACTICE.md'),
      'utf8',
    );
    expect(mainDoc).not.toMatch(/memory_find[^\n.]*to discover governing candidates/i);
    expect(mainDoc).toContain('memory_find:search discovers scoped contextual candidates; it does not create a governing lane or establish authority');

    const adaptersDir = resolve(root, 'cognitive-os', 'agent-practice', 'adapters');
    for (const name of ['AGENTS.fragment.md', 'CLAUDE.fragment.md', 'GEMINI.fragment.md', 'generic-system-prompt.md']) {
      const content = readFileSync(resolve(adaptersDir, name), 'utf8');
      expect(content).not.toMatch(/memory_find[^\n.]*to discover governing candidates/i);
      expect(content).toContain('memory_find:search discovers contextual candidates only and does not establish authority or create a governing lane');
    }
  });

  it('asserts all generated notices use mem-graph-agent-practice@1.2.0', () => {
    const expectedNotice = '<!-- Generated from practice.v1.json (mem-graph-agent-practice@1.2.0). Do not edit by hand. -->';
    const mainDoc = readFileSync(
      resolve(root, 'cognitive-os', 'agent-practice', 'MEM_GRAPH_AGENT_PRACTICE.md'),
      'utf8',
    );
    expect(mainDoc.startsWith(expectedNotice)).toBe(true);

    const adaptersDir = resolve(root, 'cognitive-os', 'agent-practice', 'adapters');
    for (const name of ['AGENTS.fragment.md', 'CLAUDE.fragment.md', 'GEMINI.fragment.md', 'generic-system-prompt.md']) {
      const content = readFileSync(resolve(adaptersDir, name), 'utf8');
      expect(content.startsWith(expectedNotice)).toBe(true);
    }
  });

  it('asserts the test suite does not mutate generated adapters and verifies freshness independently', () => {
    const targetFiles = [
      resolve(root, 'cognitive-os', 'agent-practice', 'MEM_GRAPH_AGENT_PRACTICE.md'),
      resolve(root, 'cognitive-os', 'agent-practice', 'adapters', 'AGENTS.fragment.md'),
      resolve(root, 'cognitive-os', 'agent-practice', 'adapters', 'CLAUDE.fragment.md'),
      resolve(root, 'cognitive-os', 'agent-practice', 'adapters', 'GEMINI.fragment.md'),
      resolve(root, 'cognitive-os', 'agent-practice', 'adapters', 'generic-system-prompt.md'),
    ];

    const beforeSnapshots = targetFiles.map((p) => readFileSync(p, 'utf8'));

    // Independent non-mutating freshness check (--check only, never mutating write)
    expect(() =>
      execFileSync(
        process.execPath,
        [resolve(root, 'cognitive-os', 'agent-practice', 'generate-adapters.mjs'), '--check'],
        { cwd: root, stdio: 'pipe' },
      ),
    ).not.toThrow();

    const afterSnapshots = targetFiles.map((p) => readFileSync(p, 'utf8'));
    expect(afterSnapshots).toEqual(beforeSnapshots);
  });
});
