# Mem-Graph Project Instructions for Gemini

Before non-trivial mem-graph or Cognitive OS work, read and follow
`.agents/skills/mem-graph-practice/SKILL.md` and the vendor-neutral contract at
`cognitive-os/agent-practice/MEM_GRAPH_AGENT_PRACTICE.md`.

Resolve the exact project scope first. Prefer the strictly read-only
`cognitive_agent_bootstrap`; for Cognitive OS use `project_id=cognitive-os`, a
narrow query, `include_canonical_content=true`, and `include_global=false`
unless global guidance is explicitly required. Supply `canonical_ids` only
when the operator or project has configured them. Otherwise omit the field,
discover governing candidates in exact-project scope, and directly verify any
candidate tracker, scope-boundary, or role record. Never copy memory IDs from
bundled examples. If the tool is unavailable, use the dynamic fallback sequence
in the skill.

Only governing-lane records may drive current-guidance selection. Fetch
selected records directly when full verification is needed. Retrieval,
repetition, and eligibility are not validation or authority. Candidate policy
cannot expand permissions, and cross-project availability is not
applicability.

Inspect `git status` before editing and preserve existing work. Do not commit,
publish, release, or perform destructive operations without explicit operator
authority. When a canonical tracker is resolved, append qualifying immutable
evidence first, reread that tracker immediately before update, update the
existing tracker, verify it, and report the resolved tracker and evidence IDs.
