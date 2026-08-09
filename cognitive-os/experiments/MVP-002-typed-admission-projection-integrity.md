# MVP-002: Typed Cognitive Admission and Projection Integrity

Status: frozen; implementation gated on MVP-001 live exit
Date: 2026-08-02
Integration posture: additive Cognitive OS integrity layer within mem-graph

## Entry Gate

Implementation must not begin until MVP-001 has repeated evidence from
independent live sessions that current-guidance policy retrieval changes a later
decision and improves the declared outcome without guardrail regression.

Design and adversarial fixtures may be prepared before that gate. They must not
modify the MVP-001 runtime or its live evidence.

## Problem

The current ledger constrains `cognitive_events.event_type`, preserves a hash
chain, and rejects updates and deletes, but `payload` remains general JSON.
Projection tables use foreign keys and application checks, yet the database can
still represent combinations whose rows are individually valid and
semantically inconsistent.

Examples include:

- a `PolicyCandidateCreated` event without the policy contract it claims to
  create;
- a policy projection sourced from the wrong event type;
- event and projection records that disagree on policy or evaluation ID;
- project or task scope that differs across an event and its projection;
- a `PolicyEvaluated` event that names a different policy or outcome from the
  evaluation row; and
- missing, self-referential, forward, cross-scope, or semantically incompatible
  causation.

The normal application path prevents some of these cases, but the durable model
does not yet make all of them explicit or independently auditable.

## Hypothesis

If each new cognitive event is admitted through a versioned event-specific
contract, and projection/causation roles are verified against the immutable
ledger, then Cognitive OS will reject or expose semantic corruption before it
can influence later guidance—without introducing TypeDB, changing retrieval,
or building a general ontology layer.

## Borrowed Design Principle

MVP-002 borrows one bounded idea from TypeDB: types and role constraints should
make invalid states unrepresentable or mechanically detectable.

The SQLite translation is deliberately narrow:

- TypeScript validators for event-specific payload contracts;
- SQL `CHECK`, `UNIQUE`, and foreign-key constraints where they express the
  invariant clearly;
- targeted triggers only when they remain transactionally correct and legible;
- purpose-built integrity queries for cross-row semantic invariants; and
- one read-only MCP audit surface for operator and agent verification.

## Frozen Semantic Invariants

### Event admission

- Every newly appended event uses a supported `schema_version` and a documented
  contract for its `event_type`.
- Required payload fields are present, non-empty, and of the expected primitive
  or structured type.
- Identifier-bearing policy events use stable, non-empty canonical IDs.
- Existing version-1 history remains readable and hash-verifiable; stricter new
  admission must not rewrite historical payloads.
- An idempotency key remains bound to exactly one canonical event input.

### Projection integrity

- `policy_candidates.source_event_id` references a
  `PolicyCandidateCreated` event.
- The candidate row and source payload agree on `policy_id`, project, trigger,
  action, exclusions, and verifier.
- `policy_evaluations.source_event_id` references a `PolicyEvaluated` event.
- The evaluation row and source payload agree on evaluation ID, policy ID,
  project, task, outcome, metrics, and guardrail result.
- Every evaluation policy exists and belongs to the same project.
- Aggregate evaluation counters equal the underlying evaluation rows.

### Causation integrity

- A causation reference resolves to an earlier event when one is supplied.
- An event cannot cause itself.
- Causally linked events remain within compatible project/task scope unless a
  documented cross-scope role explicitly permits otherwise.
- Event-type compatibility is explicit for the policy-learning path; arbitrary
  provenance links are not silently treated as causal validity.

## Minimal Runtime Surface

1. A versioned cognitive-event contract registry used by the append path.
2. Atomic validation before an event changes the ledger or hash chain.
3. Projection-consistency verification shared by tests and runtime audit.
4. A read-only `cognitive_integrity_check` MCP tool returning compact,
   machine-readable violations with canonical IDs and invariant codes.

The implementation may strengthen existing tables or add narrow integrity
tables. It must not add a generic concept/relation/type registry in MVP-002.

## Adversarial Proof Fixtures

At minimum, the deterministic experiment must exercise:

1. malformed event payload rejected before append;
2. unsupported schema version rejected;
3. candidate projection linked to an event of the wrong type;
4. candidate payload/projection ID mismatch;
5. evaluation project or policy mismatch;
6. evaluation payload/row outcome mismatch;
7. evaluation counters inconsistent with evaluation rows;
8. missing, self, or forward causation; and
9. a valid MVP-001 ledger and projection set producing zero violations.

Where the normal API correctly prevents a corrupt fixture, the test may create
the fixture in an isolated database through a deliberately privileged setup.
It must not weaken production append-only triggers to perform the audit.

## Proof Sequence

1. Freeze the current valid MVP-001 event/projection fixture as the compatibility
   baseline.
2. Define the supported event contracts and stable invariant codes.
3. Demonstrate pre-append rejection without a new sequence number or hash.
4. Run adversarial projection and causation fixtures through the integrity
   checker.
5. Verify that every corruption produces the expected canonical IDs and
   invariant code.
6. Verify the valid baseline returns zero violations and the hash chain remains
   valid.
7. Run the full existing test suite and TypeScript compiler.

## Acceptance Gate

MVP-002 passes only when all conditions hold:

- every new event type has a versioned admission contract;
- malformed new events fail atomically before ledger mutation;
- every frozen adversarial fixture is rejected or detected deterministically;
- valid MVP-001 history remains readable and hash-verifiable without rewrite;
- policy projections and aggregate counters pass independent consistency checks;
- integrity results identify the invariant and canonical records involved;
- current policy lookup and current-guidance retrieval semantics are unchanged;
- all pre-existing tests remain green;
- no new dependency is installed unless dependency vetting is completed first;
  and
- no measured material regression is introduced in append or lookup behavior.

## Guardrails and Non-Goals

- Do not introduce TypeDB or another database.
- Do not create TypeQL or another general-purpose query language.
- Do not add a generic inference engine, ontology registry, subtype lattice, or
  arbitrary n-ary relation store.
- Do not reinterpret weighted `synapses` as semantic truth assertions.
- Do not rewrite version-1 event history.
- Do not add automatic policy promotion, retirement, or authority expansion.
- Do not broaden agent permissions through the integrity tool.
- Do not begin MVP-003 merely because the integrity schema makes it possible.

## Deferred Candidate

If MVP-002 catches meaningful semantic failures, a later proof may evaluate
first-class semantic relations with named roles and provenance. That candidate
must remain separate from associative synapses and must answer a demonstrated
high-value query before implementation is authorized.
