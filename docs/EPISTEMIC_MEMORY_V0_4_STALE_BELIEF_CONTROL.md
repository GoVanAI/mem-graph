# Epistemic Memory v0.4 — Stale-Belief Control

**Status:** Operator-authorized Phase 0 pure implementation; recovered for
public discovery under Phase A, while runtime, persistence, automatic
scheduling, and MCP integration require separate explicit authorization  
**Date:** 2026-08-08  
**Builds on:** `EPISTEMIC_MEMORY_V0_3_IMPLEMENTATION_HANDOFF.md`

## Purpose

v0.3 represents assertions, provenance, scope, confidence, lifecycle,
authority, and contradiction. v0.4 adds a pure maintenance projection that
answers a different question: how much present-day influence should a belief
receive, and when does it deserve deliberate review?

The essential safeguard is:

> Repetition is not confirmation. Retrieval is not validation. Agreement is
> not independence. A successful outcome does not validate every contributing
> belief. Age alone does not make a belief knowledge, and contradiction alone
> does not make it false.

## Required separation

The implementation must keep these values distinct:

- **historical confidence** — the confidence recorded on the belief; never
  rewritten by the maintenance projection;
- **support summary** — a derived account of independent challenges and
  attributable outcomes;
- **applicability freshness** — whether the belief has been deliberately
  revalidated recently enough for its review policy;
- **influence score** — explicit downstream use across decisions and projects;
- **review priority score** — a separate blend of risk, volatility, and explicit
  influence for triage, never mislabeled as influence;
- **ordinary priming factor** — a bounded present-day selection factor; and
- **audit visibility** — full visibility for due, challenged, overdue, or
  worldview-audit beliefs even when ordinary priming declines.

Confidence is evidentiary. Freshness is temporal. Influence is causal or
operational. Retrieval count is none of these.

## Pure inputs

The Phase 0 projection accepts immutable in-memory inputs only.

### Belief review policy

A review policy identifies the exact belief and belief scope, review deadline, risk and volatility,
the threshold for high influence, thresholds for worldview audit, and the
minimum ordinary applicability factor. High-influence beliefs without a review
deadline are review-due rather than silently current.

### Challenge receipt

A challenge receipt records:

- stable receipt and belief IDs;
- deliberate challenge time;
- the prediction or claim under test;
- what observation would count against it;
- the test method;
- `supported`, `contradicted`, or `inconclusive` result;
- provenance; and
- an independence key.

Duplicate receipts or repeated uses of the same independence key do not create
additional independent confirmation.

### Belief-use receipt

A use receipt records an explicit decision use, project, time, and role. A
single decision ID cannot be claimed by multiple projects. The receipt is
not a retrieval receipt. Worldview influence is derived only from explicit
uses, distinct projects, and meaningful decision roles.

### Decision-outcome receipt

An outcome receipt records the belief and decision IDs, prediction, the time
the prediction was captured, observed result, attribution role, and whether
the prediction matched, missed, or remained inconclusive. A prediction must be
recorded no later than its outcome. An attributable `decisive` or `supporting`
outcome must cite a matching same-belief, same-decision use receipt with the
same role. Only those linked outcomes
enter the support summary. `contextual` and `not_testable` receipts remain audit
evidence but cannot validate the belief.

No outcome automatically rewrites belief confidence.

### Contradiction signal

A contradiction signal identifies a distinct observation, time, severity, and
rationale. Signals create contradiction pressure and review priority. They do
not reject, supersede, demote, or change the authority of the belief.

## Deterministic projection

`projectBeliefMaintenance` must:

1. accept only a v0.3 `belief` record;
2. validate timestamps, identifiers, duplicates, and receipt ownership;
3. reject policy belief/scope drift and future belief or receipt provenance;
4. preserve the belief's confidence score exactly as historical confidence;
5. deduplicate challenge evidence by receipt ID and independence key;
6. distinguish explicitly linked attributable outcomes from non-attributable outcomes;
7. calculate contradiction pressure from distinct observation IDs;
8. calculate applicability freshness from the most recent deliberate
   challenge, or the belief update time when no challenge exists;
9. derive the next effective review deadline, allowing a deliberate challenge
   to start a new review interval;
10. derive influence only from explicit meaningful use breadth, while keeping
    risk and volatility in a separate review-priority score;
11. identify review-due, overdue, challenged, and worldview-audit reasons;
12. reduce ordinary priming when freshness declines without hiding the belief
   from audit; and
13. return a new projection without mutating any input.

Age may trigger review and reduce present applicability. It does not prove the
belief false. A contradiction may trigger immediate review. It does not prove
the belief false. Repeated retrieval has no place in this calculation.

## Review queue

`buildBeliefReviewQueue` returns stable ordering:

1. challenged;
2. overdue;
3. worldview audit;
4. review due;
5. descending influence; and
6. ascending belief ID.

The queue is a read-only recommendation. It does not schedule a process or
write memory in Phase 0.

## Governing records

This projection is for beliefs. Operator-adopted or system-governing decisions
and policies do not silently decay through this mechanism. They may acquire a
review obligation in a future authorized contract, but authority changes still
require the applicable adoption or supersession path.

## Phase 0 acceptance

- Historical confidence remains byte-for-value unchanged.
- Retrieval/access counts are not inputs.
- Duplicate or non-independent challenges cannot inflate confirmation.
- Successful contextual outcomes cannot validate the belief.
- Attributable outcomes without a matching decision-use receipt fail closed.
- Contradictions queue review without mutating status or authority.
- Freshness decay affects ordinary priming, not historical evidence.
- Due or challenged beliefs retain full audit visibility.
- Cross-project worldview influence uses explicit use receipts.
- High risk without explicit downstream use is high review priority, not high
  influence.
- Queue ordering and all derived values are deterministic.
- Inputs remain deeply unchanged.
- No database, event ledger, memory, synapse, retrieval, policy, MCP, package,
  or production alias behavior changes.

## Deferred integration

If a later operator-adopted contract authorizes persistence, receipts should be admitted as
immutable, versioned evidence and projections should be rebuildable. Automatic
contradiction triggers, recurring review schedules, cross-project influence
graphs, and MCP surfaces require their own accepted contracts. This document
does not authorize typed admission or semantic-relation persistence.
