import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  COMPACT_DISCLOSURE_VERSION,
  DEFAULT_COMPACT_BUDGET_BYTES,
  buildExpansionRoute,
  canonicalJson,
  groupAndDeduplicateStatements,
  parseEpistemicRecordId,
  projectCompactBootstrap,
  sourceStableKey,
  stableJson,
  truncateUtf8CodePoints,
} from '../src/cognitive/bootstrap-disclosure.js';
import type {
  AgentBootstrapResult,
  CompactBootstrapV1,
  CompactSourceReference,
  CompactStatement,
  TaskStateBootstrapEnvelope,
} from '../src/cognitive/types.js';

// ---------------------------------------------------------------------------
// External Zod Schemas for Destination Route Verification (B3)
// ---------------------------------------------------------------------------

const COGNITIVE_EVENT_TYPES = [
  'TaskStarted', 'TaskPaused', 'TaskResumed', 'TaskCompleted', 'TaskFailed',
  'EvidenceObserved', 'HypothesisFormed', 'PolicyProposed', 'PolicyAdopted',
  'DecisionRecorded', 'ContradictionDetected', 'CheckpointSaved',
] as const;

const destinationSchemas = {
  // Agent profile tools
  memory_read: z.object({
    operation: z.literal('get'),
    id: z.number().int().positive(),
    project_id: z.string().min(1),
    include_global: z.boolean().optional(),
  }).strict(),

  cognitive_event_read: z.object({
    project_id: z.string().min(1),
    task_id: z.string().min(1).optional(),
    event_type: z.enum(COGNITIVE_EVENT_TYPES).optional(),
    session_id: z.string().min(1).optional(),
    correlation_id: z.string().min(1).optional(),
    causation_id: z.string().min(1).optional(),
    after_sequence: z.number().int().nonnegative().optional(),
    before_sequence: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }).strict(),

  epistemic_inspect_get: z.object({
    operation: z.literal('get'),
    record_id: z.number().int().positive(),
    project_id: z.string().min(1),
    include_global: z.boolean().optional(),
    as_of: z.string().optional(),
  }).strict(),

  epistemic_inspect_query: z.object({
    operation: z.literal('query'),
    project_id: z.string().min(1),
    include_global: z.boolean().optional(),
    scope: z.enum(['exact-project', '_global']).optional(),
    epistemic_status: z.enum(['verified', 'corroborated', 'inferred', 'reported', 'assumed', 'contested', 'stale', 'retracted']).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }).strict(),

  epistemic_inspect_diff: z.object({
    operation: z.literal('diff'),
    record_id: z.number().int().positive(),
    project_id: z.string().min(1),
    include_global: z.boolean().optional(),
    from_as_of: z.string().min(1),
    to_as_of: z.string().min(1),
    include_unchanged: z.boolean().optional(),
    include_retracted: z.boolean().optional(),
  }).strict(),

  cognitive_agent_bootstrap: z.object({
    query: z.string().min(1),
    project_id: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
    include_global: z.boolean().optional(),
    category: z.string().optional(),
    layer: z.enum(['working', 'episodic', 'procedural', 'semantic', 'partner']).optional(),
    canonical_ids: z.array(z.number().int().positive()).max(20).optional(),
    include_canonical_content: z.boolean().optional(),
    include_excluded_details: z.boolean().optional(),
    task_state: z.unknown().optional(),
    response_mode: z.enum(['legacy', 'compact']).optional(),
  }),

  // Full profile tools
  memory_get: z.object({
    id: z.number().int().positive(),
  }).strict(),

  cognitive_event_trace: z.object({
    project_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    event_type: z.enum(COGNITIVE_EVENT_TYPES).optional(),
    session_id: z.string().min(1).optional(),
    correlation_id: z.string().min(1).optional(),
    causation_id: z.string().min(1).optional(),
    after_sequence: z.number().int().nonnegative().optional(),
    before_sequence: z.number().int().positive().optional(),
    limit: z.number().int().nonnegative().max(1000).optional(),
  }).strict(),

  epistemic_get: z.object({
    record_id: z.number().int().positive(),
    project_id: z.string().min(1),
    include_global: z.boolean().optional(),
    as_of: z.string().optional(),
  }).strict(),

  epistemic_query: z.object({
    project_id: z.string().min(1),
    include_global: z.boolean().optional(),
    scope: z.enum(['exact-project', '_global']).optional(),
    epistemic_status: z.enum(['verified', 'corroborated', 'inferred', 'reported', 'assumed', 'contested', 'stale', 'retracted']).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }).strict(),

  epistemic_concept_diff: z.object({
    record_id: z.number().int().positive(),
    project_id: z.string().min(1),
    include_global: z.boolean().optional(),
    from_as_of: z.string().min(1),
    to_as_of: z.string().min(1),
    include_unchanged: z.boolean().optional(),
    include_retracted: z.boolean().optional(),
  }).strict(),

  cognitive_policy_lookup: z.object({
    project_id: z.string().min(1),
    trigger_type: z.string().min(1),
    trigger_value: z.string().min(1),
    limit: z.number().int().positive().max(500).optional(),
  }).strict(),
};

// ---------------------------------------------------------------------------
// Test Fixture Helpers
// ---------------------------------------------------------------------------

function createMockBootstrapResult(
  overrides: Partial<AgentBootstrapResult> = {},
): AgentBootstrapResult {
  return {
    practice: {
      id: 'mem-graph-agent-practice',
      version: '1.1.0',
      status: 'adopted_advisory',
      hard_enforcement: false,
      authority_notice: 'Advisory practice guidelines',
    },
    scope: {
      project_id: 'test-project',
      include_global: false,
      global_inclusion: 'disabled',
    },
    canonical_snapshot: {
      requested_ids: [],
      unresolved_or_out_of_scope_ids: [],
      content_included: false,
      records: [],
    },
    policy_lookup: {
      trigger_type: 'request_type',
      trigger_value: 'current_canonical_guidance',
      authority: 'candidate_only',
      candidates: [],
    },
    guidance: {
      project_id: 'test-project',
      include_global: false,
      governing: [
        {
          id: 101,
          project_id: 'test-project',
          layer: 'semantic',
          category: 'decision',
          title: 'Governing memory 101',
          snippet: 'Keep execution pure and bounded.',
          status: 'active',
          lifecycle: 'established',
        } as any,
      ],
      excluded: [],
      contradictions: [],
    } as any,
    verification: {
      required: true,
      instruction: 'Verify candidate authority directly before relying on it.',
    },
    mutation: {
      database_writes: 0,
      events_appended: 0,
      access_tracking: 'not_touched',
      receipt_persistence: 'none',
    },
    bootstrap_digest: 'mock-bootstrap-digest-1234567890',
    ...overrides,
  };
}

function createMockTaskStateEnvelope(
  overrides: Partial<TaskStateBootstrapEnvelope> = {},
): TaskStateBootstrapEnvelope {
  const ref: CompactSourceReference = {
    kind: 'memory',
    id: 101,
    project_id: 'test-project',
  };
  return {
    envelope_version: '1.1.0',
    status: 'assembled',
    scope: { project_id: 'test-project', task_id: 'task-test' },
    authority_notice: 'Task-state items enter governing only when adopted and verified.',
    envelope_digest: 'mock-envelope-digest-123',
    packet: {
      schema_version: '1.0.0',
      packet_id: 'packet-1',
      scope: { project_id: 'test-project', task_id: 'task-test' },
      verification: {
        adoption: { status: 'verified', authority: 'operator' },
      },
      applicability: 'reviewed',
      governing: [
        {
          item_id: 'task-test|objective',
          preview: 'Execute Phase B pure projection.',
          lane_membership: 'governing',
          source: ref,
          source_version: 1,
        },
        {
          item_id: 'task-test|definition_of_done',
          preview: 'All unit tests pass and code satisfies contract.',
          lane_membership: 'governing',
          source: ref,
          source_version: 1,
        },
        {
          item_id: 'task-test|constraint:0',
          preview: 'No database or MCP imports.',
          lane_membership: 'governing',
          source: ref,
          source_version: 1,
        },
        {
          item_id: 'task-test|expected_next_action',
          preview: 'Wait for Codex Gate B review.',
          lane_membership: 'governing',
          source: ref,
          source_version: 1,
        },
      ],
      current_state: [],
      open_state: [],
      evidence: [],
      context_only: [],
      warnings: [],
      unresolved: [],
      packet_digest: 'mock-packet-digest-123',
    } as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Canonical JSON Serializer & Wire Compatibility (B1)
// ---------------------------------------------------------------------------

describe('canonicalJson (Wire Serialization B1)', () => {
  it('omits undefined object properties and never outputs ":undefined"', () => {
    const dirty = { b: undefined, a: 1, c: 'hello', d: undefined };
    const serialized = canonicalJson(dirty);

    expect(serialized).toBe('{"a":1,"c":"hello"}');
    expect(serialized).not.toContain('undefined');
    expect(JSON.parse(serialized)).toEqual({ a: 1, c: 'hello' });
  });

  it('encodes undefined array elements as null', () => {
    const arr = [1, undefined, 'test', undefined, false];
    const serialized = canonicalJson(arr);

    expect(serialized).toBe('[1,null,"test",null,false]');
    expect(JSON.parse(serialized)).toEqual([1, null, 'test', null, false]);
  });

  it('rejects non-finite numbers (NaN, Infinity, -Infinity)', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ b: Infinity })).toThrow(TypeError);
    expect(() => canonicalJson({ c: -Infinity })).toThrow(TypeError);
  });

  it('rejects circular structures', () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(TypeError);
  });

  it('sorts keys recursively at all nesting levels', () => {
    const nested = {
      z: { b: 2, a: 1 },
      a: [{ d: 4, c: 3 }],
    };
    const serialized = canonicalJson(nested);
    expect(serialized).toBe('{"a":[{"c":3,"d":4}],"z":{"a":1,"b":2}}');
  });

  it('guarantees round-trip equality through JSON.parse for clean objects', () => {
    const clean = {
      profile: 'agent',
      budget: { limit: 8192, within: true },
      items: ['alpha', 'beta'],
    };
    const serialized = canonicalJson(clean);
    expect(JSON.parse(serialized)).toEqual(clean);
  });

  it('rejects top-level undefined, symbol, function, and BigInt with TypeError', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(Symbol('test'))).toThrow(TypeError);
    expect(() => canonicalJson(() => {})).toThrow(TypeError);
    expect(() => canonicalJson(BigInt(123))).toThrow(TypeError);
  });

  it('always produces valid JSON parseable by JSON.parse for primitives, arrays, and objects', () => {
    const cases: unknown[] = [
      null,
      true,
      false,
      0,
      -100,
      3.14159,
      '',
      'hello world',
      [],
      [1, 'two', null, false],
      {},
      { key: 'val', num: 42, flag: true },
      { nested: { arr: [null, 1], str: 'test' } },
    ];
    for (const item of cases) {
      const serialized = canonicalJson(item);
      expect(() => JSON.parse(serialized)).not.toThrow();
      expect(JSON.parse(serialized)).toEqual(item);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Epistemic ID Validation and Parsing Tests (B1)
// ---------------------------------------------------------------------------

describe('parseEpistemicRecordId', () => {
  it('accepts valid positive safe integers as number and string', () => {
    expect(parseEpistemicRecordId(1)).toBe(1);
    expect(parseEpistemicRecordId(42)).toBe(42);
    expect(parseEpistemicRecordId(100)).toBe(100);
    expect(parseEpistemicRecordId('1')).toBe(1);
    expect(parseEpistemicRecordId('42')).toBe(42);
    expect(parseEpistemicRecordId('100')).toBe(100);
    expect(parseEpistemicRecordId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseEpistemicRecordId(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects non-numeric suffixes ("12junk") where bare parseInt would unsafely return 12', () => {
    expect(parseInt('12junk', 10)).toBe(12); // bare parseInt defect
    expect(parseEpistemicRecordId('12junk')).toBeNull();
    expect(parseEpistemicRecordId('42abc')).toBeNull();
    expect(parseEpistemicRecordId('100_000')).toBeNull();
  });

  it('rejects zero and negative numbers', () => {
    expect(parseEpistemicRecordId(0)).toBeNull();
    expect(parseEpistemicRecordId('0')).toBeNull();
    expect(parseEpistemicRecordId(-1)).toBeNull();
    expect(parseEpistemicRecordId('-1')).toBeNull();
    expect(parseEpistemicRecordId(-50)).toBeNull();
    expect(parseEpistemicRecordId('-50')).toBeNull();
  });

  it('rejects leading zeros, whitespace, decimals, empty, NaN, and Infinity', () => {
    expect(parseEpistemicRecordId('012')).toBeNull();
    expect(parseEpistemicRecordId('007')).toBeNull();
    expect(parseEpistemicRecordId(' 123')).toBeNull();
    expect(parseEpistemicRecordId('123 ')).toBeNull();
    expect(parseEpistemicRecordId('\t123')).toBeNull();
    expect(parseEpistemicRecordId('12.34')).toBeNull();
    expect(parseEpistemicRecordId('')).toBeNull();
    expect(parseEpistemicRecordId(undefined)).toBeNull();
    expect(parseEpistemicRecordId(NaN)).toBeNull();
    expect(parseEpistemicRecordId(Infinity)).toBeNull();
  });

  it('rejects unsafe integers beyond Number.MAX_SAFE_INTEGER', () => {
    expect(parseEpistemicRecordId('9007199254740992')).toBeNull();
    expect(parseEpistemicRecordId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Unicode and Combining Text Truncation Tests (B7)
// ---------------------------------------------------------------------------

describe('truncateUtf8CodePoints (Unicode & Combining Text B7)', () => {
  it('preserves text that fits within the byte limit', () => {
    const text = 'Hello, world!';
    const res = truncateUtf8CodePoints(text, 50);
    expect(res.truncated).toBe(false);
    expect(res.text).toBe(text);
  });

  it('truncates multi-byte emoji safely without surrogate pair bisection', () => {
    const text = '🌟🚀🎉🔥';
    const res6 = truncateUtf8CodePoints(text, 6);
    expect(res6.truncated).toBe(true);
    expect(res6.text).toBe('🌟');
    expect(res6.bytes).toBe(4);
    expect(Buffer.from(res6.text, 'utf8').toString('utf8')).toBe(res6.text);
  });

  it('truncates mathematical symbols safely at code-point boundaries', () => {
    const text = '∀x ∈ ℝ: x² ≥ 0';
    const res = truncateUtf8CodePoints(text, 10);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.text, 'utf8')).toBeLessThanOrEqual(10);
    expect(Buffer.from(res.text, 'utf8').toString('utf8')).toBe(res.text);
  });

  it('truncates uncommon astral plane CJK characters safely', () => {
    const text = '𠮷野家';
    const res = truncateUtf8CodePoints(text, 5);
    expect(res.truncated).toBe(true);
    expect(res.text).toBe('𠮷');
    expect(res.bytes).toBe(4);
  });

  it('handles combining characters safely without emitting invalid UTF-8', () => {
    // cafe + combining acute accent (\u0301)
    const text = 'cafe\u0301';
    const res = truncateUtf8CodePoints(text, 4);
    expect(res.truncated).toBe(true);
    expect(Buffer.from(res.text, 'utf8').toString('utf8')).toBe(res.text);
    expect(Buffer.byteLength(res.text, 'utf8')).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 4. Scope Fencing and Route Validity (B2, B3)
// ---------------------------------------------------------------------------

describe('buildExpansionRoute & Scope Fencing (B2, B3)', () => {
  const scopeAlpha = {
    project_id: 'fixture-alpha',
    include_global: false,
    bootstrap_query: 'resume task',
  };

  it('rejects foreign project sources (reason: source_unavailable)', () => {
    const foreignSource: CompactSourceReference = {
      kind: 'memory',
      id: 5,
      project_id: 'foreign-beta',
    };
    const route = buildExpansionRoute(foreignSource, 'read', 'agent', scopeAlpha);
    expect(route.route_available).toBe(false);
    expect(route.reason).toBe('source_unavailable');
  });

  it('rejects unrequested global sources when include_global is false', () => {
    const globalSource: CompactSourceReference = {
      kind: 'memory',
      id: 10,
      project_id: '_global',
    };
    const route = buildExpansionRoute(globalSource, 'read', 'agent', scopeAlpha);
    expect(route.route_available).toBe(false);
    expect(route.reason).toBe('source_unavailable');
  });

  it('emits original project_id in route arguments when global is explicitly included', () => {
    const scopeWithGlobal = {
      project_id: 'fixture-alpha',
      include_global: true,
      bootstrap_query: 'resume task',
    };
    const globalSource: CompactSourceReference = {
      kind: 'memory',
      id: 10,
      project_id: '_global',
    };
    const route = buildExpansionRoute(globalSource, 'read', 'agent', scopeWithGlobal);

    expect(route.route_available).toBe(true);
    // Crucial B2 fix: arguments MUST use the original project_id, NOT raw '_global'
    expect(route.route?.arguments.project_id).toBe('fixture-alpha');
    expect(route.route?.arguments.include_global).toBe(true);
    expect(destinationSchemas.memory_read.safeParse(route.route?.arguments).success).toBe(true);
  });

  it('never emits event_id in cognitive event routes (satisfies destination schemas B3)', () => {
    const eventSource: CompactSourceReference = {
      kind: 'cognitive_event',
      project_id: 'fixture-alpha',
      task_id: 'task-100',
      event_id: 'evt-999',
    };

    const agentRoute = buildExpansionRoute(eventSource, 'trace', 'agent', scopeAlpha);
    expect(agentRoute.route_available).toBe(true);
    expect(agentRoute.route?.arguments).not.toHaveProperty('event_id');
    expect(agentRoute.route?.arguments.project_id).toBe('fixture-alpha');
    expect(agentRoute.route?.arguments.task_id).toBe('task-100');
    expect(destinationSchemas.cognitive_event_read.safeParse(agentRoute.route?.arguments).success).toBe(true);

    const fullRoute = buildExpansionRoute(eventSource, 'trace', 'full', scopeAlpha);
    expect(fullRoute.route_available).toBe(true);
    expect(fullRoute.route?.arguments).not.toHaveProperty('event_id');
    expect(destinationSchemas.cognitive_event_trace.safeParse(fullRoute.route?.arguments).success).toBe(true);
  });

  it('refresh route passes bootstrap query when provided and validates schema', () => {
    const route = buildExpansionRoute(null, 'refresh', 'agent', scopeAlpha);
    expect(route.route_available).toBe(true);
    expect(route.route?.arguments.query).toBe('resume task');
    expect(destinationSchemas.cognitive_agent_bootstrap.safeParse(route.route?.arguments).success).toBe(true);
  });

  it('refresh route is marked unavailable when bootstrap query is missing or empty', () => {
    const scopeNoQuery = { project_id: 'fixture-alpha', include_global: false };
    const route = buildExpansionRoute(null, 'refresh', 'agent', scopeNoQuery);
    expect(route.route_available).toBe(false);
    expect(route.reason).toBe('route_unavailable');
  });

  it('epistemic query is a scope-level operation and builds valid route without a source', () => {
    const agentQuery = buildExpansionRoute(null, 'query', 'agent', scopeAlpha);
    expect(agentQuery.route_available).toBe(true);
    expect(agentQuery.route?.tool).toBe('epistemic_inspect');
    expect(agentQuery.route?.operation).toBe('query');
    expect(destinationSchemas.epistemic_inspect_query.safeParse(agentQuery.route?.arguments).success).toBe(true);

    const fullQuery = buildExpansionRoute(null, 'query', 'full', scopeAlpha);
    expect(fullQuery.route_available).toBe(true);
    expect(fullQuery.route?.tool).toBe('epistemic_query');
    expect(destinationSchemas.epistemic_query.safeParse(fullQuery.route?.arguments).success).toBe(true);
  });

  it('marks artifact and operator_receipt sources as route_unavailable (B3)', () => {
    const artifactSource: CompactSourceReference = {
      kind: 'artifact',
      project_id: 'fixture-alpha',
      path: 'docs/SPEC.md',
    };
    const receiptSource: CompactSourceReference = {
      kind: 'operator_receipt',
      project_id: 'fixture-alpha',
      receipt_id: 'rcpt-001',
    };

    expect(buildExpansionRoute(artifactSource, 'read', 'agent', scopeAlpha).route_available).toBe(false);
    expect(buildExpansionRoute(artifactSource, 'read', 'full', scopeAlpha).route_available).toBe(false);
    expect(buildExpansionRoute(receiptSource, 'read', 'agent', scopeAlpha).route_available).toBe(false);
    expect(buildExpansionRoute(receiptSource, 'read', 'full', scopeAlpha).route_available).toBe(false);
  });

  it('validates epistemic diff routes with valid time bounds against destination schemas', () => {
    const epistemicSource: CompactSourceReference = {
      kind: 'epistemic_record',
      project_id: 'fixture-alpha',
      record_id: '105',
    };
    const bounds = { from_as_of: '2026-09-01T00:00:00Z', to_as_of: '2026-09-07T00:00:00Z' };

    const agentDiff = buildExpansionRoute(epistemicSource, 'diff', 'agent', scopeAlpha, bounds);
    expect(agentDiff.route_available).toBe(true);
    expect(destinationSchemas.epistemic_inspect_diff.safeParse(agentDiff.route?.arguments).success).toBe(true);

    const fullDiff = buildExpansionRoute(epistemicSource, 'diff', 'full', scopeAlpha, bounds);
    expect(fullDiff.route_available).toBe(true);
    expect(destinationSchemas.epistemic_concept_diff.safeParse(fullDiff.route?.arguments).success).toBe(true);
  });

  it('keeps policy references typed and exposes policy lookup only in the full profile', () => {
    const source: CompactSourceReference = {
      kind: 'cognitive_policy',
      project_id: 'fixture-alpha',
      policy_id: 'policy-17',
    };
    const agentRoute = buildExpansionRoute(source, 'policy', 'agent', scopeAlpha);
    expect(agentRoute).toMatchObject({ route_available: false, access_tracking: 'none' });

    const fullRoute = buildExpansionRoute(source, 'policy', 'full', scopeAlpha);
    expect(fullRoute.route?.tool).toBe('cognitive_policy_lookup');
    expect(fullRoute.access_tracking).toBe('none');
    expect(destinationSchemas.cognitive_policy_lookup.safeParse(fullRoute.route?.arguments).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Contaminated Input Filtering & Trusted Semantic Input (B2, B4)
// ---------------------------------------------------------------------------

describe('projectCompactBootstrap - Scope Isolation & Trusted Input (B2, B4)', () => {
  it('filters foreign and unrequested global candidate records out of the compact envelope', () => {
    const composed = createMockBootstrapResult({
      scope: {
        project_id: 'fixture-alpha',
        include_global: false,
        global_inclusion: 'disabled',
      },
      guidance: {
        project_id: 'fixture-alpha',
        include_global: false,
        governing: [
          { id: 107, project_id: 'fixture-alpha', title: 'Allowed source', status: 'active', layer: 'semantic', lifecycle: 'established' } as any,
          { id: 108, project_id: 'foreign-beta', title: 'Foreign source', status: 'active', layer: 'semantic', lifecycle: 'established' } as any,
          { id: 109, project_id: '_global', title: 'Unrequested global', status: 'active', layer: 'semantic', lifecycle: 'established' } as any,
        ],
        excluded: [
          { id: 201, project_id: 'fixture-alpha', title: 'Allowed excluded', status: 'active', layer: 'episodic', lifecycle: 'contextual' } as any,
          { id: 202, project_id: 'foreign-gamma', title: 'Foreign excluded', status: 'active', layer: 'episodic', lifecycle: 'contextual' } as any,
        ],
        contradictions: [],
      } as any,
    });

    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });

    // Only source 107 remains in governing candidates
    expect(envelope.guidance.governing_candidates.map((g) => g.id)).toEqual([107]);
    // Only source 201 remains in contextual candidates
    expect(envelope.guidance.contextual_candidates.map((c) => c.id)).toEqual([201]);

    // Verify all generated expansion routes only target fixture-alpha
    for (const exp of envelope.expansions) {
      if (exp.source) {
        expect(exp.source.project_id).toBe('fixture-alpha');
      }
    }
  });

  it('requires trustedRoleContext to declare constraints resolved when no packet constraints exist (B4)', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        governing: [
          {
            item_id: 'task-test|objective',
            preview: 'Execute task.',
            lane_membership: 'governing',
            source: { kind: 'memory', id: 101, project_id: 'test-project' },
            source_version: 1,
          },
          {
            item_id: 'task-test|definition_of_done',
            preview: 'Task is done.',
            lane_membership: 'governing',
            source: { kind: 'memory', id: 101, project_id: 'test-project' },
            source_version: 1,
          },
          {
            item_id: 'task-test|expected_next_action',
            preview: 'Wait for Codex Gate B review.',
            lane_membership: 'governing',
            source: { kind: 'memory', id: 101, project_id: 'test-project' },
            source_version: 1,
          },
        ], // constraints intentionally empty in packet
      } as any,
    });

    const composed = {
      ...createMockBootstrapResult(),
      task_state: taskState,
    };

    // Without trusted semantic context, constraints remain unresolved
    const envUnresolved = projectCompactBootstrap(composed, { profile: 'agent' });
    expect(envUnresolved.task.constraints.status).toBe('unresolved');
    expect(envUnresolved.task.constraints.reason).toBe('task_constraints_unresolved');
    expect(envUnresolved.orientation.status).toBe('partial');

    // With trusted semantic context explicitly declaring constraints empty, constraints resolve
    const envResolved = projectCompactBootstrap(composed, {
      profile: 'agent',
      trustedRoleContext: { constraints_declared_empty: true },
    });
    expect(envResolved.task.constraints.status).toBe('resolved');
    expect(envResolved.task.constraints.items).toEqual([]);
    expect(envResolved.orientation.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// 6. Source Semantics, Applicability, and Contradictions (B6)
// ---------------------------------------------------------------------------

describe('projectCompactBootstrap - Semantics, Applicability, Contradiction (B6)', () => {
  it('preserves upstream applicability from the task state packet', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        applicability: 'review_due',
      } as any,
    });
    const composed = {
      ...createMockBootstrapResult(),
      task_state: taskState,
    };
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });
    expect(envelope.orientation.applicability).toBe('review_due');
  });

  it('groups multiple sources for task slots instead of overwriting them', () => {
    const src1: CompactSourceReference = { kind: 'memory', id: 101, project_id: 'test-project' };
    const src2: CompactSourceReference = { kind: 'memory', id: 102, project_id: 'test-project' };

    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        governing: [
          {
            item_id: 'task-test|objective',
            preview: 'Finish compiler implementation.',
            lane_membership: 'governing',
            source: src1,
            source_version: 1,
          },
          {
            item_id: 'task-test|objective',
            preview: 'Finish compiler implementation.',
            lane_membership: 'governing',
            source: src2,
            source_version: 2,
          },
          {
            item_id: 'task-test|definition_of_done',
            preview: 'All tests pass.',
            lane_membership: 'governing',
            source: src1,
            source_version: 1,
          },
        ],
      } as any,
    });

    const composed = {
      ...createMockBootstrapResult(),
      task_state: taskState,
    };
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });

    expect(envelope.task.objective.statement?.sources.length).toBe(2);
    expect(envelope.task.objective.statement?.sources.map((s) => s.id)).toEqual([101, 102]);
  });

  it('keeps unscoped contradiction at envelope warning level without falsely labeling all statements', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        warnings: ['explicit_contradiction_present'],
      } as any,
    });
    const composed = {
      ...createMockBootstrapResult(),
      task_state: taskState,
    };

    // When no specific affected source is specified, statements retain review_state: 'none'
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });

    expect(envelope.warnings).toContain('explicit_contradiction_present');
    expect(envelope.task.objective.statement?.review_state).toBe('none');
  });

  it('labels only statements referencing affected sources when contradiction sources are known', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        warnings: ['explicit_contradiction_present'],
      } as any,
    });
    const composed = {
      ...createMockBootstrapResult(),
      task_state: taskState,
    };

    const envelope = projectCompactBootstrap(composed, {
      profile: 'agent',
      trustedRoleContext: {
        affected_contradiction_sources: [
          { kind: 'memory', id: 101, record_id: 104, project_id: 'test-project' },
        ],
      },
    });

    expect(envelope.warnings).toContain('explicit_contradiction_present');
    expect(envelope.task.objective.statement?.review_state).toBe('contradiction_review_required');
    expect(envelope.guidance.governing_candidates[0].review_state).toBe('contradiction_review_required');
    expect(envelope.expansions).toContainEqual(expect.objectContaining({
      reason: 'contradiction_requires_review',
      source: expect.objectContaining({ kind: 'epistemic_record', record_id: '104', project_id: 'test-project' }),
      route_available: true,
      access_tracking: 'none',
      route: expect.objectContaining({
        tool: 'epistemic_inspect',
        operation: 'get',
        arguments: expect.objectContaining({ operation: 'get', record_id: 104, project_id: 'test-project' }),
      }),
    }));
  });

  it('emits an explicit warning when server-owned contradiction evidence identifies an affected source', () => {
    const composed = createMockBootstrapResult();
    const envelope = projectCompactBootstrap(composed, {
      profile: 'agent',
      trustedRoleContext: {
        affected_contradiction_sources: [
          { kind: 'memory', id: 101, record_id: 104, project_id: 'test-project' },
        ],
      },
    });

    expect(envelope.warnings).toContain('explicit_contradiction_present');
  });

  it('treats empty but valid scoped bootstrap as partial orientation (honest unknown), not unavailable', () => {
    const composed: AgentBootstrapResult = {
      ...createMockBootstrapResult(),
      canonical_snapshot: { requested_ids: [], unresolved_or_out_of_scope_ids: [], content_included: false, records: [] },
      guidance: {
        project_id: 'empty-project',
        include_global: false,
        governing: [],
        excluded: [],
        contradictions: [],
      } as any,
    };

    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });
    expect(envelope.orientation.status).toBe('partial');
    expect(envelope.orientation.task_state).toBe('not_requested');
    expect(envelope.orientation.requires_expansion).toBe(true);
  });

  it('keeps the compact authority notice bounded without dropping authority or access-effect warnings', () => {
    const envelope = projectCompactBootstrap(createMockBootstrapResult(), { profile: 'agent' });
    const notice = envelope.verification.authority_notice;

    expect(Buffer.byteLength(notice, 'utf8')).toBeLessThanOrEqual(120);
    expect(notice).toMatch(/rank\/inclusion/i);
    expect(notice).toMatch(/no authority/i);
    expect(notice).toMatch(/role/i);
    expect(notice).toMatch(/adoption/i);
    expect(notice).toMatch(/scope/i);
    expect(notice).toMatch(/applicability/i);
    expect(notice).toMatch(/evidence/i);
    expect(notice).toMatch(/track access/i);
  });

  it('maintains consistency: requires_expansion=false only when complete and expansions is empty', () => {
    const composed = {
      ...createMockBootstrapResult(),
      task_state: createMockTaskStateEnvelope(),
    };
    const envelope = projectCompactBootstrap(composed, {
      profile: 'agent',
      trustedRoleContext: { constraints_declared_empty: true },
    });

    expect(envelope.orientation.status).toBe('complete');
    expect(envelope.orientation.requires_expansion).toBe(false);
    expect(envelope.expansions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Completeness, Omission Accounting, and Priority Ladder (B5)
// ---------------------------------------------------------------------------

describe('projectCompactBootstrap - Completeness & Budgeting (B5)', () => {
  it('enforces Invariant P0-3: required_content_omitted forces orientation.status to partial', () => {
    const composed = {
      ...createMockBootstrapResult(),
      task_state: createMockTaskStateEnvelope(),
    };

    const envelope = projectCompactBootstrap(composed, {
      profile: 'agent',
      trustedRoleContext: {
        constraints_declared_empty: true,
        required_content_omitted: true, // True required content omission
      },
    });

    expect(envelope.omissions.required_content_omitted).toBe(true);
    expect(envelope.orientation.status).toBe('partial');
    expect(envelope.orientation.requires_expansion).toBe(true);
  });

  it('truncation of a required task statement automatically flags required_content_omitted=true', () => {
    const longObjective = 'A'.repeat(500); // Exceeds 200 max preview length
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        governing: [
          {
            item_id: 'task-test|objective',
            preview: longObjective,
            lane_membership: 'governing',
            source: { kind: 'memory', id: 101, project_id: 'test-project' },
            source_version: 1,
          },
          {
            item_id: 'task-test|definition_of_done',
            preview: 'Done.',
            lane_membership: 'governing',
            source: { kind: 'memory', id: 101, project_id: 'test-project' },
            source_version: 1,
          },
        ],
      } as any,
    });

    const composed = {
      ...createMockBootstrapResult(),
      task_state: taskState,
    };
    const envelope = projectCompactBootstrap(composed, {
      profile: 'agent',
      trustedRoleContext: { constraints_declared_empty: true },
    });

    expect(envelope.task.objective.statement?.truncated).toBe(true);
    expect(envelope.omissions.required_content_omitted).toBe(true);
    expect(envelope.orientation.status).toBe('partial');
  });

  it('preserves an unavailable task-state reason without discarding base canonical guidance', () => {
    const composed = {
      ...createMockBootstrapResult({
        canonical_snapshot: {
          requested_ids: [114, 115],
          unresolved_or_out_of_scope_ids: [115],
          content_included: false,
          records: [{
            id: 114,
            project_id: 'test-project',
            layer: 'episodic',
            category: 'orientation',
            title: 'Base orientation',
            summary: 'Base orientation remains available.',
            status: 'active',
            lifecycle: 'working',
            confidence: 1,
            importance_score: 1,
            updated_at: '2026-09-07T00:00:00Z',
          }],
        },
      }),
      task_state: createMockTaskStateEnvelope({ status: 'unavailable', reason: 'manifest_invalid', packet: undefined }),
    };
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });
    expect(envelope.orientation).toMatchObject({ status: 'partial', task_state: 'unavailable', requires_expansion: true });
    expect(envelope.guidance.canonical.map((record) => record.id)).toEqual([114]);
    expect(envelope.unresolved).toEqual(['canonical_source_unavailable:115', 'manifest_invalid']);
  });

  it('accurately tracks omitted content bytes when previews or full records are truncated', () => {
    const composed = createMockBootstrapResult({
      canonical_snapshot: {
        requested_ids: [106],
        unresolved_or_out_of_scope_ids: [],
        content_included: true,
        records: [
          {
            id: 106,
            project_id: 'test-project',
            layer: 'semantic',
            category: 'contract',
            title: 'Operating contract',
            summary: 'Short preview',
            content: 'X'.repeat(5000), // 5,000 bytes of content
            status: 'active',
            lifecycle: 'established',
            confidence: 1,
            importance_score: 1,
            updated_at: '2026-09-07T00:00:00Z',
          },
        ],
      },
    });

    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });
    expect(envelope.omissions.content_bytes_omitted).toBe(4987);
    expect(envelope.expansions).toContainEqual(expect.objectContaining({
      reason: 'content_omitted',
      source: expect.objectContaining({ id: 106 }),
      route_available: true,
      access_tracking: 'touches_access_counters',
    }));
  });

  it('reports unresolved canonical ids without offering an unsafe route', () => {
    const composed = createMockBootstrapResult({
      canonical_snapshot: {
        requested_ids: [115],
        unresolved_or_out_of_scope_ids: [115],
        content_included: false,
        records: [],
      },
    });
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });
    expect(envelope.unresolved).toContain('canonical_source_unavailable:115');
    expect(envelope.expansions).toContainEqual(expect.objectContaining({
      reason: 'source_unavailable',
      source: expect.objectContaining({ id: 115 }),
      route_available: false,
      access_tracking: 'none',
    }));
  });

  it('keeps inactive canonical history non-governing and exposes deliberate history expansion', () => {
    const composed = createMockBootstrapResult({
      canonical_snapshot: {
        requested_ids: [112],
        unresolved_or_out_of_scope_ids: [],
        content_included: false,
        records: [{
          id: 112,
          project_id: 'test-project',
          layer: 'semantic',
          category: 'decision',
          title: 'Prior decision',
          summary: 'Historical context.',
          status: 'superseded',
          lifecycle: 'established',
          confidence: 1,
          importance_score: 1,
          updated_at: '2026-09-01T00:00:00Z',
        }],
      },
      guidance: { project_id: 'test-project', include_global: false, governing: [], excluded: [], contradictions: [] } as any,
    });
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });
    expect(envelope.guidance.canonical[0]).toMatchObject({
      id: 112,
      status: 'superseded',
      eligibility: 'contextual_ineligible',
    });
    expect(envelope.guidance.governing_candidates).toEqual([]);
    expect(envelope.expansions).toContainEqual(expect.objectContaining({
      reason: 'history_requested',
      source: expect.objectContaining({ id: 112 }),
      access_tracking: 'touches_access_counters',
    }));
  });

  it('projects trusted version mismatches as a refresh requirement', () => {
    const envelope = projectCompactBootstrap(createMockBootstrapResult(), {
      profile: 'agent',
      trustedRoleContext: {
        bootstrap_query: 'inspect source 110',
        version_mismatches: [{
          source: { kind: 'memory', id: 110, project_id: 'test-project' },
          expected_version: 1,
        }],
      },
    });
    expect(envelope.unresolved).toContain('refresh_required');
    expect(envelope.expansions).toContainEqual(expect.objectContaining({
      reason: 'version_mismatch',
      source: expect.objectContaining({ id: 110 }),
      expected_version: 1,
      route_available: true,
      access_tracking: 'none',
    }));
  });

  it('omitted candidate items retain expansion references with reason: content_omitted', () => {
    const largeExcluded = Array.from({ length: 25 }, (_, i) => ({
      id: 300 + i,
      project_id: 'test-project',
      layer: 'episodic',
      category: 'log',
      title: `Context record ${i}`,
      snippet: `Detailed operation log ${i}`,
      status: 'active',
      lifecycle: 'contextual',
    }));

    const composed = {
      ...createMockBootstrapResult({
        guidance: {
          project_id: 'test-project',
          include_global: false,
          governing: [],
          excluded: largeExcluded as any,
          contradictions: [],
        } as any,
      }),
      task_state: createMockTaskStateEnvelope(),
    };

    const envelope = projectCompactBootstrap(composed, { profile: 'agent', budget: 4000 });

    expect(envelope.omissions.items_omitted).toBeGreaterThan(0);
    const contentOmittedExpansions = envelope.expansions.filter((e) => e.reason === 'content_omitted');
    expect(contentOmittedExpansions.length).toBeGreaterThan(0);
    expect(contentOmittedExpansions[0].source?.id).toBeGreaterThanOrEqual(300);
  });

  it('verifies natural budget fit and mandatory core overflow at sub-minimal budget', () => {
    const composed = {
      ...createMockBootstrapResult(),
      task_state: createMockTaskStateEnvelope(),
    };

    // First measure natural size
    const initial = projectCompactBootstrap(composed, { profile: 'agent' });
    const naturalSize = initial.budget.serialized_bytes;

    // Set budget to exact natural size -> within_budget: true
    const atBoundary = projectCompactBootstrap(composed, { profile: 'agent', budget: naturalSize });
    expect(atBoundary.budget.within_budget).toBe(true);
    expect(atBoundary.warnings).not.toContain('compact_budget_overflow');

    // Set budget to a very small budget (250 bytes) where mandatory core overflows
    const overflow = projectCompactBootstrap(composed, { profile: 'agent', budget: 250 });
    expect(overflow.budget.within_budget).toBe(false);
    expect(overflow.warnings).toContain('compact_budget_overflow');
    expect(overflow.orientation.status).toBe('partial');
  });

function buildPaddedTaskStateToSize(
  targetBytes: number,
  baseComposed: AgentBootstrapResult,
  budget = 9999,
): { taskState: TaskStateBootstrapEnvelope; envelope: CompactBootstrapV1 } {
  const ref: CompactSourceReference = { kind: 'memory', id: 101, project_id: 'test-project' };
  const items: Array<{
    item_id: string;
    preview: string;
    lane_membership: 'current_state';
    source: CompactSourceReference;
    source_version: number;
  }> = [];

  // Create 20 items with minimal previews (~6,500 bytes base)
  for (let i = 0; i < 20; i++) {
    items.push({
      item_id: `task-test|current:${String(i).padStart(3, '0')}`,
      preview: `Item ${String(i).padStart(3, '0')}: `,
      lane_membership: 'current_state',
      source: { ...ref, id: 1000 + i },
      source_version: 1,
    });
  }

  let testState = createMockTaskStateEnvelope({
    packet: { ...createMockTaskStateEnvelope().packet!, current_state: items } as any,
  });
  let res = projectCompactBootstrap({ ...baseComposed, task_state: testState }, { profile: 'agent', budget });
  let needed = targetBytes - res.budget.serialized_bytes;

  if (needed < 0) {
    throw new Error(`Base items already exceed targetBytes: ${res.budget.serialized_bytes} > ${targetBytes}`);
  }

  // Distribute 'X' padding across items without changing item count
  for (let i = 0; i < items.length && needed > 0; i++) {
    const chunk = Math.min(needed, 100);
    items[i].preview += 'X'.repeat(chunk);
    needed -= chunk;
  }

  testState = createMockTaskStateEnvelope({
    packet: { ...createMockTaskStateEnvelope().packet!, current_state: items } as any,
  });
  res = projectCompactBootstrap({ ...baseComposed, task_state: testState }, { profile: 'agent', budget });

  if (res.budget.serialized_bytes !== targetBytes) {
    throw new Error(`Padded size ${res.budget.serialized_bytes} did not match target ${targetBytes}`);
  }

  return { taskState: testState, envelope: res };
}

  it('fits exactly at 8,192 bytes boundary with within_budget: true and no overflow warning', () => {
    const baseComposed = createMockBootstrapResult();
    const { envelope } = buildPaddedTaskStateToSize(8192, baseComposed, 8192);

    expect(envelope.budget.serialized_bytes).toBe(8192);
    expect(envelope.budget.within_budget).toBe(true);
    expect(envelope.warnings).not.toContain('compact_budget_overflow');
    expect(Buffer.byteLength(canonicalJson(envelope), 'utf8')).toBe(8192);
  });

  it('reduces deterministically under 8,192 bytes when equivalent input exceeds 8,192 bytes by 1 byte before reduction', () => {
    const composed = createMockBootstrapResult({
      guidance: {
        project_id: 'test-project',
        include_global: false,
        governing: [],
        excluded: [
          { id: 201, project_id: 'test-project', title: 'Contextual record', snippet: 'Context details for reduction', status: 'active', layer: 'episodic', lifecycle: 'contextual' } as any,
        ],
        contradictions: [],
      } as any,
    });

    // Build task state that makes the envelope exactly 8,193 bytes before reduction (with 4-digit budget 9999)
    const { taskState, envelope: unreduced } = buildPaddedTaskStateToSize(8193, composed, 9999);
    expect(unreduced.budget.serialized_bytes).toBe(8193);

    // Now run with actual 8192 budget: deterministic reduction ladder fires
    const reduced = projectCompactBootstrap(
      { ...composed, task_state: taskState },
      { profile: 'agent', budget: 8192 },
    );
    expect(reduced.budget.within_budget).toBe(true);
    expect(reduced.budget.serialized_bytes).toBeLessThanOrEqual(8192);
    expect(reduced.warnings).not.toContain('compact_budget_overflow');
    expect(reduced.omissions.previews_truncated > 0 || reduced.omissions.items_omitted > 0).toBe(true);
  });

  it('preserves mandatory core and overflows when core metadata exceeds budget', () => {
    const composed = {
      ...createMockBootstrapResult(),
      task_state: createMockTaskStateEnvelope(),
    };
    const overflow = projectCompactBootstrap(composed, { profile: 'agent', budget: 300 });
    expect(overflow.budget.within_budget).toBe(false);
    expect(overflow.warnings).toContain('compact_budget_overflow');
    expect(overflow.orientation.status).toBe('partial');
    expect(overflow.orientation.requires_expansion).toBe(true);
    expect(overflow.budget.serialized_bytes).toBe(Buffer.byteLength(canonicalJson(overflow), 'utf8'));
    // Mandatory task fields are preserved
    expect(overflow.task.objective.status).toBe('governing');
    expect(overflow.task.definition_of_done.status).toBe('governing');
  });
});

// ---------------------------------------------------------------------------
// 8. Deterministic Sorting for All Collections (B6, B7)
// ---------------------------------------------------------------------------

describe('projectCompactBootstrap - Deterministic Array Ordering (B6, B7)', () => {
  it('sorts canonical, candidates, statements, warnings, and expansions deterministically', () => {
    const composed = createMockBootstrapResult({
      canonical_snapshot: {
        requested_ids: [103, 101, 102],
        unresolved_or_out_of_scope_ids: [],
        content_included: false,
        records: [
          { id: 103, project_id: 'test-project', layer: 'semantic', category: null, title: 'C', summary: null, status: 'active', lifecycle: 'permanent', confidence: 1, importance_score: 1, updated_at: '' },
          { id: 101, project_id: 'test-project', layer: 'semantic', category: null, title: 'A', summary: null, status: 'active', lifecycle: 'permanent', confidence: 1, importance_score: 1, updated_at: '' },
          { id: 102, project_id: 'test-project', layer: 'semantic', category: null, title: 'B', summary: null, status: 'active', lifecycle: 'permanent', confidence: 1, importance_score: 1, updated_at: '' },
        ],
      },
      guidance: {
        project_id: 'test-project',
        include_global: false,
        governing: [
          { id: 205, project_id: 'test-project', layer: 'semantic', category: null, title: 'Gov 205', status: 'active', lifecycle: 'established' } as any,
          { id: 201, project_id: 'test-project', layer: 'semantic', category: null, title: 'Gov 201', status: 'active', lifecycle: 'established' } as any,
        ],
        excluded: [
          { id: 305, project_id: 'test-project', layer: 'episodic', category: null, title: 'Ctx 305', status: 'active', lifecycle: 'contextual' } as any,
          { id: 301, project_id: 'test-project', layer: 'episodic', category: null, title: 'Ctx 301', status: 'active', lifecycle: 'contextual' } as any,
        ],
        contradictions: [],
      } as any,
      policy_lookup: {
        trigger_type: 'request_type',
        trigger_value: 'current_canonical_guidance',
        authority: 'candidate_only',
        candidates: [
          { policy_id: 'policy-z', project_id: 'test-project', title: 'Z', statement: 'Rule Z', status: 'active' } as any,
          { policy_id: 'policy-a', project_id: 'test-project', title: 'A', statement: 'Rule A', status: 'active' } as any,
        ],
      },
    });

    const envelope = projectCompactBootstrap(composed, { profile: 'full' });

    expect(envelope.guidance.canonical.map((r) => r.id)).toEqual([101, 102, 103]);
    expect(envelope.guidance.governing_candidates.map((g) => g.id)).toEqual([201, 205]);
    expect(envelope.guidance.contextual_candidates.map((c) => c.id)).toEqual([301, 305]);
    expect(envelope.guidance.policy_candidates.map((p) => p.policy_id)).toEqual(['policy-a', 'policy-z']);
  });

  it('stably sorts CompactStatement.sources by sourceStableKey', () => {
    const src1: CompactSourceReference = { kind: 'memory', id: 200, project_id: 'test-project' };
    const src2: CompactSourceReference = { kind: 'memory', id: 100, project_id: 'test-project' };
    const stmt: CompactStatement = {
      preview: 'Multiple sources',
      lane: 'evidence',
      authority: 'evidence_only',
      review_state: 'none',
      sources: [src1, src2],
      truncated: false,
    };
    const deduplicated = groupAndDeduplicateStatements([stmt]);
    expect(deduplicated[0].sources[0].id).toBe(100);
    expect(deduplicated[0].sources[1].id).toBe(200);
  });

  it('preserves numeric manifest order for constraints', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        governing: [
          { item_id: 'task-test|objective', preview: 'Obj', lane_membership: 'governing', source: { kind: 'memory', id: 101, project_id: 'test-project' }, source_version: 1 },
          { item_id: 'task-test|definition_of_done', preview: 'Done', lane_membership: 'governing', source: { kind: 'memory', id: 101, project_id: 'test-project' }, source_version: 1 },
          { item_id: 'task-test|constraint:10', preview: 'Tenth', lane_membership: 'governing', source: { kind: 'memory', id: 101, project_id: 'test-project' }, source_version: 1 },
          { item_id: 'task-test|constraint:2', preview: 'Second', lane_membership: 'governing', source: { kind: 'memory', id: 101, project_id: 'test-project' }, source_version: 1 },
          { item_id: 'task-test|expected_next_action', preview: 'Next', lane_membership: 'governing', source: { kind: 'memory', id: 101, project_id: 'test-project' }, source_version: 1 },
        ],
      } as any,
    });
    const envelope = projectCompactBootstrap(
      { ...createMockBootstrapResult(), task_state: taskState },
      { profile: 'agent' },
    );
    expect(envelope.task.constraints.items.map((item) => item.preview)).toEqual(['Second', 'Tenth']);
  });

  it('sorts state statement collections by lane priority, project, source kind, and stable ID', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        current_state: [
          {
            item_id: 'task-test|current:beta',
            preview: 'Beta statement',
            lane_membership: 'current_state',
            source: { kind: 'memory', id: 102, project_id: 'project-b' },
            source_version: 1,
          },
          {
            item_id: 'task-test|current:alpha',
            preview: 'Alpha statement',
            lane_membership: 'current_state',
            source: { kind: 'memory', id: 101, project_id: 'project-a' },
            source_version: 1,
          },
        ],
      } as any,
    });
    const composed = {
      ...createMockBootstrapResult({ scope: { project_id: 'project-a', include_global: false, global_inclusion: 'disabled' } }),
      task_state: taskState,
    };
    const env = projectCompactBootstrap(composed, { profile: 'agent' });
    expect(env.state.current.map((s) => s.preview)).toEqual(['Alpha statement', 'Beta statement']);
  });

  it('guarantees byte-identical canonical JSON and identical compact_digest under permuted inputs', () => {
    const canonicalA = [
      { id: 101, project_id: 'test-project', layer: 'semantic', category: null, title: 'A', summary: 'sum A', status: 'active', lifecycle: 'permanent', confidence: 1, importance_score: 1, updated_at: '' },
      { id: 102, project_id: 'test-project', layer: 'semantic', category: null, title: 'B', summary: 'sum B', status: 'active', lifecycle: 'permanent', confidence: 1, importance_score: 1, updated_at: '' },
    ];
    const canonicalB = [canonicalA[1], canonicalA[0]];

    const governingA = [
      { id: 201, project_id: 'test-project', layer: 'semantic', category: null, title: 'Gov 201', snippet: 'snip 1', status: 'active', lifecycle: 'established' } as any,
      { id: 202, project_id: 'test-project', layer: 'semantic', category: null, title: 'Gov 202', snippet: 'snip 2', status: 'active', lifecycle: 'established' } as any,
    ];
    const governingB = [governingA[1], governingA[0]];

    const policiesA = [
      { policy_id: 'pol-1', project_id: 'test-project', title: 'P1', statement: 'Rule 1', status: 'active' } as any,
      { policy_id: 'pol-2', project_id: 'test-project', title: 'P2', statement: 'Rule 2', status: 'active' } as any,
    ];
    const policiesB = [policiesA[1], policiesA[0]];

    const taskItemsA = [
      { item_id: 'task-test|objective', preview: 'Obj', lane_membership: 'governing', source: { kind: 'memory', id: 101, project_id: 'test-project' }, source_version: 1 },
      { item_id: 'task-test|definition_of_done', preview: 'DoD', lane_membership: 'governing', source: { kind: 'memory', id: 101, project_id: 'test-project' }, source_version: 1 },
      { item_id: 'task-test|constraint:0', preview: 'C0', lane_membership: 'governing', source: { kind: 'memory', id: 101, project_id: 'test-project' }, source_version: 1 },
      { item_id: 'task-test|expected_next_action', preview: 'Next', lane_membership: 'governing', source: { kind: 'memory', id: 101, project_id: 'test-project' }, source_version: 1 },
    ];
    const taskItemsB = [taskItemsA[3], taskItemsA[0], taskItemsA[2], taskItemsA[1]];

    const currentA = [
      { item_id: 'task-test|cur:1', preview: 'Cur 1', lane_membership: 'current_state', source: { kind: 'memory', id: 101, project_id: 'test-project' }, source_version: 1 },
      { item_id: 'task-test|cur:2', preview: 'Cur 2', lane_membership: 'current_state', source: { kind: 'memory', id: 102, project_id: 'test-project' }, source_version: 1 },
    ];
    const currentB = [currentA[1], currentA[0]];

    const composedA = {
      ...createMockBootstrapResult({
        canonical_snapshot: { requested_ids: [101, 102], unresolved_or_out_of_scope_ids: [], content_included: false, records: canonicalA },
        guidance: { project_id: 'test-project', include_global: false, governing: governingA, excluded: [], contradictions: [] } as any,
        policy_lookup: { trigger_type: 'request_type', trigger_value: 'current_canonical_guidance', authority: 'candidate_only', candidates: policiesA },
      }),
      task_state: createMockTaskStateEnvelope({
        packet: {
          ...createMockTaskStateEnvelope().packet!,
          governing: taskItemsA,
          current_state: currentA,
        } as any,
      }),
    };

    const composedB = {
      ...createMockBootstrapResult({
        canonical_snapshot: { requested_ids: [102, 101], unresolved_or_out_of_scope_ids: [], content_included: false, records: canonicalB },
        guidance: { project_id: 'test-project', include_global: false, governing: governingB, excluded: [], contradictions: [] } as any,
        policy_lookup: { trigger_type: 'request_type', trigger_value: 'current_canonical_guidance', authority: 'candidate_only', candidates: policiesB },
      }),
      task_state: createMockTaskStateEnvelope({
        packet: {
          ...createMockTaskStateEnvelope().packet!,
          governing: taskItemsB,
          current_state: currentB,
        } as any,
      }),
    };

    const envA = projectCompactBootstrap(composedA, { profile: 'agent' });
    const envB = projectCompactBootstrap(composedB, { profile: 'agent' });

    expect(canonicalJson(envA)).toBe(canonicalJson(envB));
    expect(envA.compact_digest).toBe(envB.compact_digest);
    expect(envA.budget.serialized_bytes).toBe(envB.budget.serialized_bytes);
  });
});

// ---------------------------------------------------------------------------
// 9. Orientation Completeness Requirements (Codex B5 / Gate B)
// ---------------------------------------------------------------------------

describe('Orientation Completeness Requirements (Codex B5 / Gate B)', () => {
  const ref: CompactSourceReference = { kind: 'memory', id: 101, project_id: 'test-project' };

  it('a. objective resolved but done-condition unresolved -> status: partial, requires_expansion: true', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        governing: [
          { item_id: 'task-test|objective', preview: 'Objective only', lane_membership: 'governing', source: ref, source_version: 1 },
          { item_id: 'task-test|expected_next_action', preview: 'Next step', lane_membership: 'governing', source: ref, source_version: 1 },
        ],
      } as any,
    });
    const composed = { ...createMockBootstrapResult(), task_state: taskState };
    const envelope = projectCompactBootstrap(composed, {
      profile: 'agent',
      trustedRoleContext: { constraints_declared_empty: true },
    });

    expect(envelope.task.objective.status).toBe('governing');
    expect(envelope.task.definition_of_done.status).toBe('unresolved');
    expect(envelope.orientation.status).toBe('partial');
    expect(envelope.orientation.requires_expansion).toBe(true);
  });

  it('b. objective/done resolved but constraints unresolved -> status: partial, requires_expansion: true', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        governing: [
          { item_id: 'task-test|objective', preview: 'Do work', lane_membership: 'governing', source: ref, source_version: 1 },
          { item_id: 'task-test|definition_of_done', preview: 'Work is done', lane_membership: 'governing', source: ref, source_version: 1 },
          { item_id: 'task-test|expected_next_action', preview: 'Next step', lane_membership: 'governing', source: ref, source_version: 1 },
        ],
      } as any,
    });
    const composed = { ...createMockBootstrapResult(), task_state: taskState };
    // Without constraints_declared_empty, constraints remain unresolved
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });

    expect(envelope.task.objective.status).toBe('governing');
    expect(envelope.task.definition_of_done.status).toBe('governing');
    expect(envelope.task.constraints.status).toBe('unresolved');
    expect(envelope.orientation.status).toBe('partial');
    expect(envelope.orientation.requires_expansion).toBe(true);
  });

  it('c. next action unresolved -> status: partial, requires_expansion: true', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        governing: [
          { item_id: 'task-test|objective', preview: 'Do work', lane_membership: 'governing', source: ref, source_version: 1 },
          { item_id: 'task-test|definition_of_done', preview: 'Work is done', lane_membership: 'governing', source: ref, source_version: 1 },
          { item_id: 'task-test|constraint:0', preview: 'Rule 0', lane_membership: 'governing', source: ref, source_version: 1 },
        ], // expected_next_action is absent
      } as any,
    });
    const composed = { ...createMockBootstrapResult(), task_state: taskState };
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });

    expect(envelope.task.objective.status).toBe('governing');
    expect(envelope.task.definition_of_done.status).toBe('governing');
    expect(envelope.task.constraints.status).toBe('resolved');
    expect(envelope.task.next_action.status).toBe('unresolved');
    expect(envelope.orientation.status).toBe('partial');
    expect(envelope.orientation.requires_expansion).toBe(true);
  });

  it('d. adopted task state containing a contradicted required statement -> status: partial, requires_expansion: true', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        warnings: ['explicit_contradiction_present'],
      } as any,
    });
    const composed = { ...createMockBootstrapResult(), task_state: taskState };
    const envelope = projectCompactBootstrap(composed, {
      profile: 'agent',
      trustedRoleContext: {
        constraints_declared_empty: true,
        affected_contradiction_sources: [
          { kind: 'memory', id: 101, project_id: 'test-project' },
        ],
      },
    });

    expect(envelope.task.objective.statement?.review_state).toBe('contradiction_review_required');
    expect(envelope.orientation.status).toBe('partial');
    expect(envelope.orientation.requires_expansion).toBe(true);
  });

  it('invariant: a partial or unavailable result must never have requires_expansion=false', () => {
    const composedPartial = {
      ...createMockBootstrapResult(),
      canonical_snapshot: { requested_ids: [], unresolved_or_out_of_scope_ids: [], content_included: false, records: [] },
      guidance: { project_id: 'test-project', include_global: false, governing: [], excluded: [], contradictions: [] } as any,
    };
    const envPartial = projectCompactBootstrap(composedPartial, { profile: 'agent' });
    expect(envPartial.orientation.status).toBe('partial');
    expect(envPartial.orientation.requires_expansion).toBe(true);

    const composedUnavailable = {
      ...createMockBootstrapResult(),
      task_state: createMockTaskStateEnvelope({ status: 'unavailable' }),
    };
    const envUnavailable = projectCompactBootstrap(composedUnavailable, { profile: 'agent' });
    expect(envUnavailable.orientation.status).toBe('partial');
    expect(envUnavailable.orientation.task_state).toBe('unavailable');
    expect(envUnavailable.orientation.requires_expansion).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Omission and Expansion Integrity (Codex B3, B5 / Gate B)
// ---------------------------------------------------------------------------

describe('Omission and Expansion Integrity (Codex B3, B5 / Gate B)', () => {
  it('forces Stage 2: omitted contextual candidates, state.context_only, and state.evidence retain expansions', () => {
    const taskState = createMockTaskStateEnvelope({
      packet: {
        ...createMockTaskStateEnvelope().packet!,
        context_only: [
          { item_id: 'task-test|ctx:1', preview: 'Context 1', lane_membership: 'context_only', source: { kind: 'memory', id: 501, project_id: 'test-project' }, source_version: 1 },
        ],
        evidence: [
          { item_id: 'task-test|ev:1', preview: 'Evidence 1', lane_membership: 'evidence', source: { kind: 'cognitive_event', task_id: 'task-test', event_id: 'evt-1', project_id: 'test-project' }, source_version: 1 },
          { item_id: 'task-test|ev:2', preview: 'Evidence 2', lane_membership: 'evidence', source: { kind: 'artifact', path: 'docs/SPEC.md', project_id: 'test-project' }, source_version: 1 },
        ],
      } as any,
    });

    const composed = {
      ...createMockBootstrapResult({
        guidance: {
          project_id: 'test-project',
          include_global: false,
          governing: [],
          excluded: [
            { id: 401, project_id: 'test-project', title: 'Excluded item', snippet: 'Details', status: 'active', layer: 'episodic', lifecycle: 'contextual' } as any,
          ],
          contradictions: [],
        } as any,
      }),
      task_state: taskState,
    };

    // Derive the forcing budget from the current wire size so harmless framing
    // optimizations cannot silently turn this into a no-reduction test.
    const natural = projectCompactBootstrap(composed, { profile: 'agent' });
    const forcingBudget = natural.budget.serialized_bytes - 500;
    const envelope = projectCompactBootstrap(composed, { profile: 'agent', budget: forcingBudget });

    expect(envelope.omissions.items_omitted).toBeGreaterThan(0);
    expect(envelope.guidance.contextual_candidates).toEqual([]);
    expect(envelope.state.context_only).toEqual([]);
    expect(envelope.state.evidence).toEqual([]);

    // Check expansions retained for all omitted items
    const contentOmitted = envelope.expansions.filter((e) => e.reason === 'content_omitted');
    expect(contentOmitted.length).toBeGreaterThanOrEqual(3);

    // Memory expansion has route_available: true
    const memExp = contentOmitted.find((e) => e.source?.kind === 'memory' && e.source.id === 501);
    expect(memExp).toBeDefined();
    expect(memExp?.route_available).toBe(true);

    // Event expansion has route_available: true
    const evtExp = contentOmitted.find((e) => e.source?.kind === 'cognitive_event');
    expect(evtExp).toBeDefined();
    expect(evtExp?.route_available).toBe(true);

    // Artifact expansion has route_available: false, reason: content_omitted
    const artExp = contentOmitted.find((e) => e.source?.kind === 'artifact');
    expect(artExp).toBeDefined();
    expect(artExp?.route_available).toBe(false);

    // Required task items are NOT omitted!
    expect(envelope.task.objective.status).toBe('governing');
    expect(envelope.task.definition_of_done.status).toBe('governing');
  });

  it('forces Stage 4: omitted policy candidates retain expansion references', () => {
    const policies = [
      { policy_id: 'pol-alpha', project_id: 'test-project', title: 'Alpha rule', statement: 'Statement Alpha', status: 'active' } as any,
    ];
    const composed = {
      ...createMockBootstrapResult({
        policy_lookup: {
          trigger_type: 'request_type',
          trigger_value: 'current_canonical_guidance',
          authority: 'candidate_only',
          candidates: policies,
        },
      }),
      task_state: createMockTaskStateEnvelope(),
    };

    const envelope = projectCompactBootstrap(composed, { profile: 'agent', budget: 2600 });
    expect(envelope.guidance.policy_candidates).toEqual([]);
    const polExp = envelope.expansions.find((e) => e.source?.title === 'Alpha rule');
    expect(polExp).toBeDefined();
    expect(polExp?.reason).toBe('content_omitted');
    expect(polExp?.route_available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. Independent Digest Recalculation & Purity Invariant (B1, B7)
// ---------------------------------------------------------------------------

function independentCanonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number: ${value}`);
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map((v) =>
      v === undefined || typeof v === 'symbol' || typeof v === 'function'
        ? 'null'
        : independentCanonicalJson(v),
    );
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined || typeof v === 'symbol' || typeof v === 'function') continue;
      parts.push(`${JSON.stringify(k)}:${independentCanonicalJson(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`Unsupported type: ${typeof value}`);
}

describe('projectCompactBootstrap - Independent Digest & Module Purity (B1, B7)', () => {
  it('compact_digest independently recalculates from canonicalJson excluding compact_digest', () => {
    const composed = {
      ...createMockBootstrapResult(),
      task_state: createMockTaskStateEnvelope(),
    };
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });

    // Independent calculation: remove compact_digest, serialize with canonicalJson, hash with SHA-256
    const { compact_digest, ...digestSource } = envelope;
    const independentlyComputed = createHash('sha256')
      .update(canonicalJson(digestSource), 'utf8')
      .digest('hex');

    expect(envelope.compact_digest).toBe(independentlyComputed);
    expect(envelope.compact_digest.length).toBe(64);
  });

  it('compact_digest verifies against independent test-side canonical JSON oracle', () => {
    const composed = {
      ...createMockBootstrapResult(),
      task_state: createMockTaskStateEnvelope(),
    };
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });

    // Independent oracle without calling production canonicalJson
    const { compact_digest: _, ...digestSource } = envelope;
    const independentJson = independentCanonicalJson(digestSource);
    const independentDigest = createHash('sha256').update(independentJson, 'utf8').digest('hex');

    expect(envelope.compact_digest).toBe(independentDigest);
    expect(envelope.compact_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serialized_bytes equals Buffer.byteLength of the exact canonicalJson envelope', () => {
    const composed = {
      ...createMockBootstrapResult(),
      task_state: createMockTaskStateEnvelope(),
    };
    const envelope = projectCompactBootstrap(composed, { profile: 'agent' });
    const wireBytes = Buffer.byteLength(canonicalJson(envelope), 'utf8');

    expect(envelope.budget.serialized_bytes).toBe(wireBytes);
    expect(JSON.parse(canonicalJson(envelope))).toBeDefined();
  });

  it('pure module invariant: zero sqlite, MCP, fs, or env imports in bootstrap-disclosure.ts', () => {
    const filePath = resolve(__dirname, '../src/cognitive/bootstrap-disclosure.ts');
    const sourceCode = readFileSync(filePath, 'utf8');

    expect(sourceCode).not.toContain('better-sqlite3');
    expect(sourceCode).not.toContain('../db');
    expect(sourceCode).not.toContain('db.js');
    expect(sourceCode).not.toContain('@modelcontextprotocol/sdk');
    expect(sourceCode).not.toContain('node:fs');
    expect(sourceCode).not.toContain('node:child_process');
    expect(sourceCode).not.toContain('process.env');

    const importLines = sourceCode
      .split('\n')
      .filter((line) => line.startsWith('import ') && !line.includes('type {'));

    for (const imp of importLines) {
      expect(imp).toMatch(/from 'node:crypto'/);
    }
  });
});
