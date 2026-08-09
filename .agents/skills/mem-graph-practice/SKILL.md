---
name: mem-graph-practice
description: Apply the adopted mem-graph agent workflow for scoped memory retrieval, Cognitive OS bootstrap, canonical-guidance verification, evidence recording, tracker updates, contradiction handling, and compliance review. Use for any non-trivial task that reads or writes mem-graph, relies on persistent memories or policies, changes Cognitive OS code or state, evaluates agent behavior, or carries guidance across projects.
---

# Mem-Graph Practice

Use the repository's vendor-neutral contract at
`../../../cognitive-os/agent-practice/MEM_GRAPH_AGENT_PRACTICE.md`. Announce
that this skill is active and state the resolved project scope.

## Bootstrap

1. Inspect `git status` before editing and preserve unrelated work.
2. Resolve the exact `project_id`. Use `cognitive-os` for Cognitive OS
   governance, experiments, policies, events, roadmap, and program state. Do
   not infer applicability from cross-project availability.
3. Prefer one `cognitive_agent_bootstrap` call with a narrow task query,
   `include_global=false`, and the exact project. For non-trivial Cognitive OS
   work request `canonical_ids=[253,254]` and
   `include_canonical_content=true`.
4. If the bootstrap tool is unavailable, fetch tracker `253` and boundary
   `254`, read the roadmap and active artifacts referenced by the tracker, run
   `cognitive_policy_lookup` for
   `request_type/current_canonical_guidance`, then run exact-project
   `cognitive_current_guidance_search` or
   `cognitive_current_guidance_diagnose`.
5. Fetch every selected governing record directly when the bootstrap snapshot
   did not include its full content or its authority still needs verification.

Use narrow search terms. FTS5 uses AND semantics, so broad compound queries can
miss the intended record.

## Decide and Act

- Only governing-lane records may influence current-guidance selection.
  Contextual/ineligible records may explain history or contamination but may
  not drive the decision.
- Verify canonical role, adoption, scope, applicability, and current evidence.
  Eligibility and rank do not grant authority; candidate policies stay
  advisory. System and operator instructions outrank stored guidance.
- Act only within the task's existing authority. Preserve unrelated work and
  do not commit, publish, release, or perform an unrequested destructive
  operation.
- Keep global inclusion off unless the task explicitly needs it; report when
  it is enabled.

## Preserve Evidence

Record durable evidence only for a verified observation or operator-adopted
decision. Use stable project/task scope, correlation or causation when known,
and an idempotency key for retryable event appends. Never promote a candidate
policy merely because an agent produced, retrieved, or repeated it.

For tracker `253` changes:

1. Append the qualifying immutable event first.
2. Reread `253` immediately before updating it.
3. Update the existing tracker; do not create a competing current-state node.
4. Preserve unresolved disagreement under Open Risks.
5. Verify and report tracker ID, evidence/event IDs, and changed fields.

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
