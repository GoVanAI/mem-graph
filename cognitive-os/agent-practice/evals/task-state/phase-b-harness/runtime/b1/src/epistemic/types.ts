/**
 * Pure v0.3 epistemic-domain contracts. These types deliberately have no
 * persistence, MCP, or authority-promotion behavior.
 */
export const EPISTEMIC_TYPES = [
  'observation',
  'evidence',
  'belief',
  'decision',
  'question',
  'action',
  'artifact',
  'policy',
  'preference',
] as const;
export type EpistemicType = (typeof EPISTEMIC_TYPES)[number];

export const ASSERTION_KINDS = [
  'descriptive',
  'predictive',
  'normative',
  'procedural',
  'evaluative',
] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export const RECORD_STATUSES = [
  'proposed',
  'active',
  'conditional',
  'disputed',
  'superseded',
  'rejected',
  'completed',
  'archived',
] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const AUTHORITIES = [
  'informational',
  'advisory',
  'operator_adopted',
  'system_governing',
] as const;
export type Authority = (typeof AUTHORITIES)[number];

export const CONFIDENCE_BANDS = ['low', 'medium', 'high'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const CONFIDENCE_BASIS_CODES = [
  'DIRECT_OPERATOR_STATEMENT',
  'DIRECT_DOCUMENT_OBSERVATION',
  'MULTIPLE_CORROBORATING_SOURCES',
  'SINGLE_SOURCE_REPORT',
  'STRONG_INFERENCE',
  'PLAUSIBLE_INFERENCE',
  'MISSING_DIRECT_EVIDENCE',
  'CONTRADICTED',
] as const;
export type ConfidenceBasisCode = (typeof CONFIDENCE_BASIS_CODES)[number];

export const RELATION_TYPES = [
  'supports',
  'contradicts',
  'refines',
  'supersedes',
  'depends_on',
  'answers',
  'produces',
  'governs',
  'applies_to',
] as const;
export type EpistemicRelationType = (typeof RELATION_TYPES)[number];

export interface EpistemicScope {
  workspace?: string;
  project?: string;
  thread?: string;
  task?: string;
  subject?: string;
  valid_from?: string;
  valid_until?: string;
}

export type ProvenanceSourceType =
  | 'operator_statement'
  | 'document'
  | 'repository'
  | 'tool_result'
  | 'execution_audit'
  | 'experiment'
  | 'public_source'
  | 'synthetic_fixture';

export interface ProvenanceRef {
  source_type: ProvenanceSourceType;
  source_ref: string;
  observed_at: string;
  excerpt_hash?: string;
  actor?: string;
}

export interface CalibratedConfidence {
  score: number;
  band: ConfidenceBand;
  basis: ConfidenceBasisCode[];
  rationale: string;
}

export interface EpistemicRelation {
  type: EpistemicRelationType;
  target_id: string;
  rationale?: string;
}

export interface EpistemicRecord {
  schema_version: '0.3';
  id: string;
  type: EpistemicType;
  assertion_kind: AssertionKind;
  statement: string;
  scope: EpistemicScope;
  provenance: ProvenanceRef[];
  confidence: CalibratedConfidence;
  status: RecordStatus;
  authority: Authority;
  conditions?: string[];
  relations: EpistemicRelation[];
  created_at: string;
  updated_at: string;
}

export interface PrimeReference {
  id: string;
  reason: string;
}

export interface CompactPrime {
  schema_version: '0.3';
  generated_at: string;
  query: string;
  scope: EpistemicScope;
  current_focus: string;
  record_refs: PrimeReference[];
  contradiction_refs: PrimeReference[];
  open_question_refs: PrimeReference[];
  recommended_action_refs: PrimeReference[];
  exclusions: Array<{ id: string; reason: string }>;
  audit: {
    candidate_count: number;
    eligible_count: number;
    included_count: number;
    contradiction_count: number;
    mutation: 'none';
  };
}

export interface Assessment {
  schema_version: '0.3';
  assessment_id: string;
  assigned_stance: string;
  scope: EpistemicScope;
  conclusion: string;
  confidence: CalibratedConfidence;
  supporting_record_refs: string[];
  counterbelief_refs: string[];
  decisive_missing_evidence: string[];
  proposed_actions: string[];
}

export interface SynthesisArtifact {
  schema_version: '0.3';
  synthesis_id: string;
  scope: EpistemicScope;
  assessment_refs: string[];
  shared_observations: string[];
  genuine_disagreements: string[];
  decisive_missing_evidence: string[];
  candidate_decision: string;
  candidate_decision_status: 'proposed';
  confidence: CalibratedConfidence;
  next_actions: string[];
}

export type PrimeMode = 'ordinary' | 'historical' | 'completion';

export interface PrimeLimits {
  records?: number;
  contradictions?: number;
  questions?: number;
  actions?: number;
}

export interface CompilePrimeInput {
  query: string;
  current_focus: string;
  scope: EpistemicScope;
  records: readonly EpistemicRecord[];
  now: string;
  mode?: PrimeMode;
  limits?: PrimeLimits;
  relevance_scorer?: RelevanceScorer;
  /** Authority IDs verified outside this pure kernel. Claims absent here receive no governing rank benefit. */
  verified_authority_ids?: ReadonlySet<string>;
}

export type RelevanceScorer = (query: string, record: EpistemicRecord) => number;

export interface PrimeDebugEntry {
  id: string;
  eligible: boolean;
  total_score?: number;
  relevance?: number;
  scope_specificity?: number;
  recency?: number;
  lifecycle_fitness?: number;
  authority_visibility?: number;
  exclusion_reason?: string;
}

export interface ValidationIssue {
  code: string;
  path: Array<string | number>;
  message: string;
  severity: 'error' | 'warning';
  record_id?: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}

/** A prime result uses `value` (rather than a second `prime` alias) for consistency with validation results. */
export interface CompilePrimeResult {
  ok: boolean;
  value?: CompactPrime;
  issues: ValidationIssue[];
  debug: PrimeDebugEntry[];
}

export interface SynthesizeInput {
  synthesis_id: string;
  scope: EpistemicScope;
  assessments: readonly Assessment[];
  records: readonly EpistemicRecord[];
  shared_observations: string[];
  genuine_disagreements: string[];
  decisive_missing_evidence: string[];
  candidate_decision: string;
  confidence: CalibratedConfidence;
  next_actions: string[];
}

export type SynthesisResult = ValidationResult<SynthesisArtifact>;
