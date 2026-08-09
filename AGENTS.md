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
framework's architectural boundary. Canonical tracker and scope-boundary IDs
are deployment-local and must come from operator or project configuration, not
from this repository.

Keep scopes distinct:

- use `project_id=cognitive-os` for Cognitive OS governance, experiments,
  policies, event evidence, roadmap work, and program state;
- use the applicable mem-graph project scope for substrate maintenance,
  releases, and unrelated runtime work; and
- never treat cross-project availability as automatic applicability.

## Mandatory Cognitive OS Bootstrap

Before non-trivial Cognitive OS work:

1. Prefer `cognitive_agent_bootstrap` with `project_id=cognitive-os`, a narrow
   task query, `include_canonical_content=true`, and `include_global=false`
   unless global guidance is explicitly required. Supply `canonical_ids` only
   when the operator or project has configured them; otherwise omit the field
   and use the governing lane to discover candidates. This tool is strictly
   read-only and does not touch access tracking or append a receipt.
2. Directly verify any candidate tracker, scope boundary, or role record before
   using it. When a canonical tracker is resolved, read the roadmap and active
   artifacts it references before changing implementation or making a
   milestone claim.
3. Fetch selected known records directly when their full content or authority
   still needs verification.
4. If the bootstrap tool is unavailable, use the dynamic fallback sequence:
   resolve deployment-local canonical IDs from operator/project configuration
   or exact-project governing guidance; `memory_get` each resolved record;
   then read referenced roadmap/artifacts and run `cognitive_policy_lookup` using
   `request_type/current_canonical_guidance`, exact-project
   `cognitive_current_guidance_search` or diagnosis, and direct fetch of each
   selected record.

Never copy memory IDs from bundled examples. Use narrow routing terms or
deployment-configured canonical IDs. FTS5 searches use AND semantics by
default, so a broad compound query can miss stored direction.

## Progress Tracker Mutation

When the deployment has a resolved canonical progress tracker, its guarded
multi-agent update rule is mandatory. In particular:

- reread the resolved tracker immediately before every attempted update;
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
  the resolved canonical tracker and later operator-adopted decisions for
  current program state.
