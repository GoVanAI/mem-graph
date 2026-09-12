// Test suite for the Step 4 Phase 4A transcript fixtures.
//
// Every representative fixture is graded by arm-grader.mjs and must pass.
// Every counterexample fixture is graded by arm-grader.mjs and must fail
// with the fixture's declared expected_failure_code.
//
// The single grader enforces every contract field (tool membership,
// excluded tools, cardinality, ordering, required calls, scope
// preservation, bootstrap behavior, response_mode, pd-06 honest refresh).
// No bespoke detection_plan authority remains.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePredicate } from '../progressive-disclosure/structured-predicate.mjs';

import {
  STEP4_CASES,
  representativeFixtures,
  counterexampleFixtures,
  STEP4_COUNTEREXAMPLES,
} from './transcript-fixtures.mjs';
import { gradeTranscriptAgainstArm } from './arm-grader.mjs';

function caseById(caseId) {
  return STEP4_CASES.find((entry) => entry.id === caseId);
}

for (const fixture of representativeFixtures) {
  test(`representative: ${fixture.case_id}/${fixture.arm}/${fixture.intent ?? 'default'} passes`, () => {
    const caseDoc = caseById(fixture.case_id);
    assert.ok(caseDoc, `case ${fixture.case_id} must exist in cases.json`);
    if (fixture.intent === 'explicit_global') {
      const sub = caseDoc.arms?.explicit_global_subfixture;
      assert.ok(sub, 'explicit_global_subfixture must be declared on pd-05');
      const env = fixture.transcript[0].response_envelope;
      for (const predicate of sub.required_response_envelope_predicates ?? []) {
        const r = evaluatePredicate(env, predicate);
        assert.ok(r.ok, `subfixture predicate ${JSON.stringify(predicate)} failed to evaluate: ${r.reason ?? ''}`);
        assert.equal(r.passed, true, `subfixture predicate must pass; got ${JSON.stringify(r)}`);
      }
      return;
    }
    const grade = gradeTranscriptAgainstArm(fixture.transcript, caseDoc, fixture.arm);
    assert.equal(grade.passed, true, `representative ${fixture.case_id}/${fixture.arm} must pass; failures=${JSON.stringify(grade.failures)}; failure_codes=${JSON.stringify(grade.failure_codes)}`);
  });
}

for (const fixture of counterexampleFixtures) {
  test(`counterexample family ${fixture.family}: ${fixture.detection_reason}`, () => {
    const caseDoc = caseById(fixture.case_id);
    assert.ok(caseDoc, `case ${fixture.case_id} must exist in cases.json`);
    assert.ok(fixture.expected_failure_code, `counterexample ${fixture.family} must carry an expected_failure_code`);
    const grade = gradeTranscriptAgainstArm(fixture.transcript, caseDoc, fixture.arm);
    assert.equal(
      grade.passed,
      false,
      `counterexample ${fixture.detection_reason} must fail grading; grade=${JSON.stringify(grade.checks.filter((c) => !c.passed))}`,
    );
    assert.ok(
      grade.failure_codes.includes(fixture.expected_failure_code),
      `counterexample ${fixture.detection_reason} must fail with expected_failure_code=${fixture.expected_failure_code}; got=${JSON.stringify(grade.failure_codes)}`,
    );
  });
}

test('every counterexample in cases.json is represented by a transcript fixture', () => {
  const expectedFamilies = new Set(STEP4_COUNTEREXAMPLES.map((c) => c.family));
  const present = new Set(counterexampleFixtures.map((f) => f.family));
  for (const family of expectedFamilies) {
    assert.ok(present.has(family), `counterexample fixture family ${family} missing`);
  }
});

test('counterexamples cover families 1..10', () => {
  const families = new Set(counterexampleFixtures.map((f) => f.family));
  for (const family of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.ok(families.has(family), `counterexample family ${family} missing from fixtures`);
  }
});

test('no personal path or live database path appears in any fixture', () => {
  const serialized = JSON.stringify({ representativeFixtures, counterexampleFixtures });
  const patterns = [
    String.fromCharCode(86, 97, 110, 67, 104),
    'C:' + String.fromCharCode(92, 92) + 'Users',
    'Documents' + String.fromCharCode(92, 92) + 'Projects',
    String.fromCharCode(77, 69, 77, 95, 71, 82, 65, 80, 72, 95, 68, 73, 82),
  ];
  const leakPattern = new RegExp(patterns.join('|'), 'i');
  assert.equal(leakPattern.test(serialized), false, 'fixture leak detected');
});

function representative(caseId, arm) {
  return representativeFixtures.find((fixture) => fixture.case_id === caseId && fixture.arm === arm && fixture.intent === 'representative');
}

function gradeMutated(caseId, arm, mutate) {
  const fixture = representative(caseId, arm);
  assert.ok(fixture, `representative ${caseId}/${arm} missing`);
  const transcript = structuredClone(fixture.transcript);
  mutate(transcript);
  return gradeTranscriptAgainstArm(transcript, caseById(caseId), arm);
}

test('public epistemic_get rejects a missing project_id', () => {
  const grade = gradeMutated('pd-03-fresh-contradiction', 'control', (transcript) => {
    delete transcript[1].args.project_id;
  });
  assert.equal(grade.passed, false);
  assert.ok(grade.failure_codes.includes('scope_missing_project_id'));
});

test('memory_find search rejects a missing query and an unknown argument', () => {
  const grade = gradeMutated('pd-08-degraded-input', 'candidate', (transcript) => {
    delete transcript[1].args.query;
    transcript[1].args.unknown_argument = true;
  });
  assert.equal(grade.passed, false);
  const familyFailure = grade.failures.find((failure) => failure.kind === 'scope_missing_project_id');
  assert.ok(familyFailure?.details.some((entry) => entry.missing === 'query'));
  assert.ok(familyFailure?.details.some((entry) => entry.unexpected === 'unknown_argument'));
});

test('unavailable orientation cannot claim requires_expansion=false', () => {
  const grade = gradeMutated('pd-08-degraded-input', 'candidate', (transcript) => {
    transcript[0].response_envelope.orientation.requires_expansion = false;
  });
  assert.equal(grade.passed, false);
  assert.ok(grade.failure_codes.includes('orientation_invariant_violation'));
});

test('an undeclared optional expansion is rejected when optional calls are forbidden', () => {
  const grade = gradeMutated('pd-01-ordinary-restart', 'candidate', (transcript) => {
    transcript.push({
      tool: 'memory_find',
      args: { operation: 'search', query: 'extra', project_id: 'fixture-alpha', include_global: false },
      response_envelope: { results: [] },
    });
  });
  assert.equal(grade.passed, false);
  assert.ok(grade.failure_codes.includes('optional_expansion_not_allowed'));
});

test('pd-06 representative preserves the public comparison gap without fabricated refresh signals', () => {
  const fixture = representative('pd-06-source-revised', 'candidate');
  const serialized = JSON.stringify(fixture.transcript);
  assert.equal(serialized.includes('refresh_required'), false);
  assert.equal(serialized.includes('version_mismatch'), false);
  assert.equal(caseById('pd-06-source-revised').arms.candidate.expected_outcome, 'unavailable-honest');
});

test('bootstrap accepts task_state but rejects top-level task_id in the public schema mirror', () => {
  const valid = representative('pd-02-valid-manifest', 'candidate');
  assert.ok(valid.transcript[0].args.task_state);
  const grade = gradeMutated('pd-02-valid-manifest', 'candidate', (transcript) => {
    delete transcript[0].args.task_state;
    transcript[0].args.task_id = 'fixture-task-2';
  });
  assert.equal(grade.passed, false);
  assert.ok(grade.failure_codes.includes('scope_missing_project_id'));
});
