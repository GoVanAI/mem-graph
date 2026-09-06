/**
 * Pure boundary between a terminal Task Ledger and Dream's later admission
 * evaluation. This module does not decide admission, persist data, or invoke
 * any runtime tool: it only preserves a closed task's auditable context.
 */

import type {
  EpistemicWorkingSetEntry,
  PhaseTrailEntry,
  TaskLedgerSnapshot,
} from './task-ledger.js';

const PHASES = new Set(['understand', 'gather', 'build', 'verify', 'report', 'complete']);
const ENTRY_KINDS = new Set(['phase', 'decision', 'evidence', 'repair', 'handoff', 'completion']);

export interface DreamAdmissionEnvelope {
  source: 'task-ledger';
  ledger_snapshot: TaskLedgerSnapshot;
  working_set: EpistemicWorkingSetEntry[];
  phase_trail: PhaseTrailEntry[];
  done_condition: string;
  intent: string;
}

/**
 * Prepare a closed ledger for Dream's governed admission pass.
 *
 * The returned data is deliberately detached from the caller's snapshot. The
 * full ledger remains available for audit, while the top-level working set is
 * limited to beliefs that the ledger explicitly marked material.
 */
export function createDreamAdmissionEnvelope(
  snapshot: TaskLedgerSnapshot,
): DreamAdmissionEnvelope {
  assertClosedSnapshot(snapshot);

  const ledger_snapshot = cloneSnapshot(snapshot);
  return {
    source: 'task-ledger',
    ledger_snapshot,
    working_set: ledger_snapshot.epistemic_working_set
      .filter((entry) => entry.material)
      .map(cloneWorkingSetEntry),
    phase_trail: ledger_snapshot.phase_trail.map(clonePhaseTrailEntry),
    done_condition: ledger_snapshot.done_condition,
    intent: ledger_snapshot.intent,
  };
}

function assertClosedSnapshot(snapshot: TaskLedgerSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Dream task-ledger handoff requires a closed TaskLedgerSnapshot');
  }
  if (snapshot.status !== 'closed') {
    throw new Error('Dream task-ledger handoff refuses an open TaskLedgerSnapshot');
  }
  if (!nonEmptyString(snapshot.closed_at)) {
    throw new Error('Closed TaskLedgerSnapshot must include closed_at');
  }
  if (
    !canonicalIso(snapshot.created_at)
    || !canonicalIso(snapshot.updated_at)
    || !canonicalIso(snapshot.closed_at)
  ) {
    throw new Error('Closed TaskLedgerSnapshot must preserve canonical ISO timestamps');
  }
  if (!nonEmptyString(snapshot.project_id) || !nonEmptyString(snapshot.task_id) || !nonEmptyString(snapshot.agent_id)) {
    throw new Error('Closed TaskLedgerSnapshot must preserve its identity triple');
  }
  if (!nonEmptyString(snapshot.done_condition) || !nonEmptyString(snapshot.intent)) {
    throw new Error('Closed TaskLedgerSnapshot must preserve done_condition and intent');
  }
  if (!Array.isArray(snapshot.phase_trail) || !Array.isArray(snapshot.epistemic_working_set)) {
    throw new Error('Closed TaskLedgerSnapshot must contain phase_trail and epistemic_working_set arrays');
  }
  if (!Number.isInteger(snapshot.total_checkpoints) || snapshot.total_checkpoints < snapshot.phase_trail.length) {
    throw new Error('Closed TaskLedgerSnapshot has inconsistent checkpoint totals');
  }
  if (!snapshot.phase_trail.every(validPhaseTrailEntry)) {
    throw new Error('Closed TaskLedgerSnapshot contains a malformed phase trail entry');
  }
  if (!snapshot.epistemic_working_set.every(validWorkingSetEntry)) {
    throw new Error('Closed TaskLedgerSnapshot contains a malformed working-set entry');
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalIso(value: unknown): value is string {
  return nonEmptyString(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validPhaseTrailEntry(value: unknown): value is PhaseTrailEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<PhaseTrailEntry>;
  return typeof entry.phase === 'string'
    && PHASES.has(entry.phase)
    && typeof entry.kind === 'string'
    && ENTRY_KINDS.has(entry.kind)
    && canonicalIso(entry.recorded_at)
    && nonEmptyString(entry.summary)
    && (entry.references === undefined
      || (Array.isArray(entry.references) && entry.references.every(nonEmptyString)));
}

function validWorkingSetEntry(value: unknown): value is EpistemicWorkingSetEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<EpistemicWorkingSetEntry>;
  return typeof entry.material === 'boolean'
    && nonEmptyString(entry.statement)
    && typeof entry.confidence === 'number'
    && Number.isFinite(entry.confidence)
    && entry.confidence >= 0
    && entry.confidence <= 1
    && (entry.record_id === undefined
      || (Number.isInteger(entry.record_id) && (entry.record_id as number) > 0))
    && (entry.last_challenged_at === undefined
      || entry.last_challenged_at === null
      || canonicalIso(entry.last_challenged_at));
}

function cloneSnapshot(snapshot: TaskLedgerSnapshot): TaskLedgerSnapshot {
  return {
    ...snapshot,
    phase_trail: snapshot.phase_trail.map(clonePhaseTrailEntry),
    epistemic_working_set: snapshot.epistemic_working_set.map(cloneWorkingSetEntry),
  };
}

function clonePhaseTrailEntry(entry: PhaseTrailEntry): PhaseTrailEntry {
  return {
    ...entry,
    references: entry.references ? [...entry.references] : undefined,
  };
}

function cloneWorkingSetEntry(entry: EpistemicWorkingSetEntry): EpistemicWorkingSetEntry {
  return { ...entry };
}
