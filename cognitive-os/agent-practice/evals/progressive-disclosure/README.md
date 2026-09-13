# Progressive disclosure — Step 2A contract, Step 3 evaluation contract

Status: contract and source-surface baseline for the adopted ten-tool Step 2B
agent design plus the Step 3 compact-mode structured-predicate evaluation
contract. This directory freezes the contract that the Step 2B and Step 3
runtime implementations must satisfy; it does not itself register MCP tools.

## Profile memberships

The adopted design has three profiles over the 41-tool legacy surface.

### Full profile (41 legacy tools)

The existing full surface is preserved unchanged. All 41 tools currently
registered in `src/tools/*.ts` remain available. No consolidated wrappers
are introduced in this directory.

### Agent profile (10 tools)

Exactly these ten tool names must appear in the agent profile:

1. `cognitive_agent_bootstrap`
2. `memory_prime`
3. `memory_find`
4. `memory_read`
5. `memory_write`
6. `epistemic_inspect`
7. `epistemic_admit`
8. `epistemic_append_receipt`
9. `cognitive_event_append`
10. `cognitive_event_read`

Each legacy operation maps exactly once, per the destination column of
`tool-mapping.json`:

| Legacy operation | Destination |
| --- | --- |
| `memory_search` | `memory_find:search` |
| `memory_recent` | `memory_find:recent` |
| `memory_changes` | `memory_find:changes` |
| `memory_activate` | `memory_find:related` |
| `memory_get` | `memory_read:get` |
| `memory_synapse_traverse` | `memory_read:links` |
| `memory_add` | `memory_write:add` |
| `memory_update` | `memory_write:update` |
| `memory_mark` | `memory_write:mark` |
| `memory_supersede` | `memory_write:supersede` |
| `memory_tag_add` | `memory_write:tag_add` |
| `memory_tag_remove` | `memory_write:tag_remove` |
| `epistemic_get` | `epistemic_inspect:get` |
| `epistemic_query` | `epistemic_inspect:query` |
| `epistemic_concept_diff` | `epistemic_inspect:diff` |
| `cognitive_event_trace` | `cognitive_event_read` |
| `memory_prime` | `memory_prime` |

`memory_prime` reclassifies from `legacy-only` to `everyday`. The agent
profile is exact-project first and opts into `_global`; `_global` means
only `_global` and never authorizes arbitrary foreign-project access.
Intentional cross-project wikilinks may be revealed only as reference
stubs in the agent profile, not auto-hydrated.

### Maintenance profile (18 tools)

Exactly these existing tools belong to the maintenance profile:

- `cognitive_policy_create`
- `cognitive_policy_evaluate`
- `cognitive_policy_lookup`
- `epistemic_integrity_check`
- `list_databases`
- `memory_boost`
- `memory_categories`
- `memory_decay`
- `memory_import_from_mem_sol`
- `memory_overview`
- `memory_projects`
- `memory_spread_stats`
- `memory_stale`
- `memory_stats`
- `memory_synapse_create`
- `sql_execute`
- `sql_introspect`
- `sql_query`

### Rejected families (must not appear)

- `memory_admin` — rejected; administrative operations remain separate
  maintenance tools rather than being folded into `memory_write`
- `cognitive_policy` — three separate maintenance tools (`cognitive_policy_create`, `cognitive_policy_evaluate`, `cognitive_policy_lookup`)
- `cognitive_bootstrap` — single `cognitive_agent_bootstrap` only
- `sql_substrate` — `sql_*` maintenance tools, no consolidated wrapper
- universal `mem_graph({ action, args })` dispatcher

## Authority and effect annotations

- `memory_find:related` inherits `memory_activate` access-tracking effects
  (increments memory and synapse access counters and timestamps). Must not
  be described as strictly read-only.
- `memory_read:get` inherits `memory_get` memory and synapse access tracking.
  Must not be described as strictly read-only.
- `memory_prime`, `cognitive_agent_bootstrap`, and `epistemic_inspect`
  remain zero-write.
- `epistemic_integrity_check` remains maintenance-only.
- `cognitive_policy_create`, `cognitive_policy_evaluate`, and
  `cognitive_policy_lookup` remain maintenance-only.
- `sql_query`, `sql_introspect`, and `sql_execute` remain
  maintenance-or-full only.
- `memory_import_from_mem_sol`, `memory_decay`, `memory_boost`, and
  `memory_synapse_create` remain maintenance-only.
- `epistemic_admit` and `epistemic_append_receipt` remain separate
  top-level authority surfaces, not subsumed under `memory_write`.
- `cognitive_event_append` and `cognitive_event_read` remain separate.
- `_global` means only `_global`; never authorizes arbitrary foreign
  projects.
- Foreign cross-project wikilinks may be revealed only as reference stubs
  in the agent profile.

`cognitive_current_guidance_search` and `cognitive_current_guidance_diagnose`
remain full-profile legacy fallbacks behind `cognitive_agent_bootstrap`,
not adopted into the agent profile.

## Artifacts

- `cases.json` contains the eight synthetic cases specified by Step 2. No live
  or personal database material is included. Their baseline traces are frozen
  expectations and deliberately marked `contract-only-not-executed`.
- `tool-mapping.json` maps every tool currently registered in `src/tools/*.ts`
  exactly once to an everyday, specialist, or legacy-only destination. It also
  records current inputs, scope, return shape, effects, fallback, and practice
  callers.
- `cases.schema.json` and `tool-mapping.schema.json` define the portable data
  contracts.
- `measure-step2a.mjs` validates those contracts, extracts the registration set
  from source, checks exact mapping coverage, and reports deterministic byte and
  count measurements to stdout. Strengthened checks confirm the adopted ten
  routes, the legacy-to-agent mapping, the maintenance list, and the
  rejected-family prohibition.
- `legacy-tool-surface-baseline.json` records the current 41-tool legacy
  measurement: description bytes, input-schema bytes, combined bytes, and
  per-registration-group totals. Its source fingerprint identifies the exact
  registration files measured even when the working tree is dirty. The receipt
  is labeled `legacy-full-surface`.
- `agent-tool-surface-baseline.json` records the real MCP `tools/list` surface
  at the Step 2 boundary, before Step 3 added `response_mode` to the shared
  bootstrap schema. That frozen receipt measures 10,524 combined description
  and input-schema bytes versus 31,553 for the full legacy surface. The current
  Step 3 surface measures 10,697 versus 31,726 bytes; both preserve a 75.61%
  tool-count reduction, while the current serialized-byte reduction is 66.28%.
  These are interface measurements, not agent-effectiveness results.

The eight cases began as deferred Step 3 evaluation contracts rather than Step
2B evidence. Phase D has now executed their declared layers: seven are
`executed-pass` and `pd-06-source-revised` is an honest `executed-gap` backed by
both independent-run witnesses.

## Phase D executed-status rules

After Phase D execution lands and the receipt at
`phase-d-receipt.json` (in this directory) passes every receipt
validation check, each case may have its `baseline_trace.measurement_status`
updated from the default `contract-only-not-executed` to one of:

- `executed-pass` — the case ran its declared execution layer, produced
  raw and normalized evidence, passed determinism, passed DB/access
  checks, passed the structured predicate plan, and the receipt
  independently verifies its compact_digest, byte count, and semantic
  hash.
- `executed-gap` — the case ran its declared execution layer, produced
  raw and normalized evidence, passed determinism, passed DB/access
  checks, but at least one structurally-valid predicate resolved
  against a captured response that did not match what the case
  contract required. This is a deterministic product-level miss.
- `executed-unavailable` — the case cannot execute in the current
  runtime because the required typed path is not implemented.

Every status other than `contract-only-not-executed` MUST carry a
`baseline_trace.phase_d_receipt_pointer` whose value is the case id.
`validate-step3-contract.mjs` cross-checks both receipt runs against the case
status and execution layer. It independently verifies canonical raw wire and
UTF-8 bytes, compact digest, semantic hash, mutation and scope verdicts,
cross-run determinism, and the retained three-call witness for `pd-06`. It exits
nonzero on any mismatch.

`run-step3-cases.mts` writes a validated receipt and exits zero only when every
case passes. A correctly evidenced `executed-gap` is preserved in the receipt
but produces exit code 1 with `status="phase-d-runner-product-gap"`; this keeps
automation fail-closed without discarding evidence for unrelated passing cases.

Do NOT change a case's status from `contract-only-not-executed` until
the corresponding Phase D receipt entry has been generated, validated,
and recorded.

## Step 3 structured-predicate evaluation contract

Phase A of the Step 3 phase-gated execution plan
(`docs/Update/STEP_3_PHASE_GATED_EXECUTION_PLAN.md` §4) migrates the eight
cases from literal-substring grading to structured-predicate grading. The
legacy `required_signals` and `forbidden_signals` strings remain in each case
as human-readable documentation; they no longer govern compact-mode grading.
Compact-mode grading uses `required_predicates` and `forbidden_predicates`,
each entry a v1 JSON-Pointer predicate from
`STEP_3_COMPACT_CONTEXT_DELIVERY_DESIGN.md` §3 D8:

```ts
interface CompactCasePredicate {
  pointer: string;        // RFC 6901 JSON Pointer
  operator: 'equals' | 'includes' | 'excludes' | 'exists' | 'not_exists';
  value?: string | number | boolean | null | object;
}
```

Rules enforced by `structured-predicate.mjs`:

- RFC 6901 pointer decoding with `~0` and `~1` tilde escapes; bare `~` or
  any escape other than `~0` / `~1` fails closed (rejected).
- Empty pointer `""` addresses the root document.
- `value` is required for `equals` / `includes` / `excludes` and forbidden
  for `exists` / `not_exists`. Array values are forbidden across all operators.
- Predicates are exact-equality on scalars and recursive partial-match on
  object array elements (extra candidate keys are ignored).
- No coercion, no regular expressions, no executable expressions, no
  free-form query language.
- Malformed pointers, malformed predicates, and unresolved pointers all
  fail the case rather than being silently treated as absent.

Each case declares a `fixture_intent`:

- `lexical_discovery` (pd-01 only) — the case tests whether the synthetic
  summary contains the declared query vocabulary. Until the summary is
  aligned, the case cannot pass even when the structured predicates
  describe the expected envelope shape.
- `deterministic_source_projection` (pd-02 through pd-08) — the case
  tests compact projection of a known source; the snapshot can use
  `canonical_ids` and the case does not require a lexical hit.

Each case began with
`baseline_trace.measurement_status: "contract-only-not-executed"`. Phase D
evidence has now updated seven cases to `executed-pass` and pd-06 to
`executed-gap`, each with its declared execution layer and receipt pointer.

### Step 3 artifacts

- `structured-predicate.mjs` — pure RFC 6901 + operator evaluator; no I/O,
  importable from any Node context.
- `structured-predicate.test.mjs` — `node --test` suite; covers all five
  operators, escaped tokens, missing pointers, scalar mismatch without
  coercion, recursive partial matching, malformed operators, forbidden
  extra properties, and proof that evaluation does not search raw
  serialized text.
- `case-fixtures.mjs` — eight representative compact envelopes plus
  eight counterexample envelopes. The representative envelopes model
  the projector output for each case; the counterexamples model the
  failure mode each case is designed to detect.
- `case-fixtures.test.mjs` — `node --test` suite that runs every case
  plan against its representative envelope (must pass), every case
  plan against its counterexample (must fail), and a contract-path
  resolution check on every required and forbidden predicate.
- `validate-step3-contract.mjs` — Step 3 contract validator. Confirms
  every case has `fixture_intent` (matching design Section 11), every
  predicate passes `validatePredicate`, every pointer decodes, every
  case status agrees with both receipt runs, pd-04, pd-05, pd-07, and
  pd-08 carry the required `canonical_ids` in their machine-readable request,
  each case declares the expected `execution_layer` per Codex review,
  every required predicate resolves against the representative
  envelope (catches nonexistent paths), every case plan passes
  against its fixture, every case plan fails against its counterexample,
  and no M3-owned file leaks a personal path or live database
  reference.

### Operator-level semantics

`evaluatePredicate` reports `passed = true` when the predicate's literal
condition is met:

- `equals`: values strictly match.
- `includes`: array contains a matching element (scalar strict-equal
  or object recursive partial-match).
- `excludes`: array contains NO matching element.
- `exists`: pointer resolves in the envelope.
- `not_exists`: pointer does not resolve in the envelope.

### Plan semantics

`evaluatePlan` splits predicates into required and forbidden. Required
predicates must all pass; forbidden predicates must describe the BAD
condition literally so a `passed = true` on a forbidden predicate fires
the plan.

To express "this must NOT happen" inside `required_predicates`, use the
operator that returns `passed = true` when the thing is absent:

- `required_predicates: [{ operator: excludes, value: X }]` — passes
  when X is absent.
- `required_predicates: [{ operator: not_exists }]` — passes when the
  pointer does not resolve.

To express "this MUST NOT happen" inside `forbidden_predicates`, describe
the bad condition itself:

- `forbidden_predicates: [{ operator: includes, value: X }]` — fires
  when X is present.

Never place `excludes` or `not_exists` inside `forbidden_predicates`;
those operators pass when the thing is absent, which would be a
forbidden predicate that always holds.

### Run the Step 3 evaluator suite

From the repository root:

```powershell
python scripts/validate-progressive-disclosure-schemas.py
node cognitive-os/agent-practice/evals/progressive-disclosure/measure-step2a.mjs
node --test cognitive-os/agent-practice/evals/progressive-disclosure/structured-predicate.test.mjs
node --test cognitive-os/agent-practice/evals/progressive-disclosure/case-fixtures.test.mjs
node cognitive-os/agent-practice/evals/progressive-disclosure/validate-step3-contract.mjs
git diff --check -- cognitive-os/agent-practice/evals/progressive-disclosure
```

A Phase A pass requires:

- Draft 2020-12 validation: both schemas and instances PASS.
- `measure-step2a.mjs`: 41 registered, 41 mapped, exactly 10 proposed
  everyday routes, `memory_prime` reclassified everyday, prohibited
  family names absent, every workflow covered.
- `structured-predicate.test.mjs`: all 65 unit tests pass (61
  base + 4 explicit required+excludes / forbidden+includes semantics
  tests added per Codex review).
- `case-fixtures.test.mjs`: all 32 contract-harness tests pass
  (8 representative envelopes pass their plans, 8 counterexample
  envelopes fail their plans, 16 contract-path resolution checks pass).
- `validate-step3-contract.mjs`: every case carries `fixture_intent`,
  `required_predicates`, `forbidden_predicates`, `canonical_ids`
  (where required), and the expected `execution_layer`; every
  predicate is structurally valid; the eight frozen case IDs are
  present in order; every executed `measurement_status` agrees with both
  receipt runs; every required predicate resolves
  against its representative envelope; every plan passes its
  representative envelope and fails its counterexample; no M3-owned
  file leaks a personal path.
- `git diff --check`: no whitespace errors within the directory.

The Phase A fixtures remain contract-level examples. Phase D separately ran
the declared execution layer twice for every case and is the sole authority for
the executed statuses recorded in `cases.json`.

## Run the oracle

From the repository root:

```powershell
node cognitive-os/agent-practice/evals/progressive-disclosure/measure-step2a.mjs
```

Measure actual profile surfaces through an in-memory MCP client/server pair:

```powershell
npx tsx scripts/tools-measure.mts --profile=full
npx tsx scripts/tools-measure.mts --profile=agent
npx tsx scripts/tools-measure.mts --profile=maintenance
```

A pass requires:

- exactly the eight frozen case IDs;
- synthetic-only fixtures with no personal path/name marker;
- every live `server.tool` registration mapped exactly once;
- no mapped tool absent from source;
- exactly ten proposed everyday routes (not 8–10);
- `memory_prime` is among the ten routes and classified `everyday`;
- every declared route belongs to at least one workflow;
- every mapped legacy operation maps to exactly one of the ten routes;
- no rejected family name appears in `proposed_everyday_routes` or in any
  `destination` field;
- complete mapping fields and non-overlapping destination classification;
- all four workflows covered.

The measurement reports serialized UTF-8 bytes for fixture inputs and mapping
contracts, source registration-segment bytes, and expected legacy call counts.
It does **not** claim runtime response size, latency, provider token use, or
agent effectiveness. Those require the later disposable-database and optional
provider execution described in the working plan.

## Draft 2020-12 validation (separate step)

The custom oracle above is structural-only — it does not run a real JSON
Schema validator against the instance documents. Before declaring the
contract valid, run Draft 2020-12 validation separately:

```powershell
python scripts/validate-progressive-disclosure-schemas.py
```

This catches `additionalProperties` rejections and other structural
failures the custom oracle misses (notably: both schemas set
`additionalProperties: false` at the root and require an explicit
`$schema` property declaration, which the instance documents include
for editor and tool discovery).

## Scope and compatibility assumptions

- the existing full surface remains a compatibility surface;
- the agent surface is exact-project first and opts into `_global`;
- `_global` inclusion never means arbitrary foreign-project access;
- intentional cross-project wikilinks remain stored and appear as reference
  stubs until a deliberate target-project hydration;
- access-tracking reads are labeled rather than described as zero-write.

Any later source change that adds, removes, or renames a registered tool
makes this oracle fail until the mapping is consciously reconciled.
The proposed ten routes are stable; the underlying source may grow new
maintenance tools without re-opening the agent-profile contract.
