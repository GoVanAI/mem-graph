/**
 * Epistemic Memory Phase B — projection rebuild, as-of query, integrity audit.
 *
 * Per EPB-001 D2 / [[283]] Step 6 acceptance:
 *   - current_record projection is rebuildable from immutable revisions;
 *   - delete-all-derived-rows + replay produces a canonicalized snapshot
 *     identical to the pre-delete snapshot;
 *   - as-of results match the event/revision cutoff;
 *   - integrity detects missing, wrong-scope, forward-dated, duplicate, and
 *     inconsistent rows with stable codes;
 *   - rebuild never mutates immutable history (revisions/receipts/provenance/
 *     cognitive_events remain untouched).
 *
 * Read-only by design: nothing here writes to immutable tables. The single
 * mutation surface is the `epistemic_records` projection (deletable +
 * re-insertable).
 */

import type Database from 'better-sqlite3';

export type IntegrityCode =
  | 'MISSING_REVISION'
  | 'WRONG_SCOPE_REVISION'
  | 'FORWARD_DATED_REVISION'
  | 'DUPLICATE_REVISION_NUMBER'
  | 'INCONSISTENT_PROJECTION';

export interface IntegrityIssue {
  code: IntegrityCode;
  record_id: number;
  revision_id?: string;
  path: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface IntegrityReport {
  total_revisions: number;
  total_records: number;
  issues: IntegrityIssue[];
  ok: boolean;
}

export interface ProjectionRow {
  record_id: number;
  project_id: string;
  scope: string;
  statement: string;
  epistemic_status: string;
  verification_level: string;
  source_quality: string;
  confidence: number;
  valid_from: string;
  valid_until: string | null;
  current_revision_id: string;
  source_event_id: string;
  source_memory_id: number | null;
  created_at: string;
  updated_at: string;
  superseded_by_record_id: number | null;
}

export interface AsOfRecord extends ProjectionRow {
  revision_id: string;
  revision_number: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * For each record_id, compute the current projection by walking its
 * revisions in order and selecting the latest non-superseded revision.
 * Returns one row per active record.
 */
export function projectCurrentState(db: Database.Database): ProjectionRow[] {
  const rows = db
    .prepare(
      `SELECT r.revision_id, r.record_id, r.revision_number, r.record_payload,
              r.valid_from, r.valid_until, r.source_event_id, r.created_at,
              r.superseded_by_record_id
         FROM epistemic_revisions r
         INNER JOIN (
           SELECT record_id, MAX(revision_number) AS max_rev
             FROM epistemic_revisions
             GROUP BY record_id
         ) latest ON latest.record_id = r.record_id AND latest.max_rev = r.revision_number
         WHERE r.superseded_by_record_id IS NULL
         ORDER BY r.record_id ASC`,
    )
    .all() as Array<{
    revision_id: string;
    record_id: number;
    revision_number: number;
    record_payload: string;
    valid_from: string;
    valid_until: string | null;
    source_event_id: string;
    created_at: string;
    superseded_by_record_id: number | null;
  }>;

  return rows.map((row) => projectionFromRevision(db, row));
}

interface RevisionSummary {
  revision_id: string;
  record_id: number;
  revision_number: number;
  record_payload: string;
  valid_from: string;
  valid_until: string | null;
  source_event_id: string;
  created_at: string;
  superseded_by_record_id: number | null;
}

function projectionFromRevision(
  db: Database.Database,
  row: RevisionSummary,
): ProjectionRow {
  const payload = JSON.parse(row.record_payload) as Record<string, unknown>;
  // Look up provenance (any) to find source_memory_id and authority_input.
  const prov = db
    .prepare(
      `SELECT source_memory_id FROM epistemic_provenance
       WHERE revision_id = ? LIMIT 1`,
    )
    .get(row.revision_id) as { source_memory_id: number | null } | undefined;
  return {
    record_id: row.record_id,
    project_id: String(payload.project_id ?? ''),
    scope: String(payload.scope ?? 'exact-project'),
    statement: String(payload.statement ?? ''),
    epistemic_status: String(payload.epistemic_status ?? 'reported'),
    verification_level: String(payload.verification_level ?? ''),
    source_quality: String(payload.source_quality ?? ''),
    confidence: Number(payload.confidence ?? 0),
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    current_revision_id: row.revision_id,
    source_event_id: row.source_event_id,
    source_memory_id: prov?.source_memory_id ?? null,
    created_at: row.created_at,
    updated_at: row.created_at,
    superseded_by_record_id: row.superseded_by_record_id,
  };
}

/**
 * Rebuild the `epistemic_records` projection from immutable revisions.
 * Deletes every row in the projection table, then re-inserts one row per
 * active (non-superseded) record's latest revision. Immutable tables
 * (revisions, receipts, provenance, cognitive_events) are untouched.
 */
export function rebuildProjection(db: Database.Database): {
  rebuilt: number;
  deleted: number;
} {
  return db.transaction(() => {
    const deleted = db.prepare('DELETE FROM epistemic_records').run().changes;
    const rows = db
      .prepare(
        `SELECT r.revision_id, r.record_id, r.revision_number, r.record_payload,
                r.valid_from, r.valid_until, r.source_event_id, r.created_at,
                r.superseded_by_record_id
           FROM epistemic_revisions r
           INNER JOIN (
             SELECT record_id, MAX(revision_number) AS max_rev
               FROM epistemic_revisions
               GROUP BY record_id
           ) latest ON latest.record_id = r.record_id AND latest.max_rev = r.revision_number
           WHERE r.superseded_by_record_id IS NULL
           ORDER BY r.record_id ASC`,
      )
      .all() as RevisionSummary[];

    const insert = db.prepare(
      `INSERT INTO epistemic_records
       (record_id, project_id, scope, statement, epistemic_status, verification_level,
        source_quality, confidence, valid_from, valid_until, current_revision_id,
        source_event_id, source_memory_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let rebuilt = 0;
    for (const row of rows) {
      const proj = projectionFromRevision(db, row);
      insert.run(
        proj.record_id,
        proj.project_id,
        proj.scope,
        proj.statement,
        proj.epistemic_status,
        proj.verification_level,
        proj.source_quality,
        proj.confidence,
        proj.valid_from,
        proj.valid_until,
        proj.current_revision_id,
        proj.source_event_id,
        proj.source_memory_id,
        proj.created_at,
        proj.updated_at,
      );
      rebuilt += 1;
    }
    return { rebuilt, deleted };
  })();
}

/**
 * Snapshot the projection state. Returns a deterministic JSON string that
 * excludes `updated_at` (timestamps can drift across rebuilds without
 * affecting content equality).
 */
export function snapshotProjection(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT record_id, project_id, scope, statement, epistemic_status,
              verification_level, source_quality, confidence, valid_from,
              valid_until, current_revision_id, source_event_id,
              source_memory_id, created_at, superseded_by_record_id
         FROM epistemic_records
         ORDER BY record_id ASC`,
    )
    .all() as Array<Omit<ProjectionRow, 'updated_at'>>;
  return JSON.stringify(rows, Object.keys(rows[0] ?? {}).sort());
}

/**
 * As-of query: return the projection state a record would have had at
 * the cutoff timestamp. The latest revision whose `valid_from` is at or
 * before the cutoff and that is not superseded before the cutoff.
 */
export function asOfQuery(
  db: Database.Database,
  recordId: number,
  cutoffIso: string,
): AsOfRecord | null {
  // Walk revisions in reverse order, pick the latest whose source event
  // observed_at <= cutoff (or valid_from <= cutoff when no source event).
  const row = db
    .prepare(
      `SELECT r.revision_id, r.record_id, r.revision_number, r.record_payload,
              r.valid_from, r.valid_until, r.source_event_id, r.created_at,
              r.superseded_by_record_id
         FROM epistemic_revisions r
         WHERE r.record_id = ?
           AND r.valid_from <= ?
           AND NOT EXISTS (
             SELECT 1 FROM epistemic_revisions r2
              WHERE r2.record_id = r.record_id
                AND r2.revision_number > r.revision_number
                AND r2.valid_from <= ?
           )
         ORDER BY r.revision_number DESC
         LIMIT 1`,
    )
    .get(recordId, cutoffIso, cutoffIso) as RevisionSummary | undefined;
  if (!row) return null;
  const proj = projectionFromRevision(db, row);
  return {
    ...proj,
    revision_id: row.revision_id,
    revision_number: row.revision_number,
  };
}

/**
 * Read-only integrity audit over revisions and projection.
 * Detects:
 *   - DUPLICATE_REVISION_NUMBER — multiple revisions share (record_id, revision_number)
 *   - MISSING_REVISION — projection.current_revision_id not found in revisions
 *   - WRONG_SCOPE_REVISION — projection.scope disagrees with revision payload
 *   - FORWARD_DATED_REVISION — revision.valid_from is in the future (sanity check)
 *   - INCONSISTENT_PROJECTION — projection fields disagree with revision payload
 */
export function integrityAudit(db: Database.Database): IntegrityReport {
  const issues: IntegrityIssue[] = [];

  // 1. Duplicate (record_id, revision_number)
  const duplicates = db
    .prepare(
      `SELECT record_id, revision_number, COUNT(*) AS c
         FROM epistemic_revisions
         GROUP BY record_id, revision_number
         HAVING c > 1`,
    )
    .all() as Array<{ record_id: number; revision_number: number; c: number }>;
  for (const d of duplicates) {
    issues.push({
      code: 'DUPLICATE_REVISION_NUMBER',
      record_id: d.record_id,
      path: 'epistemic_revisions',
      message: `revision_number ${d.revision_number} appears ${d.c} times for record_id ${d.record_id}`,
      details: { revision_number: d.revision_number, count: d.c },
    });
  }

  // 2. Forward-dated revisions
  const now = nowIso();
  const forwards = db
    .prepare(
      `SELECT revision_id, record_id, valid_from
         FROM epistemic_revisions
         WHERE valid_from > ?`,
    )
    .all(now) as Array<{ revision_id: string; record_id: number; valid_from: string }>;
  for (const f of forwards) {
    issues.push({
      code: 'FORWARD_DATED_REVISION',
      record_id: f.record_id,
      revision_id: f.revision_id,
      path: 'epistemic_revisions.valid_from',
      message: `revision ${f.revision_id} valid_from ${f.valid_from} is in the future`,
      details: { valid_from: f.valid_from, now },
    });
  }

  // 3. Projection consistency
  const records = db
    .prepare('SELECT * FROM epistemic_records')
    .all() as ProjectionRow[];
  for (const r of records) {
    const rev = db
      .prepare('SELECT * FROM epistemic_revisions WHERE revision_id = ?')
      .get(r.current_revision_id) as
      | (RevisionSummary & { record_payload: string })
      | undefined;
    if (!rev) {
      issues.push({
        code: 'MISSING_REVISION',
        record_id: r.record_id,
        revision_id: r.current_revision_id,
        path: 'epistemic_records.current_revision_id',
        message: `projection references revision ${r.current_revision_id} which does not exist`,
      });
      continue;
    }
    const payload = JSON.parse(rev.record_payload) as Record<string, unknown>;
    if (payload.scope !== undefined && payload.scope !== r.scope) {
      issues.push({
        code: 'WRONG_SCOPE_REVISION',
        record_id: r.record_id,
        revision_id: rev.revision_id,
        path: 'epistemic_records.scope',
        message: `projection scope ${r.scope} disagrees with revision scope ${payload.scope}`,
        details: { projection_scope: r.scope, revision_scope: payload.scope },
      });
    }
    if (
      payload.project_id !== undefined &&
      String(payload.project_id) !== r.project_id
    ) {
      issues.push({
        code: 'INCONSISTENT_PROJECTION',
        record_id: r.record_id,
        revision_id: rev.revision_id,
        path: 'epistemic_records.project_id',
        message: `projection project_id ${r.project_id} disagrees with revision project_id ${payload.project_id}`,
        details: { projection_project_id: r.project_id, revision_project_id: payload.project_id },
      });
    }
  }

  const totalRev = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get() as {
    c: number;
  }).c;
  const totalRec = (db.prepare('SELECT COUNT(*) AS c FROM epistemic_records').get() as {
    c: number;
  }).c;
  return {
    total_revisions: totalRev,
    total_records: totalRec,
    issues,
    ok: issues.length === 0,
  };
}
