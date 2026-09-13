#!/usr/bin/env node
// Contract-harness test: run evaluatePlan for every Step 3 case against its
// representative envelope (must pass) and its counterexample envelope (must
// fail). Verifies that:
//   - the eight case contracts are mechanically expressible against the
//     compact envelope shape;
//   - every required predicate actually resolves against a well-formed
//     fixture (catches nonexistent paths like /task/objective/authority);
//   - every forbidden predicate actually filters out the failure mode it
//     is meant to detect;
//   - each case has a non-trivial counterexample (one wrong value or one
//     missing field must make the plan fail).
// Run via: node --test cognitive-os/agent-practice/evals/progressive-disclosure/case-fixtures.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { evaluatePlan, decodePointer, validatePredicate } from './structured-predicate.mjs';
import { ALL_FIXTURES, COUNTEREXAMPLES } from './case-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const casesDocument = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));
const casesById = new Map(casesDocument.cases.map((entry) => [entry.id, entry]));

const EXPECTED_IDS = [
  'pd-01-ordinary-restart',
  'pd-02-valid-manifest',
  'pd-03-fresh-contradiction',
  'pd-04-long-governing-record',
  'pd-05-wrong-project',
  'pd-06-source-revised',
  'pd-07-history-heavy',
  'pd-08-degraded-input',
];

for (const id of EXPECTED_IDS) {
  test(`${id}: representative envelope passes the case plan`, () => {
    const fixture = ALL_FIXTURES[id];
    assert.ok(fixture, `${id} has no representative envelope fixture`);
    const plan = casesById.get(id);
    assert.ok(plan, `${id} is missing from cases.json`);
    const result = evaluatePlan(fixture, plan);
    if (!result.ok) {
      assert.fail(`${id} plan failed to evaluate against its fixture: ${result.reason}`);
    }
    if (!result.passed) {
      const failing = [
        ...result.requiredFail.map((p) => `required: ${p}`),
        ...(result.forbiddenFail ?? result.forbiddenFired ?? []).map((p) => `forbidden: ${p}`),
      ];
      assert.fail(`${id} fixture did not satisfy plan:\n  ${failing.join('\n  ')}`);
    }
    assert.equal(result.passed, true);
  });

  test(`${id}: counterexample envelope fails the case plan`, () => {
    const counter = COUNTEREXAMPLES[id];
    assert.ok(counter, `${id} has no counterexample envelope fixture`);
    const plan = casesById.get(id);
    assert.ok(plan, `${id} is missing from cases.json`);
    const result = evaluatePlan(counter, plan);
    if (!result.ok) {
      // A counterexample that fails at the validator layer is fine; that's
      // an even stronger failure mode than a runtime miss.
      return;
    }
    assert.equal(
      result.passed,
      false,
      `${id} counterexample unexpectedly passed the plan — the failure-mode detection is too weak`,
    );
  });
}

// Contract-path check: every required predicate pointer must resolve against
// the representative envelope for its case. Predicates that fail to resolve
// expose nonexistent paths like the /task/objective/authority mistake from
// pd-02's prior version. This is a defense-in-depth pass on top of the
// per-case plan evaluation above.
for (const id of EXPECTED_IDS) {
  const fixture = ALL_FIXTURES[id];
  const plan = casesById.get(id);
  if (!fixture || !plan) continue;

  test(`${id}: every required predicate pointer resolves against the envelope`, () => {
    for (const predicate of plan.required_predicates ?? []) {
      const validation = validatePredicate(predicate);
      assert.equal(validation.ok, true, `${id} required predicate invalid: ${validation.reason}`);
      let tokens;
      try {
        tokens = decodePointer(predicate.pointer);
      } catch (error) {
        assert.fail(`${id} required predicate pointer decode failed: ${error.message}`);
      }
      // The pointer must resolve. For required predicates that use `equals`
      // with a concrete value, finding the value proves the path exists.
      // For `exists` / `not_exists`, a missing path is a structural
      // problem we want to surface — that contradicts "the case proves this
      // is present".
      const operatorsThatRequirePresence = new Set(['equals', 'includes', 'excludes', 'exists']);
      if (operatorsThatRequirePresence.has(predicate.operator)) {
        const found = resolvePointerLocal(fixture, tokens);
        assert.equal(
          found,
          true,
          `${id} required predicate ${JSON.stringify(predicate)} does not resolve against the fixture — check for a typo or a renamed envelope field`,
        );
      }
    }
  });

  test(`${id}: every forbidden predicate pointer resolves against the envelope (or the absence is the assertion)`, () => {
    for (const predicate of plan.forbidden_predicates ?? []) {
      const validation = validatePredicate(predicate);
      assert.equal(validation.ok, true, `${id} forbidden predicate invalid: ${validation.reason}`);
      // Forbidden predicates may be either:
      //   - "this must NOT exist" (not_exists) — the absence itself is the assertion;
      //   - "this must NOT match any array element" (excludes) — the array must exist;
      //   - "this must NOT equal this scalar" (equals would not be a forbidden pattern
      //     in the v1 set; we do not see this).
      if (predicate.operator === 'not_exists') {
        // The pointer is allowed to be absent; that is the desired behavior.
        continue;
      }
      let tokens;
      try {
        tokens = decodePointer(predicate.pointer);
      } catch (error) {
        assert.fail(`${id} forbidden predicate pointer decode failed: ${error.message}`);
      }
      const found = resolvePointerLocal(fixture, tokens);
      assert.equal(
        found,
        true,
        `${id} forbidden predicate ${JSON.stringify(predicate)} target array does not resolve — excludes needs an array`,
      );
    }
  });
}

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
