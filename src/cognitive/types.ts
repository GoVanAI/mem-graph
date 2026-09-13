export const COGNITIVE_EVENT_TYPES = [
  'DecisionMade',
  'ExecutionObserved',
  'EvidenceObserved',
  'BeliefRevised',
  'ReflectionProposed',
  'PolicyCandidateCreated',
  'PolicyRetrieved',
  'PolicyEvaluated',
] as const;

export type CognitiveEventType = (typeof COGNITIVE_EVENT_TYPES)[number];

export interface AppendCognitiveEventInput {
  event_type: CognitiveEventType;
  task_id: string;
  project_id: string;
  payload: Record<string, unknown>;
  session_id?: string;
  correlation_id?: string;
  causation_id?: string;
  idempotency_key?: string;
  observed_at?: string;
  /** Override the default schema_version (1 = legacy opaque; 2 = typed contract). */
  schema_version?: 1 | 2;
}

export interface CognitiveEvent {
  sequence: number;
  event_id: string;
  event_type: CognitiveEventType;
  task_id: string;
  project_id: string;
  session_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
  payload: Record<string, unknown>;
  schema_version: number;
  observed_at: string;
  created_at: string;
  previous_hash: string | null;
  event_hash: string;
}

export type PolicyStatus = 'candidate' | 'strengthened' | 'revised' | 'rejected';

export interface CreatePolicyCandidateInput {
  project_id: string;
  title: string;
  statement: string;
  trigger_type: string;
  trigger_value: string;
  action: Record<string, unknown>;
  exclusions: string[];
  verifier: Record<string, unknown>;
  task_id: string;
  session_id?: string;
  idempotency_key?: string;
}

export interface PolicyCandidate {
  policy_id: string;
  project_id: string;
  title: string;
  statement: string;
  trigger_type: string;
  trigger_value: string;
  action: Record<string, unknown>;
  exclusions: string[];
  verifier: Record<string, unknown>;
  status: PolicyStatus;
  evaluation_count: number;
  success_count: number;
  failure_count: number;
  inconclusive_count: number;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export type PolicyEvaluationOutcome = 'succeeded' | 'failed' | 'inconclusive';

export interface EvaluatePolicyInput {
  policy_id: string;
  task_id: string;
  project_id: string;
  outcome: PolicyEvaluationOutcome;
  metrics: Record<string, number | boolean | string | null>;
  guardrail_regression: boolean;
  session_id?: string;
  correlation_id?: string;
  causation_id?: string;
  idempotency_key?: string;
}

export interface StrictGuidanceSearchInput {
  query: string;
  project_id: string;
  limit?: number;
  include_global?: boolean;
  category?: string;
  layer?: 'working' | 'episodic' | 'procedural' | 'semantic' | 'partner';
}

/**
 * The same retrieval controls as strict search, with an additional fixed
 * eligibility predicate. This is intentionally a retrieval classification,
 * not a durable authority or policy-promotion model.
 */
export interface GoverningGuidanceSearchInput extends StrictGuidanceSearchInput {}

export interface StrictGuidanceResult {
  id: number;
  layer: string;
  project_id: string;
  title: string;
  summary: string | null;
  status: 'active';
  lifecycle: string;
  confidence: number;
  importance_score: number;
  adjusted_rank: number;
  snippet: string;
}

export interface GoverningGuidanceResult extends StrictGuidanceResult {
  category: string | null;
  eligibility: 'governing_eligible';
}

export type GuidanceExclusionReason =
  | 'working_layer'
  | 'ephemeral_lifecycle'
  | 'category_not_governing';

export interface ContextualGuidanceResult extends StrictGuidanceResult {
  category: string | null;
  eligibility: 'contextual_ineligible';
  exclusion_reasons: GuidanceExclusionReason[];
}

export interface CurrentGuidanceDiagnostic {
  scope: {
    project_id: string;
    include_global: boolean;
    active_only: true;
    graph_expansion: false;
    candidate_limit: number;
  };
  access_tracking: 'not_touched';
  governing: GoverningGuidanceResult[];
  excluded: ContextualGuidanceResult[];
}

export interface AgentBootstrapInput extends GoverningGuidanceSearchInput {
  /** Explicit records to snapshot without incrementing access counters. */
  canonical_ids?: number[];
  /** Include record bodies in the read-only canonical snapshot. */
  include_canonical_content?: boolean;
  /**
   * Include full excluded-record details (snippets, BM25 ranks, full
   * metadata) in the bootstrap output. Default false: returns only
   * {id, title, exclusion_reasons} per excluded record. Set true for
   * diagnostic / review scenarios. Per mem-graph-upgrade-v1.md §6 (Fix D).
   */
  include_excluded_details?: boolean;
  /**
   * Output mode for bootstrap: 'legacy' (default) returns the full composed
   * payload; 'compact' returns the deterministic <= 8KiB disclosure envelope.
   */
  response_mode?: 'legacy' | 'compact';
}

/** Optional opaque public input. The server validates the manifest manually. */
export interface TaskStateBootstrapRequest {
  project_id: string;
  task_id: string;
  include_global?: boolean;
  manifest: unknown;
  adoption_receipt?: unknown;
}

export interface TaskStateBootstrapEnvelope {
  envelope_version: '1.0.0' | '1.1.0';
  status: 'assembled' | 'unavailable';
  scope: { project_id: string | null; task_id: string | null };
  authority_notice: string;
  reason?: 'invalid_request' | 'manifest_invalid' | 'source_resolution_failed';
  packet?: import('./task-state.js').TaskStatePacket;
  envelope_digest: string;
}

export interface AgentBootstrapCanonicalRecord {
  id: number;
  layer: string;
  project_id: string;
  category: string | null;
  title: string;
  content?: string;
  summary: string | null;
  status: string;
  lifecycle: string;
  confidence: number;
  importance_score: number;
  updated_at: string;
}

export interface AgentBootstrapResult {
  practice: {
    id: 'mem-graph-agent-practice';
    version: '1.1.0';
    status: 'adopted_advisory';
    hard_enforcement: false;
    authority_notice: string;
  };
  scope: {
    project_id: string;
    include_global: boolean;
    global_inclusion: 'disabled' | 'explicit';
  };
  canonical_snapshot: {
    requested_ids: number[];
    unresolved_or_out_of_scope_ids: number[];
    content_included: boolean;
    records: AgentBootstrapCanonicalRecord[];
  };
  policy_lookup: {
    trigger_type: 'request_type';
    trigger_value: 'current_canonical_guidance';
    authority: 'candidate_only';
    candidates: PolicyCandidate[];
  };
  guidance: CurrentGuidanceDiagnostic;
  verification: {
    required: true;
    instruction: string;
  };
  mutation: {
    database_writes: 0;
    events_appended: 0;
    access_tracking: 'not_touched';
    receipt_persistence: 'none';
  };
  bootstrap_digest: string;
}

/**
 * Optional epistemic lane populated by `bootstrapCognitiveAgentWithEpistemicLane`.
 * Surfaces unverified epistemic records (and their maintenance projections)
 * without granting them authority. Unverified claims never enter the
 * governing lane.
 */
export interface EpistemicBootstrapLane {
  scope: {
    project_id: string;
    include_global: boolean;
  };
  records: Array<{
    record_id: number;
    project_id: string;
    scope: string;
    statement: string;
    epistemic_status: string;
    confidence: number;
    valid_from: string;
    ordinary_priming_factor: number;
    review_state: string;
    review_reasons: string[];
  }>;
  total_matched: number;
  returned: number;
  authority_notice: string;
}

export interface AgentPracticeScenario {
  project_id: string;
  include_global?: boolean;
  required_canonical_ids?: number[];
  selected_guidance_ids?: number[];
  authorized_mutation_tools?: string[];
  requires_tracker_update?: boolean;
  tracker_id?: number;
}

export interface AgentPracticeToolCall {
  kind: 'tool_call';
  tool: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

export interface AgentPracticeMessage {
  kind: 'assistant_message';
  text: string;
}

export interface AgentPracticeFileAction {
  kind: 'file_read' | 'file_write';
  path: string;
}

export type AgentPracticeAction =
  | AgentPracticeToolCall
  | AgentPracticeMessage
  | AgentPracticeFileAction;

export interface AgentPracticeTranscript {
  schema_version: '1.0.0';
  scenario_id: string;
  scenario: AgentPracticeScenario;
  actions: AgentPracticeAction[];
  final_response: string;
}

export interface AgentPracticeCheck {
  id: string;
  passed: boolean;
  critical: boolean;
  weight: number;
  detail: string;
}

export interface AgentPracticeGrade {
  rubric_version: '1.0.0';
  scenario_id: string;
  score: number;
  passed: boolean;
  critical_failures: string[];
  checks: AgentPracticeCheck[];
}

// ---------------------------------------------------------------------------
// Compact Context Delivery (Step 3) Types
// ---------------------------------------------------------------------------

export interface TrustedSemanticRoleContext {
  bootstrap_query?: string;
  constraints_declared_empty?: boolean;
  affected_contradiction_sources?: Array<{
    kind: string;
    id?: number;
    record_id?: string | number;
    project_id?: string;
    task_id?: string;
    event_id?: string;
  }>;
  required_content_omitted?: boolean;
  version_mismatches?: Array<{
    source: CompactSourceReference;
    expected_version: string | number | null;
  }>;
}

export type CompactStatementAuthority =
  | 'adopted_task_orientation_only'
  | 'governing_candidate_unverified'
  | 'policy_advisory'
  | 'evidence_only'
  | 'context_only';

export type CompactStatementLane =
  | 'governing'
  | 'current_state'
  | 'open_state'
  | 'evidence'
  | 'context_only';

export type CompactStatementRole =
  | 'objective'
  | 'definition_of_done'
  | 'constraint'
  | 'expected_next_action'
  | 'current_state'
  | 'open_state'
  | 'evidence';

export interface CompactSourceReference {
  kind: 'memory' | 'cognitive_event' | 'epistemic_record' | 'cognitive_policy' | 'artifact' | 'operator_receipt';
  id?: number;
  project_id: string;
  event_id?: string;
  task_id?: string;
  record_id?: string;
  policy_id?: string;
  path?: string;
  receipt_id?: string;
  version?: string | number | null;
  title?: string;
  preview?: string;
  truncated?: boolean;
}

export interface CompactStatement {
  semantic_role?: CompactStatementRole;
  preview: string;
  lane: CompactStatementLane;
  authority: CompactStatementAuthority;
  review_state: 'none' | 'contradiction_review_required';
  sources: CompactSourceReference[];
  truncated: boolean;
}

export interface CompactTaskSlot {
  status: 'governing' | 'context_only' | 'unresolved';
  statement?: CompactStatement;
  reason?: string;
}

export interface CompactMemoryReference {
  id: number;
  project_id: string;
  layer: string;
  category: string | null;
  title: string;
  status: string;
  lifecycle: string;
  preview?: string;
  truncated: boolean;
  review_state: 'none' | 'contradiction_review_required';
  eligibility?: 'governing_eligible' | 'contextual_ineligible';
}

export interface CompactPolicyReference {
  policy_id: string;
  project_id: string;
  title: string;
  status: string;
  authority: 'candidate_only';
  preview?: string;
  truncated: boolean;
}

export interface CompactExpansion {
  reason:
    | 'verify_authority'
    | 'content_omitted'
    | 'history_requested'
    | 'contradiction_requires_review'
    | 'version_mismatch'
    | 'source_unavailable'
    | 'route_unavailable';
  source: CompactSourceReference | null;
  expected_version: string | number | null;
  route_available: boolean;
  access_tracking: 'none' | 'touches_access_counters' | 'unknown';
  route?: {
    tool: string;
    operation?: string;
    arguments: Record<string, unknown>;
  };
}

export interface CompactBootstrapV1 {
  disclosure_version: '1.0.0';
  response_mode: 'compact';
  profile: 'full' | 'agent';

  scope: {
    project_id: string;
    include_global: boolean;
    global_inclusion: 'disabled' | 'explicit';
  };

  orientation: {
    status: 'complete' | 'partial' | 'unavailable';
    requires_expansion: boolean;
    task_state: 'not_requested' | 'assembled' | 'unavailable';
    applicability: 'unknown' | 'review_due' | 'reviewed';
  };

  task: {
    objective: CompactTaskSlot;
    definition_of_done: CompactTaskSlot;
    constraints: {
      status: 'resolved' | 'context_only' | 'unresolved';
      items: CompactStatement[];
      reason?: string;
    };
    next_action: CompactTaskSlot;
  };

  guidance: {
    canonical: CompactMemoryReference[];
    governing_candidates: CompactMemoryReference[];
    contextual_candidates: CompactMemoryReference[];
    policy_candidates: CompactPolicyReference[];
  };

  state: {
    current: CompactStatement[];
    open: CompactStatement[];
    evidence: CompactStatement[];
    context_only: CompactStatement[];
  };

  warnings: string[];
  unresolved: string[];
  expansions: CompactExpansion[];

  omissions: {
    previews_truncated: number;
    items_omitted: number;
    content_bytes_omitted: number | null;
    required_content_omitted: boolean;
  };

  source_snapshot: {
    bootstrap_digest: string;
    task_state_envelope_digest: string | null;
    task_state_packet_digest: string | null;
  };

  verification: {
    required: true;
    authority_notice: string;
    adoption_status: 'not_applicable' | 'verified' | 'unverified';
  };

  mutation: {
    database_writes: 0;
    events_appended: 0;
    access_tracking: 'not_touched';
    receipt_persistence: 'none';
  };

  budget: {
    limit_bytes: number;
    serialized_bytes: number;
    within_budget: boolean;
  };

  compact_digest: string;
}
