// Transcript fixtures for the Step 4 Phase 4A profile-aware workflow contract.
// Representative fixtures conform to the per-arm envelope shape:
//   - control arms use the committed AgentBootstrapResult shape (legacy)
//   - candidate arms use the committed CompactBootstrapV1 shape (compact)
//
// The same arm-grader.mjs module evaluates both representative fixtures
// (must return passed=true) and counterexample fixtures (must return the
// fixture's declared expected_failure_code). No bespoke detection_plan
// authority remains.
//
// Pure module: no I/O beyond a one-shot read of cases.json via Node's
// JSON import. Reuses the Step 3 structured-predicate evaluator via
// relative import — no second operator semantics are introduced.

import CASES_DOC from './cases.json' with { type: 'json' };
import {
  FULL_PROFILE_TOOL_NAMES,
  AGENT_PROFILE_TOOL_NAMES,
} from './tool-profiles-mirror.mjs';

const SENTINEL_FULL = '__FROM_MIRROR__';
const SENTINEL_AGENT = '__FROM_AGENT_MIRROR__';

function resolveAllowedToolNames(value) {
  if (!Array.isArray(value)) return value;
  if (value.length === 1 && value[0] === SENTINEL_FULL) return FULL_PROFILE_TOOL_NAMES.slice();
  if (value.length === 1 && value[0] === SENTINEL_AGENT) return AGENT_PROFILE_TOOL_NAMES.slice();
  return value;
}

function resolveArm(armDoc) {
  return {
    ...armDoc,
    allowed_tool_names: resolveAllowedToolNames(armDoc.allowed_tool_names),
    required_tool_calls: armDoc.required_tool_calls && {
      ...armDoc.required_tool_calls,
      calls: armDoc.required_tool_calls.calls,
    },
  };
}

function resolveCase(caseDoc) {
  return {
    ...caseDoc,
    arms: {
      control: resolveArm(caseDoc.arms.control),
      candidate: resolveArm(caseDoc.arms.candidate),
      ...(caseDoc.arms.explicit_global_subfixture ? { explicit_global_subfixture: caseDoc.arms.explicit_global_subfixture } : {}),
    },
  };
}

export const STEP4_CASES = CASES_DOC.cases.map(resolveCase);
export const STEP4_COUNTEREXAMPLES = CASES_DOC.counterexamples ?? [];
export const STEP4_EXPANSION_REASONS = CASES_DOC.expansion_reasons;
export const STEP4_FROZEN_THRESHOLDS = CASES_DOC.frozen_thresholds;

// --- Envelope builders -------------------------------------------------------

function legacyBootstrapEnvelope(projectId, includeGlobal = false, overrides = {}) {
  // Mirrors AgentBootstrapResult (src/cognitive/types.ts:209).
  return {
    practice: {
      id: 'mem-graph-agent-practice',
      version: '1.1.0',
      status: 'adopted_advisory',
      hard_enforcement: false,
      authority_notice: 'governing lane may drive selection; retrieval is not validation',
    },
    scope: {
      project_id: projectId,
      include_global: includeGlobal,
      global_inclusion: includeGlobal ? 'explicit' : 'disabled',
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
      governing: [],
      contextual: [],
      policy_candidates: [],
    },
    verification: {
      required: true,
      instruction: 'bootstrap is read-only; selected records must be fetched directly before reliance',
    },
    mutation: {
      database_writes: 0,
      events_appended: 0,
      access_tracking: 'not_touched',
      receipt_persistence: 'none',
    },
    bootstrap_digest: 'placeholder',
    ...overrides,
  };
}

function compactBootstrapEnvelope(projectId, includeGlobal = false, overrides = {}) {
  // Mirrors CompactBootstrapV1 (src/cognitive/types.ts:454).
  return {
    disclosure_version: '1.0.0',
    response_mode: 'compact',
    profile: 'agent',
    scope: {
      project_id: projectId,
      include_global: includeGlobal,
      global_inclusion: includeGlobal ? 'explicit' : 'disabled',
    },
    orientation: {
      status: 'partial',
      requires_expansion: true,
      task_state: 'not_requested',
      applicability: 'unknown',
    },
    task: {
      objective: { status: 'unresolved' },
      definition_of_done: { status: 'unresolved' },
      constraints: { status: 'unresolved', items: [] },
      next_action: { status: 'unresolved' },
    },
    guidance: {
      canonical: [],
      governing_candidates: [],
      contextual_candidates: [],
      policy_candidates: [],
    },
    state: {
      current: [],
      open: [],
      evidence: [],
      context_only: [],
    },
    warnings: [],
    unresolved: [],
    expansions: [],
    omissions: {
      previews_truncated: 0,
      items_omitted: 0,
      content_bytes_omitted: null,
      required_content_omitted: false,
    },
    source_snapshot: {
      bootstrap_digest: 'placeholder',
      task_state_envelope_digest: null,
      task_state_packet_digest: null,
    },
    verification: {
      required: true,
      authority_notice: 'unresolved slots require manifest',
      adoption_status: 'not_applicable',
    },
    mutation: {
      database_writes: 0,
      events_appended: 0,
      access_tracking: 'not_touched',
      receipt_persistence: 'none',
    },
    budget: {
      limit_bytes: 8192,
      serialized_bytes: 1024,
      within_budget: true,
    },
    compact_digest: '0'.repeat(64),
    ...overrides,
  };
}

const PD02_TASK_STATE = structuredClone(
  CASES_DOC.cases.find((entry) => entry.id === 'pd-02-valid-manifest')
    .arms.candidate.synthetic_request.task_state,
);

// --- Representative transcripts ------------------------------------------------

const PD01_CONTROL = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, query: 'where were we' },
    response_envelope: legacyBootstrapEnvelope('fixture-alpha', false),
  },
];

const PD01_CANDIDATE = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', query: 'where were we' },
    response_envelope: compactBootstrapEnvelope('fixture-alpha', false),
  },
];

const PD02_CONTROL = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', task_state: PD02_TASK_STATE, query: 'resume parser task' },
    response_envelope: legacyBootstrapEnvelope('fixture-alpha', false, {
      policy_lookup: {
        trigger_type: 'request_type',
        trigger_value: 'current_canonical_guidance',
        authority: 'candidate_only',
        candidates: [
          { policy_id: 'fixture-policy-2', project_id: 'fixture-alpha', title: 'Parser policy', status: 'candidate', authority: 'candidate_only', preview: 'Keep parsing deterministic.', truncated: false },
        ],
      },
    }),
  },
  {
    tool: 'memory_get',
    args: { id: 103 },
    response_envelope: { id: 103, project_id: 'fixture-alpha', title: 'Parser decision' },
  },
];

const PD02_CANDIDATE = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', task_state: PD02_TASK_STATE, query: 'resume parser task' },
    response_envelope: compactBootstrapEnvelope('fixture-alpha', false, {
      orientation: { status: 'partial', requires_expansion: true, task_state: 'assembled', applicability: 'reviewed' },
      task: {
        objective: {
          status: 'governing',
          statement: {
            semantic_role: 'objective',
            preview: 'Finish parser',
            lane: 'governing',
            authority: 'adopted_task_orientation_only',
            review_state: 'none',
            sources: [{ kind: 'memory', id: 102, project_id: 'fixture-alpha', version: 1 }],
            truncated: false,
          },
        },
        definition_of_done: {
          status: 'governing',
          statement: {
            semantic_role: 'definition_of_done',
            preview: 'All parser fixtures pass',
            lane: 'governing',
            authority: 'adopted_task_orientation_only',
            review_state: 'none',
            sources: [{ kind: 'memory', id: 102, project_id: 'fixture-alpha', version: 1 }],
            truncated: false,
          },
        },
        constraints: {
          status: 'resolved',
          items: [
            {
              semantic_role: 'constraint',
              preview: 'No schema migration',
              lane: 'governing',
              authority: 'adopted_task_orientation_only',
              review_state: 'none',
              sources: [{ kind: 'memory', id: 102, project_id: 'fixture-alpha', version: 1 }],
              truncated: false,
            },
          ],
          reason: 'manifest provided',
        },
        next_action: {
          status: 'governing',
          statement: {
            semantic_role: 'expected_next_action',
            preview: 'Inspect failing fixture',
            lane: 'governing',
            authority: 'adopted_task_orientation_only',
            review_state: 'none',
            sources: [{ kind: 'memory', id: 102, project_id: 'fixture-alpha', version: 1 }],
            truncated: false,
          },
        },
      },
    }),
  },
];

const PD03_CONTROL = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', query: 'resume deployment' },
    response_envelope: legacyBootstrapEnvelope('fixture-alpha', false, {
      policy_lookup: {
        trigger_type: 'request_type',
        trigger_value: 'current_canonical_guidance',
        authority: 'candidate_only',
        candidates: [
          { policy_id: 'fixture-policy-3', project_id: 'fixture-alpha', title: 'Deployment target', status: 'candidate', authority: 'candidate_only', preview: 'Target A.', truncated: false },
        ],
      },
    }),
  },
  {
    tool: 'epistemic_get',
    args: { record_id: 104, project_id: 'fixture-alpha' },
    response_envelope: { ok: true, record: { record_id: 104, project_id: 'fixture-alpha', summary: 'Use target A.' }, mode: 'current' },
  },
];

const PD03_CANDIDATE = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', query: 'resume deployment' },
    response_envelope: compactBootstrapEnvelope('fixture-alpha', false, {
      orientation: { status: 'partial', requires_expansion: true, task_state: 'not_requested', applicability: 'review_due' },
      warnings: ['explicit_contradiction_present'],
      guidance: {
        governing_candidates: [
          {
            id: 104, project_id: 'fixture-alpha', layer: 'semantic', category: 'decision', title: 'Deployment target',
            status: 'active', lifecycle: 'permanent', preview: 'Use target A.',
            truncated: false, review_state: 'contradiction_review_required', eligibility: 'governing_eligible',
          },
        ],
        canonical: [], contextual_candidates: [], policy_candidates: [],
      },
      expansions: [
        {
          reason: 'contradiction_requires_review',
          source: { kind: 'epistemic_record', record_id: '104', project_id: 'fixture-alpha' },
          expected_version: null,
          route_available: true,
          access_tracking: 'none',
          route: { tool: 'epistemic_inspect', operation: 'get', arguments: { operation: 'get', record_id: 104, project_id: 'fixture-alpha', include_global: false } },
        },
      ],
    }),
  },
  {
    tool: 'epistemic_inspect',
    args: { operation: 'get', record_id: 104, project_id: 'fixture-alpha' },
    response_envelope: { ok: true, operation: 'get', record: { record_id: 104, project_id: 'fixture-alpha' }, mode: 'current' },
  },
];

const PD04_CONTROL = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', canonical_ids: [106], include_canonical_content: true, query: 'load operating constraints' },
    response_envelope: legacyBootstrapEnvelope('fixture-alpha', false, {
      canonical_snapshot: {
        requested_ids: [106],
        unresolved_or_out_of_scope_ids: [],
        content_included: true,
        records: [
          {
            id: 106, project_id: 'fixture-alpha',
            content: 'A bounded preview.',
            summary: 'A bounded preview.',
            status: 'active',
            lifecycle: 'permanent',
            confidence: 1,
            importance_score: 1,
            updated_at: '2026-09-08T00:00:00Z',
          },
        ],
      },
    }),
  },
  {
    tool: 'memory_get',
    args: { id: 106 },
    response_envelope: { id: 106, project_id: 'fixture-alpha', title: 'Long operating contract' },
  },
];

const PD04_CANDIDATE = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', canonical_ids: [106], include_canonical_content: true, query: 'load operating constraints' },
    response_envelope: compactBootstrapEnvelope('fixture-alpha', false, {
      orientation: { status: 'partial', requires_expansion: true, task_state: 'not_requested', applicability: 'reviewed' },
      guidance: {
        canonical: [
          { id: 106, project_id: 'fixture-alpha', layer: 'semantic', category: 'contract', title: 'Long operating contract', status: 'active', lifecycle: 'permanent', preview: 'A bounded preview.', truncated: true, review_state: 'none', eligibility: 'governing_eligible' },
        ],
        governing_candidates: [], contextual_candidates: [], policy_candidates: [],
      },
      omissions: {
        previews_truncated: 1,
        items_omitted: 1,
        content_bytes_omitted: 11982,
        required_content_omitted: false,
      },
      expansions: [
        {
          reason: 'content_omitted',
          source: { kind: 'memory', id: 106, project_id: 'fixture-alpha' },
          expected_version: null,
          route_available: true,
          access_tracking: 'touches_access_counters',
          route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 106, project_id: 'fixture-alpha', include_global: false } },
        },
      ],
    }),
  },
  {
    tool: 'memory_read',
    args: { project_id: 'fixture-alpha',  operation: 'get', id: 106 },
    response_envelope: { ok: true, operation: 'get', touched: true, memory: {  id: 106, project_id: 'fixture-alpha'  } },
  },
];

const PD05_CONTROL = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, canonical_ids: [107, 108, 109], query: 'current implementation' },
    response_envelope: legacyBootstrapEnvelope('fixture-alpha', false, {
      canonical_snapshot: {
        requested_ids: [107, 108, 109],
        unresolved_or_out_of_scope_ids: [108, 109],
        content_included: false,
        records: [
          {
            id: 107, project_id: 'fixture-alpha',
            content: 'Allowed source.',
            summary: 'Allowed source.',
            status: 'active',
            lifecycle: 'permanent',
            confidence: 1,
            importance_score: 1,
            updated_at: '2026-09-08T00:00:00Z',
          },
        ],
      },
    }),
  },
];

const PD05_CANDIDATE = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', canonical_ids: [107, 108, 109], query: 'current implementation' },
    response_envelope: compactBootstrapEnvelope('fixture-alpha', false, {
      orientation: { status: 'partial', requires_expansion: true, task_state: 'not_requested', applicability: 'reviewed' },
      guidance: {
        canonical: [
          { id: 107, project_id: 'fixture-alpha', layer: 'semantic', category: 'implementation', title: 'Allowed source', status: 'active', lifecycle: 'permanent', preview: 'Allowed source.', truncated: false, review_state: 'none', eligibility: 'governing_eligible' },
        ],
        governing_candidates: [], contextual_candidates: [], policy_candidates: [],
      },
      expansions: [
        { reason: 'route_unavailable', source: { kind: 'memory', id: 108, project_id: 'fixture-beta' }, expected_version: null, route_available: false, access_tracking: 'none' },
        { reason: 'route_unavailable', source: { kind: 'memory', id: 109, project_id: '_global' }, expected_version: null, route_available: false, access_tracking: 'none' },
      ],
    }),
  },
];

const PD05_EXPLICIT_GLOBAL = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: true, response_mode: 'compact', query: 'current implementation' },
    response_envelope: compactBootstrapEnvelope('fixture-alpha', true, {
      orientation: { status: 'complete', requires_expansion: false, task_state: 'not_requested', applicability: 'reviewed' },
    }),
  },
];

const PD06_CONTROL = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', query: 'inspect source 110' },
    response_envelope: legacyBootstrapEnvelope('fixture-alpha', false),
  },
  {
    tool: 'memory_get',
    args: { id: 110 },
    response_envelope: { id: 110, project_id: 'fixture-alpha', title: 'Revised source', version: 2 },
  },
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', query: 'inspect source 110' },
    response_envelope: legacyBootstrapEnvelope('fixture-alpha', false),
  },
];

const PD06_CANDIDATE = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', query: 'inspect source 110' },
    response_envelope: compactBootstrapEnvelope('fixture-alpha', false, {
      orientation: { status: 'partial', requires_expansion: true, task_state: 'not_requested', applicability: 'review_due' },
      // Honest Step 3 product gap: the public compact MCP has no cross-call
      // comparison seam. This is a normal authority-verification expansion;
      // neither refresh_required nor version_mismatch may be fabricated.
      guidance: {
        governing_candidates: [
          {
            id: 110, project_id: 'fixture-alpha', layer: 'semantic', category: 'source', title: 'Revised source',
            status: 'active', lifecycle: 'permanent', preview: 'Source requiring verification.',
            truncated: false, review_state: 'none', eligibility: 'governing_eligible',
          },
        ],
        canonical: [], contextual_candidates: [], policy_candidates: [],
      },
      expansions: [
        {
          reason: 'verify_authority',
          source: { kind: 'memory', id: 110, project_id: 'fixture-alpha' },
          expected_version: null,
          route_available: true,
          access_tracking: 'touches_access_counters',
          route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 110, project_id: 'fixture-alpha', include_global: false } },
        },
      ],
    }),
  },
  {
    tool: 'memory_read',
    args: { project_id: 'fixture-alpha', operation: 'get', id: 110 },
    response_envelope: { ok: true, operation: 'get', touched: true, memory: { id: 110, version: 2, project_id: 'fixture-alpha' } },
  },
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', query: 'inspect source 110' },
    response_envelope: compactBootstrapEnvelope('fixture-alpha', false, {
      orientation: { status: 'partial', requires_expansion: true, task_state: 'not_requested', applicability: 'reviewed' },
      guidance: {
        governing_candidates: [
          {
            id: 110, project_id: 'fixture-alpha', layer: 'semantic', category: 'source', title: 'Revised source',
            status: 'active', lifecycle: 'permanent', preview: 'Source requiring verification.',
            truncated: false, review_state: 'none', eligibility: 'governing_eligible',
          },
        ],
        canonical: [], contextual_candidates: [], policy_candidates: [],
      },
      expansions: [
        {
          reason: 'verify_authority',
          source: { kind: 'memory', id: 110, project_id: 'fixture-alpha' },
          expected_version: null,
          route_available: true,
          access_tracking: 'touches_access_counters',
          route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 110, project_id: 'fixture-alpha', include_global: false } },
        },
      ],
    }),
  },
];

const PD07_CONTROL = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', canonical_ids: [111, 112, 113], query: 'current decision and its history' },
    response_envelope: legacyBootstrapEnvelope('fixture-alpha', false, {
      canonical_snapshot: {
        requested_ids: [111, 112, 113],
        unresolved_or_out_of_scope_ids: [],
        content_included: false,
        records: [
          { id: 111, project_id: 'fixture-alpha', content: 'Current decision.', summary: 'Current decision.', status: 'active', lifecycle: 'permanent', confidence: 1, importance_score: 1, updated_at: '2026-09-08T00:00:00Z' },
          { id: 112, project_id: 'fixture-alpha', content: 'Prior decision.', summary: 'Prior decision.', status: 'superseded', lifecycle: 'milestone', confidence: 1, importance_score: 1, updated_at: '2026-09-08T00:00:00Z' },
          { id: 113, project_id: 'fixture-alpha', content: 'Early exploration.', summary: 'Early exploration.', status: 'archived', lifecycle: 'milestone', confidence: 1, importance_score: 1, updated_at: '2026-09-08T00:00:00Z' },
        ],
      },
    }),
  },
  {
    tool: 'memory_search',
    args: { query: 'history', project_id: 'fixture-alpha' },
    response_envelope: { access_tracking: 'none', results: [{ id: 112 }, { id: 113 }] },
  },
];

const PD07_CANDIDATE = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', canonical_ids: [111, 112, 113], query: 'current decision and its history' },
    response_envelope: compactBootstrapEnvelope('fixture-alpha', false, {
      orientation: { status: 'partial', requires_expansion: true, task_state: 'not_requested', applicability: 'reviewed' },
      guidance: {
        canonical: [
          { id: 111, project_id: 'fixture-alpha', layer: 'semantic', category: 'decision', title: 'Current decision', status: 'active', lifecycle: 'permanent', preview: 'Current decision.', truncated: false, review_state: 'none', eligibility: 'governing_eligible' },
          { id: 112, project_id: 'fixture-alpha', layer: 'semantic', category: 'decision', title: 'Prior decision', status: 'superseded', lifecycle: 'milestone', preview: 'Prior decision.', truncated: false, review_state: 'none', eligibility: 'contextual_ineligible' },
          { id: 113, project_id: 'fixture-alpha', layer: 'semantic', category: 'decision', title: 'Early exploration', status: 'archived', lifecycle: 'milestone', preview: 'Early exploration.', truncated: false, review_state: 'none', eligibility: 'contextual_ineligible' },
        ],
        governing_candidates: [], contextual_candidates: [], policy_candidates: [],
      },
      expansions: [
        { reason: 'history_requested', source: { kind: 'memory', id: 112, project_id: 'fixture-alpha' }, expected_version: null, route_available: true, access_tracking: 'touches_access_counters', route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 112, project_id: 'fixture-alpha', include_global: false } } },
        { reason: 'history_requested', source: { kind: 'memory', id: 113, project_id: 'fixture-alpha' }, expected_version: null, route_available: true, access_tracking: 'touches_access_counters', route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 113, project_id: 'fixture-alpha', include_global: false } } },
      ],
    }),
  },
  {
    tool: 'memory_read',
    args: { operation: 'get', id: 112, project_id: 'fixture-alpha' },
    response_envelope: { ok: true, operation: 'get', touched: true, memory: { id: 112, project_id: 'fixture-alpha', status: 'superseded' } },
  },
  {
    tool: 'memory_read',
    args: { operation: 'get', id: 113, project_id: 'fixture-alpha' },
    response_envelope: { ok: true, operation: 'get', touched: true, memory: { id: 113, project_id: 'fixture-alpha', status: 'archived' } },
  },
];

const PD08_CONTROL = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', canonical_ids: [114, 115], query: 'resume task' },
    response_envelope: legacyBootstrapEnvelope('fixture-alpha', false, {
      canonical_snapshot: {
        requested_ids: [114, 115],
        unresolved_or_out_of_scope_ids: [115],
        content_included: false,
        records: [
          { id: 114, project_id: 'fixture-alpha', content: 'Base orientation remains available.', summary: 'Base orientation remains available.', status: 'active', lifecycle: 'permanent', confidence: 1, importance_score: 1, updated_at: '2026-09-08T00:00:00Z' },
        ],
      },
    }),
  },
  {
    tool: 'memory_search',
    args: { query: 'fallback', project_id: 'fixture-alpha' },
    response_envelope: { access_tracking: 'none', results: [{ id: 114 }] },
  },
];

const PD08_CANDIDATE = [
  {
    tool: 'cognitive_agent_bootstrap',
    args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', canonical_ids: [114, 115], query: 'resume task' },
    response_envelope: compactBootstrapEnvelope('fixture-alpha', false, {
      orientation: { status: 'partial', requires_expansion: true, task_state: 'unavailable', applicability: 'reviewed' },
      guidance: {
        canonical: [
          { id: 114, project_id: 'fixture-alpha', layer: 'episodic', category: 'context', title: 'Base orientation', status: 'active', lifecycle: 'permanent', preview: 'Base orientation remains available.', truncated: false, review_state: 'none', eligibility: 'governing_eligible' },
        ],
        governing_candidates: [], contextual_candidates: [], policy_candidates: [],
      },
      unresolved: ['canonical_source_unavailable:115', 'manifest_invalid'],
      expansions: [
        { reason: 'source_unavailable', source: { kind: 'memory', id: 115, project_id: 'fixture-alpha' }, expected_version: null, route_available: false, access_tracking: 'none' },
      ],
    }),
  },
  {
    tool: 'memory_find',
    args: { operation: 'search', query: 'fallback', project_id: 'fixture-alpha' },
    response_envelope: { access_tracking: 'none', results: [{ id: 114 }] },
  },
];

export const representativeFixtures = [
  { case_id: 'pd-01-ordinary-restart', arm: 'control', intent: 'representative', transcript: PD01_CONTROL },
  { case_id: 'pd-01-ordinary-restart', arm: 'candidate', intent: 'representative', transcript: PD01_CANDIDATE },
  { case_id: 'pd-02-valid-manifest', arm: 'control', intent: 'representative', transcript: PD02_CONTROL },
  { case_id: 'pd-02-valid-manifest', arm: 'candidate', intent: 'representative', transcript: PD02_CANDIDATE },
  { case_id: 'pd-03-fresh-contradiction', arm: 'control', intent: 'representative', transcript: PD03_CONTROL },
  { case_id: 'pd-03-fresh-contradiction', arm: 'candidate', intent: 'representative', transcript: PD03_CANDIDATE },
  { case_id: 'pd-04-long-governing-record', arm: 'control', intent: 'representative', transcript: PD04_CONTROL },
  { case_id: 'pd-04-long-governing-record', arm: 'candidate', intent: 'representative', transcript: PD04_CANDIDATE },
  { case_id: 'pd-05-wrong-project', arm: 'control', intent: 'representative', transcript: PD05_CONTROL },
  { case_id: 'pd-05-wrong-project', arm: 'candidate', intent: 'representative', transcript: PD05_CANDIDATE },
  { case_id: 'pd-06-source-revised', arm: 'control', intent: 'representative', transcript: PD06_CONTROL },
  { case_id: 'pd-06-source-revised', arm: 'candidate', intent: 'representative', transcript: PD06_CANDIDATE },
  { case_id: 'pd-07-history-heavy', arm: 'control', intent: 'representative', transcript: PD07_CONTROL },
  { case_id: 'pd-07-history-heavy', arm: 'candidate', intent: 'representative', transcript: PD07_CANDIDATE },
  { case_id: 'pd-08-degraded-input', arm: 'control', intent: 'representative', transcript: PD08_CONTROL },
  { case_id: 'pd-08-degraded-input', arm: 'candidate', intent: 'representative', transcript: PD08_CANDIDATE },
  { case_id: 'pd-05-wrong-project', arm: 'candidate', intent: 'explicit_global', transcript: PD05_EXPLICIT_GLOBAL },
];

// --- Counterexample transcripts ----------------------------------------------
// Each counterexample carries a violating transcript. The arm-grader must
// return the fixture's declared expected_failure_code.

export const counterexampleFixtures = [
  {
    family: 1,
    case_id: 'pd-02-valid-manifest',
    arm: 'candidate',
    expected_failure_code: 'tool_not_in_profile',
    detection_reason: 'agent_profile_calls_memory_get_instead_of_memory_read',
    transcript: [
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', task_state: PD02_TASK_STATE, query: 'resume parser task' },
        response_envelope: PD02_CANDIDATE[0].response_envelope,
      },
      {
        tool: 'memory_get',
        args: { id: 103 },
        response_envelope: 'memory entry JSON text',
      },
    ],
  },
  {
    family: 2,
    case_id: 'pd-01-ordinary-restart',
    arm: 'candidate',
    expected_failure_code: 'tool_not_in_profile',
    detection_reason: 'agent_profile_calls_sql_or_maintenance_tool',
    transcript: [
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', query: 'where were we' },
        response_envelope: PD01_CANDIDATE[0].response_envelope,
      },
      {
        tool: 'sql_query',
        args: { database: 'memory', query: 'SELECT * FROM memories' },
        response_envelope: { access_tracking: 'none', rows: [] },
      },
    ],
  },
  {
    family: 3,
    case_id: 'pd-05-wrong-project',
    arm: 'candidate',
    expected_failure_code: 'required_call_arg_mismatch',
    detection_reason: 'compact_request_silently_widens_include_global',
    transcript: [
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: true, response_mode: 'compact', canonical_ids: [107, 108, 109], query: 'current implementation' },
        response_envelope: compactBootstrapEnvelope('fixture-alpha', true, {
          orientation: { status: 'complete', requires_expansion: false, task_state: 'not_requested', applicability: 'reviewed' },
          guidance: {
            canonical: [
              { id: 107, project_id: 'fixture-alpha', layer: 'semantic', category: 'implementation', title: 'Allowed source', status: 'active', lifecycle: 'permanent', preview: 'Allowed source.', truncated: false, review_state: 'none', eligibility: 'governing_eligible' },
              { id: 109, project_id: '_global', layer: 'semantic', category: 'implementation', title: 'Global source', status: 'active', lifecycle: 'permanent', preview: 'Global source.', truncated: false, review_state: 'none', eligibility: 'contextual_ineligible' },
            ],
            governing_candidates: [], contextual_candidates: [], policy_candidates: [],
          },
        }),
      },
    ],
  },
  {
    family: 4,
    case_id: 'pd-05-wrong-project',
    arm: 'candidate',
    expected_failure_code: 'expansion_route_unavailable_called',
    detection_reason: 'expansion_calls_route_marked_route_available_false',
    transcript: [
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', canonical_ids: [107, 108, 109], query: 'current implementation' },
        response_envelope: PD05_CANDIDATE[0].response_envelope,
      },
      {
        tool: 'memory_read',
        args: { project_id: 'fixture-alpha', operation: 'get', id: 108 },
        response_envelope: { ok: true, operation: 'get', touched: true, memory: { id: 108, project_id: 'fixture-beta' } },
      },
    ],
  },
  {
    family: 5,
    case_id: 'pd-02-valid-manifest',
    arm: 'candidate',
    expected_failure_code: 'tool_not_in_profile',
    detection_reason: 'expansion_names_tool_absent_from_active_profile',
    transcript: [
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', task_state: PD02_TASK_STATE, query: 'resume parser task' },
        response_envelope: PD02_CANDIDATE[0].response_envelope,
      },
      {
        tool: 'memory_search',
        args: { query: 'parser', project_id: 'fixture-alpha' },
        response_envelope: { access_tracking: 'none', results: [{ id: 103 }] },
      },
    ],
  },
  {
    family: 6,
    case_id: 'pd-02-valid-manifest',
    arm: 'candidate',
    expected_failure_code: 'required_call_response_mismatch',
    detection_reason: 'governing_guidance_used_without_required_verification',
    transcript: [
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', task_state: PD02_TASK_STATE, query: 'resume parser task' },
        response_envelope: compactBootstrapEnvelope('fixture-alpha', false, {
          orientation: { status: 'complete', requires_expansion: false, task_state: 'assembled', applicability: 'reviewed' },
          task: {
            objective: {
              status: 'governing',
              statement: {
                semantic_role: 'objective',
                preview: 'Finish parser',
                lane: 'governing',
                authority: 'adopted_task_orientation_only',
                review_state: 'none',
                sources: [{ kind: 'memory', id: 102, project_id: 'fixture-alpha', version: 1 }],
                truncated: false,
              },
            },
            definition_of_done: { status: 'unresolved' },
            constraints: { status: 'unresolved', items: [] },
            next_action: { status: 'unresolved' },
          },
        }),
      },
    ],
  },
  {
    family: 7,
    case_id: 'pd-01-ordinary-restart',
    arm: 'candidate',
    expected_failure_code: 'retry_count_exceeded',
    detection_reason: 'unsupported_response_mode_retried_more_than_once',
    transcript: [
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', query: 'where were we' },
        response_envelope: { error: 'response_mode=compact not supported', mutation: { database_writes: 0, events_appended: 0, access_tracking: 'not_touched', receipt_persistence: 'none' } },
      },
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, query: 'where were we' },
        response_envelope: legacyBootstrapEnvelope('fixture-alpha', false),
      },
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, query: 'where were we' },
        response_envelope: legacyBootstrapEnvelope('fixture-alpha', false),
      },
    ],
  },
  {
    family: 8,
    case_id: 'pd-04-long-governing-record',
    arm: 'candidate',
    expected_failure_code: 'access_tracking_lie',
    detection_reason: 'access_tracking_expansion_described_as_zero_touch',
    transcript: [
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', canonical_ids: [106], include_canonical_content: true, query: 'load operating constraints' },
        response_envelope: {
          ...structuredClone(PD04_CANDIDATE[0].response_envelope),
          expansions: PD04_CANDIDATE[0].response_envelope.expansions.map((entry) => ({ ...structuredClone(entry), access_tracking: 'none' })),
        },
      },
      {
        tool: 'memory_read',
        args: { project_id: 'fixture-alpha',  operation: 'get', id: 106 },
        response_envelope: { ok: true, operation: 'get', touched: true, memory: { id: 106, project_id: 'fixture-alpha' } },
      },
    ],
  },
  {
    family: 9,
    case_id: 'pd-06-source-revised',
    arm: 'candidate',
    expected_failure_code: 'pd06_version_mismatch_fabrication',
    detection_reason: 'pd06_fabricates_version_mismatch_without_evidence',
    transcript: [
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', query: 'inspect source 110' },
        response_envelope: compactBootstrapEnvelope('fixture-alpha', false, {
          orientation: { status: 'partial', requires_expansion: true, task_state: 'not_requested', applicability: 'review_due' },
          expansions: [
            { reason: 'version_mismatch', source: { kind: 'memory', id: 110, project_id: 'fixture-alpha' }, expected_version: '1', route_available: true, access_tracking: 'touches_access_counters', route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 110, project_id: 'fixture-alpha', include_global: false } } },
          ],
          unresolved: ['refresh_required'],
        }),
      },
    ],
  },
  {
    family: 10,
    case_id: 'pd-04-long-governing-record',
    arm: 'candidate',
    expected_failure_code: 'required_call_missing',
    detection_reason: 'final_answer_correct_but_required_expansion_never_called',
    transcript: [
      {
        tool: 'cognitive_agent_bootstrap',
        args: { project_id: 'fixture-alpha', include_global: false, response_mode: 'compact', canonical_ids: [106], include_canonical_content: true, query: 'load operating constraints' },
        response_envelope: PD04_CANDIDATE[0].response_envelope,
      },
    ],
  },
];

// Convenience exports.

export function representativeByCaseArm(caseId, arm) {
  return representativeFixtures.find((entry) => entry.case_id === caseId && entry.arm === arm);
}

export function explicitGlobalSubfixture() {
  return representativeFixtures.find((entry) => entry.intent === 'explicit_global');
}

export function counterexamplesByCaseArm(caseId, arm) {
  return counterexampleFixtures.filter((entry) => entry.case_id === caseId && entry.arm === arm);
}
