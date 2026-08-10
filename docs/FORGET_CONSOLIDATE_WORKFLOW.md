# Forget/consolidate operator workflow (2026-08-10)

> **Epistemic classification (Gather.5):**
> - **External (reported):** the three tools `memory_stale`, `memory_mark`, `memory_decay` exist (verified via `src/tools/memory-graph.ts` + `memory-write.ts`); their ENUMs and parameters are what the source code documents.
> - **Derivation (inferred):** the workflow chain (when to run which tool, in what cadence) is our judgment, addressing the gap identified in memory 299 §5.
> - **Awaiting operator validation (assumed):** the 30-day threshold, the weekly cadence, and the "no auto-promote" rule.

## Problem

Practitioner memory principles (memory 299 §1 — Generational Context Architecture, MOSAIC) include a "forget/consolidate" lifecycle stage that we implemented only passively. `memory_decay` runs synaptic decay on a schedule; `memory_stale` returns cold entries; `memory_mark` flips status. But there is no documented operator workflow that chains these for a periodic hygiene pass.

## The three tools

### `memory_stale`

Returns memories not accessed in N days. Defaults to 30 days. Output includes `never_accessed: boolean` (true when `accessed_at IS NULL`).

**Use for:** finding candidates for consolidation or archival.

### `memory_mark`

Flips a memory's `status` to `active`, `superseded`, `archived`, or `invalid`. Quiet — does not bump access_count or re-run wikilink extraction.

**Use for:** explicit lifecycle transitions. `archived` for "no longer useful but referenceable"; `invalid` for "was wrong, do not trust"; `superseded` for "replaced by a newer entry" (use `memory_supersede` instead for the linked variant).

### `memory_decay`

Runs a matrix-based decay cycle on synapses. Older synapses (default 7 days) lose weight; synapses below the prune floor (default 0.1) are removed. Access-based exemption keeps hot edges alive.

**Use for:** periodic background maintenance on the graph, not on individual memories.

## Recommended workflow

### Weekly hygiene pass (~15 minutes)

1. **Find cold entries**
   ```
   memory_stale days=30 limit=200
   ```
   Look at the top results. These are candidates for consolidation.

2. **Decide per entry**
   - Is the content still useful but just old? → `memory_mark status='archived'` (keep referenceable, reduce retrieval priority)
   - Is the content flatly wrong? → `memory_mark status='invalid'`
   - Is there a newer entry that supersedes this? → `memory_supersede old_id=<this> new_id=<newer>` (creates an explicit supersedes link)
   - Still useful? → leave it; the staleness is informational, not a verdict

3. **Don't over-moderate**
   - A 30-day threshold is informational. Many memories are deliberately evergreen (e.g., `[[60]]` session-start foundations, `[[41]]` global rules).
   - The `never_accessed: true` cohort is more interesting than the timestamp-based one — it flags entries that were never retrieved at all, which often means they were never relevant.

4. **Don't autorun decay in a hot loop**
   - `memory_decay` mutates the synapse table. It's an external operator-tool, not a hook (per Locked Invariant #13).
   - Run it once per week, not on every session. Excessive decay erodes the graph.

### Monthly audit (longer, ~1 hour)

1. Run `memory_overview` to see layer / status / category distribution.
2. Look at `never_accessed` entries with `importance_score >= 0.7` — these are gap candidates (memories you expected to be useful but weren't).
3. For each, decide: archive, repurpose, or accept that the prediction was wrong.
4. For each `invalid` decision, append a `BeliefRevised` event so the audit trail is durable.

### Annual pass

Skip the active work. The substrate is designed for cheap storage. The annual pass is "remember this workflow exists" — not a forced cleanup.

## What this workflow deliberately does NOT do

- **No auto-archive** — the operator decides, not a hook.
- **No auto-promote** — never elevate a memory to a different layer or status without operator review.
- **No global decay pass on every session** — that would erode the graph asymptotically.
- **No forced supersession** — if a newer entry exists, the operator still chooses whether to mark the old one.

## Cross-references

- Memory 299 §5 — the source priority action
- Memory 300 — the RCA that drove this
- `src/tools/memory-orient.ts` — `memory_stale` registration
- `src/tools/memory-write.ts` — `memory_mark` registration
- `src/tools/memory-graph.ts` — `memory_decay` registration
- Practitioner handoff pattern (memory 299 §1) — the "forget/consolidate" lifecycle stage