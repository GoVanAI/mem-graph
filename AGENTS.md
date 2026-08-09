# Mem-Graph Project Instructions for Codex

This file adds repository-specific routing to the global agent rules. It is a
bootstrap contract, not a duplicate project-status document.

Use the repo-scoped `$mem-graph-practice` skill for any non-trivial mem-graph
or Cognitive OS task. The vendor-neutral source contract is
`cognitive-os/agent-practice/practice.v1.json`; generated host adapters must not
be edited by hand.

## Scope

Cognitive OS is a global, cross-project agent framework. This repository is
its current additive proving ground and persistence substrate; it is not the
framework's architectural boundary. Canonical scope boundary: mem-graph memory
`254`.

Keep scopes distinct:

- use `project_id=cognitive-os` for Cognitive OS governance, experiments,
  policies, event evidence, roadmap work, and program state;
- use the applicable mem-graph project scope for substrate maintenance,
  releases, and unrelated runtime work; and
- never treat cross-project availability as automatic applicability.

## Mandatory Cognitive OS Bootstrap

Before non-trivial Cognitive OS work:

1. Prefer `cognitive_agent_bootstrap` with `project_id=cognitive-os`, a narrow
   task query, `canonical_ids=[253,254]`,
   `include_canonical_content=true`, and `include_global=false` unless global
   guidance is explicitly required. This tool is strictly read-only and does
   not touch access tracking or append a receipt.
2. Read the roadmap and active canonical artifacts referenced by tracker `253`
   before changing implementation or making a milestone claim.
3. Fetch selected known records directly when their full content or authority
   still needs verification.
4. If the bootstrap tool is unavailable, use the former explicit sequence:
   `memory_get` 253 then 254, roadmap/artifacts,
   `cognitive_policy_lookup` using
   `request_type/current_canonical_guidance`, exact-project
   `cognitive_current_guidance_search` or diagnosis, and direct fetch of each
   selected record.

Use narrow routing terms or known canonical IDs. FTS5 searches use AND
semantics by default, so a broad compound query can miss stored direction.

## Progress Tracker Mutation

The guarded multi-agent update rule inside memory `253` is mandatory. In
particular:

- reread `253` immediately before every attempted update;
- update it only from verified evidence or an operator-adopted decision;
- append qualifying source observations or decisions to the Cognitive OS event
  ledger with stable scope and idempotency before summarizing them in the
  tracker;
- preserve unresolved disagreement under Open Risks;
- keep architectural commitments in separate semantic nodes; and
- verify the updated tracker and report its ID, evidence/event IDs, and changed
  fields.

Routine turns, raw tool output, unadopted recommendations, and duplicated
summaries do not change the tracker. Do not create a competing current-state
node.

## Collaboration and Repository Safety

- Inspect `git status` before editing and preserve existing uncommitted work.
- Do not edit files owned concurrently by another agent without a handoff.
- Do not commit, tag, publish, release, or use raw mem-graph SQL without
  explicit operator authorization.
- Candidate policies remain advisory and may not expand authority or promote
  themselves.
- Historical milestone contracts remain evidence, not active tripwires. Use
  tracker `253` and later operator-adopted decisions for current program state.
