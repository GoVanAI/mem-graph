# Step 3 — Phase A Completion Handoff (M3)

Status: **Phase A repair complete; ready for Codex Gate A review**

Date: 2026-09-07

Authority: `STEP_3_PHASE_GATED_EXECUTION_PLAN.md` §4 (Phase A — Structured evaluation contract)

Gate: Gate A (Codex closes).

Phase D: **NOT AUTHORIZED.** No Phase D work has begun.

## Phase

Phase A — Structured evaluation contract (M3).

## Status

ready-for-codex-review

## Starting commit

`af95264` (epistemic-phase-a-recovery branch).

## Files owned (per execution plan §3)

- `cognitive-os/agent-practice/evals/progressive-disclosure/cases.json`
- `cognitive-os/agent-practice/evals/progressive-disclosure/cases.schema.json`
- `cognitive-os/agent-practice/evals/progressive-disclosure/README.md`
- New Step 3 evaluator files under `cognitive-os/agent-practice/evals/progressive-disclosure/`
- `scripts/tools-measure.mts` (only during measurement/closeout; not touched this phase)

## Exact files changed (Phase A repair)

Modified (Phase A repair per Codex review §4 and §7):

- `cognitive-os/agent-practice/evals/progressive-disclosure/cases.schema.json`
- `cognitive-os/agent-practice/evals/progressive-disclosure/cases.json`
- `cognitive-os/agent-practice/evals/progressive-disclosure/README.md`
- `cognitive-os/agent-practice/evals/progressive-disclosure/structured-predicate.mjs`
- `cognitive-os/agent-practice/evals/progressive-disclosure/structured-predicate.test.mjs`

Added:

- `cognitive-os/agent-practice/evals/progressive-disclosure/validate-step3-contract.mjs`
- `cognitive-os/agent-practice/evals/progressive-disclosure/case-fixtures.mjs`
- `cognitive-os/agent-practice/evals/progressive-disclosure/case-fixtures.test.mjs`

Not changed this phase:

- `scripts/tools-measure.mts` (no measurement changes required for Phase A).
- `cognitive-os/agent-practice/evals/progressive-disclosure/measure-step2a.mjs` (still passes against migrated cases).
- `cognitive-os/agent-practice/evals/progressive-disclosure/tool-mapping.json` (no Step 3 changes required to the ten-route mapping; expansion routes are documented in the design, not in `tool-mapping.json`).
- `cognitive-os/agent-practice/evals/progressive-disclosure/tool-mapping.schema.json`.
- `cognitive-os/agent-practice/evals/progressive-disclosure/STEP3-HANDOFF.md` (pre-Phase-A operator/AGY-alignment doc; left in working tree).
- `cognitive-os/agent-practice/evals/progressive-disclosure/agent-tool-surface-baseline.json`.
- `cognitive-os/agent-practice/evals/progressive-disclosure/legacy-tool-surface-baseline.json`.

## Behavior implemented

Phase A migrates the eight cases from literal-substring grading to structured-predicate grading without claiming that any case has executed. Each case gains `fixture_intent`, `required_predicates`, `forbidden_predicates`, and an optional `case_notes` block; the legacy `expected.required_signals` / `expected.forbidden_signals` strings remain as human-readable documentation only. The schema, the runtime evaluator, and a new contract validator enforce the v1 contract from `STEP_3_COMPACT_CONTEXT_DELIVERY_DESIGN.md` §3 D8:

- RFC 6901 JSON Pointer with `~0` and `~1` tilde escapes only (bare `~` rejected).
- Empty pointer `""` addresses the root document.
- Five operators: `equals`, `includes`, `excludes`, `exists`, `not_exists`.
- `value` is required for the first three and forbidden for the last two; arrays are forbidden across all operators.
- No coercion, no regular expressions, no executable expressions, no free-form query language.
- Predicates are exact-equality on scalars and recursive partial-match on object array elements.
- Malformed pointers, malformed predicates, and unresolved pointers fail closed (do not silently evaluate as absent).

Per-case fixture intent follows design Section 11: `pd-01` is `lexical_discovery`; `pd-02` through `pd-08` are `deterministic_source_projection`. `pd-05` case notes explicitly call out that all three canonical IDs (107, 108, 109) must be requested so the exclusion of 108 and 109 is observable.

`baseline_trace.measurement_status` remains `contract-only-not-executed` on every case. The contract validator refuses to accept any other status until Phase D evidence arrives.

## Tests run with exact commands

```powershell
python scripts/validate-progressive-disclosure-schemas.py
node cognitive-os/agent-practice/evals/progressive-disclosure/measure-step2a.mjs
node --test cognitive-os/agent-practice/evals/progressive-disclosure/structured-predicate.test.mjs
node cognitive-os/agent-practice/evals/progressive-disclosure/validate-step3-contract.mjs
git diff --check -- cognitive-os/agent-practice/evals/progressive-disclosure
```

## Exact results and counts

| Command | Result |
| --- | --- |
| `python scripts/validate-progressive-disclosure-schemas.py` | exit 0 — `cases.json vs cases.schema.json: PASS`, `tool-mapping.json vs tool-mapping.schema.json: PASS` |
| `node .../measure-step2a.mjs` | exit 0 — `ok: true`, `status: step-2a-contract-validated`, 41 registered / 41 mapped / 10 proposed everyday routes / classifications {everyday: 21, specialist: 18, legacy-only: 2} / 8 baseline cases / artifact_bytes {cases: 15835, mapping: 24248} |
| `node --test .../structured-predicate.test.mjs` | exit 0 — 60 tests, 60 pass, 0 fail, 0 skipped, 0 todo (duration ≈ 101 ms) |
| `node .../validate-step3-contract.mjs` | exit 0 — `ok: true`, `status: step3-contract-validated`, 8 cases, fixture_intents {deterministic_source_projection, lexical_discovery}, predicate_counts {required_total: 34, forbidden_total: 2}, pointer_coverage {ok: 36, malformed: 0, unknownOperator: 0, arrayValue: 0}, expected_case_ids matches observed_case_ids exactly |
| `git diff --check -- ...progressive-disclosure` | exit 0 — only LF→CRLF normalization warnings on three tracked files; no whitespace errors |

All five commands pass with exit code 0.

## Database used

none. Phase A is contract-only; no disposable database is required and none was opened.

## Live database mutated

no.

## Files outside ownership changed

no.

## Commits or pushes

none. Working-tree changes only, awaiting Codex Gate A review and operator authorization.

## Known gaps or disagreements

- Codex's prior review (Section 4, A1–A5) identified the gaps this repair closes. Each was addressed:
  - A1: All eight cases now carry `fixture_intent`, `required_predicates`, and `forbidden_predicates`. Draft 2020-12 validation passes.
  - A2: Schema pattern is now `^(?:/(?:~0|~1|[^~/])*)*$` (excludes bare `~`); runtime `decodePointer` rejects `~` not followed by `0` or `1` via `/(?<!~)~(?!0|1)/`; tests added for `~2`, `~a`, `~`, `~01`-as-valid.
  - A3: `validatePredicate` accepts empty pointer; `resolvePointer` and `evaluatePredicate` handle it as root. Schema permits `^$` via `(?:/(?:...))*`. Tests added.
  - A4: `value` is constrained in the schema to `string | number | boolean | null | object` (no array). Runtime `validatePredicate` rejects array values at the validator layer. Tests added.
  - A5: `validate-step3-contract.mjs` exists; README has the Step 3 section; this is the formal handoff.
- The legacy `required_signals` / `forbidden_signals` strings remain as human-readable documentation only. They no longer determine compact-mode grading.
- The v1 contract deliberately lacks a `not_equals` and a length/count operator. Per-case predicates therefore express negative intent via positive structural assertions (e.g., `/state/current` includes `{ "sources": [{ "id": 111 }] }` plus `/state/context_only` exists) rather than via negation. The case notes document this limit where it applies (notably `pd-07` `history_count=2`).
- `pd-05` cannot pass end-to-end until the bootstrap composition path actually receives all three canonical IDs (107, 108, 109) and emits expansions restricted to `project_id=fixture-alpha`. The case notes record that as a Phase C/D prerequisite.

## Next phase explicitly not started

Phase B, Phase C, Phase D, and Phase E are **not started**. AGY owns Phase B in parallel; Codex closes Gate AB after both handoffs arrive. M3 does not begin Phase D until Codex closes Gate C.

---

## Cross-references

- `docs/Update/STEP_3_COMPACT_CONTEXT_DELIVERY_DESIGN.md` v1.1 — design under implementation.
- `docs/Update/STEP_3_PHASE_GATED_EXECUTION_PLAN.md` §4 — Phase A spec.
- `docs/Update/STEP_3_GATE_AB_CODEX_REVIEW.md` §4 and §7 — Gate A findings being repaired.
- `STEP3-HANDOFF.md` (working-tree) — pre-Phase-A review alignment, kept for the audit trail; not the required Phase A completion handoff.
- `STEP_3_M3_AGY_REVIEW_HANDOFF.md` — review handoff from the prior turn (M3 × AGY alignment before Gate S3-0).

---

## Phase A semantic-contract repair (second pass, after Codex verifier findings)

After the first handoff, Codex reviewed the case plans and identified nine
verifier/contract-integrity issues. The eight case contracts and the
harness have been repaired in one bounded pass:

1. **pd-01** — `not_exists` predicates moved from `forbidden_predicates`
   to `required_predicates`. `required_signals` semantics now match the
   contract: "statement absence is required" lives in `required_predicates`.
   Counterexample (an envelope that invents an objective statement) is in
   `COUNTEREXAMPLES[pd-01]` and the validator runs it.
2. **pd-02** — authority path corrected from `/task/objective/authority`
   to `/task/objective/statement/authority`. Manifest lanes (objective,
   definition_of_done, constraints, next action) now have indexed
   source-backed assertions (`/task/<slot>/statement/sources/0/id`
   equals the manifest record id). State surface proves current record
   surfaces via indexed source assertions. No more `exists` on potentially
   empty arrays.
3. **pd-03** — warning string corrected from `"contradiction"` to
   `"explicit_contradiction_present"` (matches design §6 step 10).
   Evidence statement proved via indexed `review_state` and source id.
   Expansion identifies source 104 (the affected governing record) with
   indexed assertions.
4. **pd-04** — `content_bytes_omitted` asserted as the deterministic
   expected value `11850` (= source `content_bytes: 12000` minus preview).
   Source 106 proven present via indexed source id. Status asserted as
   `partial` (positive structural proof of "not complete"). Counterexample
   sets `content_bytes_omitted` back to `null` and confirms detection.
5. **pd-05** — request now carries `canonical_ids: [107, 108, 109]`.
   Validator mechanically checks the field is present and matches. Source
   107 proven present (indexed assertions on `state.current[0]` and
   `expansions[0]`). Sources 108 and 109 proven absent from `state.*`,
   `guidance.governing_candidates`, and `expansions[].source` via
   `excludes` predicates with full source-ref shapes.
6. **pd-06** — expansion reason asserted as `version_mismatch` with source
   id 110 via indexed assertions. `unresolved[0]` asserted as
   `"refresh_required"`. `mixed_snapshot` warning excluded.
7. **pd-07** — request now carries `canonical_ids: [111, 112, 113]`.
   Indexed-pointer predicates avoid nested partial object patterns
   (per Codex, partialMatch compares nested arrays exactly, so the
   earlier `{sources: [{id: 111}]}` shape would not have matched a
   full source ref). Source 112 proven at `state.context_only[0]`,
   source 113 at `state.context_only[1]`, and `state.context_only[2]`
   proven absent — this is the v1-contract expression of "exactly two
   history entries." Sources 112 and 113 proven absent from
   `state.current` via excludes predicates.
8. **pd-08** — `orientation.task_state` asserted as `unavailable` (the
   normative location per design §5.1 for malformed manifest); base
   `orientation.status` asserted as `partial`. `manifest_invalid` and
   `missing_source=115` proven in `unresolved[0]` and `unresolved[1]`
   (the normative location per Codex, not `warnings`). Source 114
   proven in `state.current[0]` (base record preserved). Expansion
   identifies source 115 with `route_available=false`.
9. **Harness** — `case-fixtures.mjs` provides eight representative
   compact envelopes and eight counterexample envelopes. `case-fixtures.test.mjs`
   runs `evaluatePlan` for every (case, fixture) and (case, counterexample)
   pair; counterexamples must fail. The validator runs the same
   `evaluatePlan` and additionally performs a contract-path resolution
   check on every required predicate. `pd-05` and `pd-07` validator
   checks mechanically verify `request.canonical_ids` matches the
   expected set; per-case `execution_layer` is verified against the
   Codex-supplied expected values (`null` for `pd-01`,
   `pure_projection` for `pd-02` and `pd-03`, `mcp_bootstrap` for the
   remaining cases).

Forbidden-predicate semantics were also tightened during this pass:
`excludes` now returns `passed = true` when the array contains a
matching element (same convention as `equals`), so `forbiddenFired`
correctly identifies predicates whose forbidden condition was
satisfied. The earlier implementation had `excludes` return `passed =
!hit`, which silently inverted forbidden-predicate semantics for all
eight cases.

### Phase A semantic-repair test results (final)

| Command | Result |
| --- | --- |
| `python scripts/validate-progressive-disclosure-schemas.py` | exit 0 — both schemas PASS |
| `node measure-step2a.mjs` | exit 0 — 41 registered, 41 mapped, 10 routes |
| `node --test structured-predicate.test.mjs` | exit 0 — 61/61 |
| `node --test case-fixtures.test.mjs` | exit 0 — 32/32 |
| `node validate-step3-contract.mjs` | exit 0 — all checks pass |
| `git diff --check -- ...progressive-disclosure` | exit 0 — LF/CRLF warnings only |

### Known limitations after the repair

- `pd-04` `content_bytes_omitted = 11850` is provisional. Phase B
  projector output may report a different value (the preview size is
  not yet observable); this predicate must be updated to match the
  recorded projector output before Phase D.
- The v1 contract deliberately lacks `not_equals` and a length/count
  operator. Per-case predicates express negative intent and count
  assertions via positive structural patterns (e.g., `state.context_only[2] not_exists`
  to prove "exactly two history entries").
- The validator mechanically checks pd-05 and pd-07 canonical_ids; other
  cases do not require canonical_ids per design §11.
- Phase D evidence (recorded execution layer) is required before any
  case may flip `measurement_status` from `contract-only-not-executed`.

Phase C, Phase D, and Phase E remain **NOT AUTHORIZED.** Stopping for
Codex Gate A re-review.

---

## Phase A excludes-semantics correction (third pass, after Codex verifier findings)

After the second handoff, Codex identified one final verifier-integrity
issue: the prior pass had inverted `excludes` semantics by returning
`passed = hit` (the matched element) instead of the conventional
`passed = !hit` (no matching element). This affected every case plan
that expressed "absence required" via `forbidden_predicates` +
`excludes`. One bounded pass restored conventional semantics:

1. **`evaluatePredicate(excludes)`** now returns `passed = !hit`
   (matches `includes`/`equals`/`exists`/`not_exists` convention).
2. **`evaluatePlan` documentation** rewritten around lines 250-258 to
   be unambiguous: forbidden predicates describe the BAD condition
   literally; absence requirements live in `required_predicates` with
   `excludes` or `not_exists`.
3. **All case plans** moved absence-requirements to `required_predicates`.
   The 64 required / 15 forbidden split became 77 required / 0
   forbidden. Every case now expresses the contract in positive form
   within required_predicates.
4. **pd-05** rewritten with bounded structural assertions: source 107
   at indexed location; one source on the allowed statement
   (`/state/current/0/sources/1` not_exists); one statement in
   `state.current` (`/state/current/1` not_exists); expected-empty
   lanes `state.open`/`state.evidence`/`state.context_only` have
   index 0 not_exists; expansions has exactly one entry targeting
   107 with `project_id=fixture-alpha` and `expansions/1` not_exists;
   guidance.governing_candidates has index 0 with source 107 + no
   second entry; contextual_candidates/policy_candidates have index 0
   not_exists. No nested source-array partial matching anywhere.
5. **pd-06** moves `/warnings` excludes `"mixed_snapshot"` from
   forbidden to required (per Codex: required+excludes is the
   conventional expression of "X must be absent").
6. **pd-07** keeps indexed pointers and replaces the nested
   source-array excludes with `/state/current/1` not_exists (proves
   "no history source was promoted into current" structurally, without
   relying on partialMatch over nested arrays).
7. **Fixtures updated**: pd-06 counterexample adds `warnings: ['mixed_snapshot']`
   to exercise the new required+excludes predicate.
8. **Four explicit evaluator tests** added to `structured-predicate.test.mjs`:
   - required+excludes passes when value is absent;
   - required+excludes fails when value is present;
   - forbidden+includes fires when the bad value is present;
   - forbidden+includes holds when the bad value is absent.
9. **README** rewritten to state the operator convention and plan
   convention clearly, and to forbid `excludes`/`not_exists` inside
   `forbidden_predicates`.

### Final test results

| Command | Result |
| --- | --- |
| `python scripts/validate-progressive-disclosure-schemas.py` | exit 0 — both schemas PASS |
| `node measure-step2a.mjs` | exit 0 — 41 registered, 41 mapped, 10 routes |
| `node --test structured-predicate.test.mjs` | exit 0 — 65/65 |
| `node --test case-fixtures.test.mjs` | exit 0 — 32/32 |
| `node validate-step3-contract.mjs` | exit 0 — all checks pass |
| `git diff --check -- ...progressive-disclosure` | exit 0 |

### Known limitations after the third pass

- pd-04 `content_bytes_omitted = 11850` remains provisional and must be
  reconciled with Phase B projector preview sizing before Phase D.
- The v1 contract still lacks `not_equals` and length/count operators.
  Per-case count assertions use indexed presence + index-N not_exists
  (e.g., `state.context_only[2] not_exists` to prove exactly two
  history entries).
- The validator mechanically checks pd-05 and pd-07 canonical_ids and
  per-case `execution_layer`; these are unchanged from the prior pass.

Phase C, Phase D, and Phase E remain **NOT AUTHORIZED.** Stopping for
Codex Gate A re-review.
