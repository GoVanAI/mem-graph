# DecisionMade payload convention (2026-08-10)

> **Epistemic classification (Gather.5):** this is a convention document.
> - **External (reported):** the `payload` column is JSON-typed (per `src/cognitive/schema.ts:6`); existing events 55, 60, 36, 41 already carry rich structured fields.
> - **Derivation (inferred):** the three-field convention is our design, addressing the gap identified in memory 299 §5 and [[300]] RCA.
> - **Awaiting operator validation (assumed):** field names (`prior_state`, `change`, `alternative_considered`) until operator ratifies.

## Problem

Practitioner handoff patterns (per memory 299 §1) emphasize that durable decisions should be auditable: "what was the prior state, what changed, what was the alternative?" Our current `DecisionMade` events have a free-form JSON `payload` field; agents recording decisions use whatever fields they find convenient. The result is that future agents reading the event chain cannot reconstruct the decision context without the prior conversation.

## Convention

When appending a `DecisionMade` event, include the following three optional fields in the `payload` (in addition to whatever the decision is):

| Field | Type | Purpose |
|---|---|---|
| `prior_state` | string \| object | Description of the state before the decision. Cite evidence refs. |
| `change` | string \| object | What the decision actually changes. Should be testable. |
| `alternative_considered` | string \| object | What was not chosen and why. One alternative is enough; multiple is better. |

None of these fields are required. If an event has none of them, it's still valid — but its auditability is reduced. The convention is an *encouragement*, not a schema change.

## When to use this convention

- Decisions that change project scope, priority, or architecture
- Decisions that supersede a previous decision
- Decisions that the operator will need to verify later
- Decisions that affect post-Phase-B work

For trivial operational decisions (e.g., "I used this CLI flag because the default didn't work"), the convention is overkill. Use judgment.

## Reference example

Example event 86 (appended 2026-08-10) demonstrates the convention. Future audit scripts can grep for `prior_state` / `change` / `alternative_considered` in `DecisionMade` events to surface decisions with full context.

## Picking up where memory 299 left off

The Phase B completion narrative (memory 253 §Confirmed Evidence, events 81-83) would have been more auditable with this convention. Future decision recording should follow it.

## Cross-references

- [[300]] RCA — this convention is one of the priority actions
- [[299]] §5 — the medium-priority action `DecisionMade` payload extension
- Memory 86 — exemplar event demonstrating the convention
- `src/cognitive/schema.ts` — the underlying `payload` JSON column
- Practitioner handoff pattern (memory 299 §1) — the source of this convention