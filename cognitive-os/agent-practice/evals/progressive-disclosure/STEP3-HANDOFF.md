# Step 3 design-review handoff

Author: M3 (this turn, 2026-09-07). Status: pre-compaction handoff.
Purpose: post-compact M3 picks up Step 3 design review without re-deriving context.

## Where we are

- Step 2 verified and committed locally as `af95264` on `epistemic-phase-a-recovery`. Per `the canonical current-state projection` canonical current-state.
- Real MCP `tools/list` measurement: full=41 tools / 31,553 combined bytes; agent=10 tools / 10,524 bytes. 66.65% byte reduction, 75.61% count reduction.
- Step 2A contract cleanup committed in working tree (uncommitted, awaiting Codex integration review) — see the eight files in `cognitive-os/agent-practice/evals/progressive-disclosure/` plus `scripts/tools-measure.mts`.

## Lane boundary

- **M3 owns:** `cognitive-os/agent-practice/evals/progressive-disclosure/**`, `scripts/tools-measure.mts`
- **Terra owns:** `src/**`, `tests/**`
- **Do not modify** `docs/CURRENT_AGENT_ALIGNMENT.md`, `docs/Update/MEM_GRAPH_UPDATE_WORKING_PLAN.md`, `practice.v1.json`, lockfiles, `.agents/**`.
- **Do not commit or push** without explicit operator authorization.

## Step 3 spec — what to know

Read `docs/Update/MEM_GRAPH_UPDATE_WORKING_PLAN.md` lines 445-555 before reviewing.

Key contract points:

- **Output:** opt-in compact response from `cognitive_agent_bootstrap`, with a pure projection function. **No new MCP tool, no schema migration.** Adds `response_mode: "legacy" | "compact"` to bootstrap input (default `legacy` when omitted).
- **Module path:** proposed `src/cognitive/bootstrap-disclosure.ts` (Terra's code; M3 reviews the contract, not the code).
- **Compact envelope fields:** scope, source snapshot identity, request mode, orientation status (complete/partial/unavailable), structured task-state lanes when available (objective / done-condition / constraints / next-action), governing candidate references, current/open-state previews, warning + unresolved code categories, expansion references, omission counts + `requires_expansion` markers.
- **Scope contract:** project-first, opt-in `_global`. `include_global=false` must not surface `_global` records. Step 1.5 three-pattern inventory is the implementation contract.
- **Size budget:** 8 KiB default serialized UTF-8. Essential content overflow → explicit partial result. Never silently drop a constraint.
- **Expansion triggers** must map to legacy ops; in agent profile, return their mapped Step 2 equivalents. Never instruct expansion through a tool absent from the active profile.
- **Determinism:** deterministic ordering; digest compact output separately from full output.
- **No hidden writes.** Existing `memory_get` access-counter updates are not "the whole recovery path is zero-write."

## M3's review checklist (Step 3 → contract surface in my lane)

When GPT's design lands, cross-check against these:

1. **`response_mode` input field** — does it conflict with the existing bootstrap input schema (Zod)? The change is in `src/tools/cognitive.ts` (Terra). M3 verifies Draft 2020-12 still validates the Step 2A contract post-change. Run `python scripts/validate-progressive-disclosure-schemas.py`.

2. **Expansion trigger → agent tool mapping** — verify each expansion trigger in the design maps cleanly to one of the ten agent tools (no rejected families, no hidden legacy tools). Source of truth: `tool-mapping.json`. Specifically:

   | Trigger from Step 3 spec | Should map to (agent tool) |
   |---|---|
   | Applicable guidance needs verification → fetch with `memory_get` | `memory_read:get` |
   | Receipt / event / decision disputed → bounded `cognitive_event_trace` | `cognitive_event_read` |
   | Epistemic revision needs inspection → `epistemic_get`, concept diff | `epistemic_inspect:get`, `epistemic_inspect:diff` |
   | History / analogy → existing search/activation | `memory_find:search`, `memory_find:related` |
   | Source version changed → refresh orientation | `cognitive_agent_bootstrap` (re-call) |

3. **Eight-case acceptance preservation** — Step 3 acceptance says *"all eight Step 2 cases pass deterministic checks."* Run `node measure-step2a.mjs` after Step 3 lands. The oracle must still report `contract-only-not-executed` for all eight; the Step 2A contract is unchanged by Step 3.

4. **Compact envelope shape vs my mapping contract** — if Step 3 adds fields that the eight-case `expected.required_signals` / `forbidden_signals` reference, my cases.json may need a contract clarification (e.g., `objective` becomes `objective_resolved` vs `objective_unresolved`). Update `cases.schema.json` if needed. Re-run Draft 2020-12.

5. **Forbidden-family prohibition carries forward** — Step 3 must not reintroduce `memory_admin`, `cognitive_policy`, `cognitive_bootstrap`, `sql_substrate`, or universal `mem_graph` dispatcher. Verify by inspecting the design and cross-checking against my Step 2A oracle's prohibition list (in `measure-step2a.mjs`).

6. **`_global` and foreign wikilink invariants** — Step 3 must not widen scope beyond the caller's request. `include_global=false` means no `_global` records surface. Foreign cross-project wikilinks appear as reference stubs only. Cross-check the design's scope handling against `the canonical current-state projection`'s scope contract.

7. **Size budget is a hard ceiling, not a target** — 8 KiB default is a deterministic engineering budget. If the design has "soft" budget handling (e.g., "try to fit under 8 KiB but allow more"), that's a flag.

8. **Determinism preserved** — same-input, same-output. The design should commit to a deterministic ordering and explicit overflow handling. No model-generated compression in this step.

## What M3 should NOT do during review

- Don't write code under `src/` or `tests/`.
- Don't modify the eight-case `expected.required_signals` / `forbidden_signals` to make Step 3 pass. Step 3 acceptance runs the *same* eight cases. If Step 3 design breaks them, that's a design defect to surface.
- Don't loosen authority/effect annotations in `tool-mapping.json` to accommodate Step 3 expansion triggers. The mapping contract is anchored on the ten-tool design.
- Don't commit or push.

## What to do if the design conflicts with the contract

Surface the conflict clearly to the operator with three pieces of evidence:

1. The specific clause in `tool-mapping.json` / `measure-step2a.mjs` / `cases.json` that conflicts.
2. The exact trigger or field in the Step 3 design that conflicts.
3. The proposed resolution (which contract to update, or which design element to revise).

Do not silently resolve by relaxing the contract. Step 3 is a Step 1.5 / Step 2 extension — it cannot widen authority or expand rejected families.

## Open questions to bring into the review

- Does the compact envelope expose `[[id]]` references to canonical mem-graph IDs, or only semantic descriptors? My eight-case contract uses literal substrings (e.g., `source_id=107`); Step 3 may need to upgrade to structured predicates. That's a contract change, not a measurement artifact.
- Does the compact envelope include `bootstrap_digest`? The legacy response has it. If compact omits it, host adapters digesting the compact payload need a separate digest strategy.
- Are `epistemic_inspect` variants (`get`, `query`, `diff`) addressed in the compact expansion triggers, or only `epistemic_get`? The Step 3 spec calls out `epistemic_get` and "concept diff" — verify both.
- The "agent profile" in `the canonical current-state projection` and `CURRENT_AGENT_ALIGNMENT.md` references `epistemic_inspect` as a single tool. The expansion triggers need to disambiguate to the correct variant. The design should not instruct the host to call `epistemic_inspect` without specifying the variant.

## Files M3 can touch in this workstream

- `cognitive-os/agent-practice/evals/progressive-disclosure/README.md` — update with Step 3 references if the contract surface changes
- `cognitive-os/agent-practice/evals/progressive-disclosure/tool-mapping.json` — update mapping metadata if expansion triggers require new destination declarations (rare; the existing 10 routes should cover everything)
- `cognitive-os/agent-practice/evals/progressive-disclosure/cases.json` — **only** if Step 3 changes the eight-case signal vocabulary, and **only after operator authorization**
- `cognitive-os/agent-practice/evals/progressive-disclosure/cases.schema.json` — same condition as `cases.json`
- `cognitive-os/agent-practice/evals/progressive-disclosure/measure-step2a.mjs` — strengthen if the contract surface changes
- `scripts/tools-measure.mts` — extend if Step 3 introduces new measurement paths (M3 owns this; GPT already added `--profile` runtime measurement)

## Memory cross-references for post-compact primer

- `the canonical current-state projection` — current-state canonical (Step 2 verified, Step 3 next)
- `the error-resolution pattern` — error-resolution pattern, applied for schema/contract vocabulary mismatches
- `the ACT-to-working-layer pattern` — ACT output → working-layer canonical pattern
- `the AI agentic session-start foundations` — AI agentic session-start foundations (5-layer substrate)
- `the canonical current-state projection` — Cognitive OS current state (now superseded by `the canonical current-state projection`)
- `the scope-boundary canonical record` — Cognitive OS scope boundary
- `the heredoc-and-commit-message hygiene lesson` — Heredoc artifact (commit-message hygiene lesson, applied throughout this session)

## Step 3 review entry point

1. Read `docs/Update/MEM_GRAPH_UPDATE_WORKING_PLAN.md` lines 445-555.
2. Read GPT's Step 3 design (wherever it lands — likely a new doc or a working-tree file).
3. Read `CURRENT_AGENT_ALIGNMENT.md` for operator-facing direction.
4. Run `python scripts/validate-progressive-disclosure-schemas.py` and `node measure-step2a.mjs` to confirm pre-Step-3 baseline.
5. Walk through the M3 review checklist above.
6. Surface conflicts to operator with three pieces of evidence each.
