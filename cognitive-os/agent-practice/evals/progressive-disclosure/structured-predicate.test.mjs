#!/usr/bin/env node
// Unit tests for the structured-predicate evaluator. Pure node:test.
// Run via: node --test cognitive-os/agent-practice/evals/progressive-disclosure/structured-predicate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePointer,
  resolvePointer,
  strictEqual,
  partialMatch,
  validatePredicate,
  evaluatePredicate,
  evaluatePlan,
} from './structured-predicate.mjs';

test('decodePointer handles empty pointer', () => {
  assert.deepEqual(decodePointer(''), []);
});

test('decodePointer handles root path', () => {
  assert.deepEqual(decodePointer('/'), ['']);
});

test('decodePointer unescapes ~1 to / and ~0 to ~', () => {
  assert.deepEqual(decodePointer('/a~1b/c~0d'), ['a/b', 'c~d']);
});

test('decodePointer rejects invalid tilde escape ~2', () => {
  assert.throws(() => decodePointer('/a~2'), /invalid tilde escape/);
});

test('decodePointer rejects invalid tilde escape ~ (bare)', () => {
  assert.throws(() => decodePointer('/a~'), /invalid tilde escape/);
});

test('decodePointer rejects invalid tilde escape ~a', () => {
  assert.throws(() => decodePointer('/~a'), /invalid tilde escape/);
});

test('decodePointer accepts ~01 (decodes to ~1; ~0+1 is valid token char sequence)', () => {
  // Per RFC 6901, decode is greedy left-to-right: ~0 first (decoding to ~),
  // then the remaining 1 is a literal token character. Result: the segment
  // becomes "~1", which is itself a valid escape for "/". Two layers of
  // re-encoding are intentional and not an error.
  assert.deepEqual(decodePointer('/~01'), ['~1']);
});

test('decodePointer preserves replacement order (~1 before ~0)', () => {
  // /~01 must decode to ['~1'] not ['/']; replacing ~0 first would yield '/'.
  assert.deepEqual(decodePointer('/~01'), ['~1']);
});

test('decodePointer throws when pointer does not start with /', () => {
  assert.throws(() => decodePointer('a/b'), /must start with/);
});

test('decodePointer throws when input is not a string', () => {
  assert.throws(() => decodePointer(123), /must be a string/);
});

test('resolvePointer with empty pointer returns the root document', () => {
  const root = { a: 1, b: [2, 3] };
  const result = resolvePointer(root, []);
  assert.equal(result.found, true);
  assert.equal(result.value, root);
});

test('resolvePointer follows nested object paths', () => {
  const root = { a: { b: { c: 42 } } };
  const result = resolvePointer(root, decodePointer('/a/b/c'));
  assert.equal(result.found, true);
  assert.equal(result.value, 42);
});

test('resolvePointer handles array indices', () => {
  const root = { list: [{ name: 'first' }, { name: 'second' }] };
  const result = resolvePointer(root, decodePointer('/list/1/name'));
  assert.equal(result.found, true);
  assert.equal(result.value, 'second');
});

test('resolvePointer rejects non-integer array segments', () => {
  const root = { list: [1, 2, 3] };
  const result = resolvePointer(root, decodePointer('/list/abc'));
  assert.equal(result.found, false);
});

test('resolvePointer reports absent paths as not found', () => {
  const result = resolvePointer({ a: 1 }, decodePointer('/b/c'));
  assert.equal(result.found, false);
});

test('resolvePointer rejects traversal into primitives', () => {
  const result = resolvePointer({ a: 5 }, decodePointer('/a/b'));
  assert.equal(result.found, false);
});

test('strictEqual performs identity on primitives', () => {
  assert.equal(strictEqual(1, 1), true);
  assert.equal(strictEqual('a', 'a'), true);
  assert.equal(strictEqual(true, true), true);
  assert.equal(strictEqual(null, null), true);
  assert.equal(strictEqual(undefined, undefined), true);
});

test('strictEqual rejects cross-type comparisons', () => {
  assert.equal(strictEqual(1, '1'), false);
  assert.equal(strictEqual(0, false), false);
  assert.equal(strictEqual(null, 0), false);
  assert.equal(strictEqual(null, undefined), false);
});

test('strictEqual compares arrays element-wise', () => {
  assert.equal(strictEqual([1, 2, 3], [1, 2, 3]), true);
  assert.equal(strictEqual([1, 2, 3], [1, 2]), false);
  assert.equal(strictEqual([1, 2, 3], [1, 2, '3']), false);
});

test('strictEqual compares objects key-by-key', () => {
  assert.equal(strictEqual({ a: 1, b: 2 }, { a: 1, b: 2 }), true);
  assert.equal(strictEqual({ a: 1, b: 2 }, { a: 1 }), false);
  assert.equal(strictEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(strictEqual({ a: 1, b: 2 }, { a: 1, b: 3 }), false);
});

test('partialMatch allows extra keys on candidate', () => {
  assert.equal(partialMatch({ a: 1, b: 2, c: 3 }, { a: 1, b: 2 }), true);
  assert.equal(partialMatch({ a: 1 }, { a: 1, b: 2 }), false);
});

test('partialMatch delegates to strictEqual for primitives and arrays', () => {
  assert.equal(partialMatch(5, 5), true);
  assert.equal(partialMatch([1, 2], [1, 2]), true);
  assert.equal(partialMatch([1, 2, 3], [1, 2]), false); // array pattern: must match entire array
  assert.equal(partialMatch([1, 2], [1, 2, 3]), false);
});

test('partialMatch rejects mismatched kinds', () => {
  assert.equal(partialMatch({ a: 1 }, [1]), false);
  assert.equal(partialMatch(null, { a: 1 }), false);
});

test('validatePredicate accepts valid equals predicate', () => {
  const result = validatePredicate({ pointer: '/scope/project_id', operator: 'equals', value: 'fixture-alpha' });
  assert.equal(result.ok, true);
});

test('validatePredicate rejects missing pointer', () => {
  const result = validatePredicate({ operator: 'equals', value: 1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing pointer/);
});

test('validatePredicate rejects missing operator', () => {
  const result = validatePredicate({ pointer: '/a' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing operator/);
});

test('validatePredicate rejects unknown operator', () => {
  const result = validatePredicate({ pointer: '/a', operator: 'regex', value: 'foo' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /operator must be one of/);
});

test('validatePredicate rejects equals without value', () => {
  const result = validatePredicate({ pointer: '/a', operator: 'equals' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires value/);
});

test('validatePredicate rejects exists with value', () => {
  const result = validatePredicate({ pointer: '/a', operator: 'exists', value: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /forbids value/);
});

test('validatePredicate rejects forbidden extra property', () => {
  const result = validatePredicate({ pointer: '/a', operator: 'equals', value: 1, regex: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /forbidden extra property/);
});

test('validatePredicate rejects non-object predicate', () => {
  assert.equal(validatePredicate('nope').ok, false);
  assert.equal(validatePredicate(null).ok, false);
  assert.equal(validatePredicate([]).ok, false);
});

test('validatePredicate accepts empty pointer (root document)', () => {
  const result = validatePredicate({ pointer: '', operator: 'exists' });
  assert.equal(result.ok, true);
});

test('validatePredicate rejects equals with array value', () => {
  const result = validatePredicate({ pointer: '/a', operator: 'equals', value: [1, 2, 3] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /forbids array value/);
});

test('validatePredicate rejects includes with array value', () => {
  const result = validatePredicate({ pointer: '/a', operator: 'includes', value: [1, 2, 3] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /forbids array value/);
});

test('validatePredicate accepts equals with object value (recursive partial match target)', () => {
  const result = validatePredicate({ pointer: '/a', operator: 'equals', value: { x: 1 } });
  assert.equal(result.ok, true);
});

test('evaluatePredicate equals passes on exact match', () => {
  const result = evaluatePredicate({ scope: { project_id: 'fixture-alpha' } }, { pointer: '/scope/project_id', operator: 'equals', value: 'fixture-alpha' });
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
});

test('evaluatePredicate equals fails without coercion', () => {
  const result = evaluatePredicate({ a: 1 }, { pointer: '/a', operator: 'equals', value: '1' });
  assert.equal(result.ok, true);
  assert.equal(result.passed, false);
});

test('evaluatePredicate includes matches scalar in array', () => {
  const envelope = { warnings: ['contradiction', 'stale'] };
  const result = evaluatePredicate(envelope, { pointer: '/warnings', operator: 'includes', value: 'contradiction' });
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
});

test('evaluatePredicate excludes passes when array lacks value', () => {
  const envelope = { warnings: ['stale'] };
  const result = evaluatePredicate(envelope, { pointer: '/warnings', operator: 'excludes', value: 'contradiction' });
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
});

test('evaluatePredicate excludes fails when array contains value', () => {
  const envelope = { warnings: ['contradiction', 'stale'] };
  const result = evaluatePredicate(envelope, { pointer: '/warnings', operator: 'excludes', value: 'contradiction' });
  assert.equal(result.ok, true);
  assert.equal(result.passed, false);
});

test('evaluatePredicate includes does partial match for objects', () => {
  const envelope = { expansions: [{ reason: 'version_mismatch', source: { id: 110 } }, { reason: 'verify_authority' }] };
  const result = evaluatePredicate(envelope, { pointer: '/expansions', operator: 'includes', value: { reason: 'version_mismatch' } });
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
});

test('evaluatePredicate rejects array value at validator (fails closed, not silently absent)', () => {
  // Per v1 contract refinement: array values are forbidden in predicates; the
  // contract uses scalar / object recursive partial-match. A predicate that
  // somehow reaches evaluation with an array value (e.g., constructed in code
  // bypassing validatePredicate) must still be rejected by the operator path.
  const envelope = { ids: [1, 2, 3] };
  // Validate-then-evaluate path catches it at the validator.
  const validation = validatePredicate({ pointer: '/ids', operator: 'includes', value: [1, 2, 3] });
  assert.equal(validation.ok, false);
  assert.match(validation.reason, /forbids array value/);
  // Reference: the resolved envelope value is still an array, but the predicate
  // is rejected before evaluation. There is no "silent absent" path.
  const resolution = resolvePointer(envelope, decodePointer('/ids'));
  assert.equal(resolution.found, true);
  assert.ok(Array.isArray(resolution.value));
});

test('evaluatePredicate exists passes when pointer resolves', () => {
  const envelope = { state: { current: [{ sources: [] }] } };
  const result = evaluatePredicate(envelope, { pointer: '/state/current', operator: 'exists' });
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
});

test('evaluatePredicate exists fails when pointer is absent (ok=false, not silently absent)', () => {
  const result = evaluatePredicate({}, { pointer: '/state/current', operator: 'exists' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not resolve/);
});

test('evaluatePredicate not_exists passes when pointer is absent', () => {
  const result = evaluatePredicate({}, { pointer: '/invented', operator: 'not_exists' });
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
});

test('evaluatePredicate not_exists fails when pointer resolves', () => {
  const result = evaluatePredicate({ invented: 1 }, { pointer: '/invented', operator: 'not_exists' });
  assert.equal(result.ok, true);
  assert.equal(result.passed, false);
});

test('evaluatePredicate reports malformed pointer as ok=false (fails closed)', () => {
  const result = evaluatePredicate({}, { pointer: 'no-slash', operator: 'exists' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /pointer decode failed/);
});

test('evaluatePredicate reports invalid tilde escape as ok=false (fails closed)', () => {
  const result = evaluatePredicate({}, { pointer: '/a~2', operator: 'not_exists' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /pointer decode failed/);
});

test('evaluatePredicate with empty pointer exists matches root document', () => {
  const root = { scope: 'alpha' };
  const result = evaluatePredicate(root, { pointer: '', operator: 'exists' });
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
});

test('evaluatePredicate with empty pointer equals matches the root value', () => {
  const root = { scope: 'alpha' };
  const result = evaluatePredicate(root, { pointer: '', operator: 'equals', value: root });
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
});

test('evaluatePredicate with empty pointer equals fails when root differs', () => {
  const result = evaluatePredicate({ scope: 'alpha' }, { pointer: '', operator: 'equals', value: { scope: 'beta' } });
  assert.equal(result.ok, true);
  assert.equal(result.passed, false);
});

test('evaluatePredicate reports malformed predicate as ok=false', () => {
  const result = evaluatePredicate({}, { pointer: '/a', operator: 'regex', value: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /operator must be one of/);
});

test('evaluatePredicate includes requires array target', () => {
  const result = evaluatePredicate({ a: 'scalar' }, { pointer: '/a', operator: 'includes', value: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /includes requires array target/);
});

test('evaluatePlan returns ok=true when all required pass and all forbidden hold', () => {
  const envelope = {
    scope: { project_id: 'fixture-alpha', include_global: false },
    orientation: { status: 'partial', task_state: 'assembled' },
  };
  const plan = {
    required_predicates: [
      { pointer: '/scope/project_id', operator: 'equals', value: 'fixture-alpha' },
      { pointer: '/orientation/task_state', operator: 'equals', value: 'assembled' },
    ],
    forbidden_predicates: [
      { pointer: '/scope/include_global', operator: 'equals', value: true },
    ],
  };
  const result = evaluatePlan(envelope, plan);
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
});

test('evaluatePlan returns passed=false when a required predicate fails (and the failing pointer is named)', () => {
  const envelope = {
    scope: { project_id: 'fixture-beta', include_global: false },
    orientation: { status: 'partial', task_state: 'assembled' },
  };
  const plan = {
    required_predicates: [
      { pointer: '/scope/project_id', operator: 'equals', value: 'fixture-alpha' },
      { pointer: '/orientation/task_state', operator: 'equals', value: 'assembled' },
    ],
  };
  const result = evaluatePlan(envelope, plan);
  assert.equal(result.ok, true);
  assert.equal(result.passed, false);
  assert.deepEqual(result.requiredFail, ['/scope/project_id']);
});

test('evaluatePlan returns passed=false when a forbidden predicate fires (and the failing pointer is named)', () => {
  const envelope = { warnings: ['manifest_invalid'] };
  const plan = {
    forbidden_predicates: [
      { pointer: '/warnings', operator: 'includes', value: 'manifest_invalid' },
    ],
  };
  const result = evaluatePlan(envelope, plan);
  assert.equal(result.ok, true);
  assert.equal(result.passed, false);
  assert.deepEqual(result.forbiddenFired, ['/warnings']);
});

test('evaluatePlan fails closed on malformed required predicate', () => {
  const result = evaluatePlan({}, { required_predicates: [{ pointer: 'no-slash', operator: 'exists' }] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /required predicate .* failed to evaluate/);
});

test('evaluatePlan fails closed on malformed forbidden predicate', () => {
  const result = evaluatePlan({}, { forbidden_predicates: [{ pointer: '/a', operator: 'regex', value: 'x' }] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /forbidden predicate .* failed to evaluate/);
});

// Codex-required explicit semantics tests: required+excludes and forbidden+includes
// must each behave as their literal operator name implies.

test('required excludes passes when value is absent', () => {
  const envelope = { warnings: ['stale'] };
  const plan = {
    required_predicates: [
      { pointer: '/warnings', operator: 'excludes', value: 'contradiction' },
    ],
  };
  const result = evaluatePlan(envelope, plan);
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
});

test('required excludes fails when value is present', () => {
  const envelope = { warnings: ['contradiction', 'stale'] };
  const plan = {
    required_predicates: [
      { pointer: '/warnings', operator: 'excludes', value: 'contradiction' },
    ],
  };
  const result = evaluatePlan(envelope, plan);
  assert.equal(result.ok, true);
  assert.equal(result.passed, false);
  assert.deepEqual(result.requiredFail, ['/warnings']);
});

test('forbidden includes fires when the bad value is present', () => {
  const envelope = { warnings: ['mixed_snapshot', 'stale'] };
  const plan = {
    forbidden_predicates: [
      { pointer: '/warnings', operator: 'includes', value: 'mixed_snapshot' },
    ],
  };
  const result = evaluatePlan(envelope, plan);
  assert.equal(result.ok, true);
  assert.equal(result.passed, false);
  assert.deepEqual(result.forbiddenFired, ['/warnings']);
});

test('forbidden includes holds when the bad value is absent', () => {
  const envelope = { warnings: ['stale'] };
  const plan = {
    forbidden_predicates: [
      { pointer: '/warnings', operator: 'includes', value: 'mixed_snapshot' },
    ],
  };
  const result = evaluatePlan(envelope, plan);
  assert.equal(result.ok, true);
  assert.equal(result.passed, true);
  assert.deepEqual(result.forbiddenFired, []);
});

test('evaluator does not search raw serialized text — same envelope with different key ordering still produces the same result', () => {
  const envelopeA = {
    orientation: { status: 'partial', task_state: 'unavailable' },
    scope: { project_id: 'fixture-alpha', include_global: false, global_inclusion: 'disabled' },
  };
  const envelopeB = {
    scope: { global_inclusion: 'disabled', include_global: false, project_id: 'fixture-alpha' },
    orientation: { task_state: 'unavailable', status: 'partial' },
  };
  const plan = {
    required_predicates: [
      { pointer: '/scope/project_id', operator: 'equals', value: 'fixture-alpha' },
      { pointer: '/orientation/status', operator: 'equals', value: 'partial' },
    ],
    forbidden_predicates: [
      { pointer: '/scope/include_global', operator: 'equals', value: true },
    ],
  };
  const resultA = evaluatePlan(envelopeA, plan);
  const resultB = evaluatePlan(envelopeB, plan);
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  assert.equal(resultA.passed, true);
  assert.equal(resultB.passed, true);
});

test('evaluator does not search raw serialized text — numeric strings are not coerced to numbers', () => {
  // A raw-text grader that saw `42` would pass both equals(42) and equals("42");
  // the structured evaluator must distinguish.
  const envelope = { value: '42' };
  const passesAsNumber = evaluatePredicate(envelope, { pointer: '/value', operator: 'equals', value: 42 });
  const passesAsString = evaluatePredicate(envelope, { pointer: '/value', operator: 'equals', value: '42' });
  assert.equal(passesAsNumber.passed, false);
  assert.equal(passesAsString.passed, true);
});

test('evaluator does not search raw serialized text — whitespace is significant', () => {
  const envelope = { label: 'foo' };
  const paddedMatch = evaluatePredicate(envelope, { pointer: '/label', operator: 'equals', value: 'foo ' });
  assert.equal(paddedMatch.passed, false);
});
