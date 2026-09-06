# Worked Example — Phase B Stream 1 missed Step 6 (projection rebuild proof)

**Source:** Redacted from `.claude/skills/self-correct-loop/field-logs/2026-08-09-stream-1-step-6-missed-acceptance-gate.md`
**Redaction date:** 2026-08-11
**Purpose:** Canonical pre-mortem example for `cognitive-os/skills/pre-mortem/examples/`
**Status:** Reconstructed representative (per `reasoning-gates.v1.json` contract — example files are not current live tasks)

## Source incident summary

When responding to the operator's "what's the remaining work to wire them?" question after a kernel-recovery phase was verified, an agent enumerated four wiring streams and recommended Stream 1 (persistence) as the next move. A reviewer produced a sharper 7-step ordering that included a step the agent had not articulated:

> **Step 6 — Projection rebuild proof — delete + rebuild from immutable evidence.**

The agent had named `projection_*` tables in the Stream 1 schema sketch but had **not asked "where do these tables come from after I write them the first time?"** That is the rebuild question. The kernel's documentation declares the rebuild property but the agent treated it as a kernel-side concern rather than an acceptance gate.

The reviewer also identified the specific risk the agent had named only vaguely:

> "The critical problem is that startup currently executes CREATE TABLE IF NOT EXISTS without a versioned migration system in src/db.ts:163. That cannot safely evolve columns, constraints, or repair behavior. Additionally, `cognitive_events.event_type` has a fixed SQL CHECK constraint in src/cognitive/schema.ts:6."

The agent had said "migration is the riskiest part" but cited "row count" rather than the actual risk: **`cognitive_events.event_type` CHECK constraint evolution**.

This example captures the miss and proposes a structural fix.

---

## Reflection — Five root causes

Each cause is tied to the specific reasoning chain in the session, not a general failure mode.

### 1. Linear-build framing
- **What was done:** Enumerated steps as "tables → MCP → done." A linear build doesn't naturally produce "delete and rebuild" steps because deletion feels like a backstep.
- **Why this matters:** Verification gates that require deletion are skipped because the mental model has no backstep slot.

### 2. Verification as ad-hoc final check
- **What was done:** Treated tests as "run them, see them pass." The reviewer's mental model treats verification as a **gate within each step** ("after this step, prove X by test Y").
- **Why this matters:** When verification lives only at the end, mid-step gates get implicit. Gates are what catch acceptance drift; final checks are what confirm the gates were met.

### 3. Trust in "pure" labeling
- **What was done:** Read "side-effect-free pure contract" and overtrusted it. Pure in-memory does not mean rebuildable-after-Serialize-to-SQLite. The persistence layer introduces ordering, transaction, and serialization concerns.
- **Why this matters:** Purity at one layer does not propagate to adjacent layers. Each layer's correctness must be proven at that layer.

### 4. Anchoring on prior plan
- **What was done:** A canonical memory entry's Phase B section said "Add append-only epistemic revisions, relations, and receipts plus rebuildable current projections." The word "rebuildable" was in the plan. But it was not translated into an acceptance criterion.
- **Why this matters:** Concept without gate = wish. Gate without concept = missed requirement. Both are required.

### 5. Pressure to start coding
- **What was done:** Answered "what's the next move" with implementation steps. The reviewer's discipline is to **enumerate gates before code**. The agent jumped to "let me start" instead of "let me design until every step has a verifiable acceptance line."
- **Why this matters:** Once the agent is offering steps, the operator moves to choose among them. Design is rushed. The reviewer's structure forces design to complete before any step is offered.

---

## Cross-cutting structural pattern

This is the **same family** as the 2026-08-02 field log. Both incidents share a signature:

- **Locally-correct pieces that don't compose into a system with reproducible acceptance gates.**
- **Steps enumerated without corresponding verification gates.**
- **Recurring pattern:** agent produces implementation, reviewer produces gates.

The 2026-08-02 log was about seven process misses. This log is about a single miss (Step 6) but the structural cause is identical.

If this pattern recurs a third time across a third thread, it becomes a candidate policy item: **"no step is offered without an explicit acceptance line and a verification test that proves it."**

---

## Plan — Structural fix

For every implementation step, the next line must be: **"Acceptance: X is proven by test Y."**

Examples for Phase B with this discipline:

| Step | Acceptance |
|---|---|
| 3 (migrations) | Interrupted migration can be recovered; proven by `interrupted-migration.test.ts` |
| 4 (epistemic tables) | Existing memories untouched; proven by row-count invariant test |
| 5 (admission) | Event append + record insert atomic; proven by injecting failure between them and observing rollback |
| 6 (rebuild) | Projection table deletable and rebuildable from events; proven by snapshot-delete-replay-compare test |
| 7 (MCP tools) | Read-only first; admission tools fail closed when event append fails; proven by transaction-failure integration test |

The reviewer's structure forces this. The discipline was missing from the agent's enumeration.

---

## Proposed framework v3.4.0 addition — Acceptance-Gated Step Enumeration

In the Build phase of the orchestration framework (Understand → Gather → Build → Verify → Report), the Build step currently allows free-form step enumeration. Add a sub-rule:

> "When proposing a sequence of work (3+ steps), each step must include an explicit acceptance line. If a step lacks a verifiable acceptance, the agent must say so explicitly and either justify the lack or refuse to enumerate the sequence."

This is enforceable via:
1. **Agent-side discipline** — self-check before offering a sequence
2. **Skill-side gate** — orchestration framework verifies acceptance lines exist before allowing the sequence to be presented
3. **Operator-side pattern** — operator can ask "what's the acceptance?" for any step lacking one

The third is already happening in this session. The first and second are framework-tuning candidates.

### Why this is a pre-action concern, not a post-failure concern

- **`self-correct-loop`-style pattern** captures and admits reusable learning after failure. This field log does that.
- **Orchestration framework** governs pre-action discipline so the failure doesn't happen. v3.4.0 would be the pre-action fix; this log is the post-failure record.

The two compose: orchestration framework prevents; self-correct-loop captures when it doesn't.

---

## What this means for the contract freeze

The reviewer's 7-step ordering is correct. The first deliverable should be:

1. **Migration infrastructure** (schema_migrations table + apply/rollback + interrupted-recovery)
2. **One minimal append-only admission path** (records table + admit function)

Both with explicit acceptance lines and verification tests **before any MCP exposure**.

The `cognitive_events.event_type` CHECK constraint question: defer. Reuse existing `EvidenceObserved` for Slice 1 admission; introduce a new event type only when needed, and gate that on its own migration proof.

---

## Pre-mortem application

For the pre-mortem skill, this example maps to:

| Failure-mode category | Example application |
|---|---|
| `plan` | Steps enumerated without explicit acceptance lines |
| `verification` | "Pure" labeling across layers = no inter-layer gate; verification skipped at boundaries |
| `implementation` | Anchoring on prior plan = concept not translated to acceptance criterion |
| `evidence` | Single `frozen_at` field conflates query-freeze and oracle-revision events |
| `human` | Pressure to start coding = design phase skipped |

If a future pre-mortem encounters a similar phased-implementation plan (multiple steps with gates expected), it should flag at minimum:
- Each step lacks explicit acceptance line (plan category)
- Verification gates live only at end (verification category)
- Layer purity claims without layer-specific verification (implementation category)
- Plan references prior concept without acceptance translation (evidence category)
- Time-sensitive fields use single timestamp for multiple events (evidence category)

**Status that would have applied at the time of this RCA:** `flagged` (multiple categories affected; same family as the 2026-08-02 example).

---

## Cross-references

- **Pattern-matched example:** `2026-08-02-process-miss-redacted.md` (process-miss family)
- **Domain contract:** `cognitive-os/agent-practice/reasoning-gates.v1.json`
- **Validator:** `src/cognitive/pre-mortem/pre-mortem-eval.ts` (Sol H4)
- **Kernel doc:** `docs/EPISTEMIC_MEMORY_PHASE0_IMPLEMENTATION_REPORT.md:101` — kernel report noting that "wiring is intentional" and becomes the focus of Phase B

## Update provenance

- 2026-08-11: Redacted and reformatted as canonical pre-mortem example from the original operator-local field log.
- Original file: `.claude/skills/self-correct-loop/field-logs/2026-08-09-stream-1-step-6-missed-acceptance-gate.md`
- Redactions applied: operator session UUID; specific line numbers in public source files (preserved file paths only); specific event UUIDs.
- Preserved: incident descriptions, root-cause analyses, structural patterns, public source file paths.
