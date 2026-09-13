import type Database from 'better-sqlite3';

export type ActPhase = 'intake' | 'pivot' | 'close';

export interface ActAxiomPayload {
  objective: string;
  grounded_paths?: string[];
  refused_inferences?: string[];
  oracle_command?: string;
  oracle_exit_code?: number;
}

export interface ActCascadePayload {
  direct_dependents?: string[];
  system_invariants?: string[];
  adversarial_risk?: string;
}

export interface ActTracePayload {
  phase: ActPhase;
  terminal_evidence?: string;
  git_commit_sha?: string;
  test_output_summary?: string;
}

export interface ActLedgerRecord {
  project_id: string;
  task_id: string;
  agent_id?: string;
  axiom: ActAxiomPayload;
  cascade: ActCascadePayload;
  trace: ActTracePayload;
}

export interface ActCheckpointResult {
  id: number;
  phase: ActPhase;
  title: string;
  status: 'active' | 'archived';
  changes: number;
}

/**
 * Format standard title and slug for an ACT task ledger node.
 */
export function formatActLedgerIdentity(projectId: string, taskId: string, agentId = 'agy-mem-graph') {
  return {
    title: `ACT Ledger :: ${projectId} :: ${agentId} :: ${taskId}`,
    slug: `act-ledger-${projectId}-${taskId}`.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
  };
}

/**
 * Mint or checkpoint an ACT Task Ledger in the SQLite substrate at a phase boundary.
 */
export function checkpointActLedger(
  db: Database.Database,
  input: ActLedgerRecord,
  existingId?: number,
): ActCheckpointResult {
  const { title, slug } = formatActLedgerIdentity(input.project_id, input.task_id, input.agent_id);
  const isClose = input.trace.phase === 'close';
  const status = isClose ? 'archived' : 'active';
  const summary = `ACT [${input.trace.phase.toUpperCase()}] :: ${input.axiom.objective}`;
  const content = JSON.stringify(
    {
      act_ledger: {
        task_id: input.task_id,
        project_id: input.project_id,
        agent_id: input.agent_id ?? 'agy-mem-graph',
        phase: input.trace.phase,
        axiom: input.axiom,
        cascade: input.cascade,
        trace: input.trace,
      },
    },
    null,
    2,
  );

  const tags = JSON.stringify([
    'task-ledger',
    'act',
    input.project_id,
    input.task_id,
    `phase-${input.trace.phase}`,
  ]);

  if (existingId) {
    const stmt = db.prepare(`
      UPDATE memories
      SET summary = ?,
          content = ?,
          status = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    const result = stmt.run(summary, content, status, existingId);
    return {
      id: existingId,
      phase: input.trace.phase,
      title,
      status,
      changes: result.changes,
    };
  }

  const insertStmt = db.prepare(`
    INSERT INTO memories (
      project_id, layer, category, title, slug, summary, content,
      confidence, importance_score, lifecycle, status, created_at, updated_at
    ) VALUES (
      ?, 'working', 'task_ledger', ?, ?, ?, ?,
      1.0, 1.0, 'ephemeral', ?, datetime('now'), datetime('now')
    )
  `);

  const info = insertStmt.run(
    input.project_id,
    title,
    slug,
    summary,
    content,
    status,
  );

  const newId = Number(info.lastInsertRowid);

  return {
    id: newId,
    phase: input.trace.phase,
    title,
    status,
    changes: 1,
  };
}
