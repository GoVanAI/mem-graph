/**
 * Self-correct-loop bridge for the Epistemic Task Ledger.
 *
 * This module records only a verified recovery that is non-trivial and
 * materially changes the verifier path forward. It deliberately does not
 * record the triggering failure, retry work, or a learning candidate, and it
 * never promotes anything into the epistemic working set.
 */

import {
  EpistemicTaskLedger,
  type ActiveTurnShapePhase,
  type PhaseTrailEntry,
} from './task-ledger.js';

export interface SelfCorrectRepairInput {
  /** Reverification passed after the repair. */
  verified: boolean;
  /** The repair was not a fully obvious, one-line correction. */
  non_trivial: boolean;
  /** The repair changes the subsequent verifier path. */
  changes_verifier_path: boolean;
  /** Turn Shape phase whose failed path was recovered. */
  phase: ActiveTurnShapePhase;
  /** ISO-8601 recovery timestamp supplied by the caller. */
  recorded_at: string;
  /** Scoped description of the recovery outcome, never the original failure. */
  summary: string;
  /** Stable outcome evidence, such as `cognitive_event:<id>` or `artifact:<id>`. */
  references: readonly string[];
}

export type SelfCorrectRepairReason =
  | 'recorded'
  | 'ledger_closed'
  | 'repair_not_verified'
  | 'repair_trivial'
  | 'verifier_path_unchanged'
  | 'invalid_checkpoint'
  | 'missing_stable_references';

export interface SelfCorrectRepairResult {
  recorded: boolean;
  reason: SelfCorrectRepairReason;
  checkpoint?: PhaseTrailEntry;
}

const STABLE_REPAIR_REFERENCE = /^(?:cognitive_event|artifact):[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/**
 * Stable repair evidence is intentionally limited to durable event or
 * artifact identifiers. Human prose, volatile output, and empty strings are
 * not sufficient to make a recovery checkpoint durable.
 */
export function isStableRepairReference(reference: string): boolean {
  return STABLE_REPAIR_REFERENCE.test(reference);
}

/**
 * Append a recovery-only repair checkpoint when self-correct-loop has
 * completed a qualifying repair. All rejected inputs are deterministic
 * no-ops so callers can safely decide whether to continue, escalate, or stop.
 */
export function recordSelfCorrectRepair(
  ledger: EpistemicTaskLedger,
  input: SelfCorrectRepairInput,
): SelfCorrectRepairResult {
  if (ledger.status !== 'open') {
    return { recorded: false, reason: 'ledger_closed' };
  }
  if (!input.verified) {
    return { recorded: false, reason: 'repair_not_verified' };
  }
  if (!input.non_trivial) {
    return { recorded: false, reason: 'repair_trivial' };
  }
  if (!input.changes_verifier_path) {
    return { recorded: false, reason: 'verifier_path_unchanged' };
  }
  if (
    input.summary.trim().length === 0
    || !['understand', 'gather', 'build', 'verify', 'report'].includes(input.phase)
    || !Number.isFinite(Date.parse(input.recorded_at))
    || new Date(input.recorded_at).toISOString() !== input.recorded_at
  ) {
    return { recorded: false, reason: 'invalid_checkpoint' };
  }
  if (input.references.length === 0 || !input.references.every(isStableRepairReference)) {
    return { recorded: false, reason: 'missing_stable_references' };
  }

  ledger.recordCheckpoint({
    kind: 'repair',
    phase: input.phase,
    recorded_at: input.recorded_at,
    summary: input.summary,
    references: [...input.references],
  });

  const checkpoint = ledger.phase_trail.at(-1);
  return {
    recorded: true,
    reason: 'recorded',
    checkpoint: checkpoint === undefined
      ? undefined
      : {
          ...checkpoint,
          references: checkpoint.references ? [...checkpoint.references] : undefined,
        },
  };
}
