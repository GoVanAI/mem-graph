---
name: mem-graph-practice
description: Apply the adopted mem-graph agent workflow for scoped memory retrieval, Cognitive OS bootstrap, canonical-guidance verification, evidence recording, tracker updates, contradiction handling, and compliance review. Use for any non-trivial task that reads or writes mem-graph, relies on persistent memories or policies, changes Cognitive OS code or state, evaluates agent behavior, or carries guidance across projects.
---

# Mem-Graph Practice

Use the repository's vendor-neutral contract at
`../../../cognitive-os/agent-practice/MEM_GRAPH_AGENT_PRACTICE.md`. Announce
that this skill is active and state the resolved project scope and active profile.

## Profile Discovery and Tool Routing

1. Determine the active profile/tool surface before issuing tool calls:
   - **Agent profile (preferred everyday surface, 10 workflow tools)**:
     `cognitive_agent_bootstrap`, `memory_prime`, `memory_find`, `memory_read`,
     `memory_write`, `epistemic_inspect`, `epistemic_admit`,
     `epistemic_append_receipt`, `cognitive_event_append`, `cognitive_event_read`.
     - `memory_find`: search, recent, changes, related
     - `memory_read`: get, links
     - `memory_write`: add, update, mark, supersede, tag_add, tag_remove
     - `epistemic_inspect`: get, query, diff
   - **Full profile (41 legacy tools)**: Retains legacy tool names for backward
     compatibility.
   - **Maintenance profile (18 specialist tools)**: Specialist database
     administration, raw SQL, and maintenance diagnostics belong outside everyday
     workflows.
2. Tool availability does not establish applicability or authority. Never
   request a tool absent from the active profile (no hidden legacy, SQL, or
   maintenance tools in agent profile).

## Bootstrap and Recovery

1. Inspect `git status` before editing and preserve unrelated work.
2. Resolve the exact `project_id`. Use `cognitive-os` for Cognitive OS
   governance, experiments, policies, events, roadmap, and program state. Do
   not infer applicability from cross-project availability. Keep
   `include_global=false` by default; global scope requires explicit
   operator/task opt-in.
3. Before non-trivial mem-graph or Cognitive OS work, run `cognitive_agent_bootstrap`.
   In the agent profile, request `response_mode="compact"`. In the full profile, legacy
   mode is supported; do not assume compact mode is the server default. Supply
   `canonical_ids` only when configured by operator or project configuration. If none
   are configured, omit `canonical_ids` and use narrow routing terms in an exact-project
   query to discover governing candidates. Never copy memory IDs from bundled examples.
   FTS5 searches use AND semantics by default, so a broad compound query can miss
   stored direction.
4. Bootstrap is strictly zero-write, appends no events, and does not touch
   access tracking.
5. If `response_mode="compact"` is rejected specifically as unsupported, retry
   exactly once without `response_mode="compact"` (1 retry max; no repeated
   retries).
6. If bootstrap itself is unavailable, select fallback tools strictly from the
   active profile:
   - In agent profile: directly fetch configured canonical IDs with `memory_read:get`,
     or discover scoped contextual candidates using `memory_find:search` in exact
     project scope (`memory_find:search` discovers scoped contextual candidates only;
     it does not create a governing lane or establish authority). Directly fetch
     applicable candidates with `memory_read:get` and verify authority from an
     operator-adopted artifact, canonical role, or explicit delegation. If authority
     cannot be established, report current guidance unresolved. Read referenced
     roadmaps and active contracts before changing implementation.
   - In full profile: use legacy fallback (`memory_get`, `cognitive_policy_lookup`,
     `cognitive_current_guidance_search`).
   - Never call hidden legacy tools from the agent profile.
7. Directly verify candidate tracker, scope-boundary, or role records before
   use. When a canonical tracker is resolved, read the roadmap and active
   contracts it references before changing implementation.

## Expansion and Retrieval Discipline

1. Follow only expansion routes with `route_available=true` in the active
   profile with valid typed arguments.
2. Preserve originating `project_id` and global scope decisions; never hydrate
   foreign-project sources through scoped expansion. Foreign wikilinks remain
   bounded reference stubs.
3. Do not silently substitute another tool when a route is unavailable; report
   the unresolved source or unavailable route honestly.
4. Expansion effects: `memory_read:get` updates access counters;
   `memory_find:related` touches returned memories and synapses. Do not
   describe expansion as zero-touch.
5. pd-06 known product gap: Public MCP `cognitive_agent_bootstrap` provides no trusted
   cross-call comparison input. Cross-call version comparison is unavailable in public
   compact bootstrap. Unconditionally prohibit fabricating `version_mismatch` or
   `refresh_required`; report comparison as unavailable when relevant.

## Decide and Act

- Only governing-lane records may influence current-guidance selection.
  Contextual/ineligible records may explain history or contamination but may
  not drive the decision.
- Verify canonical role, adoption, scope, applicability, and current evidence.
  Eligibility and rank do not grant authority; candidate policies stay
  advisory. System and operator instructions outrank stored guidance.
- Contradictions remain explicit warnings requiring review without automatic
  rejection or silent adoption.
- Act only within the task's existing authority. Preserve unrelated work and
  do not commit, publish, release, or perform an unrequested destructive
  operation.

## Preserve Evidence and Mutation Boundaries

- Search before creating a new memory (`memory_write:add`).
- Deliberate `_global` mutation requires `confirm_global=true` and must not
  result from fallback behavior.
- Epistemic admission (`epistemic_admit`) and receipts (`epistemic_append_receipt`)
  remain separate authority/effect boundaries.
- Cognitive event append (`cognitive_event_append`) and read (`cognitive_event_read`)
  remain separate routes.
- Record durable evidence only for a verified observation or operator-adopted
  decision. Use stable project/task scope, correlation or causation when known,
  and an idempotency key for retryable event appends.

For changes to a resolved canonical tracker:

1. Append the qualifying immutable event first.
2. Reread the resolved tracker immediately before updating it.
3. Update the existing tracker; do not create a competing current-state node.
4. Preserve unresolved disagreement under Open Risks.
5. Verify and report the resolved tracker ID, evidence/event IDs, and changed
   fields.

## Keep Beliefs Fresh

Repetition is not confirmation, retrieval is not validation, and age alone
does not make a belief knowledge. Use review deadlines, deliberate challenge
receipts, linked outcome calibration, contradiction review queues,
applicability/influence decay, and worldview audits when the task touches
high-influence beliefs. Contradiction queues review without automatic
rejection. Decay present applicability or priming, not historical confidence.

## Evaluate Adoption

Use deterministic compliance grading before an optional independent model
review. The model may assess judgment, uncertainty, and authority boundaries;
it may not override deterministic trace facts. Hard enforcement remains off
unless repeated evaluations demonstrate non-compliance and the operator
explicitly authorizes blocking behavior.
