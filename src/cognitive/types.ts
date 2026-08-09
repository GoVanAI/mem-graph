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
    version: '1.0.0';
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
