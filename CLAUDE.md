# Mem-Graph Project Instructions for Claude

This file adds repository-specific routing to the global Claude rules. It is a
startup contract, not the source of live milestone state.

Before non-trivial mem-graph or Cognitive OS work, read and follow
`.agents/skills/mem-graph-practice/SKILL.md`. Its vendor-neutral source is
`cognitive-os/agent-practice/practice.v1.json`; generated host adapters must not
be edited by hand.

## Scope

Cognitive OS is a global, cross-project agent framework. This repository is
its current additive proving ground and persistence substrate; it is not the
framework's architectural boundary. Canonical tracker, scope-boundary, and
optional role-record IDs are deployment-local and must come from operator or
project configuration, not from this repository.

Use `project_id=cognitive-os` for Cognitive OS governance, experiments,
policies, event evidence, roadmap work, and program state. Keep unrelated
mem-graph substrate work in its applicable project scope. Cross-project
availability never implies automatic applicability.

## Mandatory Cognitive OS Bootstrap

Before reviewing, changing, or recording Cognitive OS work:

1. Prefer `cognitive_agent_bootstrap` with `project_id=cognitive-os`, a narrow
   task query, `include_canonical_content=true`, and `include_global=false`
   unless global guidance is explicitly required. Supply `canonical_ids` only
   when the operator or project has configured tracker, scope-boundary, or role
   records; otherwise omit it and discover governing candidates. The bootstrap
   does not touch access tracking or write a receipt.
2. Directly verify any candidate canonical records. When a tracker is resolved,
   read the roadmap and active artifacts it references before modifying
   implementation or judging milestone completion.
3. Fetch selected records directly when their full content or authority still
   needs verification. A verified, operator/project-designated tracker—not a
   static onboarding example—is the authority for current program state.
4. If the bootstrap tool is unavailable, use the dynamic fallback sequence:
   resolve configured canonical IDs or discover exact-project governing
   candidates; `memory_get` each resolved record; read referenced
   roadmap/artifacts;
   `cognitive_policy_lookup` for
   `request_type/current_canonical_guidance`; exact-project guidance search or
   diagnosis; and direct fetch of every selected record.

Never copy memory IDs from bundled examples. Prefer narrow routing terms or
deployment-configured canonical IDs because FTS5 multi-term searches use AND
semantics by default.

## Configured Review Responsibility

Do not assume a built-in M3 or reviewer role. Apply role-specific duties only
when the operator or project explicitly configures a role record. When acting
as a reviewer, challenge claims using current canonical state, explicit
invariants, source evidence, or the cheapest discriminating test. Verify
trigger reachability, contamination, exclusions, decision-path causality,
event payload accuracy, and guardrail results.

Do not count deterministic tests, a hash-valid event chain, or a prompted
diagnostic as independent live proof unless the frozen contract says they
satisfy the gate.

## Progress Tracker Mutation

When a canonical progress tracker is resolved, its guarded multi-agent update
rule is mandatory:

- reread the resolved tracker immediately before every attempted update;
- update it only from verified evidence or an operator-adopted decision;
- append qualifying source evidence to the Cognitive OS event ledger with
  stable scope and idempotency before summarizing it in the tracker;
- record unresolved disagreement under Open Risks rather than silently
  resolving it;
- keep architectural commitments in separate semantic decision nodes;
- update the existing tracker instead of creating a competing current-state
  node; and
- verify and report tracker ID, evidence/event IDs, and changed fields after
  mutation.

Routine turns, raw outputs, duplicated summaries, and unadopted recommendations
do not modify the tracker.

## Collaboration and Repository Safety

- Inspect `git status` before editing and preserve all existing uncommitted
  work.
- Do not edit overlapping files without an explicit handoff.
- Do not commit, tag, publish, release, or use raw mem-graph SQL without
  explicit operator authorization.
- Candidate policies remain advisory and cannot expand authority or authorize
  their own promotion.
- Historical milestone contracts remain evidence, not active tripwires. Use
  the resolved canonical tracker and later operator-adopted decisions for
  current program state.
