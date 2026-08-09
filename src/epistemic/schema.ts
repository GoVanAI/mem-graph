import { z } from 'zod';
import {
  ASSERTION_KINDS,
  AUTHORITIES,
  CONFIDENCE_BANDS,
  CONFIDENCE_BASIS_CODES,
  EPISTEMIC_TYPES,
  RECORD_STATUSES,
  RELATION_TYPES,
} from './types.js';

const nonBlank = (label: string) =>
  z.string().refine((value) => value.trim().length > 0, `${label} must be non-empty after trimming`);
const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/, 'must be an opaque v0.3 ID');
const isoTimestamp = z.iso.datetime({ offset: true });

export const EpistemicScopeSchema = z.object({
  workspace: nonBlank('workspace').optional(),
  project: nonBlank('project').optional(),
  thread: nonBlank('thread').optional(),
  task: nonBlank('task').optional(),
  subject: nonBlank('subject').optional(),
  valid_from: isoTimestamp.optional(),
  valid_until: isoTimestamp.optional(),
}).strict();

export const ProvenanceRefSchema = z.object({
  source_type: z.enum([
    'operator_statement', 'document', 'repository', 'tool_result', 'execution_audit', 'experiment', 'public_source', 'synthetic_fixture',
  ]),
  source_ref: nonBlank('source_ref'),
  observed_at: isoTimestamp,
  excerpt_hash: nonBlank('excerpt_hash').optional(),
  actor: nonBlank('actor').optional(),
}).strict();

export const CalibratedConfidenceSchema = z.object({
  score: z.number().finite().min(0).max(1),
  band: z.enum(CONFIDENCE_BANDS),
  basis: z.array(z.enum(CONFIDENCE_BASIS_CODES)).min(1),
  rationale: nonBlank('confidence rationale'),
}).strict();

export const EpistemicRelationSchema = z.object({
  type: z.enum(RELATION_TYPES),
  target_id: opaqueId,
  rationale: nonBlank('relation rationale').optional(),
}).strict();

export const EpistemicRecordSchema = z.object({
  schema_version: z.literal('0.3'),
  id: opaqueId,
  type: z.enum(EPISTEMIC_TYPES),
  assertion_kind: z.enum(ASSERTION_KINDS),
  statement: nonBlank('statement'),
  scope: EpistemicScopeSchema,
  provenance: z.array(ProvenanceRefSchema),
  confidence: CalibratedConfidenceSchema,
  status: z.enum(RECORD_STATUSES),
  authority: z.enum(AUTHORITIES),
  conditions: z.array(nonBlank('condition')).optional(),
  relations: z.array(EpistemicRelationSchema),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
}).strict();

export const PrimeReferenceSchema = z.object({ id: opaqueId, reason: nonBlank('prime reason') }).strict();

export const CompactPrimeSchema = z.object({
  schema_version: z.literal('0.3'),
  generated_at: isoTimestamp,
  query: nonBlank('query'),
  scope: EpistemicScopeSchema,
  current_focus: nonBlank('current_focus'),
  record_refs: z.array(PrimeReferenceSchema).max(8),
  contradiction_refs: z.array(PrimeReferenceSchema).max(4),
  open_question_refs: z.array(PrimeReferenceSchema).max(3),
  recommended_action_refs: z.array(PrimeReferenceSchema).max(3),
  exclusions: z.array(z.object({ id: opaqueId, reason: nonBlank('exclusion reason') }).strict()),
  audit: z.object({
    candidate_count: z.number().int().min(0),
    eligible_count: z.number().int().min(0),
    included_count: z.number().int().min(0),
    contradiction_count: z.number().int().min(0),
    mutation: z.literal('none'),
  }).strict(),
}).strict();

export const AssessmentSchema = z.object({
  schema_version: z.literal('0.3'),
  assessment_id: opaqueId,
  assigned_stance: nonBlank('assigned_stance'),
  scope: EpistemicScopeSchema,
  conclusion: nonBlank('conclusion'),
  confidence: CalibratedConfidenceSchema,
  supporting_record_refs: z.array(opaqueId),
  counterbelief_refs: z.array(opaqueId),
  decisive_missing_evidence: z.array(nonBlank('decisive_missing_evidence')),
  proposed_actions: z.array(nonBlank('proposed_action')).max(3),
}).strict();

export const SynthesisArtifactSchema = z.object({
  schema_version: z.literal('0.3'),
  synthesis_id: opaqueId,
  scope: EpistemicScopeSchema,
  assessment_refs: z.array(opaqueId),
  shared_observations: z.array(nonBlank('shared_observation')),
  genuine_disagreements: z.array(nonBlank('genuine_disagreement')),
  decisive_missing_evidence: z.array(nonBlank('decisive_missing_evidence')),
  candidate_decision: nonBlank('candidate_decision'),
  candidate_decision_status: z.literal('proposed'),
  confidence: CalibratedConfidenceSchema,
  next_actions: z.array(nonBlank('next_action')).max(3),
}).strict();
