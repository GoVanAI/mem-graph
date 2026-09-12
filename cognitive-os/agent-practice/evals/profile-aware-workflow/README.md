# Profile-aware workflow — Step 4 Phase 4A evaluation contract

Status: contract-only Phase 4A. Frozen evaluation contract for the complete
profile-aware workflow before AGY changes agent-practice guidance. No cases
have been executed yet; every case remains `contract-only-not-executed` until
Phase 4C execution lands.

This directory freezes the deterministic, machine-readable contract that
evaluates both arms for each of the eight frozen Step 3 progressive-disclosure
intentions. Phase 4A does not run any agent; it freezes the contract that
Phase 4C execution must satisfy.

## Profile memberships (mirrored from source)

`tool-profiles-mirror.mjs` derives the canonical profile membership from the
committed source-of-truth at module load time:

- **Full profile (41 tools)** — every `server.tool('<name>', …)` registration in
  `src/tools/*.ts`.
- **Agent profile (10 tools)** — mirrored from
  `src/tool-profiles.ts:42-46 AGENT_TOOL_NAMES`.
- **Maintenance profile (18 tools)** — mirrored from
  `src/tool-profiles.ts:35-41 MAINTENANCE_TOOL_NAMES`.

`validate-step4-contract.mjs` compares `cases.json` against the mirror via set
equality so a drift in either `src/tools/` or `src/tool-profiles.ts` fails
the contract.

## Required contract checks

Each Phase 4A case freezes both arms:

- **control** — `profile: full`, `bootstrap_response_mode: legacy`. The agent has
  access to the full 41-tool legacy surface.
- **candidate** — `profile: agent`, `bootstrap_response_mode: compact`. The agent
  has access to only the ten everyday tools.

For each arm the contract declares:

1. `synthetic_request` — the public bootstrap input. Evaluation-only comparison
   inputs are forbidden.
2. `allowed_tool_names` — the tools the profile exposes. Mirrored from the
   profile constants for the contract.
3. `prohibited_tool_names_or_families` — names that must never appear in the
   transcript.
4. `required_tool_calls` — minimum required calls (with `excluded_tools`).
5. `allowed_call_cardinality` — `{ min, max }`.
6. `required_ordering_relationships` — predecessor/successor constraints,
   including `bootstrap_before_mutation` for the agent workflow rule.
7. `required_argument_predicates` — RFC 6901 predicates over
   `/transcript/<i>/args/...`.
8. `response_predicates` — RFC 6901 predicates over
   `/transcript/<i>/response_envelope/...` reusing the Step 3 operator semantics.
9. `expected_scope` — exact project_id, include_global, and
   `global_inclusion` ('disabled' or 'explicit' only — never 'enabled' or 'n/a').
10. `expected_bootstrap_mutation_or_access_behavior` — zero-write, no access
    tracking.
11. `expected_expansion_behavior` — required expansion calls must be present.
12. `expected_outcome` — orient, orient-and-verify, refresh-required, or
    unavailable-honest.
13. `measurement_status` — every Phase 4A arm is `contract-only-not-executed`.
14. `metric_policy` — frozen measurement fields including the
    `applies_large_or_small_threshold` label.

## Single grader

`arm-grader.mjs` exports `gradeTranscriptAgainstArm(transcript, caseDoc, arm)`
which returns a structured grade with one check per contract field:

| Check | Stable failure code |
| --- | --- |
| `tool_membership` | `tool_not_in_profile` |
| `excluded_tools` | `excluded_tool_present` |
| `prohibited_families` | `prohibited_family_present` |
| `call_cardinality` | `cardinality_out_of_range` |
| `ordering_relationships` | `ordering_violation` |
| `required_calls` (per-call args/response predicates, expansion_route, access tracking) | `required_call_missing`, `required_call_arg_mismatch`, `required_call_response_mismatch`, `expansion_route_unavailable_called`, `access_tracking_lie` |
| `arm_level_predicates` (arm-level `required_argument_predicates` + `response_predicates`) | `required_argument_predicate_failed`, `response_predicate_failed` |
| `scope_preservation` (incl. missing project_id) | `scope_not_preserved`, `scope_missing_project_id` |
| `tool_family_args` | `scope_missing_project_id` |
| `orientation_invariant` (complete → no expansion; partial/unavailable → expansion) | `orientation_invariant_violation` |
| `search_before_create` | `search_before_create_violation` |
| `expected_expansion_behavior` | `required_expansion_not_called`, `optional_expansion_not_allowed` |
| `bootstrap_behavior` | `bootstrap_mutation_violation` |
| `response_mode` | `compact_response_mode_missing`, `legacy_response_mode_unexpected` |
| `retry_count` (compact retry cardinality from frozen threshold) | `retry_count_exceeded` |
| `pd06_honest_refresh` | `pd06_version_mismatch_fabrication` |

Both representative and counterexample fixtures run through this single
grader. No bespoke detection_plan authority remains.

## Required workflow behaviors (encoded in every arm)

| Behavior | Encoding |
| --- | --- |
| Resolve exact project_id before retrieval | `synthetic_request.project_id` mandatory; equals `expected_scope.project_id`. |
| include_global defaults to false | `synthetic_request.include_global` is `false` (or explicit). |
| No arbitrary foreign-project hydration | `allowed_tool_names` excludes SQL, maintenance, hidden legacy. |
| _global only when explicitly requested | `expected_scope.global_inclusion` ∈ {'disabled', 'explicit'}; no `enabled` / `n/a`. |
| Every expansion preserves originating scope | `required_argument_predicates` check `args/project_id`; tool family args require `project_id`. |
| Candidate prefers compact bootstrap | `arms.candidate.bootstrap_response_mode = "compact"`. |
| Compact mode is never the server default | `arms.control.bootstrap_response_mode = "legacy"`. |
| Compact unsupported-arg retry, cardinality 1 | `frozen_thresholds.unsupported_argument_retry_max = 1`; grader's `retry_count` enforces. |
| Profile awareness | `allowed_tool_names` ⊆ mirror; prohibited families checked. |
| Compact expansion route hygiene | `required_tool_calls.calls[*].expansion_route` declares `route_available`/`tool_in_active_profile`/`args_validate_structurally`/`preserve_scope`. |
| Authority | Predicates target scope, status, source identity; no predicate awards authority from rank. |
| Contradictions remain warnings | pd-03 requires `warnings/0 = explicit_contradiction_present` rather than rejecting. |
| Bootstrap is zero-write | `expected_bootstrap_mutation_or_access_behavior.writes_database = false` and `touches_access_tracking = false`. |
| Access-tracking expansion labeled honestly | response_predicates check expansion's `access_tracking`. |
| pd-06 honest refresh/unresolved | Public bootstrap has no cross-call comparison input. The contract records `unavailable-honest` and requires both `refresh_required` and `version_mismatch` to remain absent. |
| Search-before-create | grader detects `memory_write` without preceding search. |
| No provider token claims | `metric_policy.claim_provider_token_savings = false`. |

## Frozen thresholds (encoded in cases.json `frozen_thresholds`)

| Threshold | Value |
| --- | --- |
| Legacy initial > 8 KiB candidate reduction | ≥ 30 % |
| Small legacy candidate growth | ≤ 10 % |
| Median recovery tool-call increase | ≤ 1 |
| Median total context bytes | must not increase |
| Unsupported-argument retry | exactly 1 |
| Latency | excluded from determinism hashes |

The validator enforces that `cases.json` carries these exact values.

## Volatile and deterministic field exclusions

Encoded in `cases.json` under `volatile_field_exclusions` and
`deterministic_field_exclusions`. Latency, timestamps, and provider tokens
are excluded from any future determinism hash.

## Counterexample fixtures (10 families)

Each counterexample carries `expected_failure_code` and runs through the same
`arm-grader.mjs` as the representative. The grader's `failure_codes` array
must include the expected code.

| Family | Detection | Expected failure code |
| --- | --- | --- |
| 1 | Agent profile calls `memory_get` instead of `memory_read` | `tool_not_in_profile` |
| 2 | Agent profile calls SQL or maintenance tool | `tool_not_in_profile` |
| 3 | Compact request silently widens `include_global` | `required_call_arg_mismatch` |
| 4 | Expansion calls a route marked `route_available=false` | `expansion_route_unavailable_called` |
| 5 | Expansion names a tool absent from the active profile | `tool_not_in_profile` |
| 6 | Governing guidance used without required verification | `required_call_missing` |
| 7 | Unsupported `response_mode` retried more than once | `retry_count_exceeded` |
| 8 | Access-tracking expansion described as zero-touch | `access_tracking_lie` |
| 9 | pd-06 fabricates `version_mismatch` without trusted input | `pd06_version_mismatch_fabrication` |
| 10 | Final answer correct but required expansion never called | `required_call_missing` |

## Artifacts (9 owned files)

| File | Purpose |
| --- | --- |
| `README.md` | This file. |
| `cases.schema.json` | Draft 2020-12 schema for the contract document. |
| `cases.json` | The contract document itself (8 cases × 2 arms + counterexamples array). |
| `tool-profiles-mirror.mjs` | Derives full/agent/maintenance lists from `src/tools/*.ts` and `src/tool-profiles.ts`. |
| `arm-grader.mjs` | Single grader enforcing every contract field. |
| `transcript-fixtures.mjs` | Representative + counterexample fixtures with envelope builders. |
| `transcript-fixtures.test.mjs` | `node --test` suite: 36 tests (17 representative + 10 counterexample + 3 structural + 6 adversarial). |
| `validate-step4-contract.mjs` | Mechanical validator. |
| `STEP4-PHASE-A-HANDOFF.md` | Phase 4A handoff receipt. |

## How to run Phase 4A

From the repository root:

```powershell
python scripts/validate-progressive-disclosure-schemas.py
node cognitive-os/agent-practice/evals/progressive-disclosure/validate-step3-contract.mjs
node --test cognitive-os/agent-practice/evals/profile-aware-workflow/*.test.mjs
node cognitive-os/agent-practice/evals/profile-aware-workflow/validate-step4-contract.mjs
npm run practice:check
npx tsc --noEmit
node cognitive-os/agent-practice/evals/profile-aware-workflow/validate-step4-contract.mjs # trailing-whitespace scan is part of this run
git status --short
```

A Phase 4A pass requires:

- Draft 2020-12 validation: cases.json vs cases.schema.json PASS.
- Step 3 contract validator: unchanged from committed Gate E state.
- Fixture tests: 36 / 36 PASS.
- Step 4 contract validator: every required check PASS.
- `npm run practice:check`: unchanged.
- `npx tsc --noEmit`: unchanged.
- Trailing-whitespace scan: 0 issues across 9 owned artifacts.
- `git status --short`: no modifications outside the owned directory.

## Boundary statement

Phase 4A freezes the contract. No agent is run. No transcript is executed.
No provider tokens are claimed. No live database is touched. The contract
remains `contract-only-not-executed` until Phase 4C execution lands.
