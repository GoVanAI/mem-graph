---
name: pre-mortem
description: 'Run a proactive pre-commit failure analysis before an irreversible action, implementation commitment, public change, security-sensitive decision, or high-cost task. Use for "run a pre-mortem", "what could go wrong", "pressure-test this plan", "challenge the plan before coding", "identify failure modes", "check reversibility", "surface residual risks", "request approval for accepted risk", or "record accepted-risk decision".'
argument-hint: '[outcome, plan, commitment boundary, known constraints, requested waiver scope]'
user-invocable: true
version: 1.0.0
---

# pre-mortem

## 1. Purpose

Pre-mortem is a proactive pre-commit failure-analysis gate that produces a structured record of plausible failure mechanisms before irreversible actions, implementation commitments, persistent-state changes, public or expensive changes, security-privacy-safety-sensitive decisions, or hard-to-verify tasks. The gate proves **coverage only**; it grants **no task authority**. Execution authority remains with the operator and turn-shape. Per the Sol review corrections record (Sol H9), a `passed` status must never be read as "operator may proceed"; pre-mortem output is evidence of analytical breadth, not a license.

The skill is governed by `cognitive-os/agent-practice/reasoning-gates.v1.json` (per the Sol review corrections record Sol H2: a dedicated reasoning-gate contract kept separate from `practice.v1.json` because pre-mortem is a general Cognitive OS primitive, not a mem-graph use rule). The skill source lives in the repository as the canonical host-neutral form; Claude, Codex, Gemini, and generic-host adapters are generated from it (per the Sol review corrections record Sol H1: Claude directory is install target, repo is canonical). Each record is graded by the dedicated rubric evaluator at `src/cognitive/pre-mortem/pre-mortem-eval.ts` (per the Sol review corrections record Sol H4: separate from `agent-practice-eval.ts` to protect the 100-point mem-graph compliance score).

## 2. When to use

Invoke pre-mortem when a planned action matches one of the following positive triggers, mirroring the contract's `applies_to` clause:

- **Irreversible action.** Deployment, deletion, schema migration, or any step that is hard to roll back.
- **Implementation commitment.** Coding, refactor, dependency adoption, or contract change before downstream consumption.
- **Persistent state change.** Migration, on-disk format change, ledger schema addition, or any modification to durable state.
- **Public or expensive change.** Public announcement, paid operation, or significant compute spend.
- **Security, privacy, or safety-sensitive decision.** Auth, secrets handling, data egress, or operations touching regulated boundaries.
- **Hard to verify.** Novel technique, untested dependency, or output whose correctness cannot be cheaply demonstrated.

Do **not** invoke pre-mortem in the following cases; route elsewhere:

- **A failure has already occurred.** Route to `self-correct-loop`. Pre-mortem is proactive; post-failure diagnosis is its downstream consumer.
- **End-of-session learning absorption.** Route to `dream`. Pre-mortem artifacts are not session-distillation material.
- **Completion-time missed-risk review.** Route to the deferred `completion-audit` sibling. Pre-mortem must not implement completion verification.
- **Routine turn-shape execution without irreversible or novel elements.** Skip the gate. The orchestrator decides; pre-mortem is not invoked speculatively.

## 3. Responsibility boundary

Pre-mortem is one node in a composition of reasoning skills; directionality is named below.

- `turn-shape` is the **invoker**. Phase D §4 Risk Trigger delegates to pre-mortem when an `applies_to` condition is met (see `~/.claude/skills/turn-shape/SKILL.md`).
- `self-correct-loop` is the **downstream consumer** of post-failure signalization, including pre-mortem gaps discovered during execution.
- `dream` is the **end-of-session absorber** of pre-mortem patterns that recur and become durable lessons through the memory-admission gate; direct promotion is not used.
- `reflection` is the **triage destination** when repeated pre-mortem gaps suggest patch material; patches target `turn-shape` § Pre-Mortem via `~/.claude/skills/reflection/SKILL.md`.
- `completion-audit` is the **deferred sibling**; pre-mortem must not implement completion-time verification.

Per the Sol review corrections record (Sol H7), pre-mortem MUST NOT emit `waived` or `accepted_risk`. Those statuses belong to authorized actors — operator decision events (cognitive event type `DecisionMade`) or system authorization events. The skill emits `approval_required` when a residual risk needs operator sign-off; the skill records the request but not the authorization. Operator authorization flows through the normal memory-admission gate, never through pre-mortem output.

Per the Sol review corrections record (Sol M5), the section title `turn-shape § Pre-Mortem` is preserved as an alias for `reflection` triage compatibility. Do not rename this section to only `Risk Trigger`; both labels must remain searchable so that `reflection`'s existing patch destination (`~/.claude/skills/reflection/references/triage-template.md` line 130) continues to resolve.

## 4. Inputs and commitment boundary

The skill consumes a 9-field input manifest:

1. **Expected outcome** — concrete success criteria written to be verifiable.
2. **Plan** — the proposed sequence of actions under analysis.
3. **Commitment boundary** — which `applies_to` categories are in scope: `irreversible_action`, `implementation_commitment`, `persistent_state_change`, `public_or_expensive_change`, `security_privacy_safety_sensitive`, `difficult_to_verify`.
4. **Known constraints** — explicit assumptions, dependencies, and external conditions.
5. **Requested waiver scope** — pass-through for operator intent; the skill never invents waiver scope on the operator's behalf.
6. **Acceptance map** — proposed or existing gates linking success criteria to evidence.
7. **Rollback or recovery plan** — required when the boundary includes `irreversible_action` or `persistent_state_change`.
8. **Prior pre-mortem ledger reference** — optional, for incremental updates to a prior artifact.
9. **Surface-targeted operators and systems** — the actors whose authorization would close residual risks.

All nine are required for non-trivial work; the deterministic script `cognitive-os/skills/pre-mortem/scripts/check-failure-mode-coverage.py` rejects records missing `expected_outcome` or `commitment_boundary`.

## 5. Procedure

The skill advances through eight named phases:

- **FRAME.** Restate expected outcome and commitment boundary in the operator's language. Establish the applicability flags; surface any condition that should reroute before analysis begins.
- **CLASSIFY.** Decide which of the eight failure-mode categories (requirement, evidence, plan, implementation, verification, operational, security, human) apply. Category coverage is mandatory: per the Sol review corrections record (Sol M1), a raw count of modes is insufficient. Each category must contribute at least one mode, and the set of modes must be causally independent.
- **GENERATE.** Produce one or more modes per category. Each mode receives a specific mechanism; per the Sol review corrections record (Sol M1), generic labels such as "bugs" or "unexpected issues" are rejected by the deterministic script and by the dedicated rubric evaluator.
- **TRACE.** For each mode, fill preconditions, affected criterion, earliest warning, detection oracle, prevention, mitigation, rollback or recovery (when required), owner, residual risk, and disposition.
- **CHECK.** Run `cognitive-os/skills/pre-mortem/scripts/check-failure-mode-coverage.py` on the candidate record. Inspect per-mode `warning_check_status`: per the Sol review corrections record (Sol M2), the status is one of `verified`, `refused`, `unverified`, and `warning_check_evidence` is mandatory when status is `verified` or `refused`. A `refused` status carries the refusal reason in the evidence string.
- **MITIGATE.** Replace each open mode's disposition with `mitigated`, `accepted_risk` (with a matching waiver), or `blocked`. Surface anything that remains non-mitigable.
- **DECIDE.** Apply `src/cognitive/pre-mortem/pre-mortem-eval.ts` to the record and classify as `passed`, `flagged`, or `approval_required`. Per the Sol review corrections record (Sol H7), the skill never assigns `accepted_risk` or `waived`; only the dedicated rubric may assign those-or-lower.
- **HAND OFF.** Persist the artifact to `cognitive-os/skills/pre-mortem/artifacts/<task_id>_<timestamp>.json` and reference it from a Task Ledger entry (cognitive event payload field) per the Sol review corrections record (Sol H6). Return status and the critical-failure list to the invoker.

## 6. Failure-mode record

Each failure mode is a structured object drawn from the contract template:

- **id** — stable identifier within the record (e.g., `FM-1`).
- **category** — one of the eight contract categories.
- **mechanism** — specific causal path; generic labels are rejected.
- **preconditions** — conditions under which the mechanism activates.
- **affected criterion** — which success criterion or invariant would fail.
- **earliest warning** — first observable signal.
- **warning_check_status** — `verified`, `refused`, or `unverified` (per Sol M2).
- **warning_check_evidence** — string when status is `verified`; refusal reason when `refused`; null when `unverified`.
- **detection_oracle** — how the warning is observed automatically.
- **prevention** — action that reduces the probability of activation.
- **mitigation** — action taken once activation has been observed.
- **rollback_recovery** — required when commitment boundary includes `irreversible_action` or `persistent_state_change`.
- **owner** — operator or system accountable for the residual.
- **residual_risk** — what remains after mitigation.
- **disposition** — `open`, `mitigated`, `accepted_risk`, or `blocked`.

Per the Sol review corrections record (Sol M1), category coverage and causal independence are mandatory: each mode must carry a distinct, normalized mechanism, and the union of modes must cover every applicable category. Per the Sol review corrections record (Sol M2), a `verified` or `refused` warning check must include the matching evidence string. Generic labels, missing evidence, missing rollback where required, and orphan waivers are each individually sufficient to force a `flagged` outcome.

## 7. Acceptance criteria

Acceptance is machine-checkable per status:

- **passed.** All eight categories represented; every category's mode has a causally independent mechanism; every required field present; warning checks satisfied (verified or refused with evidence, or unverified with explicit rationale); rollback populated when the commitment boundary demands it; every `accepted_risk` mode carries a waiver with `authority_reference` and `no_additional_authority: true`; the deterministic script exits with code 0; the dedicated rubric returns `passed`. Coverage is proved; no task authority is granted.
- **flagged.** Any of: missing `expected_outcome` or `commitment_boundary`; category coverage incomplete; duplicate normalized mechanisms (causal dependence); generic-label mechanism; missing or invalid `warning_check_status`; missing evidence for a verified or refused warning; missing `rollback_recovery` when required; waiver without `authority_reference`; waiver without `no_additional_authority: true`; missing required waiver field; open disposition without mitigation. Execution must not proceed silently.
- **approval_required.** The validator-critical failure set is limited to the waiver-authority check, and at least one mode carries disposition `accepted_risk`. The skill records the request; the operator authorizes via a `DecisionMade` cognitive event. The skill itself does not authorize.

## 8. Output contract

Pre-mortem emits a structured record plus a status. Per the contract at `cognitive-os/agent-practice/reasoning-gates.v1.json`, statuses are partitioned:

| Status | Emitted by | Authority granted |
|---|---|---|
| `passed` | Skill | NONE — coverage proved; execution authority remains with operator and turn-shape |
| `flagged` | Skill | NONE — execution should not proceed silently |
| `approval_required` | Skill | NONE — operator authorization still required |
| `accepted_risk` | Authorized actor only | NONE additional — records the operator or system decision |
| `waived` | FORBIDDEN | — |

Per the Sol review corrections record (Sol H6), artifacts are **transient structured files** stored at `cognitive-os/skills/pre-mortem/artifacts/<task_id>_<timestamp>.json` and referenced from a Task Ledger entry. The artifact is not a cognitive event by default and not an epistemic record. Only durable outcomes (operator decisions, architectural commitments, codified policies) flow through `epistemic_admit` via the normal memory-admission gate. Per the Sol review corrections record (Sol H9), a `passed` record does not authorize execution.

## 9. Composition

Pre-mortem is composed with the following siblings; directionality is named explicitly:

- `turn-shape` → pre-mortem (Phase D §4 Risk Trigger delegation).
- pre-mortem → `self-correct-loop` (post-failure re-entry when execution exposes a missed mode).
- pre-mortem → `dream` (recurring patterns absorbed at end-of-session through the memory-admission gate).
- pre-mortem → `reflection` (triage destination for repeated gaps; patch target is `turn-shape` § Pre-Mortem).
- pre-mortem → `completion-audit` (deferred sibling; pre-mortem artifacts predate completion-time review).

## 10. Validation

Validation follows a deterministic-first sequence:

1. Run `python3 cognitive-os/skills/pre-mortem/scripts/check-failure-mode-coverage.py --input <record>` (or `--stdin`). Exit code 0 indicates structural pass; exit code 1 indicates validation failure with a JSON error list on stdout; exit code 2 indicates invocation error (missing input, malformed JSON).
2. Inspect the error list. Each error carries a stable code: `SCHEMA_VERSION_INVALID`, `EXPECTED_OUTCOME_MISSING`, `COMMITMENT_BOUNDARY_MISSING`, `APPLIES_TO_MISSING`, `FAILURE_MODES_NOT_ARRAY`, `ACCEPTED_RISKS_NOT_ARRAY`, `CATEGORY_COVERAGE_INCOMPLETE`, `MECHANISM_EMPTY`, `MECHANISM_GENERIC`, `WARNING_CHECK_STATUS_INVALID`, `WARNING_CHECK_EVIDENCE_MISSING`, `ROLLBACK_RECOVERY_MISSING`, `DISPOSITION_INVALID`, `MITIGATION_EMPTY`, `CAUSAL_DEPENDENCE`, `WAIVER_MISSING_FOR_ACCEPTED_RISK`, `WAIVER_AUTHORITY_REFERENCE_MISSING`, `WAIVER_NO_ADDITIONAL_AUTHORITY_FALSE`, `WAIVER_FIELD_MISSING`, `WAIVER_REFERENCES_UNKNOWN_MODE`, `WAIVER_MODE_DISPOSITION_MISMATCH`.
3. Surface residual risks. Determine which open modes are mitigable versus which require waiver.
4. Apply the dedicated rubric at `src/cognitive/pre-mortem/pre-mortem-eval.ts` for graded output and status classification (the rubric owns its own 100-point weighting rather than inheriting the mem-graph compliance rubric).
5. Report the validated record, the rubric status, the critical-failure list, and any waiver requests back to the invoker.

The script validates structural coverage only; qualitative plausibility remains the skill's responsibility. Per the Sol review corrections record (Sol H7 + H9), the skill never emits `accepted_risk` or `waived`; only the dedicated rubric's status (`passed` | `flagged` | `approval_required`) flows back to turn-shape.

## 11. References

- **Governing contract.** `cognitive-os/agent-practice/reasoning-gates.v1.json` (Sol H2) and its generated document `cognitive-os/agent-practice/REASONING_GATES.md`.
- **Dedicated validator.** `src/cognitive/pre-mortem/pre-mortem-eval.ts` (Sol H4); types in `src/cognitive/pre-mortem/types.ts`.
- **Deterministic script.** `cognitive-os/skills/pre-mortem/scripts/check-failure-mode-coverage.py`.
- **Failure-mode catalog.** Placeholder for the future `references/failure-mode-catalog.md` taxonomy and causal-independence guidance.
- **Canonical program state.** `the canonical current-state projection` (Cognitive OS progress tracker).
- **Sol review and corrections.** `the Sol review corrections record` (Sol review corrections applied 2026-08-11); `the Sol review task ledger` (closed Sol review task ledger).
- **Dual-tracking convention.** `the dual-tracking convention record` (plan file = live work; mem-graph = completed history).
- **Prior codex handoffs.** `the prior codex handoff`, `the prior codex handoff`.
- **Invoker.** `~/.claude/skills/turn-shape/SKILL.md` §4 Risk Trigger / Pre-Mortem.
- **Downstream consumer.** `~/.claude/skills/self-correct-loop/SKILL.md`.
- **End-of-session absorber.** `~/.claude/skills/dream/SKILL.md`.
- **Triage destination.** `~/.claude/skills/reflection/SKILL.md` (patch target: `turn-shape` § Pre-Mortem).
- **Redacted worked example 1.** `cognitive-os/skills/pre-mortem/examples/2026-08-02-process-miss-redacted.md` (sourced from `~/.claude/skills/self-correct-loop/field-logs/2026-08-02-process-miss-rca-and-turn-shape-gap.md`); demonstrates a `flagged` outcome from the seven-process-miss family.
- **Redacted worked example 2.** `cognitive-os/skills/pre-mortem/examples/2026-08-09-missed-acceptance-gate-redacted.md` (sourced from `~/.claude/skills/self-correct-loop/field-logs/2026-08-09-stream-1-step-6-missed-acceptance-gate.md`); demonstrates a `flagged` outcome from the missed-acceptance-gate family.
