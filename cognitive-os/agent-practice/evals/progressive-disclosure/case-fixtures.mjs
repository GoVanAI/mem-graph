// Representative compact envelopes for the eight Step 3 cases.
// Each fixture is a JS value that the projector would emit when the corresponding
// case is run end-to-end. The fixtures are deliberately self-consistent so the
// case predicates can prove their intended outcomes mechanically; this file
// does not import or call the projector.

export const PD01_ORDINARY_RESTART = {
  disclosure_version: '1.0.0',
  response_mode: 'compact',
  profile: 'agent',
  scope: {
    project_id: 'fixture-alpha',
    include_global: false,
    global_inclusion: 'disabled',
  },
  orientation: {
    status: 'partial',
    requires_expansion: false,
    task_state: 'not_requested',
    applicability: 'unknown',
  },
  task: {
    objective: { status: 'unresolved', reason: 'no manifest supplied' },
    definition_of_done: { status: 'unresolved', reason: 'no manifest supplied' },
    constraints: { status: 'unresolved', reason: 'no manifest supplied', items: [] },
    next_action: { status: 'unresolved', reason: 'no manifest supplied' },
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
  unresolved: ['objective', 'definition_of_done', 'next_action'],
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
  verification: { required: true, authority_notice: 'unresolved slots require manifest', adoption_status: 'not_applicable' },
  mutation: { database_writes: 0, events_appended: 0, access_tracking: 'not_touched', receipt_persistence: 'none' },
  budget: { limit_bytes: 8192, serialized_bytes: 1024, within_budget: true },
  compact_digest: '0'.repeat(64),
};

export const PD02_VALID_MANIFEST = {
  disclosure_version: '1.0.0',
  response_mode: 'compact',
  profile: 'agent',
  scope: {
    project_id: 'fixture-alpha',
    include_global: false,
    global_inclusion: 'disabled',
  },
  orientation: {
    status: 'partial',
    requires_expansion: true,
    task_state: 'assembled',
    applicability: 'reviewed',
  },
  task: {
    objective: {
      status: 'governing',
      statement: {
        semantic_role: 'objective',
        preview: 'Finish parser',
        lane: 'governing',
        authority: 'adopted_task_orientation_only',
        review_state: 'none',
        sources: [{ id: 102, project_id: 'fixture-alpha', version: 1 }],
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
        sources: [{ id: 102, project_id: 'fixture-alpha', version: 1 }],
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
          sources: [{ id: 102, project_id: 'fixture-alpha', version: 1 }],
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
        sources: [{ id: 102, project_id: 'fixture-alpha', version: 1 }],
        truncated: false,
      },
    },
  },
  guidance: {
    canonical: [],
    governing_candidates: [
      { id: 103, project_id: 'fixture-alpha', status: 'active', title: 'Parser decision', preview: 'Keep parsing deterministic.', version: 1 },
    ],
    contextual_candidates: [],
    policy_candidates: [],
  },
  state: {
    current: [
      {
        semantic_role: 'current_state',
        preview: 'Parser work in progress.',
        lane: 'current_state',
        authority: 'adopted_task_orientation_only',
        review_state: 'none',
        sources: [{ id: 103, project_id: 'fixture-alpha', version: 1 }],
        truncated: false,
      },
    ],
    open: [],
    evidence: [],
    context_only: [],
  },
  warnings: [],
  unresolved: [],
  expansions: [
    {
      reason: 'verify_authority',
      source: { id: 102, project_id: 'fixture-alpha', version: 1 },
      expected_version: 1,
      route_available: true,
      access_tracking: 'touches_access_counters',
      route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 102, project_id: 'fixture-alpha' } },
    },
  ],
  omissions: {
    previews_truncated: 0,
    items_omitted: 0,
    content_bytes_omitted: null,
    required_content_omitted: false,
  },
  source_snapshot: {
    bootstrap_digest: 'placeholder',
    task_state_envelope_digest: 'placeholder',
    task_state_packet_digest: 'placeholder',
  },
  verification: { required: true, authority_notice: 'manifest items adopted', adoption_status: 'verified' },
  mutation: { database_writes: 0, events_appended: 0, access_tracking: 'not_touched', receipt_persistence: 'none' },
  budget: { limit_bytes: 8192, serialized_bytes: 4096, within_budget: true },
  compact_digest: '0'.repeat(64),
};

export const PD03_FRESH_CONTRADICTION = {
  disclosure_version: '1.0.0',
  response_mode: 'compact',
  profile: 'agent',
  scope: {
    project_id: 'fixture-alpha',
    include_global: false,
    global_inclusion: 'disabled',
  },
  orientation: {
    status: 'partial',
    requires_expansion: true,
    task_state: 'not_requested',
    applicability: 'review_due',
  },
  task: {
    objective: { status: 'unresolved' },
    definition_of_done: { status: 'unresolved' },
    constraints: { status: 'unresolved', items: [] },
    next_action: { status: 'unresolved' },
  },
  guidance: {
    canonical: [],
    governing_candidates: [
      { id: 104, project_id: 'fixture-alpha', status: 'active', title: 'Deployment target', preview: 'Use target A.', version: 2, review_state: 'contradiction_review_required' },
    ],
    contextual_candidates: [
      { id: 105, project_id: 'fixture-alpha', status: 'active', preview: 'Target A was retired yesterday.' },
    ],
    policy_candidates: [],
  },
  state: {
    current: [],
    open: [],
    evidence: [],
    context_only: [],
  },
  warnings: ['explicit_contradiction_present'],
  unresolved: ['contradiction_review_required'],
  expansions: [
    {
      reason: 'contradiction_requires_review',
      source: { id: 104, project_id: 'fixture-alpha', version: 2 },
      expected_version: 2,
      route_available: true,
      access_tracking: 'touches_access_counters',
      route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 104, project_id: 'fixture-alpha' } },
    },
  ],
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
  verification: { required: true, authority_notice: 'contradiction requires review before adoption', adoption_status: 'unverified' },
  mutation: { database_writes: 0, events_appended: 0, access_tracking: 'not_touched', receipt_persistence: 'none' },
  budget: { limit_bytes: 8192, serialized_bytes: 3072, within_budget: true },
  compact_digest: '0'.repeat(64),
};

export const PD04_LONG_GOVERNING_RECORD = {
  disclosure_version: '1.0.0',
  response_mode: 'compact',
  profile: 'agent',
  scope: {
    project_id: 'fixture-alpha',
    include_global: false,
    global_inclusion: 'disabled',
  },
  orientation: {
    status: 'partial',
    requires_expansion: true,
    task_state: 'not_requested',
    applicability: 'reviewed',
  },
  task: {
    objective: { status: 'unresolved' },
    definition_of_done: { status: 'unresolved' },
    constraints: { status: 'unresolved', items: [] },
    next_action: { status: 'unresolved' },
  },
  guidance: {
    canonical: [
      { id: 106, project_id: 'fixture-alpha', status: 'active', title: 'Long operating contract', preview: 'A bounded preview.', version: 4 },
    ],
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
  warnings: ['long_source_truncated'],
  unresolved: [],
  expansions: [
    {
      reason: 'content_omitted',
      source: { id: 106, project_id: 'fixture-alpha', version: 4 },
      expected_version: 4,
      route_available: true,
      access_tracking: 'touches_access_counters',
      route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 106, project_id: 'fixture-alpha' } },
    },
  ],
  omissions: {
    previews_truncated: 1,
    items_omitted: 0,
    content_bytes_omitted: 11982,
    required_content_omitted: false,
  },
  source_snapshot: {
    bootstrap_digest: 'placeholder',
    task_state_envelope_digest: null,
    task_state_packet_digest: null,
  },
  verification: { required: true, authority_notice: 'long source requires expansion', adoption_status: 'verified' },
  mutation: { database_writes: 0, events_appended: 0, access_tracking: 'not_touched', receipt_persistence: 'none' },
  budget: { limit_bytes: 8192, serialized_bytes: 4096, within_budget: true },
  compact_digest: '0'.repeat(64),
};

export const PD05_WRONG_PROJECT = {
  disclosure_version: '1.0.0',
  response_mode: 'compact',
  profile: 'agent',
  scope: {
    project_id: 'fixture-alpha',
    include_global: false,
    global_inclusion: 'disabled',
  },
  orientation: {
    status: 'partial',
    requires_expansion: true,
    task_state: 'not_requested',
    applicability: 'reviewed',
  },
  task: {
    objective: { status: 'unresolved' },
    definition_of_done: { status: 'unresolved' },
    constraints: { status: 'unresolved', items: [] },
    next_action: { status: 'unresolved' },
  },
  guidance: {
    canonical: [
      { id: 107, project_id: 'fixture-alpha', status: 'active', preview: 'Allowed source.' },
    ],
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
  unresolved: ['canonical_source_unavailable:108', 'canonical_source_unavailable:109'],
  expansions: [
    {
      reason: 'source_unavailable',
      source: { id: 108, project_id: 'fixture-alpha' },
      expected_version: null,
      route_available: false,
      access_tracking: 'none',
    },
    {
      reason: 'source_unavailable',
      source: { id: 109, project_id: 'fixture-alpha' },
      expected_version: null,
      route_available: false,
      access_tracking: 'none',
    },
  ],
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
  verification: { required: true, authority_notice: 'scope fence enforced; 108/109 suppressed', adoption_status: 'verified' },
  mutation: { database_writes: 0, events_appended: 0, access_tracking: 'not_touched', receipt_persistence: 'none' },
  budget: { limit_bytes: 8192, serialized_bytes: 2048, within_budget: true },
  compact_digest: '0'.repeat(64),
};

export const PD06_SOURCE_REVISED = {
  disclosure_version: '1.0.0',
  response_mode: 'compact',
  profile: 'agent',
  scope: {
    project_id: 'fixture-alpha',
    include_global: false,
    global_inclusion: 'disabled',
  },
  orientation: {
    status: 'partial',
    requires_expansion: true,
    task_state: 'not_requested',
    applicability: 'review_due',
  },
  task: {
    objective: { status: 'unresolved' },
    definition_of_done: { status: 'unresolved' },
    constraints: { status: 'unresolved', items: [] },
    next_action: { status: 'unresolved' },
  },
  guidance: {
    canonical: [],
    governing_candidates: [
      { id: 110, project_id: 'fixture-alpha', status: 'active', title: 'Source', preview: 'The source changed before expansion.', version: 2 },
    ],
    contextual_candidates: [],
    policy_candidates: [],
  },
  state: {
    current: [],
    open: [],
    evidence: [],
    context_only: [],
  },
  warnings: ['version_drift_detected'],
  unresolved: ['refresh_required'],
  expansions: [
    {
      reason: 'version_mismatch',
      source: { id: 110, project_id: 'fixture-alpha', version: 1 },
      expected_version: 2,
      route_available: true,
      access_tracking: 'none',
      route: { tool: 'cognitive_agent_bootstrap', arguments: { query: 'inspect source 110', project_id: 'fixture-alpha', include_global: false, response_mode: 'compact' } },
    },
  ],
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
  verification: { required: true, authority_notice: 'mixed snapshot rejected; refresh orientation', adoption_status: 'unverified' },
  mutation: { database_writes: 0, events_appended: 0, access_tracking: 'not_touched', receipt_persistence: 'none' },
  budget: { limit_bytes: 8192, serialized_bytes: 2048, within_budget: true },
  compact_digest: '0'.repeat(64),
};

export const PD07_HISTORY_HEAVY = {
  disclosure_version: '1.0.0',
  response_mode: 'compact',
  profile: 'agent',
  scope: {
    project_id: 'fixture-alpha',
    include_global: false,
    global_inclusion: 'disabled',
  },
  orientation: {
    status: 'partial',
    requires_expansion: true,
    task_state: 'not_requested',
    applicability: 'reviewed',
  },
  task: {
    objective: { status: 'unresolved' },
    definition_of_done: { status: 'unresolved' },
    constraints: { status: 'unresolved', items: [] },
    next_action: { status: 'unresolved' },
  },
  guidance: {
    canonical: [
      { id: 111, project_id: 'fixture-alpha', status: 'active', title: 'Current decision', preview: 'Current decision.' },
      { id: 112, project_id: 'fixture-alpha', status: 'superseded', title: 'Prior decision', preview: 'Prior decision.' },
      { id: 113, project_id: 'fixture-alpha', status: 'archived', title: 'Early exploration', preview: 'Early exploration.' },
    ],
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
  expansions: [
    {
      reason: 'history_requested',
      source: { id: 112, project_id: 'fixture-alpha', status: 'superseded' },
      expected_version: null,
      route_available: true,
      access_tracking: 'touches_access_counters',
      route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 112, project_id: 'fixture-alpha' } },
    },
    {
      reason: 'history_requested',
      source: { id: 113, project_id: 'fixture-alpha', status: 'archived' },
      expected_version: null,
      route_available: true,
      access_tracking: 'touches_access_counters',
      route: { tool: 'memory_read', operation: 'get', arguments: { operation: 'get', id: 113, project_id: 'fixture-alpha' } },
    },
  ],
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
  verification: { required: true, authority_notice: 'history available via expansion', adoption_status: 'verified' },
  mutation: { database_writes: 0, events_appended: 0, access_tracking: 'not_touched', receipt_persistence: 'none' },
  budget: { limit_bytes: 8192, serialized_bytes: 4096, within_budget: true },
  compact_digest: '0'.repeat(64),
};

export const PD08_DEGRADED_INPUT = {
  disclosure_version: '1.0.0',
  response_mode: 'compact',
  profile: 'agent',
  scope: {
    project_id: 'fixture-alpha',
    include_global: false,
    global_inclusion: 'disabled',
  },
  orientation: {
    status: 'partial',
    requires_expansion: true,
    task_state: 'unavailable',
    applicability: 'reviewed',
  },
  task: {
    objective: { status: 'unresolved', reason: 'manifest malformed' },
    definition_of_done: { status: 'unresolved', reason: 'manifest malformed' },
    constraints: { status: 'unresolved', reason: 'manifest malformed', items: [] },
    next_action: { status: 'unresolved', reason: 'manifest malformed' },
  },
  guidance: {
    canonical: [
      { id: 114, project_id: 'fixture-alpha', status: 'active', preview: 'Base orientation remains available.' },
    ],
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
  unresolved: ['canonical_source_unavailable:115', 'manifest_invalid'],
  expansions: [
    {
      reason: 'source_unavailable',
      source: { id: 115, project_id: 'fixture-alpha' },
      expected_version: null,
      route_available: false,
      access_tracking: 'none',
    },
  ],
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
  verification: { required: true, authority_notice: 'manifest malformed; base orientation preserved', adoption_status: 'unverified' },
  mutation: { database_writes: 0, events_appended: 0, access_tracking: 'not_touched', receipt_persistence: 'none' },
  budget: { limit_bytes: 8192, serialized_bytes: 3072, within_budget: true },
  compact_digest: '0'.repeat(64),
};

// Counterexample envelopes: each is a minimal perturbation that should make
// the corresponding case fail. The counterexamples are intended to be
// representative of the failure modes the predicates are designed to detect.
export const COUNTEREXAMPLES = {
  'pd-01-ordinary-restart': {
    ...PD01_ORDINARY_RESTART,
    task: {
      ...PD01_ORDINARY_RESTART.task,
      objective: { status: 'governing', statement: { preview: 'invented', lane: 'governing', authority: 'governing_candidate_unverified', review_state: 'none', sources: [], truncated: false } },
    },
  },
  'pd-02-valid-manifest': {
    ...PD02_VALID_MANIFEST,
    task: {
      ...PD02_VALID_MANIFEST.task,
      objective: { status: 'unresolved' },
    },
  },
  'pd-03-fresh-contradiction': {
    ...PD03_FRESH_CONTRADICTION,
    guidance: {
      ...PD03_FRESH_CONTRADICTION.guidance,
      governing_candidates: PD03_FRESH_CONTRADICTION.guidance.governing_candidates.map((candidate) => ({
        ...candidate,
        review_state: 'none',
      })),
    },
  },
  'pd-04-long-governing-record': {
    ...PD04_LONG_GOVERNING_RECORD,
    omissions: { ...PD04_LONG_GOVERNING_RECORD.omissions, content_bytes_omitted: null, required_content_omitted: false },
  },
  'pd-05-wrong-project': {
    // Counterexample: foreign record 108 leaked into the hydrated canonical lane.
    ...PD05_WRONG_PROJECT,
    guidance: {
      ...PD05_WRONG_PROJECT.guidance,
      canonical: [
        ...PD05_WRONG_PROJECT.guidance.canonical,
        { id: 108, project_id: 'fixture-beta', status: 'active', preview: 'Foreign source.' },
      ],
    },
  },
  'pd-06-source-revised': {
    ...PD06_SOURCE_REVISED,
    expansions: [],
    warnings: ['mixed_snapshot'],
  },
  'pd-07-history-heavy': {
    // Counterexample: superseded history is promoted into governing candidates.
    ...PD07_HISTORY_HEAVY,
    guidance: {
      ...PD07_HISTORY_HEAVY.guidance,
      governing_candidates: [PD07_HISTORY_HEAVY.guidance.canonical[1]],
    },
  },
  'pd-08-degraded-input': {
    // Counterexample: bootstrap fully failed (no base canonical orientation).
    ...PD08_DEGRADED_INPUT,
    orientation: { ...PD08_DEGRADED_INPUT.orientation, status: 'unavailable' },
    guidance: { ...PD08_DEGRADED_INPUT.guidance, canonical: [] },
  },
};

export const ALL_FIXTURES = {
  'pd-01-ordinary-restart': PD01_ORDINARY_RESTART,
  'pd-02-valid-manifest': PD02_VALID_MANIFEST,
  'pd-03-fresh-contradiction': PD03_FRESH_CONTRADICTION,
  'pd-04-long-governing-record': PD04_LONG_GOVERNING_RECORD,
  'pd-05-wrong-project': PD05_WRONG_PROJECT,
  'pd-06-source-revised': PD06_SOURCE_REVISED,
  'pd-07-history-heavy': PD07_HISTORY_HEAVY,
  'pd-08-degraded-input': PD08_DEGRADED_INPUT,
};
