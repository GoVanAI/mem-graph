/**
 * Concept-diff implementation — structured time-travel diff over epistemic
 * records.
 *
 * Per Item 9 (Goal 8) and the Sol review corrections record (Sol H3): this is a read-only capability
 * that wraps `asOfQuery` to produce a field-level diff between two cutoff
 * timestamps. Leverages the existing asOfQuery join pattern (revisions +
 * records tables); no DB schema changes.
 *
 * Scope (first slice):
 *   - structured field-level diff (added / removed / changed / unchanged)
 *   - record-level change classification (added / removed / changed / unchanged)
 *   - retraction-aware (excludes retracted records by default)
 *
 * Out of scope (next slices):
 *   - MCP tool registration
 *   - golden-file fixtures
 *   - wide-window performance cap (acceptance: ≤100 revisions default;
 *     wider windows need explicit LIMIT opt-in)
 */

import type Database from 'better-sqlite3';
import { asOfQuery } from '../../epistemic/projections.js';
import type {
  ConceptDiffFieldChange,
  ConceptDiffOptions,
  ConceptDiffResult,
  RevisionDelta,
} from './types.js';

const COMPARABLE_FIELDS = [
  'statement',
  'epistemic_status',
  'verification_level',
  'source_quality',
  'confidence',
  'valid_from',
  'valid_until',
  'scope',
  'project_id',
  'superseded_by_record_id',
  'revision_id',
  'revision_number',
] as const;

/**
 * Compute the structured diff between a record's state at two cutoff
 * timestamps. Pure read-only — does not mutate any table.
 *
 * If from_state is null and to_state is non-null, the record was added
 * in the window. If from_state is non-null and to_state is null, the
 * record was retracted (or expired) in the window. If both are non-null,
 * fields are compared individually.
 */
export function conceptDiff(
  db: Database.Database,
  recordId: number,
  fromAsOf: string,
  toAsOf: string,
  options: ConceptDiffOptions = {},
): ConceptDiffResult {
  const { includeUnchanged = false, includeRetracted = false } = options;

  const fromState = asOfQuery(db, recordId, fromAsOf);
  let toState = asOfQuery(db, recordId, toAsOf);

  // Per the Sol review corrections record Sol H1: exclude retracted records from to-state by default.
  // A retracted record has epistemic_status='retracted' in its current
  // projection; surfacing its content in a diff would re-expose withdrawn
  // information.
  if (
    toState !== null &&
    !includeRetracted &&
    toState.epistemic_status === 'retracted'
  ) {
    toState = null;
  }

  const changes: ConceptDiffFieldChange[] = [];
  const recordChange = computeRecordChange(fromState, toState);

  if (recordChange === 'changed') {
    for (const field of COMPARABLE_FIELDS) {
      const before = fromState === null ? undefined : (fromState as unknown as Record<string, unknown>)[field];
      const after = toState === null ? undefined : (toState as unknown as Record<string, unknown>)[field];
      const fieldChange = computeFieldChange(field, before, after);
      if (fieldChange === null) continue;
      if (fieldChange.change_type === 'unchanged' && !includeUnchanged) continue;
      changes.push(fieldChange);
    }
  }

  const revisionDelta: RevisionDelta = {
    from_revision: fromState?.revision_number ?? null,
    to_revision: toState?.revision_number ?? null,
  };

  return {
    record_id: recordId,
    from_as_of: fromAsOf,
    to_as_of: toAsOf,
    from_state: fromState,
    to_state: toState,
    changes,
    revision_delta: revisionDelta,
    record_change: recordChange,
  };
}

function computeRecordChange(
  fromState: unknown,
  toState: unknown,
): ConceptDiffResult['record_change'] {
  if (fromState === null && toState !== null) return 'added';
  if (fromState !== null && toState === null) return 'removed';
  if (fromState === null && toState === null) return 'unchanged';
  return 'changed';
}

function computeFieldChange(
  field: string,
  before: unknown,
  after: unknown,
): ConceptDiffFieldChange | null {
  // Treat undefined/null-equivalent as "absent" for comparison.
  const beforeIsAbsent = before === undefined || before === null;
  const afterIsAbsent = after === undefined || after === null;

  if (beforeIsAbsent && afterIsAbsent) return null; // skip absent-absent
  if (beforeIsAbsent && !afterIsAbsent) {
    return { field, before: undefined, after, change_type: 'added' };
  }
  if (!beforeIsAbsent && afterIsAbsent) {
    return { field, before, after: undefined, change_type: 'removed' };
  }
  // Both present — value comparison.
  const equal = deepEqual(before, after);
  return {
    field,
    before,
    after,
    change_type: equal ? 'unchanged' : 'changed',
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (aKeys.some((k, i) => k !== bKeys[i])) return false;
    return aKeys.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}
