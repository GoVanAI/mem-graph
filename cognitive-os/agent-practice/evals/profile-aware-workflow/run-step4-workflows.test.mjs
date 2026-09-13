// Test suite for Step 4 Phase 4C deterministic profile-aware workflow execution.
//
// Covers all 17 required criteria with fail-closed gate evaluation:
//  1. 8x2x2 execution matrix (32 total executions: 8 cases x 2 arms x 2 runs)
//  2. Disposable database lifecycle isolation (actual mkdtempSync directories, 32 unique basenames)
//  3. Tool surface integrity & exclusion of maintenance/SQL tools (41 full, 10 agent, 18 maintenance)
//  4. Raw vs. normalized preservation (raw wire bytes and normalized envelope)
//  5. Volatile field exclusions (digests, timestamps, latencies stripped)
//  6. Semantic hashing integrity (deterministic composite sha256)
//  7. UTF-8 byte accounting (Buffer.byteLength independent recomputation)
//  8. Median calculations (even & odd lengths)
//  9. Threshold branching evaluation (large_legacy, small_legacy, medians, retries, tokens)
// 10. Zero large cases edge case = not-applicable
// 11. Zero-write audit on bootstrap (0 writes, 0 events, access untouched)
// 12. Access effects tracking (expansions increment access, bootstrap zero-touch)
// 13. Scope violation detection (preserves exact project scope, detects cross-project leaks)
// 14. Infrastructure failure vs. executed gap distinction (gaps block Gate 4C)
// 15. pd-06 honest execution behavior (no fabricated refresh signals)
// 16. Path leakage rejection (no personal/temp paths in receipt or report)
// 17. Determinism (16/16 normalized semantic hash matches between Run A and Run B)
// 18. Fail-closed Gate 4C acceptance (receipt.gate_4c.gate_passed = false on gaps/threshold misses)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gradeTranscriptAgainstArm } from './arm-grader.mjs';
import { STEP4_CASES } from './transcript-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_PATH = join(HERE, 'cases.json');
const RECEIPT_PATH = join(HERE, 'phase-4c-receipt.json');
const REPORT_PATH = join(HERE, 'phase-4c-comparison-report.md');

const casesDoc = JSON.parse(readFileSync(CASES_PATH, 'utf8'));
const receipt = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));

// Helper algorithms to verify unit logic directly
function computeMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalizeEnvelope(val, volatileFields) {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(item => normalizeEnvelope(item, volatileFields));
  const result = {};
  for (const key of Object.keys(val).sort()) {
    if (volatileFields.has(key)) continue;
    result[key] = normalizeEnvelope(val[key], volatileFields);
  }
  return result;
}

// Deliberately independent from the runner: this verifier neither imports the
// runner nor its canonical serializer/hash helpers. It reconstructs every
// deterministic result from persisted raw transcript evidence and the frozen
// external arm grader.
function canonicalizeIndependent(value, seen = new WeakSet()) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite value');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (!value || typeof value !== 'object') throw new TypeError(`unsupported value: ${typeof value}`);
  if (seen.has(value)) throw new TypeError('circular value');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonicalizeIndependent(item, seen)).join(',')}]`;
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalizeIndependent(value[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256Independent(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isUnsupportedArgumentIndependent(envelope) {
  const error = envelope?.error && typeof envelope.error === 'object' ? envelope.error : {};
  const code = error.code ?? envelope?.code;
  if (code === -32602 || code === 'INVALID_PARAMS') return true;
  const message = [error.message, envelope?.message, envelope?.raw_text].filter(v => typeof v === 'string').join(' ').toLowerCase();
  return /invalid (params?|arguments?)|parameter validation|schema validation|unsupported (argument|parameter|response_mode)/.test(message);
}

function recomputeExecutionIndependent(execution, armDoc) {
  const volatile = new Set(receipt.volatile_field_exclusions);
  let retries = 0;
  let pendingCompactFailure = false;
  const transcript = execution.transcript.map(call => ({ tool: call.tool, args: call.args, response_envelope: call.raw_envelope }));
  for (const call of execution.transcript) {
    const compact = call.tool === 'cognitive_agent_bootstrap' && call.args.response_mode === 'compact';
    const fallback = call.tool === 'cognitive_agent_bootstrap' && (call.args.response_mode === undefined || call.args.response_mode === 'legacy');
    if (fallback && pendingCompactFailure) {
      retries++;
      pendingCompactFailure = false;
    } else if (compact) {
      pendingCompactFailure = call.is_error && isUnsupportedArgumentIndependent(call.raw_envelope);
    }
  }
  const callHashes = execution.transcript.map(call => sha256Independent(canonicalizeIndependent(normalizeEnvelope(call.raw_envelope, volatile))));
  const composite = sha256Independent(canonicalizeIndependent(execution.transcript.map((call, index) => ({
    sequence: call.sequence,
    tool: call.tool,
    args: call.args,
    normalized_envelope: normalizeEnvelope(call.raw_envelope, volatile),
  }))));
  const grade = gradeTranscriptAgainstArm(transcript, STEP4_CASES.find(c => c.id === execution.case_id), execution.arm);
  return {
    callHashes,
    composite,
    initial: execution.transcript.length ? Buffer.byteLength(execution.transcript[0].raw_wire, 'utf8') : null,
    total: execution.transcript.reduce((sum, call) => sum + Buffer.byteLength(call.raw_wire, 'utf8'), 0),
    calls: execution.transcript.length,
    retries,
    outcome: execution.infrastructure_failure
      ? 'infrastructure-failure'
      : grade.passed && !execution.transcript.some(call => call.raw_envelope?.ok === false)
        ? 'executed-pass'
        : 'executed-gap',
  };
}

function recomputeReceiptIndependent(receiptValue) {
  const results = new Map();
  for (const runName of ['per_case_run_a', 'per_case_run_b']) {
    for (const execution of receiptValue[runName]) {
      results.set(`${runName}:${execution.case_id}:${execution.arm}`, recomputeExecutionIndependent(execution));
    }
  }
  const runA = receiptValue.per_case_run_a;
  const control = runA.filter(e => e.arm === 'control');
  const candidate = runA.filter(e => e.arm === 'candidate');
  const byId = (rows, id) => rows.find(row => row.case_id === id);
  const initial = rows => rows.map(row => results.get(`per_case_run_a:${row.case_id}:${row.arm}`).initial);
  const total = rows => rows.map(row => results.get(`per_case_run_a:${row.case_id}:${row.arm}`).total);
  const calls = rows => rows.map(row => results.get(`per_case_run_a:${row.case_id}:${row.arm}`).calls);
  const controlInitial = initial(control);
  const candidateInitial = initial(candidate);
  const largeIds = control.filter(row => results.get(`per_case_run_a:${row.case_id}:control`).initial >= 8192).map(row => row.case_id);
  const reductions = largeIds.map(id => {
    const ctrl = results.get(`per_case_run_a:${id}:control`).initial;
    const cand = results.get(`per_case_run_a:${id}:candidate`).initial;
    return ((ctrl - cand) / ctrl) * 100;
  });
  const smallGrowth = control.filter(row => results.get(`per_case_run_a:${row.case_id}:control`).initial < 8192).map(row => {
    const ctrl = results.get(`per_case_run_a:${row.case_id}:control`).initial;
    const cand = results.get(`per_case_run_a:${row.case_id}:candidate`).initial;
    return { case_id: row.case_id, control_bytes: ctrl, candidate_bytes: cand, absolute_delta: cand - ctrl, growth_pct: ((cand - ctrl) / ctrl) * 100 };
  });
  const medControlCalls = computeMedian(calls(control));
  const medCandidateCalls = computeMedian(calls(candidate));
  const medControlContext = computeMedian(total(control));
  const medCandidateContext = computeMedian(total(candidate));
  const aggregate = {
    controlInitialBytes: controlInitial,
    candidateInitialBytes: candidateInitial,
    controlContextBytes: total(control),
    candidateContextBytes: total(candidate),
    controlCalls: calls(control),
    candidateCalls: calls(candidate),
    medianControlCalls: medControlCalls,
    medianCandidateCalls: medCandidateCalls,
    medianCallIncrease: medCandidateCalls - medControlCalls,
    medianControlContextBytes: medControlContext,
    medianCandidateContextBytes: medCandidateContext,
    medianContextBytesDelta: medCandidateContext - medControlContext,
    median_small_growth_pct: smallGrowth.length ? computeMedian(smallGrowth.map(row => row.growth_pct)) : null,
    thresholdResults: {
      large_legacy: { applicable: largeIds.length > 0, large_case_ids: largeIds, required_reduction_pct: 30, observed_reduction_pct: largeIds.length ? Math.round(Math.min(...reductions) * 100) / 100 : null, pass: largeIds.length ? Math.min(...reductions) >= 30 : null },
      small_legacy: { applicable: smallGrowth.length > 0, max_growth_pct_allowed: 10, observed_max_growth_pct: Math.round(Math.max(...smallGrowth.map(row => row.growth_pct)) * 100) / 100, pass: Math.max(...smallGrowth.map(row => row.growth_pct)) <= 10 },
      median_call_increase: { max_allowed: 1, observed: medCandidateCalls - medControlCalls, pass: medCandidateCalls - medControlCalls <= 1 },
      median_context_bytes: { must_not_increase: true, observed_delta: medCandidateContext - medControlContext, pass: medCandidateContext - medControlContext <= 0 },
      unsupported_argument_retries: {
        max_allowed: 1,
        observed_max_per_execution: Math.max(0, ...runA.map(row => results.get(`per_case_run_a:${row.case_id}:${row.arm}`).retries)),
        total_observed: runA.reduce((sum, row) => sum + results.get(`per_case_run_a:${row.case_id}:${row.arm}`).retries, 0),
        pass: true,
      },
      provider_token_savings: { claimed: false, status: 'not_claimed_by_design' },
    },
    small_case_deltas: smallGrowth.map(row => ({
      case_id: row.case_id,
      control_initial_bytes: row.control_bytes,
      candidate_initial_bytes: row.candidate_bytes,
      absolute_delta_bytes: row.absolute_delta,
      growth_pct: row.growth_pct,
    })),
  };
  aggregate.thresholdResults.unsupported_argument_retries.pass = aggregate.thresholdResults.unsupported_argument_retries.observed_max_per_execution <= 1;
  const det = receiptValue.determinism_comparison.map(entry => {
    const a = results.get(`per_case_run_a:${entry.case_id}:${entry.arm}`);
    const b = results.get(`per_case_run_b:${entry.case_id}:${entry.arm}`);
    return { ...entry, hashes_match: a.composite === b.composite, call_counts_match: a.calls === b.calls, outcomes_match: a.outcome === b.outcome, run_a_hash: a.composite, run_b_hash: b.composite };
  });
  const runAOutcomes = runA.map(row => ({ row, outcome: results.get(`per_case_run_a:${row.case_id}:${row.arm}`).outcome }));
  const gaps = runAOutcomes.filter(({ outcome }) => outcome === 'executed-gap');
  const infra = runAOutcomes.filter(({ outcome }) => outcome === 'infrastructure-failure');
  const thresholdReasons = [];
  if (aggregate.thresholdResults.large_legacy.applicable && !aggregate.thresholdResults.large_legacy.pass) thresholdReasons.push(`Large-response reduction failed: ${aggregate.thresholdResults.large_legacy.observed_reduction_pct}% < 30%`);
  if (aggregate.thresholdResults.small_legacy.applicable && !aggregate.thresholdResults.small_legacy.pass) thresholdReasons.push(`Small-response growth failed: ${aggregate.thresholdResults.small_legacy.observed_max_growth_pct}% > 10%`);
  if (!aggregate.thresholdResults.median_call_increase.pass) thresholdReasons.push(`Median call increase failed: +${aggregate.medianCallIncrease} > 1`);
  if (!aggregate.thresholdResults.median_context_bytes.pass) thresholdReasons.push(`Median context bytes failed: +${aggregate.medianContextBytesDelta} B > 0 B`);
  if (!aggregate.thresholdResults.unsupported_argument_retries.pass) thresholdReasons.push('Unsupported argument retries exceeded max allowed');
  const reasons = [];
  if (gaps.length) reasons.push(`Deterministic executed-gaps observed: ${gaps.map(({ row }) => `${row.case_id} (${row.arm})`).join(', ')}`);
  if (infra.length) reasons.push(`Infrastructure failures observed: ${infra.length}`);
  if (det.some(item => !item.hashes_match || !item.call_counts_match || !item.outcomes_match)) reasons.push(`Determinism mismatches between Run A and Run B: ${det.filter(item => !item.hashes_match || !item.call_counts_match || !item.outcomes_match).length}`);
  reasons.push(...thresholdReasons);
  return { results, aggregate, det, gate: { gate_passed: reasons.length === 0, gate_status: reasons.length === 0 ? 'PASS' : 'FAIL', total_cases: casesDoc.cases.length, control_pass_count: runAOutcomes.filter(({ row, outcome }) => row.arm === 'control' && outcome === 'executed-pass').length, candidate_pass_count: runAOutcomes.filter(({ row, outcome }) => row.arm === 'candidate' && outcome === 'executed-pass').length, gap_count: gaps.length, infra_failure_count: infra.length, determinism_mismatch_count: det.filter(item => !item.hashes_match || !item.call_counts_match || !item.outcomes_match).length, threshold_failure_count: thresholdReasons.length, failure_reasons: reasons } };
}

function evaluateLargeThreshold(controlRuns, candidateRuns, minBytes = 8192, requiredReductionPct = 30) {
  const largeCases = controlRuns
    .filter(r => r.initial_response_bytes >= minBytes)
    .map(r => r.case_id);

  if (largeCases.length === 0) {
    return {
      applicable: false,
      large_case_ids: [],
      required_reduction_pct: requiredReductionPct,
      observed_reduction_pct: null,
      pass: null,
    };
  }

  const reductions = largeCases.map(id => {
    const ctrl = controlRuns.find(r => r.case_id === id).initial_response_bytes;
    const cand = candidateRuns.find(r => r.case_id === id).initial_response_bytes;
    return ((ctrl - cand) / ctrl) * 100;
  });
  const minReduction = Math.min(...reductions);
  return {
    applicable: true,
    large_case_ids: largeCases,
    required_reduction_pct: requiredReductionPct,
    observed_reduction_pct: Math.round(minReduction * 100) / 100,
    pass: minReduction >= requiredReductionPct,
  };
}

// ------------------------------------------------------------------
// 1. 8x2x2 Execution Matrix & Real Transport
// ------------------------------------------------------------------
test('criterion 1: receipt contains complete 8x2x2 execution matrix via real InMemoryTransport', () => {
  assert.equal(receipt.phase, '4C');
  assert.equal(receipt.receipt_schema, 'phase-4c-profile-aware-receipt/v2');
  assert.equal(receipt.per_case_run_a.length, 16, 'Run A must have 16 executions (8 cases x 2 arms)');
  assert.equal(receipt.per_case_run_b.length, 16, 'Run B must have 16 executions (8 cases x 2 arms)');

  // Verify real transport layer
  assert.equal(
    receipt.execution_layer.transport,
    'InMemoryTransport (JSON-RPC 2.0 via @modelcontextprotocol/sdk)',
  );
  assert.equal(receipt.execution_layer.autonomous_tool_selection, false);
  assert.equal(receipt.execution_layer.scripted_flow, true);

  const expectedCases = casesDoc.cases.map(c => c.id);
  assert.deepEqual(receipt.exact_case_order, expectedCases);

  for (const run of [receipt.per_case_run_a, receipt.per_case_run_b]) {
    for (let i = 0; i < expectedCases.length; i++) {
      const caseId = expectedCases[i];
      const ctrl = run[i * 2];
      const cand = run[i * 2 + 1];

      assert.equal(ctrl.case_id, caseId);
      assert.equal(ctrl.arm, 'control');
      assert.equal(ctrl.profile, 'full');
      assert.equal(ctrl.bootstrap_response_mode, 'legacy');
      assert.equal(ctrl.clean_starting_state, true, `Control ${caseId} must start with clean DB state`);

      assert.equal(cand.case_id, caseId);
      assert.equal(cand.arm, 'candidate');
      assert.equal(cand.profile, 'agent');
      assert.equal(cand.bootstrap_response_mode, 'compact');
      assert.equal(cand.clean_starting_state, true, `Candidate ${caseId} must start with clean DB state`);
    }
  }
});

// ------------------------------------------------------------------
// 2. Disposable Database Lifecycle Isolation
// ------------------------------------------------------------------
test('criterion 2: per-case isolated disposable databases with actual mkdtempSync basenames', () => {
  const basenames = receipt.disposable_db_basenames;
  assert.equal(basenames.length, 32, 'Must record 32 disposable database basenames');
  const uniqueBasenames = new Set(basenames);
  assert.equal(uniqueBasenames.size, 32, 'All 32 database basenames must be unique');

  for (const name of basenames) {
    // Verified mkdtempSync suffix format: disposable-(runA|runB)-pd-XX-...-XXXXXX
    assert.match(name, /^disposable-(runA|runB)-pd-\d{2}-[\w-]+-(control|candidate)-[0-9A-Za-z]+$/);
  }
});

test('criterion 2b: receipt lifecycle retains one immutable pre-repair pair and creates no rolling hash archives', () => {
  assert.equal(existsSync(join(HERE, 'phase-4c-receipt.pre-repair-20260912.json')), true);
  assert.equal(existsSync(join(HERE, 'phase-4c-comparison-report.pre-repair-20260912.md')), true);
  assert.deepEqual(readdirSync(HERE).filter(name => name.includes('.historical-')), []);
  assert.equal(receipt.output_lifecycle.overwrite_policy, 'explicit-replace-current');
  assert.equal(receipt.output_lifecycle.immutable_pre_repair_baseline.receipt_file, 'phase-4c-receipt.pre-repair-20260912.json');
  assert.equal(receipt.output_lifecycle.immutable_pre_repair_baseline.report_file, 'phase-4c-comparison-report.pre-repair-20260912.md');
});

// ------------------------------------------------------------------
// 3. Tool Surface Integrity & Exclusion of Maintenance/SQL Tools
// ------------------------------------------------------------------
test('criterion 3: tool surface integrity (41 full, 10 agent, 18 maintenance, zero leaks)', () => {
  const { full, agent, maintenance } = receipt.profile_tool_lists;
  assert.equal(full.length, 41, 'Full profile must contain exactly 41 tools');
  assert.equal(agent.length, 10, 'Agent profile must contain exactly 10 workflow tools');
  assert.equal(maintenance.length, 18, 'Maintenance profile must contain 18 tools');

  // Exact agent tools (sorted)
  assert.deepEqual(agent.slice().sort(), casesDoc.agent_profile_tool_names.slice().sort());

  // Agent profile must not intersect with maintenance profile
  const agentSet = new Set(agent);
  for (const mTool of maintenance) {
    assert.equal(agentSet.has(mTool), false, `Agent profile must not contain maintenance tool: ${mTool}`);
  }

  // Agent profile must not contain SQL tools
  for (const sqlTool of ['sql_query', 'sql_execute', 'sql_introspect']) {
    assert.equal(agentSet.has(sqlTool), false, `Agent profile must not contain SQL tool: ${sqlTool}`);
  }

  // In all candidate executions, in_profile must be true for all calls
  for (const run of [receipt.per_case_run_a, receipt.per_case_run_b]) {
    for (const exec of run) {
      if (exec.arm === 'candidate') {
        for (const call of exec.transcript) {
          assert.equal(call.in_profile, true, `Candidate tool call ${call.tool} must be in agent profile`);
          assert.equal(agentSet.has(call.tool), true, `Tool ${call.tool} must be in agent profile set`);
        }
      }
    }
  }
});

// ------------------------------------------------------------------
// 4. Raw vs. Normalized Preservation
// ------------------------------------------------------------------
test('criterion 4: raw wire bytes and normalized envelope preserved across all calls', () => {
  for (const run of [receipt.per_case_run_a, receipt.per_case_run_b]) {
    for (const exec of run) {
      for (const call of exec.transcript) {
        assert.ok(typeof call.raw_wire === 'string', 'raw_wire must be a string');
        assert.ok(call.raw_wire_utf8_bytes > 0, 'raw_wire_utf8_bytes must be positive');
        assert.ok(call.raw_envelope !== undefined, 'raw_envelope must be preserved');
        assert.ok(call.normalized_envelope !== undefined, 'normalized_envelope must be preserved');

        // Volatiles stripped from normalized
        for (const vol of casesDoc.volatile_field_exclusions) {
          assert.equal(call.normalized_envelope?.[vol], undefined, `Normalized envelope must not contain volatile field ${vol}`);
        }
      }
    }
  }
});

// ------------------------------------------------------------------
// 5. Volatile Field Exclusions
// ------------------------------------------------------------------
test('criterion 5: volatile field exclusions strip digests, timestamps, and latencies', () => {
  const volatileSet = new Set(casesDoc.volatile_field_exclusions);
  assert.ok(volatileSet.has('compact_digest'));
  assert.ok(volatileSet.has('bootstrap_digest'));
  assert.ok(volatileSet.has('evaluated_at'));
  assert.ok(volatileSet.has('latency_ms'));

  const raw1 = {
    orientation: { status: 'complete', project_id: 'test' },
    compact_digest: 'digest-1111',
    evaluated_at: '2026-09-11T00:00:00Z',
    latency_ms: 12.3,
  };
  const raw2 = {
    orientation: { status: 'complete', project_id: 'test' },
    compact_digest: 'digest-9999',
    evaluated_at: '2026-09-12T99:99:99Z',
    latency_ms: 999.9,
  };

  const norm1 = normalizeEnvelope(raw1, volatileSet);
  const norm2 = normalizeEnvelope(raw2, volatileSet);

  assert.deepEqual(norm1, norm2, 'Normalized envelopes must match despite different volatile values');
  assert.equal(norm1.compact_digest, undefined);
  assert.equal(norm1.evaluated_at, undefined);
  assert.equal(norm1.latency_ms, undefined);
});

// ------------------------------------------------------------------
// 6. Semantic Hashing Integrity
// ------------------------------------------------------------------
test('criterion 6: composite semantic hash is a deterministic 64-char sha256', () => {
  for (const exec of receipt.per_case_run_a) {
    assert.match(exec.normalized_semantic_hash, /^[0-9a-f]{64}$/, 'Hash must be 64-char lowercase hex');
    for (const call of exec.transcript) {
      assert.match(call.semantic_hash, /^[0-9a-f]{64}$/, 'Call hash must be 64-char lowercase hex');
    }
  }
});

// ------------------------------------------------------------------
// 7. UTF-8 Byte Accounting & Independent Recomputation
// ------------------------------------------------------------------
test('criterion 7: UTF-8 byte accounting accurately measures wire byte lengths and recomputes independently', () => {
  for (const run of [receipt.per_case_run_a, receipt.per_case_run_b]) {
    for (const exec of run) {
      for (const call of exec.transcript) {
        const recomputedBytes = Buffer.byteLength(call.raw_wire, 'utf8');
        assert.equal(
          call.raw_wire_utf8_bytes,
          recomputedBytes,
          `raw_wire_utf8_bytes must match Buffer.byteLength for call ${call.tool}`,
        );
      }
    }
  }

  // Verify multi-byte character accounting
  const multiByteStr = '{"greeting":"Hello 🌍 🚀"}';
  assert.notEqual(multiByteStr.length, Buffer.byteLength(multiByteStr, 'utf8'));
  assert.equal(Buffer.byteLength(multiByteStr, 'utf8'), 30);
});

test('criterion 7b: independent verifier reconstructs exact transcript hashes, aggregates, determinism, and Gate 4C', () => {
  const independent = recomputeReceiptIndependent(receipt);

  for (const runName of ['per_case_run_a', 'per_case_run_b']) {
    for (const execution of receipt[runName]) {
      const reconstructed = independent.results.get(`${runName}:${execution.case_id}:${execution.arm}`);
      assert.equal(reconstructed.composite, execution.normalized_semantic_hash, `Composite hash differs for ${runName}/${execution.case_id}/${execution.arm}`);
      assert.equal(reconstructed.initial, execution.initial_response_bytes);
      assert.equal(reconstructed.total, execution.total_context_bytes);
      assert.equal(reconstructed.calls, execution.calls);
      assert.equal(reconstructed.retries, execution.retries_observed);
      assert.equal(reconstructed.outcome, execution.outcome, `Outcome differs for ${runName}/${execution.case_id}/${execution.arm}`);
      execution.transcript.forEach((call, index) => {
        assert.equal(Buffer.byteLength(call.raw_wire, 'utf8'), call.raw_wire_utf8_bytes);
        assert.deepEqual(normalizeEnvelope(call.raw_envelope, new Set(receipt.volatile_field_exclusions)), call.normalized_envelope);
        assert.equal(reconstructed.callHashes[index], call.semantic_hash);
      });
    }
  }

  assert.deepEqual(independent.aggregate, receipt.aggregate_metrics);
  assert.deepEqual(independent.det, receipt.determinism_comparison);
  assert.deepEqual(independent.gate, receipt.gate_4c);
});

// ------------------------------------------------------------------
// 8. Median Calculations (Even & Odd Lengths)
// ------------------------------------------------------------------
test('criterion 8: median calculation handles even and odd lengths correctly', () => {
  assert.equal(computeMedian([5]), 5);
  assert.equal(computeMedian([1, 3, 5]), 3);
  assert.equal(computeMedian([5, 1, 3]), 3, 'Must sort before finding median');
  assert.equal(computeMedian([1, 2, 3, 4]), 2.5);
  assert.equal(computeMedian([10, 20, 30, 40]), 25);

  const agg = receipt.aggregate_metrics;
  const ctrlCalls = receipt.per_case_run_a.filter(r => r.arm === 'control').map(r => r.calls);
  const candCalls = receipt.per_case_run_a.filter(r => r.arm === 'candidate').map(r => r.calls);
  assert.equal(computeMedian(ctrlCalls), agg.medianControlCalls);
  assert.equal(computeMedian(candCalls), agg.medianCandidateCalls);
});

// ------------------------------------------------------------------
// 9. Threshold Branching Evaluation (Honest Reporting of Passes and Fails)
// ------------------------------------------------------------------
test('criterion 9: threshold branching correctly evaluates all frozen thresholds without hiding failures', () => {
  const th = receipt.aggregate_metrics.thresholdResults;

  // large_legacy: >= 30% reduction (PASSED on pd-04)
  assert.equal(th.large_legacy.applicable, true);
  assert.equal(th.large_legacy.required_reduction_pct, 30);
  assert.ok(th.large_legacy.observed_reduction_pct >= 30);
  assert.equal(th.large_legacy.pass, true);

  // small_legacy: <= 10% max growth
  assert.equal(th.small_legacy.applicable, true);
  assert.equal(th.small_legacy.max_growth_pct_allowed, 10);
  assert.ok(th.small_legacy.observed_max_growth_pct <= 10, 'Small-legacy growth must stay within 10%');
  assert.equal(th.small_legacy.pass, true, 'Small-legacy threshold must be honestly evaluated as PASS');

  // median_call_increase: <= 1 (PASSED: delta = 0)
  assert.equal(th.median_call_increase.max_allowed, 1);
  assert.equal(th.median_call_increase.observed, 0);
  assert.equal(th.median_call_increase.pass, true);

  // median_context_bytes: must not increase
  assert.equal(th.median_context_bytes.must_not_increase, true);
  assert.ok(th.median_context_bytes.observed_delta <= 0, 'Median context bytes must not increase over control');
  assert.equal(th.median_context_bytes.pass, true, 'Median context threshold must be honestly evaluated as PASS');

  // Retry bound is per workflow; totals remain descriptive only.
  assert.equal(th.unsupported_argument_retries.max_allowed, 1);
  assert.ok(th.unsupported_argument_retries.observed_max_per_execution <= 1);
  assert.ok(th.unsupported_argument_retries.total_observed >= th.unsupported_argument_retries.observed_max_per_execution);
  assert.equal(th.unsupported_argument_retries.pass, th.unsupported_argument_retries.observed_max_per_execution <= 1);

  // provider_tokens: not claimed
  assert.equal(th.provider_token_savings.claimed, false);
  assert.equal(th.provider_token_savings.status, 'not_claimed_by_design');
});

// ------------------------------------------------------------------
// 10. Zero Large Cases Edge Case = Not-Applicable
// ------------------------------------------------------------------
test('criterion 10: zero large cases edge case evaluates to applicable=false / NOT_APPLICABLE', () => {
  const fakeControl = [
    { case_id: 'c1', initial_response_bytes: 1000 },
    { case_id: 'c2', initial_response_bytes: 2000 },
  ];
  const fakeCandidate = [
    { case_id: 'c1', initial_response_bytes: 1000 },
    { case_id: 'c2', initial_response_bytes: 2000 },
  ];

  const result = evaluateLargeThreshold(fakeControl, fakeCandidate, 8192, 30);
  assert.equal(result.applicable, false);
  assert.deepEqual(result.large_case_ids, []);
  assert.equal(result.observed_reduction_pct, null);
  assert.equal(result.pass, null);
});

// ------------------------------------------------------------------
// 11. Zero-Write Audit on Bootstrap
// ------------------------------------------------------------------
test('criterion 11: zero-write audit confirms 0 table writes and 0 events during bootstrap', () => {
  for (const run of [receipt.per_case_run_a, receipt.per_case_run_b]) {
    for (const exec of run) {
      assert.equal(exec.mutation_audit.bootstrap_writes, 0, 'Bootstrap must write 0 rows');
      assert.equal(exec.mutation_audit.bootstrap_events, 0, 'Bootstrap must append 0 events');
      assert.equal(exec.mutation_audit.bootstrap_access_tracking, 'not_touched');
      assert.equal(exec.mutation_audit.bootstrap_receipts, 'none');
      assert.equal(exec.mutation_audit.verdict_pass, true);
    }
  }
});

// ------------------------------------------------------------------
// 12. Access Effects Tracking
// ------------------------------------------------------------------
test('criterion 12: access effects tracked transparently on expansion while bootstrap is zero-touch', () => {
  for (const exec of receipt.per_case_run_a) {
    const bootstrapCall = exec.transcript[0];
    assert.equal(bootstrapCall.tool, 'cognitive_agent_bootstrap');
    assert.equal(bootstrapCall.access_tracking_observed, 'none');

    // If an expansion call is made (e.g. memory_read:get), it honestly observes access tracking
    for (let i = 1; i < exec.transcript.length; i++) {
      const call = exec.transcript[i];
      if (call.tool === 'memory_read') {
        assert.equal(call.access_tracking_observed, 'touched');
      }
    }
  }
});

// ------------------------------------------------------------------
// 13. Scope Violation Detection
// ------------------------------------------------------------------
test('criterion 13: scope violation audit validates exact project scope preservation', () => {
  for (const run of [receipt.per_case_run_a, receipt.per_case_run_b]) {
    for (const exec of run) {
      assert.equal(exec.scope_audit.scope_preserved, true, `Scope must be preserved in ${exec.case_id}/${exec.arm}`);
      assert.equal(exec.scope_violations, 0);
    }
  }

  // In pd-05-wrong-project, verify candidate scope isolation
  const pd05Cand = receipt.per_case_run_a.find(r => r.case_id === 'pd-05-wrong-project' && r.arm === 'candidate');
  const env = pd05Cand.transcript[0].raw_envelope;
  const hydrated = (env.orientation?.records ?? []).concat(env.orientation?.guidance_candidates ?? []);
  for (const rec of hydrated) {
    assert.equal(rec.project_id, 'fixture-alpha', 'Hydrated record must strictly belong to requested fixture-alpha project');
    assert.notEqual(rec.project_id, 'foreign-project', 'Foreign project records must not be hydrated');
  }
});

// ------------------------------------------------------------------
// 14. Infrastructure Failure vs. Executed Gap Distinction
// ------------------------------------------------------------------
test('criterion 14: infrastructure failures and executed gaps are derived from transcript evidence', () => {
  let infraFailures = 0;
  let executedGaps = 0;
  let executedPasses = 0;

  for (const exec of receipt.per_case_run_a) {
    if (exec.outcome === 'infrastructure-failure') infraFailures++;
    if (exec.outcome === 'executed-gap') executedGaps++;
    if (exec.outcome === 'executed-pass') executedPasses++;
  }

  assert.equal(infraFailures, receipt.gate_4c.infra_failure_count);
  assert.equal(executedGaps, receipt.gate_4c.gap_count);
  assert.equal(executedPasses + executedGaps + infraFailures, receipt.per_case_run_a.length);

  const gapCases = receipt.per_case_run_a.filter(r => r.outcome === 'executed-gap');
  for (const gap of gapCases) {
    assert.ok(!gap.grader_verdict.passed || gap.tool_response_errors > 0, `Gap ${gap.case_id}/${gap.arm} needs grader or product-error evidence`);
  }
});

test('criterion 14b: runner classification makes transport/harness failures reachable and keeps product errors distinct', () => {
  const runnerUrl = new URL('./run-step4-workflows.mts', import.meta.url).href;
  const program = `import { classifyExecutionOutcome, isUnsupportedArgumentFailure, isStructuredToolResponseError, evaluateRetryThreshold, canReplaceCurrentAliases } from ${JSON.stringify(runnerUrl)}; console.log(JSON.stringify({ pass: classifyExecutionOutcome(true, false), gap: classifyExecutionOutcome(false, false), productGap: classifyExecutionOutcome(true, false, true), infra: classifyExecutionOutcome(false, true), invalid: isUnsupportedArgumentFailure({ error: { code: -32602, message: 'Invalid params' } }), product: isUnsupportedArgumentFailure({ error: { message: 'record not found' } }), structured: isStructuredToolResponseError({ ok: false, code: 'OUT_OF_SCOPE' }), independentRetries: evaluateRetryThreshold([1, 1]), excessiveRetries: evaluateRetryThreshold([2]), replaceBlocked: canReplaceCurrentAliases(true, false), replaceAllowed: canReplaceCurrentAliases(true, true) }));`;
  const tsxCli = join(HERE, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const invoked = spawnSync(process.execPath, [tsxCli, '-e', program], { cwd: HERE, encoding: 'utf8' });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.deepEqual(JSON.parse(invoked.stdout), {
    pass: 'executed-pass',
    gap: 'executed-gap',
    productGap: 'executed-gap',
    infra: 'infrastructure-failure',
    invalid: true,
    product: false,
    structured: true,
    independentRetries: { max_allowed: 1, observed_max_per_execution: 1, total_observed: 2, pass: true },
    excessiveRetries: { max_allowed: 1, observed_max_per_execution: 2, total_observed: 2, pass: false },
    replaceBlocked: false,
    replaceAllowed: true,
  });
});

test('criterion 14c: pd-03 public epistemic reads return seeded records rather than domain errors', () => {
  for (const run of [receipt.per_case_run_a, receipt.per_case_run_b]) {
    for (const execution of run.filter(row => row.case_id === 'pd-03-fresh-contradiction')) {
      const call = execution.transcript.find(entry => entry.tool === (execution.arm === 'control' ? 'epistemic_get' : 'epistemic_inspect'));
      assert.ok(call, `Missing pd-03 ${execution.arm} epistemic read`);
      assert.equal(call.raw_envelope.ok, true, `pd-03 ${execution.arm} must read a seeded record`);
      assert.equal(call.error_classification, 'none');
      assert.equal(call.args_accepted, true);
    }
  }
});

test('criterion 14d: pd-02 uses one deterministic signed manifest in both arms and verifies governing task state', () => {
  for (const run of [receipt.per_case_run_a, receipt.per_case_run_b]) {
    const control = run.find(row => row.case_id === 'pd-02-valid-manifest' && row.arm === 'control');
    const candidate = run.find(row => row.case_id === 'pd-02-valid-manifest' && row.arm === 'candidate');
    assert.ok(control && candidate);
    assert.deepEqual(control.transcript[0].args.task_state, candidate.transcript[0].args.task_state);
    assert.equal(candidate.calls, 1, 'compact signed-manifest orientation must not require an unrelated follow-up read');
    assert.equal(candidate.outcome, 'executed-pass');
    const response = candidate.transcript[0].raw_envelope;
    assert.equal(response?.verification?.adoption_status, 'verified');
    assert.equal(response?.orientation?.task_state, 'assembled');
    assert.equal(response?.task?.objective?.status, 'governing');
    assert.equal(response?.task?.definition_of_done?.status, 'governing');
    assert.equal(response?.task?.constraints?.status, 'resolved');
    assert.equal(response?.task?.next_action?.status, 'governing');
    assert.equal(candidate.mutation_audit.verdict_pass, true);
  }
});

test('criterion 14e: pd-03 derives scoped contradiction evidence and routes review through epistemic inspection', () => {
  for (const run of [receipt.per_case_run_a, receipt.per_case_run_b]) {
    const candidate = run.find(row => row.case_id === 'pd-03-fresh-contradiction' && row.arm === 'candidate');
    assert.ok(candidate);
    assert.equal(candidate.outcome, 'executed-pass');
    assert.equal(candidate.expansion_violations, 0);
    assert.equal(candidate.mutation_audit.verdict_pass, true);

    const bootstrap = candidate.transcript[0].raw_envelope;
    assert.deepEqual(bootstrap.warnings, ['explicit_contradiction_present']);
    assert.equal(bootstrap.guidance.governing_candidates[0].id, 104);
    assert.equal(bootstrap.guidance.governing_candidates[0].review_state, 'contradiction_review_required');
    assert.deepEqual(bootstrap.expansions[0], {
      access_tracking: 'none',
      expected_version: null,
      reason: 'contradiction_requires_review',
      route: {
        arguments: { include_global: false, operation: 'get', project_id: 'fixture-alpha', record_id: 104 },
        operation: 'get',
        tool: 'epistemic_inspect',
      },
      route_available: true,
      source: { kind: 'epistemic_record', project_id: 'fixture-alpha', record_id: '104' },
    });

    const inspection = candidate.transcript[1];
    assert.equal(inspection.tool, 'epistemic_inspect');
    assert.deepEqual(inspection.args, { operation: 'get', record_id: 104, project_id: 'fixture-alpha' });
    assert.equal(inspection.raw_envelope.ok, true);
    assert.equal(inspection.raw_envelope.record.source_memory_id, 104);
  }
});

// ------------------------------------------------------------------
// 15. pd-06 Honest Execution Behavior
// ------------------------------------------------------------------
test('criterion 15: pd-06 executes honestly without fabricated refresh/version mismatch signals', () => {
  const pd06CandA = receipt.per_case_run_a.find(r => r.case_id === 'pd-06-source-revised' && r.arm === 'candidate');
  const pd06CandB = receipt.per_case_run_b.find(r => r.case_id === 'pd-06-source-revised' && r.arm === 'candidate');

  assert.equal(pd06CandA.outcome, 'executed-pass');
  assert.equal(pd06CandB.outcome, 'executed-pass');
  assert.equal(pd06CandA.calls, 3);
  assert.equal(pd06CandB.calls, 3);

  // Call 1: bootstrap
  assert.equal(pd06CandA.transcript[0].tool, 'cognitive_agent_bootstrap');
  // Call 2: memory_read
  assert.equal(pd06CandA.transcript[1].tool, 'memory_read');
  // Call 3: bootstrap (re-bootstrap after expansion)
  assert.equal(pd06CandA.transcript[2].tool, 'cognitive_agent_bootstrap');
});

// ------------------------------------------------------------------
// 16. Path Leakage Rejection
// ------------------------------------------------------------------
test('criterion 16: receipt and report reject personal paths and temporary dir leakage', () => {
  const LEAK_PATTERNS = [
    String.fromCharCode(86, 97, 110, 67, 104),
    'C:' + String.fromCharCode(92, 92) + 'Users',
    'Documents' + String.fromCharCode(92, 92) + 'Projects',
    String.fromCharCode(77, 69, 77, 95, 71, 82, 65, 80, 72, 95, 68, 73, 82),
  ];
  const LEAK_RE = new RegExp(LEAK_PATTERNS.join('|'), 'i');

  const receiptRaw = readFileSync(RECEIPT_PATH, 'utf8');
  assert.equal(LEAK_RE.test(receiptRaw), false, 'Receipt must not leak personal or sensitive paths');

  const reportRaw = readFileSync(REPORT_PATH, 'utf8');
  assert.equal(LEAK_RE.test(reportRaw), false, 'Report must not leak personal or sensitive paths');
});

// ------------------------------------------------------------------
// 17. Determinism (16/16 matches)
// ------------------------------------------------------------------
test('criterion 17: cross-run determinism verifies 100% hash and outcome match between Run A and Run B', () => {
  assert.equal(receipt.determinism_comparison.length, 16);

  for (const comparison of receipt.determinism_comparison) {
    assert.equal(
      comparison.hashes_match,
      true,
      `Semantic hash mismatch in ${comparison.case_id}/${comparison.arm}: Run A=${comparison.run_a_hash}, Run B=${comparison.run_b_hash}`,
    );
    assert.equal(
      comparison.call_counts_match,
      true,
      `Call count mismatch in ${comparison.case_id}/${comparison.arm}`,
    );
    assert.equal(
      comparison.outcomes_match,
      true,
      `Outcome mismatch in ${comparison.case_id}/${comparison.arm}`,
    );
  }
});

// ------------------------------------------------------------------
// 18. Fail-Closed Gate 4C Acceptance Verification
// ------------------------------------------------------------------
test('criterion 18: Gate 4C verdict is derived fail-closed from gaps, failures, and thresholds', () => {
  const gate = receipt.gate_4c;
  const independentlyDerived = recomputeReceiptIndependent(receipt).gate;
  assert.deepEqual(gate, independentlyDerived);
  const hasBlockingEvidence = gate.gap_count > 0
    || gate.threshold_failure_count > 0
    || gate.infra_failure_count > 0
    || gate.determinism_mismatch_count > 0;
  assert.equal(gate.gate_passed, !hasBlockingEvidence);
  assert.equal(gate.gate_status, gate.gate_passed ? 'PASS' : 'FAIL');
  assert.equal(gate.failure_reasons.length === 0, gate.gate_passed);
});
