# Epistemic Memory Base Layer v0.3 — Implementation Handoff

**Status:** Historical Phase 0 implementation contract; the pure kernel was recovered under operator-authorized Phase A, while runtime and persistence still require separate explicit authorization  
**Audience:** An implementation agent entering the `mem-graph` repository without prior conversation context  
**Target repository:** the repository root containing this document  
**Date:** 2026-08-08  
**Supersedes:** Earlier conversational sketches of the epistemic-memory pattern; it does not supersede repository governance, the Cognitive OS roadmap, or accepted experiment contracts

**Current-governance note (2026-08-09):** MVP-001/MVP-002/MVP-003 gate
language below records the sequencing context in which this handoff was written.
The former milestone tripwire is historical, not an active blocker. Current
authority comes from repository instructions, the deployment's resolved tracker,
and later operator decisions. This handoff still does not authorize persistence,
MCP exposure, hooks, scheduling, or authority promotion.

## 1. Handoff outcome

Implement a domain-neutral epistemic memory layer that helps an agent resume work, start a new thread, or switch projects without treating every stored statement as equally true or equally relevant.

The layer must distinguish what was observed, what supports it, what is currently believed, what was decided, what remains unknown, and what action follows. It must also preserve disagreement and uncertainty instead of compressing them into a falsely certain summary.

The first implementation increment is intentionally limited to pure TypeScript domain logic, validators, compact-prime compilation, neutral synthesis, and clean-room tests. It must not change the database schema, MCP tool surface, existing retrieval behavior, policy authority, or production aliases until the repository's active gates explicitly permit those changes.

The receiving agent should be able to implement that first increment from this document alone, while consulting the repository sources listed in Section 18 for integration constraints.

## 2. Why this exists

Ordinary memory retrieval tends to answer, “What text looks related?” The base layer must answer a more disciplined set of questions:

1. What kind of claim is this?
2. Where did it come from?
3. What scope does it apply to?
4. How confident are we, and why?
5. Is it current, superseded, disputed, or merely proposed?
6. What other records support, contradict, refine, or depend on it?
7. Is it relevant to this prompt without being authoritative for this prompt?

This is a base-layer memory concern, not a feature tied only to QA orchestration. It must work across software design, research, writing, planning, operations, personal preferences, and future workflows.

## 3. Authority and historical constraints

Repository governance outranks this handoff. Before editing code, the implementation agent must read:

- `AGENTS.md`
- `cognitive-os/ROADMAP.md`
- `cognitive-os/experiments/MVP-001-current-guidance-retrieval.md`
- `cognitive-os/experiments/MVP-002-typed-admission-projection-integrity.md`
- Current canonical tracker and scope memories identified by repository guidance
- `git status --short`

At the time of the original handoff:

- MVP-001 remains in live observation.
- The governing eligibility path has been exercised, but causal decision improvement and external outcome improvement are not yet proven.
- MVP-002 is frozen as a contract but remains gated for implementation.
- MVP-003 semantic relations remain a candidate, not an authorized runtime feature.
- No production alias changes are authorized.
- The Cognitive OS is a global cross-project framework; `mem-graph` is the proving ground.
- Cross-project availability does not imply cross-project applicability.

These bullets are historical evidence, not current sequencing. The implementation
agent must resolve current project guidance dynamically. If current repository
instructions, an operator decision, or the resolved tracker conflicts with this
section, the newer governing source wins.

### 3.1 Allowed now: preparatory implementation

Unless newer repository guidance says otherwise, the safe increment is:

- Add isolated TypeScript types and Zod schemas.
- Add pure validation, calibration, compact-prime, and synthesis functions.
- Add clean-room YAML or JSON fixtures.
- Add unit tests for those pure functions.
- Document deferred persistence and MCP mappings.
- Run the full existing test and type-check suite.

### 3.2 Gated: do not implement without explicit authorization

- New SQLite tables, columns, triggers, migrations, or projections.
- Changes to `memories`, `synapses`, FTS, decay, or cognitive event-ledger semantics.
- New or changed MCP tools.
- Automatic memory writes from prompts or sessions.
- Policy promotion, adoption, authority expansion, or alias changes.
- Semantic-relation persistence under MVP-003.
- TypeDB, TypeQL, a general ontology, or a client/server dependency.
- Import or reconstruction of employer-owned prompts, skills, workflows, artifacts, or terminology.

## 4. Clean-room and intellectual-property boundary

This is a hard design and testing constraint:

- Do not request, copy, infer, recreate, or encode proprietary company skills or artifacts.
- Do not use internal company examples, names, tickets, repositories, policies, or distinctive workflow language.
- Use synthetic examples, public documentation, and this document only.
- Treat any conclusion about the user's company workflow as unverified unless independently represented by clean-room public or synthetic evidence.
- Do not make “looks similar to the company system” an acceptance criterion.

Generic concepts such as review, plan, execute, findings, deliverables, approval, and human-in-the-loop are not by themselves proprietary. Tests should nevertheless use neutral examples that cannot be mistaken for reconstructed company IP.

## 5. Core model

An epistemic record is a typed assertion with provenance, scope, confidence, lifecycle state, and explicit relations.

### 5.1 Record types

| Type | Meaning | Typical authority |
|---|---|---|
| `observation` | Something directly seen or measured | Descriptive, never automatically prescriptive |
| `evidence` | A source or result bearing on another assertion | Supports evaluation; does not decide by itself |
| `belief` | A currently held interpretation or model | Revisable and confidence-bearing |
| `decision` | A choice adopted by an authorized actor | Prescriptive only within its stated scope |
| `question` | A material unknown or unresolved issue | Drives investigation, not an implicit negative claim |
| `action` | A proposed, active, completed, or abandoned next step | Operational within scope and status |
| `artifact` | A durable output, specification, report, or receipt | Carries provenance; content authority varies |
| `policy` | A reusable rule governing behavior | Requires explicit adoption before authority |
| `preference` | An operator or team preference | Applies only to the named subject and scope |

### 5.2 Assertion kinds

`assertion_kind` separates the grammatical role of a statement from its epistemic type:

- `descriptive`: what is or was the case
- `predictive`: what is expected to happen
- `normative`: what should happen
- `procedural`: how an action should be performed
- `evaluative`: an assessment against criteria

For example, a `policy` is usually procedural or normative; an `observation` is normally descriptive; a `belief` may be descriptive or predictive.

### 5.3 Lifecycle status

- `proposed`: introduced but not adopted or confirmed
- `active`: currently operative or accepted within scope
- `conditional`: retained only under stated conditions
- `disputed`: materially challenged by another active record
- `superseded`: replaced by a newer canonical record
- `rejected`: explicitly not adopted
- `completed`: action or investigation finished
- `archived`: preserved for history but excluded from ordinary priming

Status must never be inferred from confidence alone. A high-confidence proposal is still a proposal. An active decision can have modest confidence while remaining operative until changed by an authorized actor.

### 5.4 Authority

- `informational`: may inform reasoning but cannot govern behavior
- `advisory`: recommends a course but is not binding
- `operator_adopted`: explicitly adopted by the operator
- `system_governing`: authorized by repository or system governance

Authority is independent of relevance and ranking. A highly relevant observation cannot silently override a governing decision.

## 6. Normative TypeScript contract

The implementation may split these declarations across files, but the semantic contract must remain stable for v0.3.

```ts
export const EPISTEMIC_TYPES = [
  "observation",
  "evidence",
  "belief",
  "decision",
  "question",
  "action",
  "artifact",
  "policy",
  "preference",
] as const;
export type EpistemicType = (typeof EPISTEMIC_TYPES)[number];

export const ASSERTION_KINDS = [
  "descriptive",
  "predictive",
  "normative",
  "procedural",
  "evaluative",
] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export const RECORD_STATUSES = [
  "proposed",
  "active",
  "conditional",
  "disputed",
  "superseded",
  "rejected",
  "completed",
  "archived",
] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const AUTHORITIES = [
  "informational",
  "advisory",
  "operator_adopted",
  "system_governing",
] as const;
export type Authority = (typeof AUTHORITIES)[number];

export const CONFIDENCE_BANDS = ["low", "medium", "high"] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const CONFIDENCE_BASIS_CODES = [
  "DIRECT_OPERATOR_STATEMENT",
  "DIRECT_DOCUMENT_OBSERVATION",
  "MULTIPLE_CORROBORATING_SOURCES",
  "SINGLE_SOURCE_REPORT",
  "STRONG_INFERENCE",
  "PLAUSIBLE_INFERENCE",
  "MISSING_DIRECT_EVIDENCE",
  "CONTRADICTED",
] as const;
export type ConfidenceBasisCode =
  (typeof CONFIDENCE_BASIS_CODES)[number];

export const RELATION_TYPES = [
  "supports",
  "contradicts",
  "refines",
  "supersedes",
  "depends_on",
  "answers",
  "produces",
  "governs",
  "applies_to",
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

export interface ProvenanceRef {
  source_type:
    | "operator_statement"
    | "document"
    | "repository"
    | "tool_result"
    | "execution_audit"
    | "experiment"
    | "public_source"
    | "synthetic_fixture";
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
  schema_version: "0.3";
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
  schema_version: "0.3";
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
    mutation: "none";
  };
}

export interface Assessment {
  schema_version: "0.3";
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
  schema_version: "0.3";
  synthesis_id: string;
  scope: EpistemicScope;
  assessment_refs: string[];
  shared_observations: string[];
  genuine_disagreements: string[];
  decisive_missing_evidence: string[];
  candidate_decision: string;
  candidate_decision_status: "proposed";
  confidence: CalibratedConfidence;
  next_actions: string[];
}
```

`assigned_stance` is an experimental role instruction, not evidence and not authority. An assessment must preserve counterbeliefs as active or conditional records instead of converting them to rejected records merely because the assessment argues the opposite side.

## 7. Validation invariants

Implement these as Zod schemas plus pure semantic checks. Zod already exists in the repository; do not add a validation dependency.

### 7.1 Structural invariants

1. `schema_version` must equal `0.3`.
2. IDs must be non-empty, stable strings. For the preparatory increment, accept opaque IDs matching `^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$`.
3. All timestamps must be valid ISO 8601 strings.
4. `statement`, confidence rationale, prime reasons, and conclusions must be non-empty after trimming.
5. Confidence score must be finite and within `[0, 1]`.
6. Confidence basis must contain at least one unique code.
7. Provenance must contain at least one entry except for a synthetic `question` or `action`; any exception must be documented by a semantic validation warning.
8. Relations must not contain duplicate `(type, target_id)` pairs.
9. A record must not relate to itself using `supersedes`, `contradicts`, or `depends_on`.
10. `updated_at` must not be earlier than `created_at`.

### 7.2 Confidence calibration

The band must be derived from the score:

| Score | Band |
|---|---|
| `0.00–0.54` | `low` |
| `0.55–0.79` | `medium` |
| `0.80–1.00` | `high` |

Additional rules:

- If `MISSING_DIRECT_EVIDENCE` is present, the band cannot be `high`.
- If `CONTRADICTED` is present and no resolution is recorded, the band cannot be `high`.
- `PLAUSIBLE_INFERENCE` alone cannot yield `high` confidence.
- The validator must report a band mismatch; it must not silently rewrite the caller's value.
- Confidence is local to the assertion and current evidence, not a permanent property of the source or actor.

### 7.3 Evidence boundary

Failure to inspect a source is not evidence that the source lacks a feature.

Example:

```yaml
type: observation
statement: The assessment did not inspect the repository source.
provenance:
  - source_type: execution_audit
```

The following is invalid unless separately supported:

```yaml
type: evidence
statement: The repository does not implement the feature.
provenance:
  - source_type: execution_audit
    source_ref: assessment-that-did-not-inspect-source
```

The semantic validator should flag assertions that use an `execution_audit` as sole provenance for claims about the underlying system rather than the execution itself. This can initially be a warning because fully determining subject matter requires semantic interpretation.

### 7.4 Scope and applicability

- Exact project scope is preferred over workspace-wide scope.
- A record from another project may be available but is not applicable unless an explicit `applies_to` relation or governing scope rule permits it.
- A thread-scoped decision must not govern a different thread merely because it is semantically similar.
- `valid_until` in the past makes a record ineligible for ordinary priming unless historical context was requested.
- A missing scope dimension means unspecified, not universal.

### 7.5 Lifecycle and authority

- Only `operator_adopted` or `system_governing` records can be treated as binding.
- A `policy` or `decision` with `proposed` status remains non-binding regardless of authority field.
- `superseded`, `rejected`, and `archived` records are excluded from ordinary prime results but may be included in audit exclusions or historical queries.
- A `disputed` record may be included only with its contradiction lane populated.
- A `supersedes` relation does not mutate or delete the older record.

### 7.6 Reference integrity

When validating a closed artifact bundle:

- Every relation target must resolve to a record in the supplied catalog or be explicitly marked as an external reference by the caller.
- Every compact-prime reference must resolve to an eligible catalog record.
- Every assessment record reference must resolve.
- Every synthesis assessment reference must resolve.
- Duplicate references are invalid.

The preparatory implementation must not assume a database. Accept catalogs as `ReadonlyMap<string, EpistemicRecord>` or equivalent immutable inputs.

## 8. Suggested isolated module layout

The implementation agent must first inspect current files and ownership. If no conflicts exist, use:

```text
src/
  epistemic/
    types.ts
    schema.ts
    validate.ts
    prime.ts
    synthesize.ts
    index.ts
tests/
  epistemic-schema.test.ts
  epistemic-validate.test.ts
  epistemic-prime.test.ts
  epistemic-synthesize.test.ts
  fixtures/
    epistemic/
```

Do not modify currently dirty files merely to re-export this module. An isolated module can be imported directly by tests during the preparatory increment. Add integration exports later only when doing so does not collide with active work.

### 8.1 Responsibilities

- `types.ts`: only stable v0.3 types and constants.
- `schema.ts`: Zod schemas and inferred structural parsing.
- `validate.ts`: semantic validation, bundle integrity, confidence calibration, warnings.
- `prime.ts`: deterministic eligibility, ranking, contradiction selection, and compact references.
- `synthesize.ts`: neutral comparison of opposed assessments.
- `index.ts`: narrow public exports; no MCP registration.

All core functions should accept immutable inputs and return new values. No function in this increment may write memory, update status, promote policy, or mutate the supplied catalog.

## 9. Validator result contract

Use a result that distinguishes parse errors, semantic errors, and non-blocking warnings:

```ts
export interface ValidationIssue {
  code: string;
  path: Array<string | number>;
  message: string;
  severity: "error" | "warning";
  record_id?: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}
```

Recommended stable issue codes:

- `SCHEMA_INVALID`
- `CONFIDENCE_BAND_MISMATCH`
- `CONFIDENCE_BASIS_OVERCLAIM`
- `TIMESTAMP_ORDER_INVALID`
- `DUPLICATE_RELATION`
- `SELF_RELATION_INVALID`
- `REFERENCE_UNRESOLVED`
- `REFERENCE_DUPLICATE`
- `REFERENCE_INELIGIBLE`
- `EXECUTION_AUDIT_OVERCLAIM`
- `BINDING_STATUS_INVALID`
- `DISPUTE_WITHOUT_CONTRADICTION`
- `SCOPE_NOT_APPLICABLE`

Issue ordering must be deterministic: sort by record ID, then path, then code.

## 10. Compact-prime compiler

### 10.1 Purpose

A compact prime is a read-only, bounded orientation packet. It primes an agent with references to canonical records rather than duplicating their full contents. The caller may resolve those references after compilation.

It is not a summary write, a policy decision, or a memory mutation.

### 10.2 Input

```ts
export interface CompilePrimeInput {
  query: string;
  scope: EpistemicScope;
  records: readonly EpistemicRecord[];
  now: string;
  limits?: {
    records?: number;        // default 8, allowed 1–8
    contradictions?: number; // default 4, allowed 1–4
    questions?: number;      // default 3, allowed 0–3
    actions?: number;        // default 3, allowed 0–3
  };
}
```

For v0.3, ranking may accept an injected relevance scorer so the core remains testable and independent of embeddings:

```ts
export type RelevanceScorer = (
  query: string,
  record: EpistemicRecord,
) => number;
```

Provide a deterministic default lexical scorer for tests. Do not add an embedding dependency.

### 10.3 Algorithm

Execute these steps in order and retain exclusion reasons:

1. Parse `now` and validate input limits.
2. Filter out invalid records; report them separately rather than crashing the entire compilation when possible. Record state and provenance later than `now` are invalid, and …468 tokens truncated…anked items.”
- Stable tie-breaker: descending total score, then descending `updated_at`, then ascending ID.

## 11. Neutral adversarial synthesis

### 11.1 Purpose

Two agents may be assigned opposite positions to expose weak assumptions. Their assigned stances are methodological roles, not evidence. Synthesis must compare both artifacts without simply choosing the more confident prose.

### 11.2 Required synthesis sequence

1. Validate both assessments and all referenced records.
2. Identify shared observations supported by both sides.
3. Identify genuine disagreements in conclusion, interpretation, predicted effect, or recommended action.
4. Identify decisive missing evidence: information whose acquisition could change the candidate decision.
5. Check confidence calibration independently for each side.
6. Preserve counterbeliefs and disputed records.
7. Produce one candidate decision with `proposed` status.
8. Produce at most three next actions aimed at resolving the most decision-relevant uncertainty.

### 11.3 Synthesis rules

- Do not average confidence scores mechanically.
- Do not select a side because its assigned stance matches the candidate decision.
- Do not transform absence of inspection into negative evidence.
- Do not mark the losing position `rejected`; maintain it as active, conditional, or disputed according to its source records.
- A candidate decision cannot become operator-adopted through synthesis.
- When decisive evidence is absent, prefer a reversible decision that preserves the current baseline and gathers evidence.

The v0.3 experiment produced two nearly balanced medium-confidence positions and therefore recommended preserving the baseline while gathering decisive evidence. That outcome validates the neutral-synthesis shape; it is not a universal rule to retain the status quo.

## 12. Illustrative clean-room YAML

This example is intentionally generic and does not model any company workflow.

### 12.1 Records

```yaml
records:
  - schema_version: "0.3"
    id: obs.parser.failures.001
    type: observation
    assertion_kind: descriptive
    statement: Three synthetic fixtures fail when a trailing delimiter is present.
    scope:
      workspace: learning-lab
      project: parser-demo
      task: delimiter-investigation
    provenance:
      - source_type: experiment
        source_ref: synthetic-test-run-17
        observed_at: "2026-08-08T16:00:00Z"
    confidence:
      score: 0.95
      band: high
      basis:
        - DIRECT_DOCUMENT_OBSERVATION
      rationale: The failing outputs were directly observed in a synthetic test run.
    status: active
    authority: informational
    relations:
      - type: supports
        target_id: belief.parser.delimiter.001
    created_at: "2026-08-08T16:05:00Z"
    updated_at: "2026-08-08T16:05:00Z"

  - schema_version: "0.3"
    id: belief.parser.delimiter.001
    type: belief
    assertion_kind: descriptive
    statement: The parser likely mishandles an empty terminal token.
    scope:
      workspace: learning-lab
      project: parser-demo
      task: delimiter-investigation
    provenance:
      - source_type: experiment
        source_ref: synthetic-test-run-17
        observed_at: "2026-08-08T16:00:00Z"
    confidence:
      score: 0.68
      band: medium
      basis:
        - STRONG_INFERENCE
        - MISSING_DIRECT_EVIDENCE
      rationale: The failure pattern is consistent, but source inspection is not complete.
    status: active
    authority: informational
    relations:
      - type: depends_on
        target_id: obs.parser.failures.001
      - type: contradicts
        target_id: belief.parser.input-contract.001
    created_at: "2026-08-08T16:10:00Z"
    updated_at: "2026-08-08T16:10:00Z"

  - schema_version: "0.3"
    id: belief.parser.input-contract.001
    type: belief
    assertion_kind: evaluative
    statement: The failing fixtures may violate the documented input contract.
    scope:
      workspace: learning-lab
      project: parser-demo
      task: delimiter-investigation
    provenance:
      - source_type: document
        source_ref: public-parser-demo-spec
        observed_at: "2026-08-08T16:12:00Z"
    confidence:
      score: 0.61
      band: medium
      basis:
        - SINGLE_SOURCE_REPORT
        - PLAUSIBLE_INFERENCE
      rationale: One specification passage suggests trailing delimiters may be invalid.
    status: conditional
    authority: informational
    conditions:
      - The cited specification remains authoritative for the tested version.
    relations:
      - type: contradicts
        target_id: belief.parser.delimiter.001
    created_at: "2026-08-08T16:15:00Z"
    updated_at: "2026-08-08T16:15:00Z"
```

### 12.2 Compact prime

```yaml
schema_version: "0.3"
generated_at: "2026-08-08T16:30:00Z"
query: Determine the next step for the delimiter failures.
scope:
  workspace: learning-lab
  project: parser-demo
  task: delimiter-investigation
current_focus: Determine whether the failure is an implementation defect or invalid input.
record_refs:
  - id: obs.parser.failures.001
    reason: Direct observation of the current failure pattern.
  - id: belief.parser.delimiter.001
    reason: Leading implementation-defect hypothesis in exact task scope.
contradiction_refs:
  - id: belief.parser.input-contract.001
    reason: Active alternative explanation that changes whether code should be modified.
open_question_refs: []
recommended_action_refs: []
exclusions: []
audit:
  candidate_count: 3
  eligible_count: 3
  included_count: 2
  contradiction_count: 1
  mutation: none
```

### 12.3 Neutral synthesis

```yaml
schema_version: "0.3"
synthesis_id: synthesis.parser.delimiter.001
scope:
  workspace: learning-lab
  project: parser-demo
  task: delimiter-investigation
assessment_refs:
  - assessment.fix-parser.001
  - assessment.retain-parser.001
shared_observations:
  - Three synthetic fixtures fail when a trailing delimiter is present.
genuine_disagreements:
  - Whether a trailing delimiter is valid input for the tested version.
decisive_missing_evidence:
  - A version-matched normative input specification.
  - A direct source trace showing terminal-token handling.
candidate_decision: Preserve the parser baseline until the input contract and source path are inspected.
candidate_decision_status: proposed
confidence:
  score: 0.72
  band: medium
  basis:
    - MULTIPLE_CORROBORATING_SOURCES
    - MISSING_DIRECT_EVIDENCE
  rationale: Both assessments agree on the failures, but the normative input contract remains unresolved.
next_actions:
  - Inspect the version-matched input contract.
  - Trace the terminal-token code path.
  - Add one valid and one invalid trailing-delimiter fixture after resolving the contract.
```

## 13. Required tests

Tests must be synthetic and deterministic. At minimum, cover the following.

### 13.1 Schema and semantic validation

- Accept one valid record of every epistemic type.
- Reject scores below zero, above one, `NaN`, and infinities.
- Reject mismatched confidence bands at both threshold edges.
- Prevent `MISSING_DIRECT_EVIDENCE`, `CONTRADICTED`, or lone `PLAUSIBLE_INFERENCE` from supporting a high band.
- Reject malformed timestamps and reversed creation/update order.
- Reject duplicate and invalid self-relations.
- Report unresolved references in a closed bundle.
- Warn on execution-audit overclaim.
- Preserve a high-confidence proposed policy as non-binding.

### 13.2 Scope and eligibility

- Prefer exact task scope over thread, project, and workspace scope.
- Exclude explicit project mismatch.
- Demonstrate that cross-project availability does not imply applicability.
- Exclude expired, superseded, rejected, and archived records from ordinary priming.
- Include disputed material only with a contradiction lane.
- Demonstrate that relevance does not override authority or scope.

### 13.3 Compact prime

- Return no more than 8 primary references.
- Return no more than 4 contradiction references.
- Return no more than 3 actions and 3 questions.
- Resolve every returned ID.
- Use deterministic ordering for ties.
- Record explicit exclusion reasons.
- Return `mutation: none` and leave the input deeply unchanged.
- Retain a lower-ranked contradiction that directly challenges a selected belief.
- Avoid copying full canonical statements into `record_refs.reason`.

### 13.4 Adversarial synthesis

- Compare opposing assessments with shared evidence.
- Preserve both counterbeliefs.
- Identify decisive missing evidence.
- Reject an unresolved assessment reference.
- Produce a proposed—not adopted—candidate decision.
- Produce at most three next actions.
- Avoid mechanical confidence averaging.
- Handle one side that did not inspect source without treating that omission as negative system evidence.

### 13.5 Resume and topic-switch fixtures

Create clean-room fixtures for:

1. New session in the same task: prime active decisions, unresolved questions, and next actions.
2. Resumed session after a decision was superseded: include the new decision and audit-exclude the old one.
3. New topic in the same project: include project preferences but exclude unrelated task beliefs.
4. Same topic name in a different project: prevent cross-project contamination.
5. A disputed research hypothesis: include both sides and missing evidence.

## 14. Acceptance criteria for the preparatory increment

The increment is complete only when all of these are true:

- The new module is isolated and has no side effects.
- v0.3 schemas, semantic validators, compact-prime compiler, and synthesis are implemented.
- All required clean-room tests pass.
- Existing repository tests remain green.
- TypeScript type checking passes.
- `git diff --check` passes.
- No new dependency is added.
- No SQLite schema, migration, cognitive event, retrieval, memory, synapse, FTS, decay, policy, MCP registration, or alias behavior changes.
- No proprietary company material appears in code, fixtures, tests, or documentation.
- The implementation report identifies every changed file and clearly labels deferred integration.

Recommended verification commands from the repository root:

```powershell
npm test
npx tsc --noEmit
git diff --check
git status --short
```

If the full suite already has unrelated failures, do not conceal them. Record the exact baseline failure, run the narrow new tests, and show that the change introduces no additional failure.

## 15. Phased integration plan

### Phase 0 — Pure epistemic kernel

**May proceed when repository governance still matches this handoff.**

Deliver types, schemas, validators, compact-prime compilation, synthesis, fixtures, and tests. Keep inputs and outputs in memory or YAML/JSON. No persistence and no tool exposure.

Phase 0 authority values are untrusted claims. A record is never treated as
binding unless the caller supplies a separately verified authority identity;
schema validity alone cannot prove operator or system adoption. The pure
kernel may classify and validate authority claims, but it cannot grant them.

Phase 0 synthesis is a deterministic validator and assembler for structured
assessment inputs. It does not claim that pure TypeScript can infer genuine
semantic disagreement or decisive missing evidence from arbitrary prose.
Those semantic claims must be supplied explicitly and remain proposed.

The compiler and validators share one fail-closed scope predicate. Every prime
lane and every assessment/synthesis citation is checked against it. Phase 0
does not infer cross-project applicability from prose or an unverified
`applies_to` relation; that exception needs a later explicit representation and
authority contract.

### Phase A — Recovery and publication review

The pure kernel may be recovered, reconciled, verified, and published without
activating it at runtime. Before any later runtime integration:

- Obtain a separate explicit operator decision for the proposed persistence or runtime surface.
- Reconcile the v0.3 domain model with current typed-admission and projection contracts.
- Decide whether epistemic artifacts enter through the cognitive event ledger, remain external experiment artifacts, or use another approved admission route.
- Define versioned migrations, rollback, repair, idempotency, and projection rebuild behavior.

This handoff does not authorize that decision.

### Phase 1 — Typed admission integration

**Requires separate explicit operator authorization.**

If authorized, integrate through an accepted versioned contract with fail-closed
admission, append-only event receipts, deterministic projection, and integrity
checks. Do not retrofit v0.3 by bypassing the event ledger.

The existing `memories` table remains canonical for memory text unless an accepted contract explicitly changes that. Existing cognitive events remain immutable receipts. Do not reinterpret historical rows.

### Gate B — Semantic-relation evidence

Before relation persistence:

- Show a concrete retrieval or reasoning failure that cannot be solved adequately with current primitives.
- Define semantic relation ownership and projection integrity.
- Establish migration, rollback, and repair behavior.
- Obtain explicit operator authorization under an accepted semantic-relation contract.

### Phase 2 — First-class semantic relations

**Not currently authorized.**

Only after Gate B may `supports`, `contradicts`, `supersedes`, and other semantic relations become persisted first-class structures. Existing `synapses` must not be silently reinterpreted as semantic truth; their present meaning and behavior must remain compatible.

### Phase 3 — Alternative database evaluation

TypeDB may remain a design reference for typed roles and constraints. Retain SQLite unless measured evidence shows a material limitation that justifies a sidecar or migration experiment. Do not introduce TypeQL, general inference, or client/server operations as part of v0.3.

## 16. Deferred persistence sketch—not an implementation instruction

If later gates authorize storage, prefer additive, versioned structures whose rows can be reconstructed from immutable admitted events. A future design may include logical projections for:

- epistemic record identity and typed attributes
- provenance references
- semantic relations
- assessment membership
- compact-prime and synthesis receipts

Do not create these tables from this sketch. Names, keys, constraints, event types, repair behavior, and compatibility requirements belong in an accepted experiment contract first.

Similarly, future MCP capabilities might validate an artifact, compile a compact prime, or synthesize assessments. Do not register those tools until schemas, admission behavior, mutation rules, error contracts, and operator approval are frozen.

## 17. Important design distinctions

### 17.1 Canonical memory versus prime

Canonical records contain the assertion and provenance. A compact prime contains IDs and selection reasons. Priming should not create divergent copies of canonical content.

### 17.2 Retrieval rank versus truth

A high retrieval score means “useful for this query,” not “true.” Confidence means “supported to this degree,” not “relevant.” Authority means “allowed to govern,” not “correct.” These dimensions must remain separate.

### 17.3 Availability versus applicability

Global memory makes a record discoverable across projects. Scope and relations determine whether it applies. Never use semantic similarity alone to cross that boundary.

### 17.4 Observation versus inference

Store the directly observed fact separately from the belief inferred from it. Link them with `supports` or `depends_on`. This makes later contradiction and confidence revision possible without rewriting history.

### 17.5 Candidate decision versus adoption

An agent may propose. Only an authorized actor or governing mechanism may adopt. Synthesis always emits a proposed candidate in v0.3.

### 17.6 Semantic relation versus synapse

A current mem-graph synapse is an existing repository primitive. Do not assume it means logical support, contradiction, or entailment. First-class epistemic relations remain logically distinct until an accepted integration contract maps them.

## 18. Repository and experiment references

Consult these in the target repository before implementation:

- `AGENTS.md`
- `README.md`
- `package.json`
- `src/db.ts`
- `src/index.ts`
- `src/cognitive/schema.ts`
- `src/cognitive/types.ts`
- `cognitive-os/ROADMAP.md`
- `cognitive-os/experiments/MVP-001-current-guidance-retrieval.md`
- `cognitive-os/experiments/MVP-002-typed-admission-projection-integrity.md`
- `docs/EPISTEMIC_MEMORY_BASE_LAYER_PROPOSAL.md`

Historical local experiments helped refine v0.3, but they are neither published
dependencies nor required for verification. The normative requirements and
synthetic fixtures needed by another agent are contained in this repository.

## 19. Implementation-agent procedure

1. Read the repository instructions and current roadmap/tracker state.
2. Inspect `git status --short`; preserve all unrelated and pre-existing edits.
3. Confirm current authorization and whether a newer accepted contract supersedes v0.3; do not treat historical milestone gates as current blockers.
4. Inspect existing naming and test conventions.
5. Implement the isolated pure module and clean-room fixtures.
6. Run narrow tests while developing.
7. Run the full verification commands in Section 14.
8. Review the diff for unintended integration or proprietary material.
9. Report changed files, validation evidence, baseline failures if any, and every deferred gated item.
10. Do not update the canonical tracker merely because code was written. Tracker updates require a verified experiment event or an operator-adopted decision under repository governance.

If a required choice would change persistence, public tool contracts, authority, or roadmap ordering, stop and request operator direction rather than inferring authorization.

## 20. Open questions for later versions

These are deliberately unresolved and must not be silently decided during Phase 0:

- Canonical ID generation and collision policy.
- Whether scope needs explicit organization, person, environment, or branch dimensions.
- Bitemporal modeling: assertion validity time versus system-recorded time.
- Alias resolution for projects and subjects.
- Data-classification fields beyond the clean-room boundary in this document.
- Confidence recalibration from downstream outcomes.
- Token-budget-aware prime limits and content resolution.
- Whether contradictions must be symmetric at admission or normalized during projection.
- How operator preference conflicts are scoped and resolved.
- Exact event types and projections under a separately authorized persistence phase.
- Exact semantic relation storage under a separately authorized relation phase.
- Whether a TypeDB sidecar ever earns its operational cost.

## 21. Definition of success

v0.3 succeeds when another agent can reliably produce and validate epistemic artifacts, compile a compact read-only prime for a new or resumed prompt, preserve meaningful disagreement, and create a neutral proposed synthesis—across unrelated clean-room domains—without modifying canonical memory or bypassing repository governance.

It does not succeed merely because the schema is expressive. The implementation must demonstrate deterministic validation, scope isolation, reference integrity, uncertainty preservation, and zero behavioral regression in the existing system.
