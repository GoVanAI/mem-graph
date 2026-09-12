# Step 4 Phase 4A — final contract handoff

Status: **ready for Codex Gate 4A closeout**

Date: 2026-09-11

Starting/ending HEAD: `7ab0f0e` (no commit or push)

## Scope and outcome

Phase 4A freezes the profile-aware workflow evaluation contract. All eight
cases remain `contract-only-not-executed`; Phase 4C has not started. The final
repair aligns fixtures and grading with the public MCP schemas and preserves
the known pd-06 product gap instead of manufacturing comparison evidence.

## Final repair findings and resolutions

| Finding | Resolution |
| --- | --- |
| The public bootstrap accepts opaque `task_state`, not top-level `task_id`. | pd-02 requests and predicates now use `task_state.task_id`; the family-schema grader rejects top-level `task_id`. |
| Public pd-06 compact calls have no cross-call version-comparison input. | The representative and contract require `unavailable-honest`; neither `refresh_required` nor `version_mismatch` may be fabricated. Family 9 proves fabrication is rejected. |
| Grader route validation required compact expansion metadata on legacy and fallback calls. | Required route metadata is validated as contract data. A returned compact route is additionally checked when present; legacy/fallback calls are not forced to invent one. |
| Public tool schemas were only approximated. | `epistemic_get` now requires `project_id`; `memory_find` requirements are operation-specific; unexpected arguments fail closed; `memory_read:get` and legacy `memory_get` fixtures match production shapes. |
| History expansion used search rather than the projector's emitted direct-read routes. | pd-07 now follows two `memory_read:get` routes for sources 112 and 113, with honest access-tracking effects and three-call cardinality. |
| Degraded task state claimed complete orientation. | pd-08 now requires `status=partial`, `task_state=unavailable`, and `requires_expansion=true`. |
| Retry grading counted ordinary re-bootstrap calls. | Retry counting opens only after an unsupported compact-mode response and permits exactly one fallback retry. Family 7 proves a second retry is rejected. |
| Optional expansion prohibition was not adversarially proved. | The grader rejects undeclared non-bootstrap calls when `may_call_optional_expansions=false`; a focused test proves the stable failure code. |
| Fixture and contract counterexample metadata could drift. | The validator compares family, case, arm, detection reason, and expected failure code between `cases.json` and executable fixtures. |

## Owned artifacts

Only `cognitive-os/agent-practice/evals/profile-aware-workflow/` is changed:

- `README.md`
- `cases.schema.json`
- `cases.json`
- `tool-profiles-mirror.mjs`
- `arm-grader.mjs`
- `transcript-fixtures.mjs`
- `transcript-fixtures.test.mjs`
- `validate-step4-contract.mjs`
- `STEP4-PHASE-A-HANDOFF.md`

Production source, repository tests, generated adapters, Step 3 artifacts,
the working plan, and the root README remain untouched.

## Frozen profile and threshold contract

- Full profile: 41 source-derived legacy tools.
- Agent profile: 10 source-derived workflow tools.
- Maintenance profile: 18 source-derived maintenance tools.
- Large legacy minimum: 8,192 bytes.
- Required large-response reduction: at least 30%.
- Allowed small-response growth: at most 10%.
- Median call increase: at most 1.
- Median context bytes: must not increase.
- Unsupported compact argument: at most one retry.
- Provider token savings: not claimed.

## Counterexample coverage

All ten families run through `gradeTranscriptAgainstArm`:

| Family | Violation | Expected code |
| --- | --- | --- |
| 1 | Agent profile calls legacy `memory_get`. | `tool_not_in_profile` |
| 2 | Agent profile calls SQL/maintenance. | `tool_not_in_profile` |
| 3 | Request silently widens global scope. | `required_call_arg_mismatch` |
| 4 | Call follows a route marked unavailable. | `expansion_route_unavailable_called` |
| 5 | Expansion uses a tool outside the active profile. | `tool_not_in_profile` |
| 6 | Required governing-source verification is omitted. | `required_call_missing` |
| 7 | Unsupported compact mode is retried more than once. | `retry_count_exceeded` |
| 8 | Expansion metadata lies about access tracking. | `access_tracking_lie` |
| 9 | pd-06 fabricates a version mismatch. | `pd06_version_mismatch_fabrication` |
| 10 | Required expansion is never called. | `required_call_missing` |

## Verification contract

Run from the repository root:

```powershell
python scripts/validate-progressive-disclosure-schemas.py
node cognitive-os/agent-practice/evals/progressive-disclosure/validate-step3-contract.mjs
node --test cognitive-os/agent-practice/evals/profile-aware-workflow/*.test.mjs
node cognitive-os/agent-practice/evals/profile-aware-workflow/validate-step4-contract.mjs
npm run practice:check
npx tsc --noEmit
git diff --check -- cognitive-os/agent-practice/evals/profile-aware-workflow
git status --short
```

Expected focused evidence: 36/36 fixture tests, eight cases, 17 representative
fixtures, ten counterexamples, nine owned artifacts, schema PASS, and zero
validator errors.

## Verified results

- Progressive-disclosure Draft 2020-12 schemas: PASS.
- Step 3 contract validator: PASS, eight cases and zero warnings.
- Phase 4 fixture suite: 36 passed, zero failed or skipped.
- Phase 4 contract validator: PASS, eight cases, 17 representatives, ten
  counterexamples, nine artifacts, zero errors.
- Agent-practice generated-adapter freshness: PASS.
- TypeScript `--noEmit`: PASS.
- Full repository suite: 48 files passed; 586 tests passed and one skipped by
  design.
- Stale-claim, JSON parse, leak, trailing-whitespace, and owned-scope checks:
  PASS.

One focused Node invocation failed before test loading with Windows
`spawn EPERM`. The unchanged command succeeded on its single bounded retry and
then succeeded again as part of the complete gate run; no artifact repair was
needed for that environmental failure.

## Non-actions

No live database, provider session, production runtime, commit, or push is part
of Phase 4A. Phase 4C execution remains future work.
