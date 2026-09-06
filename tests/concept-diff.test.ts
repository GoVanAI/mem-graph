/**
 * Tests for the concept-diff capability.
 *
 * Verifies the structured diff between two as_of timestamps for an
 * epistemic record. The capability is read-only (no DB writes); tests
 * use a real in-memory SQLite via the existing initDatabase helper.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllDatabases, getDatabase, initDatabase } from '../src/db.js';
import { conceptDiff } from '../src/cognitive/concept-diff/concept-diff.js';
import { admitEpistemicRecord } from '../src/epistemic/persistence.js';

let tmpDir: string;
let originalDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'concept-diff-'));
  originalDir = process.env.MEM_GRAPH_DIR;
  process.env.MEM_GRAPH_DIR = tmpDir;
  initDatabase('memory');
});

afterEach(() => {
  closeAllDatabases();
  if (tmpDir && tmpDir.length > 0) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (originalDir === undefined) {
    delete process.env.MEM_GRAPH_DIR;
  } else {
    process.env.MEM_GRAPH_DIR = originalDir;
  }
});

function admit(
  idempotencyKey: string,
  statement: string,
  confidence: number,
  validFrom: string,
  taskId = 't',
) {
  return admitEpistemicRecord(getDatabase('memory'), {
    idempotency_key: idempotencyKey,
    project_id: 'cognitive-os',
    scope: 'exact-project',
    statement,
    epistemic_status: 'inferred',
    verification_level: 'direct',
    source_quality: 'observed',
    confidence,
    valid_from: validFrom,
    task_id: taskId,
  });
}

describe('conceptDiff — record-level classification', () => {
  it('returns added when record did not exist at from_as_of but exists at to_as_of', () => {
    const admitted = admit('cd-1', 'initial', 0.5, '2026-08-01T00:00:00.000Z');
    const result = conceptDiff(
      getDatabase('memory'),
      admitted.record_id,
      '2026-07-01T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
    );
    expect(result.record_change).toBe('added');
    expect(result.from_state).toBeNull();
    expect(result.to_state).not.toBeNull();
    expect(result.revision_delta).toEqual({ from_revision: null, to_revision: 1 });
  });

  it('returns unchanged (no field diffs) when record exists at both timestamps with identical fields', () => {
    const admitted = admit('cd-2', 'stable', 0.5, '2026-07-01T00:00:00.000Z');
    const result = conceptDiff(
      getDatabase('memory'),
      admitted.record_id,
      '2026-07-15T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
    );
    expect(result.record_change).toBe('changed'); // both states exist
    expect(result.changes.filter((c) => c.change_type !== 'unchanged')).toEqual([]);
    expect(result.revision_delta).toEqual({ from_revision: 1, to_revision: 1 });
  });

  it('detects a field change when the record is revised between cutoffs', () => {
    const db = getDatabase('memory');
    const v1 = admit('cd-3-v1', 'initial statement', 0.5, '2026-07-01T00:00:00.000Z');
    // Revise with the real previous_revision_id from v1
    admitEpistemicRecord(db, {
      idempotency_key: 'cd-3-v2',
      record_id: v1.record_id,
      expected_revision: 1,
      previous_revision_id: v1.revision_id,
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'revised statement',
      epistemic_status: 'corroborated',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.8,
      valid_from: '2026-08-01T00:00:00.000Z',
      task_id: 't',
    });
    const result = conceptDiff(
      db,
      v1.record_id,
      '2026-07-15T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
    );
    expect(result.record_change).toBe('changed');
    expect(result.revision_delta).toEqual({ from_revision: 1, to_revision: 2 });
    // Statement should be reported as changed
    const stmtChange = result.changes.find((c) => c.field === 'statement');
    expect(stmtChange?.change_type).toBe('changed');
    expect(stmtChange?.before).toBe('initial statement');
    expect(stmtChange?.after).toBe('revised statement');
    // Confidence should also be reported as changed
    const confChange = result.changes.find((c) => c.field === 'confidence');
    expect(confChange?.change_type).toBe('changed');
    expect(confChange?.before).toBe(0.5);
    expect(confChange?.after).toBe(0.8);
  });
});

describe('conceptDiff — retraction handling (Sol H1)', () => {
  it('treats a record whose current status is retracted as removed from to-state by default', () => {
    const db = getDatabase('memory');
    const admitted = admit('cd-4', 'will be retracted', 0.5, '2026-07-01T00:00:00.000Z');
    // Retract by admitting a new revision with epistemic_status='retracted'
    // and valid_from at a later time. This represents the retraction event.
    admitEpistemicRecord(db, {
      idempotency_key: 'cd-4-retract',
      record_id: admitted.record_id,
      expected_revision: 1,
      previous_revision_id: admitted.revision_id,
      project_id: 'cognitive-os',
      scope: 'exact-project',
      statement: 'will be retracted',
      epistemic_status: 'retracted',
      verification_level: 'direct',
      source_quality: 'observed',
      confidence: 0.5,
      valid_from: '2026-08-01T00:00:00.000Z',
      task_id: 't',
    });
    // Query after the retraction: includeRetracted=false (default) should
    // hide the retracted content from the to-state.
    const result = conceptDiff(
      db,
      admitted.record_id,
      '2026-07-15T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
    );
    // Without includeRetracted, the retracted content is hidden.
    expect(result.to_state).toBeNull();
    expect(result.record_change).toBe('removed');

    // With includeRetracted=true, the content is surfaced.
    const result2 = conceptDiff(
      db,
      admitted.record_id,
      '2026-07-15T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
      { includeRetracted: true },
    );
    expect(result2.to_state).not.toBeNull();
    expect(result2.to_state?.epistemic_status).toBe('retracted');
  });
});

describe('conceptDiff — includeUnchanged option', () => {
  it('omits unchanged fields by default', () => {
    const admitted = admit('cd-5', 'stable', 0.5, '2026-07-01T00:00:00.000Z');
    const result = conceptDiff(
      getDatabase('memory'),
      admitted.record_id,
      '2026-07-15T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
    );
    expect(result.changes.every((c) => c.change_type !== 'unchanged')).toBe(true);
  });

  it('includes unchanged fields when includeUnchanged is true', () => {
    const admitted = admit('cd-6', 'stable', 0.5, '2026-07-01T00:00:00.000Z');
    const result = conceptDiff(
      getDatabase('memory'),
      admitted.record_id,
      '2026-07-15T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
      { includeUnchanged: true },
    );
    expect(result.changes.some((c) => c.change_type === 'unchanged')).toBe(true);
  });
});
