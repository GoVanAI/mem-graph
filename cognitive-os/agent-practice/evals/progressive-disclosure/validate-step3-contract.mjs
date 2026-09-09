#!/usr/bin/env node
// Step 3 contract validator. Pure Node; no I/O beyond reading the local
// contract files. Fails closed when:
//   - cases.json is missing fixture_intent, required_predicates, or
//     forbidden_predicates on any case;
//   - any predicate fails structural validation (RFC 6901, operator set,
//     value type / presence);
//   - any pointer would not decode (rejects invalid tilde escapes for
//     defense in depth even when the schema pattern would have caught it);
//   - any case changes measurement_status away from contract-only without
//     declared evidence (Phase D is the only place that may flip this);
//   - any case violates its declared fixture treatment per design Section 11
//     (pd-01 lexical, others deterministic);
//   - required_predicates or forbidden_predicates contain unknown operators
//     or array values;
//   - a deterministic canonical-source case omits its required canonical_ids;
//   - any case's required_predicates point at a path that does not resolve
//     against that case's representative envelope (catches nonexistent paths
//     such as /task/objective/authority);
//   - any case plan does not pass against its representative envelope;
//   - any case plan does not fail against its counterexample envelope.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodePointer, validatePredicate, evaluatePlan } from './structured-predicate.mjs';
import { ALL_FIXTURES, COUNTEREXAMPLES } from './case-fixtures.mjs';

// Mirror of the canonical serializer in src/cognitive/bootstrap-disclosure.ts.
// Both files must produce byte-identical output for the same input so that
// compact_digest recomputation matches the runner.
function serializeCanonical(value, seen = new WeakSet()) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot serialize non-finite number: ${value}`);
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    throw new TypeError(`Unsupported canonical value type: ${typeof value}`);
  }
  if (typeof value !== 'object') throw new TypeError(`Unsupported type for serialization: ${typeof value}`);
  if (seen.has(value)) throw new TypeError('Converting circular structure to JSON');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => {
        if (item === undefined || typeof item === 'symbol' || typeof item === 'function') return 'null';
        return serializeCanonical(item, seen);
      });
      return `[${items.join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const entries = [];
    for (const key of keys) {
      const v = value[key];
      if (v === undefined || typeof v === 'symbol' || typeof v === 'function') continue;
      entries.push(`${JSON.stringify(key)}:${serializeCanonical(v, seen)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value) {
  if (value === undefined || typeof value === 'symbol' || typeof value === 'function') {
    throw new TypeError(`Unsupported top-level value for canonical JSON: ${typeof value}`);
  }
  return serializeCanonical(value);
}

const here = dirname(fileURLToPath(import.meta.url));
const casesPath = join(here, 'cases.json');
const casesSchemaPath = join(here, 'cases.schema.json');
const receiptPath = join(here, 'phase-d-receipt.json');

const errors = [];
const warnings = [];

const ALLOWED_MEASUREMENT_STATUSES = new Set([
  'contract-only-not-executed',
  'executed-pass',
  'executed-gap',
  'executed-unavailable',
]);

const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null;
const receiptByCase = new Map();
const receiptRunBByCase = new Map();
if (receipt && Array.isArray(receipt.per_case)) {
  for (const ev of receipt.per_case) receiptByCase.set(ev.case_id, ev);
}
if (receipt && Array.isArray(receipt.per_case_run_b)) {
  for (const ev of receipt.per_case_run_b) receiptRunBByCase.set(ev.case_id, ev);
}

function fail(message) { errors.push(message); }

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const casesSchema = JSON.parse(readFileSync(casesSchemaPath, 'utf8'));

// --- Schema-level checks --------------------------------------------------

if (casesSchema.$schema?.includes('2020-12') !== true) {
  fail('cases.schema.json must declare draft 2020-12');
}
if (cases.$schema !== './cases.schema.json') {
  fail('cases.json must declare $schema "./cases.schema.json"');
}
if (cases.schema_version !== '1.0.0') {
  fail(`cases.schema_version must be "1.0.0"; got ${JSON.stringify(cases.schema_version)}`);
}
if (cases.fixture_policy !== 'synthetic-only') {
  fail(`cases.fixture_policy must be "synthetic-only"; got ${JSON.stringify(cases.fixture_policy)}`);
}
if (!Array.isArray(cases.cases) || cases.cases.length !== 8) {
  fail(`cases.cases must be an array of exactly 8 entries; got ${Array.isArray(cases.cases) ? cases.cases.length : 'non-array'}`);
}

const expectedIds = [
  'pd-01-ordinary-restart',
  'pd-02-valid-manifest',
  'pd-03-fresh-contradiction',
  'pd-04-long-governing-record',
  'pd-05-wrong-project',
  'pd-06-source-revised',
  'pd-07-history-heavy',
  'pd-08-degraded-input',
];
const seenIds = new Set();
const fixtureIntents = new Set();
const pointerCoverage = { ok: 0, malformed: 0, unknownOperator: 0, arrayValue: 0 };

// Canonical-IDs requirements per design Section 11 and Codex review.
const canonicalIdRequirements = {
  'pd-04-long-governing-record': [106],
  'pd-05-wrong-project': [107, 108, 109],
  'pd-07-history-heavy': [111, 112, 113],
  'pd-08-degraded-input': [114, 115],
};

// Per-case expected execution layer (Codex review said declared when applicable).
const expectedExecutionLayer = {
  'pd-01-ordinary-restart': null, // contract-only lexical discovery, no execution layer required
  'pd-02-valid-manifest': 'pure_projection',
  'pd-03-fresh-contradiction': 'pure_projection',
  'pd-04-long-governing-record': 'mcp_bootstrap',
  'pd-05-wrong-project': 'mcp_bootstrap',
  'pd-06-source-revised': 'mcp_bootstrap',
  'pd-07-history-heavy': 'mcp_bootstrap',
  'pd-08-degraded-input': 'mcp_bootstrap',
};

// --- Per-case predicate and metadata checks ------------------------------

function resolvePointerLocal(root, tokens) {
  let current = root;
  for (const token of tokens) {
    if (current === null || current === undefined) return false;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return false;
      const index = Number(token);
      if (index >= current.length) return false;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return false;
    if (!Object.hasOwn(current, token)) return false;
    current = current[token];
  }
  return true;
}

const fixtureResults = [];
const counterResults = [];

for (const [index, entry] of (cases.cases ?? []).entries()) {
  const label = `cases[${index}]`;
  if (!entry || typeof entry !== 'object') { fail(`${label} must be an object`); continue; }
  if (typeof entry.id !== 'string') { fail(`${label}.id must be a string`); continue; }
  if (!expectedIds.includes(entry.id)) {
    fail(`${label}.id ${JSON.stringify(entry.id)} is not in the frozen Step 3 list`);
  }
  if (seenIds.has(entry.id)) {
    fail(`${label}.id ${JSON.stringify(entry.id)} duplicates an earlier case id`);
  }
  seenIds.add(entry.id);

  // measurement_status preservation.
  const status = entry.baseline_trace?.measurement_status;
  if (!ALLOWED_MEASUREMENT_STATUSES.has(status)) {
    fail(`${label}.baseline_trace.measurement_status must be one of ${JSON.stringify([...ALLOWED_MEASUREMENT_STATUSES])}; got ${JSON.stringify(status)}`);
  }
  if (status !== 'contract-only-not-executed') {
    const pointer = entry.baseline_trace?.phase_d_receipt_pointer;
    if (!pointer) {
      fail(`${label}.baseline_trace.phase_d_receipt_pointer is required when measurement_status is ${JSON.stringify(status)}`);
    } else if (!receipt) {
      fail(`${label}.baseline_trace.phase_d_receipt_pointer=${JSON.stringify(pointer)} but phase-d-receipt.json is missing`);
    } else {
      if (pointer !== entry.id) {
        fail(`${label}.baseline_trace.phase_d_receipt_pointer must equal the case id; got ${JSON.stringify(pointer)}`);
      }
      const receiptEntry = receiptByCase.get(entry.id);
      const receiptEntryB = receiptRunBByCase.get(entry.id);
      if (!receiptEntry) {
        fail(`${label}.baseline_trace.phase_d_receipt_pointer=${JSON.stringify(pointer)} but receipt has no entry for ${entry.id}`);
      } else {
        if (receiptEntry.outcome !== status) {
          fail(`${label}.baseline_trace.measurement_status=${JSON.stringify(status)} but receipt outcome=${JSON.stringify(receiptEntry.outcome)}`);
        }
        // Verify compact_digest recomputes from receiptEntry.raw_envelope.
        const reDigestSource = { ...receiptEntry.raw_envelope };
        delete reDigestSource.compact_digest;
        const reComputed = createHash('sha256').update(canonicalJson(reDigestSource), 'utf8').digest('hex');
        if (reComputed !== receiptEntry.compact_digest) {
          fail(`${label}.receipt entry compact_digest does not recompute from stored raw_envelope for ${entry.id}; expected ${receiptEntry.compact_digest} got ${reComputed}`);
        }
        const receiptLayer = entry.baseline_trace?.execution_layer ?? 'mcp_bootstrap';
        if (receiptEntry.execution_layer !== receiptLayer) {
          fail(`${label}.receipt execution_layer=${JSON.stringify(receiptEntry.execution_layer)} but case declares ${JSON.stringify(receiptLayer)}`);
        }
        if (receiptEntry.raw_wire_utf8_bytes_verified !== true || receiptEntry.compact_digest_verified !== true || receiptEntry.semantic_hash_verified !== true || receiptEntry.mutation_result?.verdict_pass !== true || receiptEntry.scope_result?.verdict_pass !== true) {
          fail(`${label}.receipt run A has a failed verification category`);
        }
        if (Buffer.byteLength(receiptEntry.raw_wire, 'utf8') !== receiptEntry.raw_wire_utf8_bytes || canonicalJson(receiptEntry.raw_envelope) !== receiptEntry.raw_wire) {
          fail(`${label}.receipt run A raw wire does not match stored envelope/byte count`);
        }
        if (createHash('sha256').update(canonicalJson(receiptEntry.normalized_envelope), 'utf8').digest('hex') !== receiptEntry.semantic_hash) {
          fail(`${label}.receipt run A semantic_hash does not recompute`);
        }
      }
      if (!receiptEntryB) {
        fail(`${label}.receipt has no run B entry for ${entry.id}`);
      } else {
        if (receiptEntryB.outcome !== status) fail(`${label}.receipt run B outcome=${JSON.stringify(receiptEntryB.outcome)} but case status=${JSON.stringify(status)}`);
        if (receiptEntryB.execution_layer !== (entry.baseline_trace?.execution_layer ?? 'mcp_bootstrap')) fail(`${label}.receipt run B execution layer mismatch`);
        if (receiptEntryB.raw_wire_utf8_bytes_verified !== true || receiptEntryB.compact_digest_verified !== true || receiptEntryB.semantic_hash_verified !== true || receiptEntryB.mutation_result?.verdict_pass !== true || receiptEntryB.scope_result?.verdict_pass !== true) {
          fail(`${label}.receipt run B has a failed verification category`);
        }
        if (receiptEntry && receiptEntry.semantic_hash !== receiptEntryB.semantic_hash) fail(`${label}.receipt semantic hashes differ across runs`);
      }
      if (entry.id === 'pd-06-source-revised') {
        for (const [runName, evidence] of [['run A', receiptEntry], ['run B', receiptEntryB]]) {
          const expectedTools = ['cognitive_agent_bootstrap', 'memory_get', 'cognitive_agent_bootstrap'];
          if (!evidence || evidence.calls !== 3 || !Array.isArray(evidence.observations) || evidence.observations.length !== 3) {
            fail(`${label}.${runName} must retain the three declared pd-06 calls`);
          } else if (canonicalJson(evidence.observations.map((observation) => observation.tool)) !== canonicalJson(expectedTools)) {
            fail(`${label}.${runName} pd-06 observation sequence is incorrect`);
          } else if (evidence.observations.some((observation) => observation.mutation_verified !== true)) {
            fail(`${label}.${runName} pd-06 observation mutation verification failed`);
          }
        }
      }
    }
  }

  // Declared execution_layer check.
  const declaredLayer = entry.baseline_trace?.execution_layer ?? null;
  const expectedLayer = expectedExecutionLayer[entry.id] ?? null;
  if ((declaredLayer ?? null) !== (expectedLayer ?? null)) {
    fail(`${label}.baseline_trace.execution_layer must be ${JSON.stringify(expectedLayer)} for this case per Codex review; got ${JSON.stringify(declaredLayer)}`);
  }

  // fixture_intent classification per design Section 11.
  if (!['lexical_discovery', 'deterministic_source_projection'].includes(entry.fixture_intent)) {
    fail(`${label}.fixture_intent must be one of lexical_discovery | deterministic_source_projection; got ${JSON.stringify(entry.fixture_intent)}`);
  } else {
    fixtureIntents.add(entry.fixture_intent);
  }
  if (entry.id === 'pd-01-ordinary-restart' && entry.fixture_intent !== 'lexical_discovery') {
    fail(`${label} (pd-01) must declare fixture_intent="lexical_discovery" per design Section 11`);
  }
  if (entry.id !== 'pd-01-ordinary-restart' && entry.fixture_intent !== 'deterministic_source_projection') {
    fail(`${label} (${entry.id}) must declare fixture_intent="deterministic_source_projection" per design Section 11`);
  }

  // canonical_ids requirement (mechanical, not case_notes).
  const requiredIds = canonicalIdRequirements[entry.id];
  if (requiredIds) {
    const provided = Array.isArray(entry.request?.canonical_ids) ? entry.request.canonical_ids : null;
    if (!provided) {
      fail(`${label}.request.canonical_ids must be present and contain ${JSON.stringify(requiredIds)}; got ${JSON.stringify(entry.request?.canonical_ids)}`);
    } else {
      const providedSorted = [...provided].sort((a, b) => a - b);
      const expectedSorted = [...requiredIds].sort((a, b) => a - b);
      if (JSON.stringify(providedSorted) !== JSON.stringify(expectedSorted)) {
        fail(`${label}.request.canonical_ids must equal ${JSON.stringify(requiredIds)} (as a set, ignoring order); got ${JSON.stringify(provided)}`);
      }
    }
  }

  // Per-case minimum predicate coverage.
  const required = entry.required_predicates ?? [];
  const forbidden = entry.forbidden_predicates ?? [];
  if (!Array.isArray(required)) { fail(`${label}.required_predicates must be an array`); }
  if (!Array.isArray(forbidden)) { fail(`${label}.forbidden_predicates must be an array`); }
  if (required.length === 0 && forbidden.length === 0) {
    fail(`${label} declares neither required_predicates nor forbidden_predicates; structured grading cannot evaluate`);
  }

  for (const list of [['required_predicates', required], ['forbidden_predicates', forbidden]]) {
    const [listName, listValue] = list;
    for (const [pIndex, predicate] of (listValue ?? []).entries()) {
      const plabel = `${label}.${listName}[${pIndex}]`;
      const validation = validatePredicate(predicate);
      if (!validation.ok) {
        pointerCoverage.malformed += 1;
        fail(`${plabel} failed predicate validation: ${validation.reason}`);
        continue;
      }
      try {
        decodePointer(predicate.pointer);
      } catch (error) {
        pointerCoverage.malformed += 1;
        fail(`${plabel} pointer decode failed: ${error.message}`);
        continue;
      }
      const op = predicate.operator;
      if (!['equals', 'includes', 'excludes', 'exists', 'not_exists'].includes(op)) {
        pointerCoverage.unknownOperator += 1;
        fail(`${plabel} operator ${JSON.stringify(op)} is not in the v1 set`);
        continue;
      }
      if (Array.isArray(predicate?.value)) {
        pointerCoverage.arrayValue += 1;
        fail(`${plabel} array value is forbidden by the v1 contract`);
        continue;
      }
      pointerCoverage.ok += 1;
    }
  }

  // Contract-path check: every required predicate that uses an equals/includes/excludes/exists
  // operator must resolve against the representative envelope. Catches nonexistent
  // paths such as /task/objective/authority (where authority actually lives at
  // /task/objective/statement/authority).
  const fixture = ALL_FIXTURES[entry.id];
  if (fixture) {
    const operatorsThatRequirePresence = new Set(['equals', 'includes', 'excludes', 'exists']);
    for (const predicate of required) {
      if (!operatorsThatRequirePresence.has(predicate.operator)) continue;
      const validation = validatePredicate(predicate);
      if (!validation.ok) continue;
      let tokens;
      try { tokens = decodePointer(predicate.pointer); } catch { continue; }
      if (!resolvePointerLocal(fixture, tokens)) {
        fail(`${label}.required_predicates: pointer ${predicate.pointer} does not resolve against the envelope fixture for ${entry.id}; check for a typo or a renamed field`);
      }
    }
  }

  // Run the full plan against the representative envelope and the counterexample.
  if (fixture && COUNTEREXAMPLES[entry.id]) {
    const planResult = evaluatePlan(fixture, entry);
    fixtureResults.push({
      case_id: entry.id,
      ok: planResult.ok,
      passed: planResult.ok && planResult.passed,
      required_fail: planResult.requiredFail ?? [],
      forbidden_fired: planResult.forbiddenFired ?? [],
      reason: planResult.reason,
    });
    if (!planResult.ok) {
      fail(`${label}: plan failed to evaluate against fixture: ${planResult.reason}`);
    } else if (!planResult.passed) {
      fail(`${label}: representative envelope does not satisfy plan: requiredFail=${JSON.stringify(planResult.requiredFail)} forbiddenFired=${JSON.stringify(planResult.forbiddenFired)}`);
    }

    const counterResult = evaluatePlan(COUNTEREXAMPLES[entry.id], entry);
    counterResults.push({
      case_id: entry.id,
      ok: counterResult.ok,
      passed: counterResult.ok && counterResult.passed,
      failure_mode: counterResult.ok ? 'predicate_miss' : 'evaluator_fails_closed',
    });
    // A counterexample must NOT pass. Failure modes:
    //   - predicate_miss: plan ran successfully and at least one required/forbidden predicate evaluated
    //     to a failing state (planResult.passed === false);
    //   - evaluator_fails_closed: a required predicate path did not resolve at all (planResult.ok === false).
    //     This is also a valid failure detection — the contract rejects ambiguous required paths.
    if (counterResult.passed) {
      fail(`${label}: counterexample envelope unexpectedly passed the plan; the failure-mode detection is too weak or the counterexample is too gentle`);
    }
  } else {
    if (!fixture) fail(`${label}: representative envelope fixture is missing for ${entry.id}`);
    if (!COUNTEREXAMPLES[entry.id]) fail(`${label}: counterexample envelope fixture is missing for ${entry.id}`);
  }
}

// --- Coverage summaries and path leakage --------------------------------

const pathUsage = new Map();
for (const entry of (cases.cases ?? [])) {
  for (const source of [
    ...((entry.required_predicates ?? []).map((p) => ({ kind: 'required', p }))),
    ...((entry.forbidden_predicates ?? []).map((p) => ({ kind: 'forbidden', p }))),
  ]) {
    const pointer = source.p?.pointer;
    if (typeof pointer !== 'string') continue;
    pathUsage.set(pointer, (pathUsage.get(pointer) ?? 0) + 1);
  }
}

const fixtureText = JSON.stringify(cases);
if (/VanCh|C:\\\\Users|Documents\\\\Projects/i.test(fixtureText)) {
  fail('cases.json contains a personal name or absolute workstation path');
}

const owningFiles = [
  'cases.json',
  'cases.schema.json',
  'tool-mapping.json',
  'tool-mapping.schema.json',
  'structured-predicate.mjs',
  'structured-predicate.test.mjs',
  'validate-step3-contract.mjs',
  'case-fixtures.mjs',
  'case-fixtures.test.mjs',
];
const personalPathPattern = /C:\\Users\\VanCh|\/Users\/VanCh|\/home\/VanCh/i;
const liveDbPattern = /MEM_GRAPH_DIR[^=]*=\s*["']C:\\Users/i;
const leaked = [];
for (const name of owningFiles) {
  const text = readFileSync(join(here, name), 'utf8');
  if (personalPathPattern.test(text)) { leaked.push(name); continue; }
  if (liveDbPattern.test(text)) { leaked.push(name); }
}
if (leaked.length > 0) {
  fail(`personal path or live database reference leaked into M3-owned files: ${leaked.join(', ')}`);
}

const summary = {
  case_count: cases.cases?.length ?? 0,
  fixture_intents: [...fixtureIntents].sort(),
  predicate_counts: {
    required_total: cases.cases?.reduce((sum, entry) => sum + (entry.required_predicates?.length ?? 0), 0) ?? 0,
    forbidden_total: cases.cases?.reduce((sum, entry) => sum + (entry.forbidden_predicates?.length ?? 0), 0) ?? 0,
  },
  pointer_coverage: pointerCoverage,
  path_usage_top10: [...pathUsage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  fixture_plan_results: fixtureResults,
  counterexample_plan_results: counterResults,
  cases_with_canonical_id_requirement: Object.keys(canonicalIdRequirements),
  expected_case_ids: expectedIds,
  observed_case_ids: cases.cases?.map((entry) => entry.id) ?? [],
  draft_2020_12_required: true,
  warning_count: warnings.length,
};

if (errors.length === 0) {
  console.log(JSON.stringify({ ok: true, status: 'step3-contract-validated', ...summary, warnings }, null, 2));
  process.exit(0);
} else {
  console.log(JSON.stringify({ ok: false, status: 'step3-contract-invalid', errors, ...summary, warnings }, null, 2));
  process.exit(1);
}
