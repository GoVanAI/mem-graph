/**
 * Concept-diff types — structured time-travel diff over epistemic records.
 *
 * Per Item 9 (Goal 8) of the 10-reasoning-tooling-goal plan, and per
 * the Sol review corrections record (Sol review recommendation): implement as a read-only
 * runtime/library/MCP capability that wraps `asOfQuery` to produce a
 * field-level diff between two cutoff timestamps.
 *
 * The diff is intended to be human-readable AND machine-parseable.
 * Operators get an explicit `changes` array they can render or filter;
 * programmatic consumers can iterate `changes` without parsing prose.
 */

import type { AsOfRecord } from '../../epistemic/projections.js';

export type ChangeType = 'added' | 'removed' | 'changed' | 'unchanged';

export interface ConceptDiffFieldChange {
  field: string;
  /** Undefined if the field did not exist in the from-state (field was added). */
  before: unknown;
  /** Undefined if the field did not exist in the to-state (field was removed). */
  after: unknown;
  change_type: ChangeType;
}

export interface RevisionDelta {
  /** Revision number at from_as_of, or null if record did not exist. */
  from_revision: number | null;
  /** Revision number at to_as_of, or null if record was retracted. */
  to_revision: number | null;
}

export interface ConceptDiffResult {
  record_id: number;
  from_as_of: string;
  to_as_of: string;
  /** null if the record did not exist at from_as_of. */
  from_state: AsOfRecord | null;
  /** null if the record was retracted before to_as_of. */
  to_state: AsOfRecord | null;
  changes: ConceptDiffFieldChange[];
  revision_delta: RevisionDelta;
  /** "added", "removed", "changed", or "unchanged" at the record level. */
  record_change: 'added' | 'removed' | 'changed' | 'unchanged';
}

export interface ConceptDiffOptions {
  /**
   * Include fields that are unchanged. Default false — operators usually want
   * just the changes.
   */
  includeUnchanged?: boolean;
  /**
   * Include retracted records in the to-state. Default false — retracted
   * records are excluded to avoid surfacing content the operator previously
   * withdrew. Per the Sol review corrections record (Sol H1 privacy invariant).
   */
  includeRetracted?: boolean;
}
