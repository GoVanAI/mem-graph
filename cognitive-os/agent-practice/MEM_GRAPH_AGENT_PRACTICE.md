<!-- Generated from practice.v1.json (mem-graph-agent-practice@1.1.0). Do not edit by hand. -->
# Mem-Graph Agent Practice v1.1.0

Status: adopted_advisory

Make mem-graph use scoped, inspectable, evidence-governed, and portable across agent hosts.

## Authority order

1. system instructions
2. operator or user instructions
3. adopted project instructions
4. verified canonical mem-graph records
5. candidate policy and retrieved context

## Required workflow

1. Resolve and state the exact project scope. Cross-project availability is not applicability.
2. Run `cognitive_agent_bootstrap` with `include_global=false` unless global guidance is explicitly required.
3. Use canonical IDs only when supplied by operator or project configuration. If none are configured, omit `canonical_ids`, use a narrow exact-project query to discover governing candidates, and directly verify any candidate tracker, scope boundary, or role record before use. Never copy memory IDs from bundled examples. When a canonical tracker is resolved, read the roadmap and active artifacts it references.
4. Select only governing-lane guidance that matches the task and fetch selected records directly when full verification is still needed.
5. Act only within operator and task authority; candidate policy cannot broaden permissions.
6. Preserve evidence. Repetition is not confirmation, retrieval is not validation, and age alone does not make a belief knowledge.
7. For a qualifying resolved-tracker change, follow this order:

1. append immutable evidence or decision event with stable scope and idempotency
2. reread the resolved canonical tracker immediately before update
3. update the existing tracker rather than creating a competitor
4. verify the tracker and report tracker ID, event IDs, and changed fields

## Guidance verification

Verify:

- canonical role
- adoption
- scope
- applicability
- current evidence

Contradictions queue review without automatic rejection. Applicability and priming may decay; historical confidence is not silently rewritten.

## Enforcement

Hard enforcement is disabled. The current mechanism is instruction, an observable read-only bootstrap, and compliance evaluation. Blocking may be considered only after repeated evaluation failures and explicit operator authorization.
