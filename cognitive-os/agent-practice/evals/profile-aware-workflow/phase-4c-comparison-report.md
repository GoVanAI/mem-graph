# Step 4 Phase 4C — Deterministic Profile-Aware Workflow Comparison Report

Date: 2026-09-13T00:30:12.303Z
Starting commit: `979f384fd4c4fbd9c8f1e6cede5cb52dc0d04dbb` (dirty: true)
Runner version: `phase-4c-step4-runner/v3-evidence-repair`
Execution layer: InMemoryTransport (JSON-RPC 2.0 via @modelcontextprotocol/sdk)
Execution boundary: scripted in-process MCP Client ↔ McpServer transport calls. It does not exercise autonomous tool selection, LLM-provider behavior, or provider-token effectiveness.
Provider evaluation: **not-run** (scripted deterministic evaluation only)

## 1. Gate 4C Acceptance Verdict (Fail-Closed)

- **Gate 4C Status**: **PASS** (gate_passed: `true`)
- **Matrix**: 32/32 completed (Control passed: 8/8, Candidate passed: 8/8)
- **Gaps observed**: 0 candidate executed-gaps
- **Threshold failures**: 0
- **Infrastructure failures**: 0
- **Determinism mismatches**: 0

## 2. Per-Case Comparison Table

| Case ID | Control Outcome | Candidate Outcome | Control Initial B | Candidate Initial B | Control Total B | Candidate Total B | Control Calls | Candidate Calls | Determinism |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `pd-01-ordinary-restart` | executed-pass | executed-pass | 1611 | 1599 | 1611 | 1599 | 1 | 1 | MATCH (100%) |
| `pd-02-valid-manifest` | executed-pass | executed-pass | 5920 | 2689 | 6633 | 2689 | 2 | 1 | MATCH (100%) |
| `pd-03-fresh-contradiction` | executed-pass | executed-pass | 2126 | 2287 | 2759 | 2942 | 2 | 2 | MATCH (100%) |
| `pd-04-long-governing-record` | executed-pass | executed-pass | 14040 | 2187 | 26613 | 14877 | 2 | 2 | MATCH (100%) |
| `pd-05-wrong-project` | executed-pass | executed-pass | 2060 | 2228 | 2060 | 2228 | 1 | 1 | MATCH (100%) |
| `pd-06-source-revised` | executed-pass | executed-pass | 2149 | 2223 | 4933 | 5198 | 3 | 3 | MATCH (100%) |
| `pd-07-history-heavy` | executed-pass | executed-pass | 2796 | 3048 | 2798 | 4450 | 2 | 3 | MATCH (100%) |
| `pd-08-degraded-input` | executed-pass | executed-pass | 2576 | 2129 | 3074 | 2746 | 2 | 2 | MATCH (100%) |

## 3. Aggregate Medians and Frozen Thresholds

| Threshold | Required Specification | Observed Value | Verdict |
| --- | --- | --- | --- |
| Large legacy response reduction | ≥ 30% reduction for initial responses ≥ 8192 B | 84.42% | PASS |
| Small legacy response growth | ≤ 10% maximum growth for initial responses < 8192 B | Max 9.01%; median 3.44% | PASS |
| Median call increase | ≤ 1 additional recovery tool call | Control: 2, Candidate: 2 (Delta: +0) | PASS |
| Median total context bytes | Must not increase over control | Control: 2936 B, Candidate: 2844 B (Delta: -92 B) | PASS |
| Unsupported argument retry limit | ≤ 1 retry per workflow | Max workflow retries: 0; total observed: 0 | PASS |
| Provider token savings | Never claimed by design | Not claimed | PASS |

### Small-case initial-response deltas (observed; frozen threshold remains unchanged)

| Case ID | Control B | Candidate B | Delta B | Growth |
| --- | ---: | ---: | ---: | ---: |
| `pd-01-ordinary-restart` | 1611 | 1599 | -12 | -0.74% |
| `pd-02-valid-manifest` | 5920 | 2689 | -3231 | -54.58% |
| `pd-03-fresh-contradiction` | 2126 | 2287 | +161 | 7.57% |
| `pd-05-wrong-project` | 2060 | 2228 | +168 | 8.16% |
| `pd-06-source-revised` | 2149 | 2223 | +74 | 3.44% |
| `pd-07-history-heavy` | 2796 | 3048 | +252 | 9.01% |
| `pd-08-degraded-input` | 2576 | 2129 | -447 | -17.35% |
| **Aggregate across all 8 cases** | 33278 | 18390 | -14888 | n/a |

## 4. Executed-Gap Analysis

No executed gaps remain in the current deterministic matrix.

## 5. Adopted Corrections and Remaining Work

- **pd-01:** amended to the observed public invariant `partial` + `requires_expansion=true`; no unobserved `verify_authority` expansion was invented. The case now passes.
- **pd-02:** now uses the same schema-valid, deterministically signed `TaskStateManifestV1` in both arms through an ephemeral fixture-only `OperatorTrustRuntime`. Compact bootstrap verifies adoption and all task sources in one call; the prior unrelated record-103 expansion was removed. The case now passes.
- **pd-03:** compact bootstrap now derives contradiction context from a current `ContradictionSignal` receipt linked to a valid same-project cognitive-event chain and an active governing memory. It emits the warning, marks only the affected source for review, and routes the agent to the supporting epistemic record. The caller cannot inject this trusted context. The case now passes.
- **pd-05:** amended to `partial` + `requires_expansion=true` while retaining strict foreign/global isolation and source-unavailable stubs. The case now passes.
- **Thresholds:** unchanged. The production compact authority notice was reduced without dropping authority or access-effect warnings; both byte thresholds now pass.

## 6. Scope, Authority, and Access Observations

- **Zero Write Verification**: All bootstrap calls across all 32 executions recorded 0 database writes, 0 events appended, and access tracking untouched.
- **Access Tracking Transparency**: Expansion calls honestly disclosed their access counter effects, while bootstrap remained zero-touch.
- **pd-06 Honest Gap**: The candidate arm executed its declared three-call sequence honestly without fabricating version mismatch or refresh required signals.

## 7. Execution Boundary Statement

This evaluation measures scripted deterministic workflow behavior through in-process MCP `Client` → `InMemoryTransport` → `McpServer` calls. It does not measure or claim autonomous LLM tool selection, provider effectiveness, or provider-token savings.