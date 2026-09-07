# Progressive disclosure — Step 2A contract and legacy measurement

Status: contract and source-surface baseline for the adopted ten-tool Step 2B
agent design. This directory freezes the contract that the Step 2B runtime
implementation must satisfy; it does not itself register MCP tools.

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
  for the ten-tool agent profile. It measures 10,524 combined description and
  input-schema bytes versus 31,553 for the full legacy surface: a 75.61% tool
  count reduction and a 66.65% serialized-byte reduction. These are interface
  measurements, not agent-effectiveness results.

The eight cases are deferred Step 3 evaluation contracts, not executed
Step 2B evidence. The oracle preserves this honest caveat: every
`measurement_status` in `cases.json` is `contract-only-not-executed`.

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
