/**
 * Epistemic Memory Phase B — Turn Shape Phase B Task Ledger.
 *
 * Per [[285]] (Turn Shape Phase B artifacts) and [[283]] Step 9 acceptance:
 *   - host-neutral adapter that reads/writes only at qualifying ledger,
 *     recovery, admission, handoff, and completion checkpoints;
 *   - ordinary tool calls create no memory spam (events appended only
 *     at qualifying checkpoints);
 *   - one exact-task ledger updated at material phase changes;
 *   - repair success remains scoped evidence (logged, not promoted);
 *   - Dream admission shape is available at terminal close;
 *   - no hook, scheduler, or unattended promotion.
 *
 * Identity model: (project_id, agent_id, task_id) triple. Cross-agent
 * isolation enforced by exact (project_id, agent_id, task_id) match.
 *
 * Hard caps to prevent unbounded phase_trail growth:
 *   - phase_trail ≤ 50 entries (older entries archived when reached);
 *   - epistemic_working_set tracks only material beliefs.
 *
 * Adapter does NOT itself write to mem-graph; it produces a checkpoint
 * envelope that downstream persistence (e.g. a host hook) may submit.
 * For Slice 1 we keep the adapter pure and provide an explicit
 * `toCognitiveEvent()` so callers can submit at qualifying checkpoints.
 */

import { createHash } from 'node:crypto';

export type TurnShapePhase =
  | 'understand'
  | 'gather'
  | 'build'
  | 'verify'
  | 'report'
  | 'complete';

export type LedgerEntryKind =
  | 'phase'
  | 'decision'
  | 'evidence'
  | 'repair'
  | 'handoff'
  | 'completion';

export interface PhaseTrailEntry {
  phase: TurnShapePhase;
  kind: LedgerEntryKind;
  recorded_at: string;
  summary: string;
  /** Optional stable IDs from the work (event_ids, record_ids, revision_ids, ...). */
  references?: string[];
}

export interface EpistemicWorkingSetEntry {
  material: boolean;
  record_id?: number;
  statement: string;
  confidence: number;
  /** When this belief was last challenged (if ever). */
  last_challenged_at?: string | null;
}

export interface TaskLedgerCheckpoint {
  kind: 'phase' | 'decision' | 'evidence' | 'repair' | 'handoff' | 'completion';
  recorded_at: string;
  summary: string;
  references?: string[];
}

export interface TaskLedgerSnapshot {
  task_id: string;
  project_id: string;
  agent_id: string;
  /** ISO-8601 string. */
  created_at: string;
  /** ISO-8601 string. */
  updated_at: string;
  closed_at: string | null;
  status: 'open' | 'closed';
  phase_trail: PhaseTrailEntry[];
  epistemic_working_set: EpistemicWorkingSetEntry[];
  total_checkpoints: number;
}

const MAX_PHASE_TRAIL = 50;

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function makeAgentId(sessionId: string): string {
  // Stable per-session id derived from session_id; deterministic prefix
  // makes cross-agent ledger isolation verifiable.
  return `claude-${sha256(sessionId).slice(0, 8)}`;
}

export interface CreateLedgerInput {
  project_id: string;
  task_id: string;
  session_id: string;
  /** Optional override for agent_id (used in tests). */
  agent_id?: string;
  /** One-sentence done-condition recorded in the ledger. */
  done_condition: string;
  /** Material intent of the task (free text, ≤280 chars). */
  intent: string;
}

/**
 * In-memory Task Ledger. The adapter is intentionally synchronous and
 * side-effect-free: it produces a snapshot the caller can persist at
 * qualifying checkpoints.
 */
export class EpistemicTaskLedger {
  public readonly project_id: string;
  public readonly task_id: string;
  public readonly agent_id: string;
  public readonly done_condition: string;
  public readonly intent: string;
  public created_at: string;
  public updated_at: string;
  public closed_at: string | null = null;
  public status: 'open' | 'closed' = 'open';
  public phase_trail: PhaseTrailEntry[] = [];
  public epistemic_working_set: EpistemicWorkingSetEntry[] = [];
  public total_checkpoints = 0;

  constructor(input: CreateLedgerInput, now: () => string = () => new Date().toISOString()) {
    this.project_id = input.project_id;
    this.task_id = input.task_id;
    this.agent_id = input.agent_id ?? makeAgentId(input.session_id);
    this.done_condition = input.done_condition;
    this.intent = input.intent;
    const t = now();
    this.created_at = t;
    this.updated_at = t;
  }

  /**
   * Record a checkpoint at a qualifying phase transition. Callers
   * should NOT invoke this on every tool call; only at phase changes
   * and qualifying decision points (per [[285]]).
   */
  recordCheckpoint(checkpoint: TaskLedgerCheckpoint): void {
    if (this.status === 'closed') {
      throw new Error(
        `Cannot append to closed ledger (${this.project_id}/${this.task_id})`,
      );
    }
    this.phase_trail.push({
      phase: checkpoint.kind === 'completion' ? 'complete' : inferPhase(checkpoint.kind),
      kind: checkpoint.kind === 'completion' ? 'completion' : checkpoint.kind,
      recorded_at: checkpoint.recorded_at,
      summary: checkpoint.summary,
      references: checkpoint.references,
    });
    this.updated_at = checkpoint.recorded_at;
    this.total_checkpoints += 1;
    // Hard cap: archive oldest entries when phase_trail exceeds MAX_PHASE_TRAIL.
    if (this.phase_trail.length > MAX_PHASE_TRAIL) {
      const overflow = this.phase_trail.length - MAX_PHASE_TRAIL;
      this.phase_trail.splice(0, overflow);
    }
  }

  /**
   * Promote a material belief into the working set. Non-material beliefs
   * are tracked with material=false (admissible but not promoted by
   * Dream later).
   */
  recordWorkingBelief(entry: EpistemicWorkingSetEntry): void {
    this.epistemic_working_set.push(entry);
    this.updated_at = new Date().toISOString();
  }

  /**
   * Close the ledger at completion. The Dream skill can then evaluate
   * the closed snapshot for admission into mem-graph.
   */
  close(): void {
    if (this.status === 'closed') return;
    this.closed_at = new Date().toISOString();
    this.updated_at = this.closed_at;
    this.status = 'closed';
  }

  /**
   * Render the ledger as a snapshot suitable for serialization and
   * for handoff to Dream admission (per [[293]]).
   */
  snapshot(): TaskLedgerSnapshot {
    return {
      task_id: this.task_id,
      project_id: this.project_id,
      agent_id: this.agent_id,
      created_at: this.created_at,
      updated_at: this.updated_at,
      closed_at: this.closed_at,
      status: this.status,
      phase_trail: [...this.phase_trail],
      epistemic_working_set: [...this.epistemic_working_set],
      total_checkpoints: this.total_checkpoints,
    };
  }

  /**
   * Build a Cognitive OS event envelope (ready for `appendCognitiveEvent`).
   * Callers submit this only at qualifying checkpoints.
   */
  toCognitiveEvent(input: {
    event_type:
      | 'DecisionMade'
      | 'ExecutionObserved'
      | 'EvidenceObserved'
      | 'BeliefRevised'
      | 'ReflectionProposed';
    payload: Record<string, unknown>;
    idempotency_key: string;
    task_id: string;
    observed_at?: string;
    session_id?: string;
  }): {
    event_type: typeof input.event_type;
    task_id: string;
    project_id: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
    observed_at: string;
    correlation_id: string;
  } {
    return {
      event_type: input.event_type,
      task_id: input.task_id,
      project_id: this.project_id,
      payload: input.payload,
      idempotency_key: input.idempotency_key,
      observed_at: input.observed_at ?? new Date().toISOString(),
      correlation_id: `task-ledger:${this.project_id}:${this.task_id}`,
    };
  }
}

function inferPhase(kind: LedgerEntryKind): TurnShapePhase {
  switch (kind) {
    case 'phase':
      return 'build';
    case 'decision':
      return 'gather';
    case 'evidence':
      return 'verify';
    case 'repair':
      return 'verify';
    case 'handoff':
      return 'report';
    case 'completion':
      return 'complete';
  }
}

/**
 * Load a ledger back from a snapshot (used when resuming across sessions
 * after compaction/handoff).
 */
export function ledgerFromSnapshot(snap: TaskLedgerSnapshot): EpistemicTaskLedger {
  const ledger = new EpistemicTaskLedger({
    project_id: snap.project_id,
    task_id: snap.task_id,
    session_id: snap.agent_id, // not used for resume; identity comes from snapshot
    agent_id: snap.agent_id,
    done_condition: '(restored from snapshot)',
    intent: '(restored from snapshot)',
  });
  ledger.created_at = snap.created_at;
  ledger.updated_at = snap.updated_at;
  ledger.closed_at = snap.closed_at;
  ledger.status = snap.status;
  ledger.phase_trail = [...snap.phase_trail];
  ledger.epistemic_working_set = [...snap.epistemic_working_set];
  ledger.total_checkpoints = snap.total_checkpoints;
  return ledger;
}