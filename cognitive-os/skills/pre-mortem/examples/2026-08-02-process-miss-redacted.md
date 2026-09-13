# Worked Example — process-miss RCA + framework gap analysis

**Source:** Redacted from `.claude/skills/self-correct-loop/field-logs/2026-08-02-process-miss-rca-and-turn-shape-gap.md`
**Redaction date:** 2026-08-11
**Purpose:** Canonical pre-mortem example for `cognitive-os/skills/pre-mortem/examples/`
**Status:** Reconstructed representative (per `reasoning-gates.v1.json` contract — example files are not current live tasks)

## Source incident summary

During a baseline-experiment thread, an agent produced a series of artifacts and ledger events. A read-only review surfaced seven defects. The agent then produced a root-cause analysis identifying process misses. A follow-up question asked whether the orchestration framework itself caused the misses.

This example captures both:
1. The seven process misses (with concrete incidents).
2. The framework-vs-discipline gap analysis.

---

## Reflection — Seven process misses

Each defect is tied to a specific incident in the session, not a general failure mode.

### 1. No executable oracle is stored
- **Incident:** Baseline and treatment canonical result hashes were produced via inline `python -X utf8 -c "..."` calls. Scripts existed only in conversation context. The artifact files contain the hashes but not the script that produced them. A future agent cannot regenerate from the artifacts alone.
- **Root cause:** Treated conversation-as-script as a valid artifact source.
- **What should have been done from the start:** Written `cognitive-os/fixtures/mvp-001-coverage-oracle.py` (matrix-loading + sanitizer + query + evaluation + hash-emit) and used it consistently for Run-1, Run-2, and treatment.

### 2. Treatment hashes exist but no treatment-run outputs or baseline-to-treatment delta
- **Incident:** Ran the matrix against the treatment clone, computed treatment canonical hash, but did not materialize `mvp-001-treatment-run-results-v1.json` or a delta file. Symmetry with baseline-results artifact was not maintained.
- **Root cause:** Treated symmetric artifacts as optional rather than mandatory.
- **What should have been done:** After the treatment run, immediately saved `mvp-001-treatment-run-results-v1.json` and derived `mvp-001-baseline-vs-treatment-delta-v1.json`.

### 3. Artifact header date inconsistent with corpus
- **Incident:** Set `"recorded_at": "2026-08-02"` in the artifact header without verifying against the corpus. A referenced node was created 2026-08-04.
- **Root cause:** Conflated artifact-write-time with corpus-sampling-time.
- **What should have been done:** Query `MAX(created_at) FROM memories` and set `corpus_as_of_time` separately from `recorded_at`.

### 4. Single timestamp conflates two distinct events
- **Incident:** Set single `frozen_at: "2026-08-02T18:25:00Z"`. The matrix had three iterations (v1, v2, v3); queries were frozen at v2, only oracle changed in v3. One timestamp can't represent two distinct events.
- **Root cause:** Treated the schema's temporal state as a single point.
- **What should have been done:** Separate fields `query_freeze_at` and `oracle_revision_at`.

### 5. Internal contradiction between filename and content
- **Incident:** Filename `...v3.json` and `matrix_version: "v3"` but `schema_note` text said "(5) file renamed to v2". Internal contradiction.
- **Root cause:** Did not re-read output for internal consistency before declaring done.
- **What should have been done:** Re-read the v3 file after writing it; verify each claim in the schema_note matches the actual filename and version.

### 6. Row 35's forbidden ID exists only in prose
- **Incident:** Had `note: "id 41 must not appear"` and the prohibition in `pass_criteria.description` prose. An oracle executor parsing only structured fields would miss it.
- **Root cause:** Treated the oracle as something to compute in conversation; the fixture is supposed to *be* the oracle's contract.
- **What should have been done:** Added `forbidden_result_ids: [41]` (machine-readable) on row 35.

### 7. Canonical tracker stale
- **Incident:** Per operator timing guidance, T7 was supposed to be appended first. The treatment run was executed and a fix identified but T7 was never appended. Tracker still showed the prior numbers from the previous corrective thread. The new contamination failure identified by the v3 oracle wasn't reflected.
- **Root cause:** Treated T7 as a single append step rather than a chain: (1) compute hashes, (2) save treatment artifact, (3) save delta, (4) append event, (5) update tracker. Step 1 was partially executed but step 4 was never reached.
- **What should have been done:** Complete the T7 chain before declaring any thread pause.

---

## Reflection — Cross-cutting structural pattern

All seven defects share one root: **the thread was treated as a sequence of self-contained fixes when it needed to be a system that produces reproducible, self-consistent artifacts.**

The artifacts that exist are correct in isolation. But they don't compose into a reproducible system:
- No executable oracle → can't regenerate hashes from fixtures
- Treatment results not materialized → not symmetric with baseline
- recorded_at ≠ corpus_as_of_time → temporal inconsistency between artifact header and data
- frozen_at conflates two events → temporal schema incomplete
- schema_note contradicts filename → internal contradiction
- forbidden IDs in prose → fixture not a complete contract
- tracker hasn't received T7 → drift between artifact layer and human-readable layer

The structural fix is: **establish an executable oracle** (one Python file that reads matrix + clones + sanitizer + evaluation, and emits hashes + per-row results + delta) — and require every artifact the oracle produces to be reproducible from the oracle + matrix + clones alone.

Incremental pieces — ad-hoc Bash queries, partial results JSONs, matrix edits — were locally correct but didn't compose.

---

## Reflection — Did the framework cause this?

**Short answer:** No — the framework didn't cause the issue. **Non-compliance with the framework caused the issue.** The framework is the procedure that was supposed to be followed; the operator had to push through multiple turns to actually follow it.

### Where the framework's procedure (v3.2.0 at the time) was insufficient

Two structural gaps that a later version (v3.3.0) began closing:

1. **Passive availability vs. application.** v3.2.0 was loaded via SessionStart hook but didn't fire a runtime checkpoint demanding Mode + Task Ledger creation before the first substantive action. The operator had to push to "use turn-shape then continue" multiple times. v3.3.0 added the runtime-checkpoint text firing on every prompt.

2. **The PreToolUse hook was too permissive.** The operator themselves flagged this: *"The existing PreToolUse ledger hook is advisory, can be ignored, and treats any recent Task Ledger as satisfying the check — even one belonging to another task."* That's a real enforcement gap — the framework specifies a Task Ledger requirement; the hook that should enforce it didn't.

So the framework (the procedure specification) had two structural gaps:
- **Weak runtime activation** (SessionStart injects content but doesn't demand Mode declaration)
- **Weak enforcement hook** (PreToolUse allows a previous task's ledger to satisfy a new task)

### Where behavior failed independently of the framework

Even with v3.2.0's gaps, the operator had to push through:
- Multiple "use turn-shape" reminders
- A version update with explicit runtime checkpoint
- Repeated Mode declarations that became ceremonial rather than substantive

The seven process misses were each preventable by simply *reading* the existing procedure and applying it:
- "Preserve prior milestone evidence" → T7 event not authoritative
- "Map success criteria to evidence" → "all 35 queries produce row-15 PASS" not mapped to verifiable oracle output
- "Update this projection in place rather than creating competing current-state trackers" → tracker updates added scope without removing stale claims

### Where the structural fix lives

The mechanical reinforcements the operator proposed earlier — ledger scope validation, required-field validation, pre-final check, compact application receipt — are the right direction. They're not framework *replacements*; they're framework *enforcement*.

---

## Cross-cutting structural pattern (redacted)

This field log shares a signature with later incident logs (e.g., the 2026-08-09 stream-1 missed-acceptance-gate log):

- **Locally-correct pieces that don't compose into a system with reproducible acceptance gates.**
- **Steps enumerated without corresponding verification gates.**
- **Recurring pattern:** agent produces implementation, reviewer produces gates.

If this pattern recurs across multiple threads, it becomes a candidate policy item: **"no step is offered without an explicit acceptance line and a verification test that proves it."**

---

## Pre-mortem application

For the pre-mortem skill, this example maps to:

| Failure-mode category | Example application |
|---|---|
| `verification` | No executable oracle = verification gates are conversational, not reproducible |
| `plan` | Steps enumerated without corresponding acceptance lines |
| `evidence` | recorded_at ≠ corpus_as_of_time = temporal inconsistency in evidence chain |
| `operational` | T7 chain partial = drift between artifact layer and human-readable layer |
| `human` | Repeated operator pushback = missing discipline, not missing framework |

If a future pre-mortem encounters a similar artifact chain (matrix + clones + hashes + delta), it should flag at minimum:
- Executable oracle missing (verification category)
- Symmetric artifacts missing (plan category)
- Temporal schema single-field (evidence category)
- Internal contradiction in any artifact (verification category)
- Forbidden constraints in prose only (verification category)
- Tracker update chain incomplete (operational category)

**Status that would have applied at the time of this RCA:** `flagged` (multiple critical categories missing; not a single-issue failure).

---

## Cross-references

- **Pattern-matched example:** `2026-08-09-stream-1-step-6-missed-acceptance-gate-redacted.md` (acceptance-gate miss family)
- **Domain contract:** `cognitive-os/agent-practice/reasoning-gates.v1.json`
- **Validator:** `src/cognitive/pre-mortem/pre-mortem-eval.ts` (Sol H4)

## Update provenance

- 2026-08-11: Redacted and reformatted as canonical pre-mortem example from the original operator-local field log.
- Original file: `.claude/skills/self-correct-loop/field-logs/2026-08-02-process-miss-rca-and-turn-shape-gap.md`
- Redactions applied: operator session UUID; host-specific filesystem paths; internal event UUIDs; agent role label.
- Preserved: incident descriptions, structural patterns, cross-references to public docs and source files.
