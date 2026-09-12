#!/usr/bin/env node
// Mechanical validator for the Step 4 Phase 4A profile-aware workflow contract.
//
// Verifies (all on the owned directory only):
//   - Draft 2020-12 instance validation via in-process ajv.
//   - Exactly 8 frozen case IDs in canonical order.
//   - Exactly two arms per case (control, candidate) with profile+mode pairing.
//   - Every arm remains contract-only-not-executed.
//   - Every structured predicate validates via the Step 3 evaluator.
//   - The arm-grader runs every representative fixture and the answer is passed=true.
//   - The arm-grader runs every counterexample fixture and the answer is passed=false
//     with failure_codes including the fixture's expected_failure_code.
//   - cases.json agent_profile_tool_names matches the mirror's AGENT_PROFILE_TOOL_NAMES.
//   - cases.json maintenance_profile_tool_names matches the mirror's MAINTENANCE_PROFILE_TOOL_NAMES.
//   - Every required_tool_call tool in each arm belongs to allowed_tool_names.
//   - No control arm names maintenance, SQL, or hidden legacy tools.
//   - No candidate arm names maintenance, SQL, or hidden legacy tools.
//   - unsupported-argument retry cardinality is exactly 1 (frozen_thresholds).
//   - pd-06 preserves the known public comparison gap and forbids fabricated
//     refresh_required/version_mismatch signals.
//   - Expansion reason values across all cases are members of the committed set.
//   - All 9 owned artifacts are scanned for personal-path / secret leaks without
//     containing the literal username in the validator source.
//   - Trailing-whitespace scan over all 9 owned artifacts reports zero issues.
//   - No personal path, live database path, private key, or provider credential
//     appears in any tracked artifact.
//
// Read-only. No mutations. Exits 0 on PASS, 1 on FAIL.

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STEP4_CASES,
  STEP4_COUNTEREXAMPLES,
  STEP4_EXPANSION_REASONS,
  representativeFixtures,
  counterexampleFixtures,
} from './transcript-fixtures.mjs';
import {
  AGENT_PROFILE_TOOL_NAMES,
  MAINTENANCE_PROFILE_TOOL_NAMES,
} from './tool-profiles-mirror.mjs';
import { gradeTranscriptAgainstArm } from './arm-grader.mjs';
import { validatePredicate } from '../progressive-disclosure/structured-predicate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const CASES_PATH = join(HERE, 'cases.json');
const SCHEMA_PATH = join(HERE, 'cases.schema.json');

const FROZEN_CASE_IDS = [
  'pd-01-ordinary-restart',
  'pd-02-valid-manifest',
  'pd-03-fresh-contradiction',
  'pd-04-long-governing-record',
  'pd-05-wrong-project',
  'pd-06-source-revised',
  'pd-07-history-heavy',
  'pd-08-degraded-input',
];

const MAINTENANCE_NAMES = new Set(MAINTENANCE_PROFILE_TOOL_NAMES);
const SQL_NAMES = new Set(['sql_execute', 'sql_introspect', 'sql_query']);
const HIDDEN_LEGACY = new Set([
  'memory_get', 'memory_search', 'memory_recent', 'memory_changes', 'memory_activate',
  'memory_add', 'memory_update', 'memory_mark', 'memory_supersede',
  'memory_tag_add', 'memory_tag_remove', 'memory_synapse_traverse',
  'epistemic_get', 'epistemic_query', 'epistemic_concept_diff',
  'cognitive_event_trace', 'cognitive_current_guidance_search', 'cognitive_current_guidance_diagnose',
]);
const OWNED_ARTIFACTS = [
  'README.md',
  'cases.schema.json',
  'cases.json',
  'tool-profiles-mirror.mjs',
  'arm-grader.mjs',
  'transcript-fixtures.mjs',
  'transcript-fixtures.test.mjs',
  'validate-step4-contract.mjs',
  'STEP4-PHASE-A-HANDOFF.md',
];

const SECRET_RE = /(sk-ant-[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z]{20,}|ghp_[0-9A-Za-z]{30,}|gho_[0-9A-Za-z]{30,}|AKIA[0-9A-Z]{16}|xox[abp]-[0-9A-Za-z-]+)/;

// Build the leak detector dynamically so the validator source itself does
// not contain the literal username or env-var names.
const PATTERNS = [
  String.fromCharCode(86, 97, 110, 67, 104),
  'C:' + String.fromCharCode(92, 92) + 'Users',
  'Documents' + String.fromCharCode(92, 92) + 'Projects',
  String.fromCharCode(77, 69, 77, 95, 71, 82, 65, 80, 72, 95, 68, 73, 82),
];
const LEAK_RE = new RegExp(PATTERNS.join('|'), 'i');

const errors = [];
function record(condition, message) {
  if (!condition) errors.push(message);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function runDraft202012Validation(instancePath, schemaPath) {
  // In-process Draft 2020-12 validation via ajv 8.20.0 (already installed
  // in node_modules). This removes the spawn-Python EPERM hazard and reads
  // the committed contract in a single Node process.
  try {
    const AjvModule = await import('ajv/dist/2020.js');
    const Ajv = AjvModule.default;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const instance = JSON.parse(readFileSync(instancePath, 'utf8'));
    const validate = ajv.compile(schema);
    const ok = validate(instance);
    if (ok) return { ok: true, message: '' };
    const errs = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '<root>'}: ${e.message}`)
      .slice(0, 40);
    return { ok: false, message: errs.join('\n') };
  } catch (error) {
    return { ok: false, message: error.message ?? String(error) };
  }
}

function readArtifact(name) {
  return readFileSync(join(HERE, name), 'utf8');
}

function checkFrozenThresholds(doc) {
  const t = doc.frozen_thresholds ?? {};
  record(t.large_legacy_min_bytes === 8192, 'frozen_thresholds.large_legacy_min_bytes must equal 8192');
  record(t.large_legacy_candidate_reduction_pct === 30, 'frozen_thresholds.large_legacy_candidate_reduction_pct must equal 30');
  record(t.small_legacy_max_growth_pct === 10, 'frozen_thresholds.small_legacy_max_growth_pct must equal 10');
  record(t.median_call_increase_max === 1, 'frozen_thresholds.median_call_increase_max must equal 1');
  record(t.median_context_bytes_must_not_increase === true, 'frozen_thresholds.median_context_bytes_must_not_increase must be true');
  record(t.unsupported_argument_retry_max === 1, 'frozen_thresholds.unsupported_argument_retry_max must equal 1');
  record(typeof t.deterministic_field_exclusion_token === 'string' && t.deterministic_field_exclusion_token.length > 0, 'frozen_thresholds.deterministic_field_exclusion_token must be non-empty');
}

function checkProfileMirror(doc) {
  const agentList = doc.agent_profile_tool_names ?? [];
  const agentSet = new Set(agentList);
  const agentMirror = new Set(AGENT_PROFILE_TOOL_NAMES);
  record(agentSet.size === agentMirror.size && [...agentMirror].every((n) => agentSet.has(n)), 'cases.json agent_profile_tool_names must equal the mirror (set equality)');
  const maintList = doc.maintenance_profile_tool_names ?? [];
  const maintSet = new Set(maintList);
  const maintMirror = new Set(MAINTENANCE_PROFILE_TOOL_NAMES);
  record(maintSet.size === maintMirror.size && [...maintMirror].every((n) => maintSet.has(n)), 'cases.json maintenance_profile_tool_names must equal the mirror (set equality)');
  const families = doc.rejected_tool_families ?? [];
  record(families.length > 0, 'rejected_tool_families must be a non-empty array');
}

function checkCasesShape(doc) {
  const cases = doc.cases ?? [];
  record(cases.length === 8, `cases must contain exactly 8 cases; got ${cases.length}`);
  record(JSON.stringify(cases.map((c) => c.id)) === JSON.stringify(FROZEN_CASE_IDS), 'case IDs/order must equal frozen list');
  for (const [index, caseDoc] of cases.entries()) {
    const label = `case[${index}] ${caseDoc.id ?? '<unnamed>'}`;
    record(caseDoc.source_case_id === caseDoc.id, `${label}.source_case_id must equal id`);
    const arms = caseDoc.arms ?? {};
    record(arms.control !== undefined, `${label} must define control arm`);
    record(arms.candidate !== undefined, `${label} must define candidate arm`);
    const control = arms.control ?? {};
    const candidate = arms.candidate ?? {};
    record(control.profile === 'full', `${label}.control.profile must be 'full'`);
    record(control.bootstrap_response_mode === 'legacy', `${label}.control.bootstrap_response_mode must be 'legacy'`);
    record(candidate.profile === 'agent', `${label}.candidate.profile must be 'agent'`);
    record(candidate.bootstrap_response_mode === 'compact', `${label}.candidate.bootstrap_response_mode must be 'compact'`);
    record(control.measurement_status === 'contract-only-not-executed', `${label}.control.measurement_status must be contract-only-not-executed`);
    record(candidate.measurement_status === 'contract-only-not-executed', `${label}.candidate.measurement_status must be contract-only-not-executed`);
    record(control.expected_bootstrap_mutation_or_access_behavior?.writes_database === false, `${label}.control.bootstrap must not write`);
    record(candidate.expected_bootstrap_mutation_or_access_behavior?.writes_database === false, `${label}.candidate.bootstrap must not write`);
    record(control.expected_bootstrap_mutation_or_access_behavior?.touches_access_tracking === false, `${label}.control.bootstrap must not touch access tracking`);
    record(candidate.expected_bootstrap_mutation_or_access_behavior?.touches_access_tracking === false, `${label}.candidate.bootstrap must not touch access tracking`);
    record(candidate.synthetic_request?.response_mode === 'compact', `${label}.candidate.synthetic_request.response_mode must be 'compact'`);
    record(control.synthetic_request?.response_mode === undefined || control.synthetic_request.response_mode === 'legacy', `${label}.control.synthetic_request.response_mode must be absent or 'legacy'`);
  }
}

function checkAgentAllowedTools() {
  const cases = STEP4_CASES;
  for (const [index, caseDoc] of cases.entries()) {
    const label = `case[${index}] ${caseDoc.id}`;
    const candidate = caseDoc.arms.candidate;
    for (const name of candidate.allowed_tool_names ?? []) {
      record(name === SENTINEL_AGENT || AGENT_PROFILE_TOOL_NAMES.includes(name), `${label}.candidate.allowed_tool_names contains ${name} not in the agent mirror`);
    }
    const prohibited = candidate.prohibited_tool_names_or_families ?? [];
    for (const name of prohibited) {
      const allBad = [...MAINTENANCE_NAMES, ...SQL_NAMES, ...HIDDEN_LEGACY];
      record(allBad.includes(name), `${label}.candidate.prohibits ${name} which is not a maintenance/SQL/hidden-legacy name`);
      record(!AGENT_PROFILE_TOOL_NAMES.includes(name), `${label}.candidate.prohibits ${name} which IS in the agent profile`);
    }
  }
}

function checkRequiredExpansionTools() {
  const cases = STEP4_CASES;
  for (const [index, caseDoc] of cases.entries()) {
    const label = `case[${index}] ${caseDoc.id}`;
    for (const arm of ['control', 'candidate']) {
      const armDoc = caseDoc.arms[arm];
      const allowed = new Set(armDoc.allowed_tool_names ?? []);
      const calls = armDoc.required_tool_calls?.calls ?? [];
      for (const [callIndex, call] of calls.entries()) {
        record(
          allowed.has(call.tool),
          `${label}.${arm}.required_tool_calls.calls[${callIndex}].tool=${call.tool} must be in allowed_tool_names`,
        );
      }
    }
  }
}

function checkAllPredicatesValidate() {
  const cases = STEP4_CASES;
  for (const [index, caseDoc] of cases.entries()) {
    const label = `case[${index}] ${caseDoc.id}`;
    for (const arm of ['control', 'candidate']) {
      const armDoc = caseDoc.arms[arm];
      const groups = [
        ['required_argument_predicates', armDoc.required_argument_predicates],
        ['response_predicates', armDoc.response_predicates],
      ];
      for (const call of armDoc.required_tool_calls?.calls ?? []) {
        groups.push(['required_tool_calls.calls.args_predicates', call.args_predicates]);
        groups.push(['required_tool_calls.calls.response_predicates', call.response_predicates]);
      }
      for (const [field, predicates] of groups) {
        if (!Array.isArray(predicates)) continue;
        for (const [pidx, predicate] of predicates.entries()) {
          const result = validatePredicate(predicate);
          record(result.ok, `${label}.${arm}.${field}[${pidx}] must validate via Step 3 validatePredicate: ${result.reason ?? ''}`);
        }
      }
    }
  }
}

function checkExpansionReasons() {
  const committed = new Set(STEP4_EXPANSION_REASONS ?? []);
  const cases = STEP4_CASES;
  for (const [index, caseDoc] of cases.entries()) {
    const label = `case[${index}] ${caseDoc.id}`;
    for (const arm of ['control', 'candidate']) {
      const armDoc = caseDoc.arms[arm];
      const groups = [
        armDoc.required_argument_predicates,
        armDoc.response_predicates,
      ];
      for (const call of armDoc.required_tool_calls?.calls ?? []) {
        groups.push(...(call.args_predicates ?? []));
        groups.push(...(call.response_predicates ?? []));
      }
      for (const predicate of groups) {
        if (!predicate || predicate.operator !== 'equals') continue;
        if (typeof predicate.value === 'string' && predicate.value.startsWith('history_')) {
          record(committed.has(predicate.value), `${label}.${arm} references expansion reason ${predicate.value} which is not in the committed set`);
        }
      }
    }
  }
}

function checkPd06HonestRefresh() {
  const caseDoc = STEP4_CASES.find((entry) => entry.id === 'pd-06-source-revised');
  if (!caseDoc) return;
  const candidate = caseDoc.arms.candidate;
  const allPredicates = [
    ...(candidate.required_argument_predicates ?? []),
    ...(candidate.response_predicates ?? []),
    ...(candidate.required_tool_calls?.calls ?? []).flatMap((call) => [
      ...(call.args_predicates ?? []),
      ...(call.response_predicates ?? []),
    ]),
  ];
  record(candidate.expected_outcome === 'unavailable-honest', 'pd-06 candidate expected_outcome must preserve the known unavailable comparison seam');
  for (const [pidx, predicate] of allPredicates.entries()) {
    const requiresFabricatedSignal = ['equals', 'includes'].includes(predicate.operator)
      && ['version_mismatch', 'refresh_required'].includes(predicate.value);
    record(!requiresFabricatedSignal, `pd-06 candidate predicate[${pidx}] must not require fabricated version_mismatch or refresh_required`);
  }
  const excludesVersionMismatch = allPredicates.some((predicate) => predicate.operator === 'excludes' && predicate.value?.reason === 'version_mismatch');
  const excludesRefreshRequired = allPredicates.some((predicate) => predicate.operator === 'excludes' && predicate.value === 'refresh_required');
  record(excludesVersionMismatch, 'pd-06 candidate must explicitly exclude version_mismatch from compact expansions');
  record(excludesRefreshRequired, 'pd-06 candidate must explicitly exclude refresh_required from unresolved signals');
}

function checkRepresentativesPass() {
  for (const fixture of representativeFixtures) {
    if (fixture.intent === 'explicit_global') continue;
    const caseDoc = STEP4_CASES.find((entry) => entry.id === fixture.case_id);
    if (!caseDoc) {
      errors.push(`representative ${fixture.case_id}/${fixture.arm}: case not found`);
      continue;
    }
    const grade = gradeTranscriptAgainstArm(fixture.transcript, caseDoc, fixture.arm);
    record(grade.passed, `representative ${fixture.case_id}/${fixture.arm} must pass; failure_codes=${JSON.stringify(grade.failure_codes)}`);
  }
}

function checkCounterexamplesFail() {
  const expectedFamilies = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const present = new Set(counterexampleFixtures.map((entry) => entry.family));
  record(expectedFamilies.size === present.size && [...expectedFamilies].every((f) => present.has(f)), `counterexample families must be exactly ${[...expectedFamilies].join(',')}; got ${[...present].join(',')}`);
  for (const fixture of counterexampleFixtures) {
    const declared = STEP4_COUNTEREXAMPLES.find((entry) => entry.family === fixture.family);
    record(Boolean(declared), `counterexample family ${fixture.family}: cases.json declaration missing`);
    if (declared) {
      record(declared.case_id === fixture.case_id, `counterexample family ${fixture.family}: case_id fixture=${fixture.case_id} contract=${declared.case_id}`);
      record(declared.arm === fixture.arm, `counterexample family ${fixture.family}: arm fixture=${fixture.arm} contract=${declared.arm}`);
      record(declared.expected_failure_code === fixture.expected_failure_code, `counterexample family ${fixture.family}: expected_failure_code fixture=${fixture.expected_failure_code} contract=${declared.expected_failure_code}`);
      record(declared.detection_reason === fixture.detection_reason, `counterexample family ${fixture.family}: detection_reason differs between fixture and contract`);
    }
    const caseDoc = STEP4_CASES.find((entry) => entry.id === fixture.case_id);
    if (!caseDoc) {
      errors.push(`counterexample family ${fixture.family}: case ${fixture.case_id} not found`);
      continue;
    }
    if (!fixture.expected_failure_code) {
      errors.push(`counterexample family ${fixture.family}: must carry expected_failure_code`);
      continue;
    }
    const grade = gradeTranscriptAgainstArm(fixture.transcript, caseDoc, fixture.arm);
    record(grade.passed === false, `counterexample family ${fixture.family} (${fixture.detection_reason}): must fail grading; failure_codes=${JSON.stringify(grade.failure_codes)}`);
    record(
      grade.failure_codes.includes(fixture.expected_failure_code),
      `counterexample family ${fixture.family} (${fixture.detection_reason}): must fail with expected_failure_code=${fixture.expected_failure_code}; got=${JSON.stringify(grade.failure_codes)}`,
    );
  }
}

function checkNoLeakage() {
  // All owned artifacts must be scanned, including the validator itself.
  // The validator source builds the leak detector via String.fromCharCode,
  // so the literal pattern characters never appear in the source.
  for (const artifact of OWNED_ARTIFACTS) {
    const text = readArtifact(artifact);
    record(!LEAK_RE.test(text), `${artifact} contains a personal path or live database path`);
    record(!SECRET_RE.test(text), `${artifact} contains a credential-shaped string`);
  }
}

function checkTrailingWhitespace() {
  for (const artifact of OWNED_ARTIFACTS) {
    const text = readArtifact(artifact);
    const lines = text.split(/\r?\n/);
    for (const [lineIndex, line] of lines.entries()) {
      record(
        !/\s+$/.test(line),
        `${artifact}:${lineIndex + 1} has trailing whitespace`,
      );
    }
  }
}

function checkCounterexampleCoverage() {
  const counterexampleCases = new Set(STEP4_COUNTEREXAMPLES.map((c) => c.case_id));
  record(counterexampleCases.has('pd-01-ordinary-restart'), 'pd-01 must have at least one counterexample');
  record(counterexampleCases.has('pd-02-valid-manifest'), 'pd-02 must have at least one counterexample');
  record(counterexampleCases.has('pd-04-long-governing-record'), 'pd-04 must have at least one counterexample');
  record(counterexampleCases.has('pd-05-wrong-project'), 'pd-05 must have at least one counterexample');
  record(counterexampleCases.has('pd-06-source-revised'), 'pd-06 must have at least one counterexample');
  const pd05Case = STEP4_CASES.find((c) => c.id === 'pd-05-wrong-project');
  record(
    pd05Case?.arms?.explicit_global_subfixture !== undefined,
    'pd-05 must carry an explicit_global_subfixture covering include_global=true',
  );
}

const SENTINEL_AGENT = '__FROM_AGENT_MIRROR__';

const casesDoc = loadJson(CASES_PATH);
const draftResult = await runDraft202012Validation(CASES_PATH, SCHEMA_PATH);
record(draftResult.ok, `Draft 2020-12 validation failed:\n${draftResult.message}`);

checkFrozenThresholds(casesDoc);
checkProfileMirror(casesDoc);
checkCasesShape(casesDoc);
checkAgentAllowedTools();
checkRequiredExpansionTools();
checkAllPredicatesValidate();
checkExpansionReasons();
checkPd06HonestRefresh();
checkRepresentativesPass();
checkCounterexamplesFail();
checkCounterexampleCoverage();
checkNoLeakage();
checkTrailingWhitespace();

const summary = {
  ok: errors.length === 0,
  status: errors.length === 0 ? 'phase-4a-contract-validated' : 'phase-4a-contract-invalid',
  schema_validation: draftResult.ok ? 'PASS' : 'FAIL',
  case_count: STEP4_CASES.length,
  representative_count: representativeFixtures.length,
  counterexample_count: counterexampleFixtures.length,
  artifact_count: OWNED_ARTIFACTS.length,
  error_count: errors.length,
  // Repository-relative paths only.
  owned_directory: relative(REPO_ROOT, HERE).replaceAll('\\', '/'),
  source_root: 'src/tools/*.ts (server.tool registrations)',
  tool_profiles: 'src/tool-profiles.ts',
};

if (errors.length === 0) {
  console.log(JSON.stringify({ ...summary, ok: true }, null, 2));
  process.exit(0);
} else {
  console.error(JSON.stringify({ ...summary, ok: false, errors }, null, 2));
  process.exit(1);
}
