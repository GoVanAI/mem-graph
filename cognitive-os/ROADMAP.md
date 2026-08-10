# Cognitive OS Roadmap

Status: historical milestone map; active sequencing is maintained in the deployment's resolved canonical tracker
Date: 2026-08-02
Integration posture: additive, proof-gated evolution within mem-graph

## Roadmap Contract

This document preserves the original falsifiable milestone sequence and its
proof contracts. Operator decision event 36
(`0d72848f-1e2e-4c6d-9c16-c6a82aa84041`) retired the former MVP-001-to-MVP-002
tripwire as an active blocker on 2026-08-08. The contracts remain historical
evidence; current sequencing and authority come from the deployment's
operator/project-configured canonical tracker plus later operator-adopted
decisions.

Each milestone must:

- preserve the SQLite/FTS5 memory and retrieval substrate unless replacement is
  independently justified by evidence;
- identify a real failure or ambiguity in the current system;
- add the narrowest inspectable mechanism that can address it;
- state explicit non-goals to prevent anticipatory platform building;
- retain canonical identifiers and reconstructable provenance;
- define measurable acceptance and regression gates; and
- require dependency vetting before any new package or service is introduced.

## Phase A: Pure Epistemic Kernel Recovery and Publication

Status: worktree verified; commit and publication require separate operator authorization

Phase A restores the previously verified, side-effect-free Epistemic Memory
kernel under stable repository-relative paths and makes it discoverable through
the README and versioned design documents. The recovered surface is limited to
pure TypeScript types, validators, compact-prime compilation, neutral synthesis,
stale-belief maintenance, synthetic fixtures, and tests.

Phase A does not authorize SQLite epistemic schema, migrations, MCP tools,
bootstrap lanes, hooks, schedulers, policy promotion, hard enforcement, or any
other runtime integration. Those require separate operator-adopted contracts.
See [`../docs/EPISTEMIC_MEMORY_PHASE0_IMPLEMENTATION_REPORT.md`](../docs/EPISTEMIC_MEMORY_PHASE0_IMPLEMENTATION_REPORT.md).

## MVP-001: Current-Guidance Retrieval

Status: historical implemented milestone; former exit tripwire retired
Frozen contract:
[`experiments/MVP-001-current-guidance-retrieval.md`](experiments/MVP-001-current-guidance-retrieval.md)

Purpose: prove that a scoped candidate policy can be retrieved on a later task,
change the retrieval decision, and reduce lifecycle/project contamination
without changing legacy mem-graph behavior.

Historical exit evidence criteria (retained for evaluation, not as a blocker):

- repeated evidence from independent live sessions, not only deterministic
  tests or the first smoke;
- exact-project current-guidance retrieval remains uncontaminated;
- the candidate policy changes the later decision path;
- the observed outcome improves the declared metric without guardrail
  regression; and
- the event chain reconstructs what was available, used, and changed.

## MVP-002: Typed Cognitive Admission and Projection Integrity

Status: historical frozen contract; no longer gated by MVP-001
Frozen contract:
[`experiments/MVP-002-typed-admission-projection-integrity.md`](experiments/MVP-002-typed-admission-projection-integrity.md)

Purpose: borrow TypeDB's strongest applicable idea—invalid semantic states
should be rejected by the model—without adopting TypeDB or building a general
ontology engine. MVP-002 will add versioned cognitive-event contracts and
verify that event type, payload, causation, project/task scope, and policy
projections agree.

The milestone succeeds only if it prevents or detects semantic corruption that
the current event-type-plus-JSON model permits while preserving the append-only
hash chain, current retrieval behavior, SQLite operation, and existing tests.

## MVP-003 Candidate: First-Class Semantic Relations

Status: candidate only; not frozen or authorized for implementation

Potential purpose: represent high-value semantic assertions with explicit
relation identity, named participant roles, provenance, confidence, lifecycle,
and canonical references. This layer would remain separate from weighted,
decaying `synapses` because associative relevance and semantic truth have
different lifecycles.

Entry evidence required before freezing:

- MVP-002 catches meaningful invalid states in live or adversarial use;
- at least one important provenance or policy query remains awkward or unsafe
  after typed admission;
- a first-class relation answers that query more clearly than a purpose-built
  table or view; and
- the proposal demonstrates that it will not become a generic ontology or
  query-language project.

Possible proof targets include policy applicability, evidence-support paths,
contradictory active commitments, and actor/artifact provenance. Subtyping,
recursive semantic functions, and broader polymorphism remain separate future
candidates and must be justified individually.

## Parallel Research Track: Agent Collaboration Liveness

Status: architectural requirement adopted; transport undecided

The collaboration control plane must accept external and autonomous triggers
and continue, resume, or explicitly recover an identity-scoped agent session
without mailbox polling. This research can proceed alongside the MVP sequence,
but it must not expand an MVP's storage or semantic scope merely because the
same events may later trigger agents.

## TypeDB Influence Boundary

TypeDB remains a design reference, not an adopted dependency. Borrowed ideas
must be translated into the narrowest SQLite constraint, trigger, view,
recursive CTE, versioned validator, or purpose-built MCP tool that proves the
benefit. The project will not transplant TypeQL, a generic inference engine,
RocksDB/client-server deployment, clustering, or TypeDB-specific administration.
