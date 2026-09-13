#!/usr/bin/env node
// Structured-predicate evaluator for Step 3 compact-mode grading.
// Pure module: no I/O, no clock, no Math.random, no global state.
//
// Implements the v1 contract from STEP_3_COMPACT_CONTEXT_DELIVERY_DESIGN.md §3 D8:
//   - RFC 6901 JSON Pointer decoding (including ~0 and ~1 escapes)
//   - exact scalar equality for `equals`
//   - exact scalar / recursive-partial match for `includes` and `excludes`
//   - pure existence / non-existence for `exists` and `not_exists`
//
// Forbidden: coercion (Number(), String(), Boolean()), regular expressions,
// executable expressions, free-form query language, side effects, or any
// raw-text search over the serialized envelope. The evaluator operates
// exclusively on the parsed JS value of the envelope.
//
// Malformed pointers and malformed predicates fail closed (return
// { ok: false, reason }) instead of evaluating as absent.

const POINTER_OPERATORS = new Set(['equals', 'includes', 'excludes', 'exists', 'not_exists']);
const POINTER_OPERATORS_NEEDING_VALUE = new Set(['equals', 'includes', 'excludes']);

/**
 * Decode a JSON Pointer (RFC 6901) into reference-token segments.
 * Returns an array of unescaped tokens; throws on invalid input (bare `~`
 * not followed by `0` or `1`, or missing leading `/` when non-empty).
 * Empty pointer resolves to [] (the whole document).
 * @param {string} pointer
 * @returns {string[]}
 */
export function decodePointer(pointer) {
  if (typeof pointer !== 'string') {
    throw new Error('pointer must be a string');
  }
  if (pointer === '') return [];
  if (pointer[0] !== '/') {
    throw new Error('pointer must start with "/" or be empty');
  }
  const raw = pointer.slice(1).split('/');
  const decoded = [];
  for (const segment of raw) {
    // RFC 6901: only ~0 and ~1 are valid escape sequences.
    // Any `~` not followed by 0 or 1 is an invalid escape and must be rejected.
    if (/(?<!~)~(?!0|1)/.test(segment)) {
      throw new Error(`invalid tilde escape in pointer segment: ${JSON.stringify(segment)}`);
    }
    decoded.push(segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return decoded;
}

/**
 * Resolve a pointer against a parsed JS value.
 * Returns { found: true, value } when the path exists, { found: false } otherwise.
 * Does not coerce; array indexing uses integer parsing only when the segment is a
 * non-negative integer (per RFC 6901); otherwise the property is accessed by name.
 * @param {unknown} root
 * @param {string[]} tokens
 * @returns {{ found: boolean, value?: unknown }}
 */
export function resolvePointer(root, tokens) {
  let current = root;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (current === null || current === undefined) return { found: false };
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const arrayIndex = Number(token);
      if (arrayIndex >= current.length) return { found: false };
      current = current[arrayIndex];
      continue;
    }
    if (typeof current !== 'object') return { found: false };
    if (!Object.hasOwn(current, token)) return { found: false };
    current = current[token];
  }
  return { found: true, value: current };
}

/**
 * Strict deep equality with no coercion.
 * - typeof must match
 * - for objects, key sets must match and every value must strictly equal
 * - for arrays, length must match and every element must strictly equal
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function strictEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!strictEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!strictEqual(left[key], right[key])) return false;
  }
  return true;
}

/**
 * Recursive partial match for object values.
 * Every key in `pattern` must exist in `candidate` and recursively strictly equal.
 * Extra keys on the candidate are allowed (and ignored).
 * Arrays follow the same rule: pattern arrays must match the entire candidate array
 * element-by-element (so a pattern of length 0 matches any array, a pattern of length
 * 1 matches only when the array has exactly one element with that exact shape).
 * @param {unknown} candidate
 * @param {unknown} pattern
 * @returns {boolean}
 */
export function partialMatch(candidate, pattern) {
  if (pattern === null || typeof pattern !== 'object' || Array.isArray(pattern)) {
    return strictEqual(candidate, pattern);
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  for (const key of Object.keys(pattern)) {
    if (!Object.hasOwn(candidate, key)) return false;
    if (!partialMatch(candidate[key], pattern[key])) return false;
  }
  return true;
}

/**
 * Validate a single predicate object against the v1 shape.
 * Returns { ok: true, predicate } when valid, { ok: false, reason } otherwise.
 * @param {unknown} candidate
 */
export function validatePredicate(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'predicate must be an object' };
  }
  const keys = Object.keys(candidate);
  const allowed = new Set(['pointer', 'operator', 'value']);
  for (const key of keys) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `predicate has forbidden extra property: ${key}` };
    }
  }
  if (!('pointer' in candidate)) return { ok: false, reason: 'predicate missing pointer' };
  if (!('operator' in candidate)) return { ok: false, reason: 'predicate missing operator' };
  if (typeof candidate.pointer !== 'string') {
    return { ok: false, reason: 'predicate pointer must be a string' };
  }
  // Empty pointer is valid (addresses the whole document) per RFC 6901.
  if (!POINTER_OPERATORS.has(candidate.operator)) {
    return { ok: false, reason: `predicate operator must be one of ${[...POINTER_OPERATORS].join('|')}; got ${JSON.stringify(candidate.operator)}` };
  }
  if (POINTER_OPERATORS_NEEDING_VALUE.has(candidate.operator)) {
    if (!('value' in candidate)) {
      return { ok: false, reason: `operator ${candidate.operator} requires value` };
    }
    if (candidate.value === undefined) {
      return { ok: false, reason: `operator ${candidate.operator} forbids undefined value (use null for explicit null)` };
    }
    if (typeof candidate.value === 'object' && candidate.value !== null && Array.isArray(candidate.value)) {
      return { ok: false, reason: `operator ${candidate.operator} forbids array value (use object recursive partial-match or scalar)` };
    }
  } else {
    if ('value' in candidate) {
      return { ok: false, reason: `operator ${candidate.operator} forbids value` };
    }
  }
  return { ok: true, predicate: candidate };
}

/**
 * Apply one predicate against a parsed envelope value.
 * Returns { ok: true, passed: boolean, observed?: unknown, reason?: string }.
 * Malformed pointers and unknown predicate shapes return ok:false and never
 * silently evaluate as absent (per design contract).
 * @param {unknown} envelope
 * @param {unknown} predicate
 */
export function evaluatePredicate(envelope, predicate) {
  const validation = validatePredicate(predicate);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }
  const safe = validation.predicate;
  let tokens;
  try {
    tokens = decodePointer(safe.pointer);
  } catch (error) {
    return { ok: false, reason: `pointer decode failed: ${error.message}` };
  }
  const resolution = resolvePointer(envelope, tokens);
  if (!resolution.found) {
    if (safe.operator === 'not_exists') {
      return { ok: true, passed: true, observed: 'absent' };
    }
    return { ok: false, reason: `pointer ${safe.pointer} does not resolve` };
  }
  const observed = resolution.value;
  switch (safe.operator) {
    case 'exists':
      return { ok: true, passed: true, observed };
    case 'not_exists':
      return { ok: true, passed: false, observed };
    case 'equals':
      return { ok: true, passed: strictEqual(observed, safe.value), observed };
    case 'includes': {
      if (Array.isArray(observed)) {
        if (typeof safe.value === 'object' && safe.value !== null && !Array.isArray(safe.value)) {
          const hit = observed.some((entry) => partialMatch(entry, safe.value));
          return { ok: true, passed: hit, observed };
        }
        const hit = observed.some((entry) => strictEqual(entry, safe.value));
        return { ok: true, passed: hit, observed };
      }
      return { ok: false, reason: `operator includes requires array target; got ${typeof observed}` };
    }
    case 'excludes': {
      if (Array.isArray(observed)) {
        if (typeof safe.value === 'object' && safe.value !== null && !Array.isArray(safe.value)) {
          const hit = observed.some((entry) => partialMatch(entry, safe.value));
          return { ok: true, passed: !hit, observed };
        }
        const hit = observed.some((entry) => strictEqual(entry, safe.value));
        return { ok: true, passed: !hit, observed };
      }
      return { ok: false, reason: `operator excludes requires array target; got ${typeof observed}` };
    }
    default:
      // validatePredicate already restricts the operator; this is defense in depth.
      return { ok: false, reason: `unhandled operator ${safe.operator}` };
  }
}

/**
 * Evaluate a list of predicates against an envelope.
 * Returns { ok: true, passed, requiredPass, requiredFail, forbiddenFired,
 *   forbiddenHold, requiredResults, forbiddenResults }.
 *
 * Operator-level convention (from evaluatePredicate):
 *   passed === true  means the predicate's literal condition is met.
 *     equals:      values match.
 *     includes:    array contains a matching element.
 *     excludes:    array contains NO matching element.
 *     exists:      pointer resolves.
 *     not_exists:  pointer does not resolve.
 *
 * evaluatePlan convention:
 *   required_predicates  — every one must have passed === true.
 *   forbidden_predicates — must describe the BAD condition literally; the
 *     predicate fires (and the plan fails) when passed === true because the
 *     forbidden thing is present.
 *
 * Therefore, when a forbidden predicate expresses "absence required," use
 * the literal "absence" operator. Concretely:
 *   forbidden_predicates:
 *     - {operator: includes, value: X}    — fires when X is present (good).
 *     - {operator: equals, value: Y}     — fires when Y equals the target.
 *   required_predicates:
 *     - {operator: excludes, value: X}    — passes when X is absent.
 *     - {operator: not_exists}           — passes when the pointer is absent.
 *
 * Predicates that fail at the predicate-validator level (ok:false) fail the
 * whole call; the contract requires malformed or unresolved pointers to
 * fail required predicates rather than be treated as absent.
 * @param {unknown} envelope
 * @param {{ required_predicates?: unknown[], forbidden_predicates?: unknown[] }} plan
 */
export function evaluatePlan(envelope, plan) {
  const required = Array.isArray(plan?.required_predicates) ? plan.required_predicates : [];
  const forbidden = Array.isArray(plan?.forbidden_predicates) ? plan.forbidden_predicates : [];
  const requiredResults = [];
  const forbiddenResults = [];
  for (const predicate of required) {
    const result = evaluatePredicate(envelope, predicate);
    if (!result.ok) {
      return {
        ok: false,
        reason: `required predicate ${JSON.stringify(predicate)} failed to evaluate: ${result.reason}`,
        requiredResults,
        forbiddenResults,
      };
    }
    requiredResults.push({ pointer: predicate?.pointer, passed: result.passed });
  }
  for (const predicate of forbidden) {
    const result = evaluatePredicate(envelope, predicate);
    if (!result.ok) {
      return {
        ok: false,
        reason: `forbidden predicate ${JSON.stringify(predicate)} failed to evaluate: ${result.reason}`,
        requiredResults,
        forbiddenResults,
      };
    }
    forbiddenResults.push({ pointer: predicate?.pointer, passed: result.passed });
  }
  const requiredPass = requiredResults.every((entry) => entry.passed);
  // Forbidden predicate fires (plan fails) when the literal condition is met.
  const forbiddenFired = forbiddenResults.filter((entry) => entry.passed);
  const forbiddenHold = forbiddenFired.length === 0;
  return {
    ok: true,
    passed: requiredPass && forbiddenHold,
    requiredPass,
    requiredFail: requiredResults.filter((entry) => !entry.passed).map((entry) => entry.pointer),
    forbiddenHold,
    forbiddenFired: forbiddenFired.map((entry) => entry.pointer),
    requiredResults,
    forbiddenResults,
  };
}
