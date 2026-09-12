# Step 4 Phase 4C — Deterministic Profile-Aware Workflow Comparison Report

Date: 2026-09-12T16:38:50.989Z
Starting commit: `9878fe7320a7d0e182fb242092185d60772b3660` (dirty: true)
Runner version: `phase-4c-step4-runner/v3-evidence-repair`
Execution layer: InMemoryTransport (JSON-RPC 2.0 via @modelcontextprotocol/sdk)
Execution boundary: scripted in-process MCP Client ↔ McpServer transport calls. It does not exercise autonomous tool selection, LLM-provider behavior, or provider-token effectiveness.
Provider evaluation: **not-run** (scripted deterministic evaluation only)

## 1. Gate 4C Acceptance Verdict (Fail-Closed)

- **Gate 4C Status**: **FAIL** (gate_passed: `false`)
- **Matrix**: 32/32 completed (Control passed: 8/8, Candidate passed: 4/8)
- **Gaps observed**: 4 candidate executed-gaps
- **Threshold failures**: 2
- **Infrastructure failures**: 0
- **Determinism mismatches**: 0

### Blocking Failure Reasons

- ❌ **Deterministic executed-gaps observed: pd-01-ordinary-restart (candidate), pd-02-valid-manifest (candidate), pd-03-fresh-contradiction (candidate), pd-05-wrong-project (candidate)**
- ❌ **Small-response growth failed: 19.32% > 10%**
- ❌ **Median context bytes failed: +36.5 B > 0 B**

## 2. Per-Case Comparison Table

| Case ID | Control Outcome | Candidate Outcome | Control Initial B | Candidate Initial B | Control Total B | Candidate Total B | Control Calls | Candidate Calls | Determinism |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pd-01-ordinary-restart` | executed-pass | executed-gap | 1611 | 1823 | 1611 | 1823 | 1 | 1 | MATCH (100%) |
| `pd-02-valid-manifest` | executed-pass | executed-gap | 2118 | 1897 | 2753 | 2649 | 2 | 2 | MATCH (100%) |
| `pd-03-fresh-contradiction` | executed-pass | executed-gap | 1611 | 1823 | 2244 | 2478 | 2 | 2 | MATCH (100%) |
| `pd-04-long-governing-record` | executed-pass | executed-pass | 14035 | 2411 | 26598 | 15091 | 2 | 2 | MATCH (100%) |
| `pd-05-wrong-project` | executed-pass | executed-gap | 2055 | 2452 | 2055 | 2452 | 1 | 1 | MATCH (100%) |
| `pd-06-source-revised` | executed-pass | executed-pass | 2149 | 2447 | 4923 | 5636 | 3 | 3 | MATCH (100%) |
| `pd-07-history-heavy` | executed-pass | executed-pass | 2781 | 3272 | 2783 | 4654 | 2 | 3 | MATCH (100%) |
| `pd-08-degraded-input` | executed-pass | executed-pass | 2571 | 2353 | 3059 | 2960 | 2 | 2 | MATCH (100%) |

## 3. Aggregate Medians and Frozen Thresholds

| Threshold | Required Specification | Observed Value | Verdict |
| --- | --- | --- | --- |
| Large legacy response reduction | ≥ 30% reduction for initial responses ≥ 8192 B | 82.82% | PASS |
| Small legacy response growth | ≤ 10% maximum growth for initial responses < 8192 B | Max 19.32%; median 13.16% | FAIL |
| Median call increase | ≤ 1 additional recovery tool call | Control: 2, Candidate: 2 (Delta: +0) | PASS |
| Median total context bytes | Must not increase over control | Control: 2768 B, Candidate: 2804.5 B (Delta: +36.5 B) | FAIL |
| Unsupported argument retry limit | ≤ 1 retry per workflow | Max workflow retries: 0; total observed: 0 | PASS |
| Provider token savings | Never claimed by design | Not claimed | PASS |

### Small-case initial-response deltas (observed; frozen threshold remains unchanged)

| Case ID | Control B | Candidate B | Delta B | Growth |
| --- | ---: | ---: | ---: | ---: |
| `pd-01-ordinary-restart` | 1611 | 1823 | +212 | 13.16% |
| `pd-02-valid-manifest` | 2118 | 1897 | -221 | -10.43% |
| `pd-03-fresh-contradiction` | 1611 | 1823 | +212 | 13.16% |
| `pd-05-wrong-project` | 2055 | 2452 | +397 | 19.32% |
| `pd-06-source-revised` | 2149 | 2447 | +298 | 13.87% |
| `pd-07-history-heavy` | 2781 | 3272 | +491 | 17.66% |
| `pd-08-degraded-input` | 2571 | 2353 | -218 | -8.48% |
| **Aggregate across all 8 cases** | 28931 | 18478 | -10453 | n/a |

## 4. Analysis of Executed Gaps

The following are observations against the frozen Phase 4A contract; they are not contract amendments:

1. **`pd-01-ordinary-restart` (candidate)**: observed `orientation.status = "partial"` and `requires_expansion = true`. The current receipt contains no emitted expansion, so it does not support requiring or claiming `verify_authority` for record 101.
2. **`pd-02-valid-manifest` (candidate)**: the supplied synthetic manifest did not reach governing task state. A valid-case amendment must use a schema-valid signed `TaskStateManifestV1` plus a deterministic ephemeral `OperatorTrustRuntime` through the supported registration option; it must not redefine this case as an unverified fallback.
3. **`pd-03-fresh-contradiction` (candidate)**: the public composition surface does not currently provide the trusted contradiction-source context needed for the required review state/expansion. Seeding a database event alone is not demonstrated to make that path reachable.
4. **`pd-05-wrong-project` (candidate)**: observed `partial` orientation while strict foreign/global isolation and source-unavailable stubs held. The orientation expectation and scope assertions are separable.

## 5. Amendment Proposal Status (No Amendments Applied)

- **pd-01:** `partial` + `requires_expansion=true` is a candidate amendment. Do not add a `verify_authority` expansion predicate unless a justified fixture/query/canonical-id path makes record 101 reachable and a fresh public-runtime execution observes it.
- **pd-02:** recommend only the strong valid-manifest path: schema-valid signed `TaskStateManifestV1` and deterministic ephemeral test keys through the supported `OperatorTrustRuntime` registration option. No real secrets.
- **pd-03:** classify as a public-composition seam/product gap requiring separately reviewed design, or narrow the contract without claiming current reachability. Do not claim that contradiction events are ingested from a public event stream.
- **pd-05:** `partial` + `requires_expansion=true` is a candidate amendment; retain strict foreign/global isolation and source-unavailable stub assertions.
- **Thresholds:** no amendment is recommended. Structural framing bytes remain real context. A replacement requires a pre-registered framing-cost study and operator decision; do not select a post-observation percentage or substitute aggregate totals for per-case protection.

## 6. Scope, Authority, and Access Observations

- **Zero Write Verification**: All bootstrap calls across all 32 executions recorded 0 database writes, 0 events appended, and access tracking untouched.
- **Access Tracking Transparency**: Expansion calls honestly disclosed their access counter effects, while bootstrap remained zero-touch.
- **pd-06 Honest Gap**: The candidate arm executed its declared three-call sequence honestly without fabricating version mismatch or refresh required signals.

## 7. Execution Boundary Statement

This evaluation measures scripted deterministic workflow behavior through in-process MCP `Client` → `InMemoryTransport` → `McpServer` calls. It does not measure or claim autonomous LLM tool selection, provider effectiveness, or provider-token savings.