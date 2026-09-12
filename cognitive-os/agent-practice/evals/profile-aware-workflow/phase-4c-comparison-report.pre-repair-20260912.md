# Step 4 Phase 4C — Deterministic Profile-Aware Workflow Comparison Report

Date: 2026-09-12T03:55:10.707Z
Starting commit: `9878fe7320a7d0e182fb242092185d60772b3660` (dirty: false)
Runner version: `phase-4c-step4-runner/v2`
Execution layer: InMemoryTransport (JSON-RPC 2.0 via @modelcontextprotocol/sdk)
Provider evaluation: **not-run** (scripted deterministic evaluation only)

## 1. Gate 4C Acceptance Verdict (Fail-Closed)

- **Gate 4C Status**: **FAIL** (gate_passed: `false`)
- **Matrix**: 32/32 completed (Control passed: 8/8, Candidate passed: 4/8)
- **Gaps observed**: 4 candidate executed-gaps
- **Threshold failures**: 2
- **Infrastructure failures**: 0
- **Determinism mismatches**: 0

### Blocking Failure Reasons

- ❌ **Deterministic candidate executed-gaps observed: pd-01-ordinary-restart (candidate), pd-02-valid-manifest (candidate), pd-03-fresh-contradiction (candidate), pd-05-wrong-project (candidate)**
- ❌ **Small-response growth failed: 19.32% > 10%**
- ❌ **Median context bytes failed: +36.5 B > 0 B**

## 2. Per-Case Comparison Table

| Case ID | Control Outcome | Candidate Outcome | Control Initial B | Candidate Initial B | Control Total B | Candidate Total B | Control Calls | Candidate Calls | Determinism |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pd-01-ordinary-restart` | executed-pass | executed-gap | 1611 | 1823 | 1611 | 1823 | 1 | 1 | MATCH (100%) |
| `pd-02-valid-manifest` | executed-pass | executed-gap | 2118 | 1897 | 2753 | 2649 | 2 | 2 | MATCH (100%) |
| `pd-03-fresh-contradiction` | executed-pass | executed-gap | 1611 | 1823 | 1696 | 1908 | 2 | 2 | MATCH (100%) |
| `pd-04-long-governing-record` | executed-pass | executed-pass | 14035 | 2411 | 26598 | 15091 | 2 | 2 | MATCH (100%) |
| `pd-05-wrong-project` | executed-pass | executed-gap | 2055 | 2452 | 2055 | 2452 | 1 | 1 | MATCH (100%) |
| `pd-06-source-revised` | executed-pass | executed-pass | 2149 | 2447 | 4923 | 5636 | 3 | 3 | MATCH (100%) |
| `pd-07-history-heavy` | executed-pass | executed-pass | 2781 | 3272 | 2783 | 4654 | 2 | 3 | MATCH (100%) |
| `pd-08-degraded-input` | executed-pass | executed-pass | 2571 | 2353 | 3059 | 2960 | 2 | 2 | MATCH (100%) |

## 3. Aggregate Medians and Frozen Thresholds

| Threshold | Required Specification | Observed Value | Verdict |
| --- | --- | --- | --- |
| Large legacy response reduction | ≥ 30% reduction for initial responses ≥ 8192 B | 82.82% | PASS |
| Small legacy response growth | ≤ 10% maximum growth for initial responses < 8192 B | 19.32% | FAIL |
| Median call increase | ≤ 1 additional recovery tool call | Control: 2, Candidate: 2 (Delta: +0) | PASS |
| Median total context bytes | Must not increase over control | Control: 2768 B, Candidate: 2804.5 B (Delta: +36.5 B) | FAIL |
| Unsupported argument retry limit | ≤ 1 retry attempt permitted | Observed: 0 retries | PASS |
| Provider token savings | Never claimed by design | Not claimed | PASS |

## 4. Analysis of Executed Gaps

Four candidate arms exhibited `executed-gap` against the frozen Phase 4A contract:

1. **`pd-01-ordinary-restart` (candidate)**: The runtime compact projector emits `orientation.status = "partial"` and `requires_expansion = true` when task state is not requested, whereas Phase 4A expected `"complete"`. This accurately reflects the runtime design where orientation remains partial until an adopted manifest is assembled.
2. **`pd-02-valid-manifest` (candidate)**: In the absence of signed operator adoption key infrastructure at runtime, task state slots are marked `context_only` rather than `governing`.
3. **`pd-03-fresh-contradiction` (candidate)**: The runtime does not yet have a server-owned automated contradiction detection engine; contradiction warnings require explicit injection context.
4. **`pd-05-wrong-project` (candidate)**: Scope isolation was 100% verified (neither foreign nor unrequested global sources were hydrated), but `orientation.status` remained `"partial"` per runtime logic.

## 5. Scope, Authority, and Access Observations

- **Zero Write Verification**: All bootstrap calls across all 32 executions recorded 0 database writes, 0 events appended, and access tracking untouched.
- **Access Tracking Transparency**: Expansion calls honestly disclosed their access counter effects, while bootstrap remained zero-touch.
- **pd-06 Honest Gap**: The candidate arm executed its declared three-call sequence honestly without fabricating version mismatch or refresh required signals.

## 6. Execution Boundary Statement

This evaluation measures scripted deterministic workflow behavior against local MCP handlers via InMemoryTransport. It does not measure or claim unconstrained autonomous LLM model effectiveness or provider token savings.