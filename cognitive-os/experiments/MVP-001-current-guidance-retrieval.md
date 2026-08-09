# MVP-001: Current-Guidance Retrieval

Status: frozen for implementation
Date: 2026-08-01
Integration posture: additive Cognitive OS sidecar within mem-graph

## Problem

Spreading activation is useful for broad context, but it can surface inactive or
out-of-scope memories as though they were current guidance. Current-guidance
requests need stricter retrieval before graph expansion.

## Hypothesis

When a task asks for current canonical guidance, retrieving active memories from
the current project first, then consulting a matching candidate policy, will
reduce lifecycle and project contamination without changing legacy mem-graph
behavior.

## Frozen Policy Candidate

- Trigger type: `request_type`
- Trigger value: `current_canonical_guidance`
- Scope precedence: exact `project_id`, then `_global`
- Action: search active, exact-project memories before any graph activation;
  fetch a selected canonical memory directly; expand the graph only when the
  task calls for related context.
- Exclusions: historical audit, cross-project analogy, reflection clustering,
  and provenance reconstruction.
- Verifier: zero inactive results, zero unintended cross-project results, and
  the expected canonical memory present.

## Minimal Runtime Surface

The sidecar adds four logically separate capabilities while retaining the same
SQLite substrate:

1. An append-only, hash-linked cognitive event ledger.
2. Candidate-policy projection and exact-trigger lookup.
3. Explicit policy evaluation that updates evidence counts but never promotes
   candidate authority automatically.
4. Strict current-guidance retrieval over the existing `memories` table.

Required event types for the first proof:

- `DecisionMade`
- `ExecutionObserved`
- `EvidenceObserved`
- `BeliefRevised`
- `ReflectionProposed`
- `PolicyCandidateCreated`
- `PolicyRetrieved`
- `PolicyEvaluated`

## Proof Sequence

1. Record the prior retrieval decision and its observed contamination.
2. Record evidence, a belief revision, and the scoped candidate policy.
3. On a fresh analogous task, retrieve the candidate by exact trigger.
4. Use strict retrieval and record that the decision path changed.
5. Evaluate correctness, lifecycle contamination, project contamination, and
   guardrail regression.
6. Reconstruct the event sequence in insertion order and verify its hash chain.

## Acceptance Gate

The experiment passes only when all conditions hold:

- Existing mem-graph APIs, schemas, and behavior remain compatible.
- All pre-existing tests stay green.
- The event ledger rejects update and delete operations.
- Reusing an idempotency key with different event content is rejected.
- Exact-project, active-only retrieval returns the expected canonical memory.
- Superseded, archived, invalid, `_global`, and other-project memories are
  excluded unless their inclusion is explicitly requested.
- Policy lookup prefers exact-project scope over `_global` scope.
- Evaluation evidence is recorded without automatic promotion to authoritative
  policy.
- A deterministic integration test demonstrates the full proof sequence.

## Guardrails

- Do not rewrite or reinterpret legacy memory rows.
- Do not change `memory_search` or `memory_activate` semantics in MVP-001.
- Do not install new dependencies. If that constraint must change,
  `dependency-vetting` is a mandatory pre-install gate.
- Do not perform automatic policy promotion, deletion, or authority expansion.
- Do not discuss a replacement mem-graph architecture until this proof gate has
  produced positive evidence.
