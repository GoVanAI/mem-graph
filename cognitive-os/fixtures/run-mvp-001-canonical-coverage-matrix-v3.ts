/**
 * Replays MVP-001's frozen coverage matrix against an isolated in-memory
 * fixture. It never opens the live mem-graph database.
 *
 * Run: npx tsx cognitive-os/fixtures/run-mvp-001-canonical-coverage-matrix-v3.ts --write
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInMemoryDb } from '../../tests/helpers.js';
import { searchCurrentGuidance } from '../../src/cognitive/retrieval.js';

type Entry = {
  id: number; project_id: string; layer: string; lifecycle: string; category: string;
  title: string; summary: string; content: string;
};
type MatrixRow = {
  row_id: number; scope: string; includes_global: boolean; limit: number; result_limit_2: number;
  test_type: 'positive_coverage' | 'alternate_owner'; query: string; expected_target_ids: number[];
  acceptable_ids_above_target: number[]; max_acceptable_target_rank: number;
  forbidden_result_ids?: number[];
};
type Fixture = { entries: Entry[]; treatment: { patches: Array<{id: number; append_content: string}> } };

const root = resolve(import.meta.dirname, '..', '..');
const matrixPath = resolve(import.meta.dirname, 'mvp-001-canonical-coverage-matrix-v3.json');
const fixturePath = resolve(import.meta.dirname, 'mvp-001-canonical-coverage-fixture-v1.json');
const outputPath = resolve(import.meta.dirname, 'mvp-001-canonical-coverage-matrix-v3-controlled-runs-v2.json');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as { matrix_version: string; rows: MatrixRow[] };
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createFixture(treatment: boolean) {
  const db = createInMemoryDb();
  const patched = new Map(fixture.treatment.patches.map((patch) => [patch.id, patch.append_content]));
  const insert = db.prepare(`INSERT INTO memories
    (id, title, slug, content, project_id, category, layer, lifecycle, status, confidence, source, importance_score, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1.0, 'manual', 1.0, ?)`);
  for (const entry of fixture.entries) {
    insert.run(
      entry.id, entry.title, `fixture-${entry.id}`,
      entry.content + (treatment ? (patched.get(entry.id) ?? '') : ''),
      entry.project_id, entry.category, entry.layer, entry.lifecycle, entry.summary,
    );
  }
  return db;
}

function evaluate(row: MatrixRow, ids: number[]) {
  const targetIndex = ids.findIndex((id) => row.expected_target_ids.includes(id));
  const targetRank = targetIndex < 0 ? null : targetIndex + 1;
  const aboveTargetIds = targetIndex < 0 ? [] : ids.slice(0, targetIndex);
  const unexpectedAboveTargetIds = aboveTargetIds.filter(
    (id) => !row.acceptable_ids_above_target.includes(id),
  );
  const forbiddenResultIds = (row.forbidden_result_ids ?? []).filter((id) => ids.includes(id));
  const targetPresent = targetIndex >= 0;
  const rankAcceptable = targetRank !== null && targetRank <= row.max_acceptable_target_rank;
  const pass = row.test_type === 'positive_coverage'
    ? targetPresent && rankAcceptable && unexpectedAboveTargetIds.length === 0
    : targetPresent && rankAcceptable && forbiddenResultIds.length === 0;
  const classification = pass
    ? 'PASS'
    : !targetPresent
      ? 'COVERAGE_FAIL'
      : 'RANK_OR_CONTAMINATION_FAIL';
  return {
    classification, target_present: targetPresent, target_rank: targetRank,
    result_ids: ids, above_target_ids: aboveTargetIds,
    unexpected_above_target_ids: unexpectedAboveTargetIds,
    forbidden_result_ids_present: forbiddenResultIds,
  };
}

function runOnce(treatment: boolean) {
  const db = createFixture(treatment);
  const rows: Record<string, ReturnType<typeof evaluate> & { diagnostic_result_ids: number[] }> = {};
  for (const row of matrix.rows) {
    const input = { query: row.query, project_id: row.scope, include_global: row.includes_global, limit: row.limit };
    const resultIds = searchCurrentGuidance(db, input).map((result) => result.id);
    const diagnosticIds = searchCurrentGuidance(db, { ...input, limit: row.result_limit_2 }).map((result) => result.id);
    rows[String(row.row_id)] = { ...evaluate(row, resultIds), diagnostic_result_ids: diagnosticIds };
  }
  db.close();
  return rows;
}

function countClassifications(rows: Record<string, {classification: string}>) {
  return Object.values(rows).reduce<Record<string, number>>((counts, row) => {
    counts[row.classification] = (counts[row.classification] ?? 0) + 1;
    return counts;
  }, {});
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deltaRows(
  baseline: Record<string, ReturnType<typeof evaluate> & {diagnostic_result_ids: number[]}>,
  treatment: Record<string, ReturnType<typeof evaluate> & {diagnostic_result_ids: number[]}>,
) {
  return matrix.rows.map((row) => {
    const before = baseline[String(row.row_id)];
    const after = treatment[String(row.row_id)];
    return {
      row_id: row.row_id,
      changed: !stableEqual(before.result_ids, after.result_ids) || before.classification !== after.classification,
      baseline_classification: before.classification,
      treatment_classification: after.classification,
      baseline_target_rank: before.target_rank,
      treatment_target_rank: after.target_rank,
      baseline_unexpected_above_target_ids: before.unexpected_above_target_ids,
      treatment_unexpected_above_target_ids: after.unexpected_above_target_ids,
    };
  });
}

const baselineRun1 = runOnce(false);
const baselineRun2 = runOnce(false);
const treatmentRun1 = runOnce(true);
const treatmentRun2 = runOnce(true);
const deltas = deltaRows(baselineRun1, treatmentRun1);
const artifact = {
  artifact_type: 'controlled_fixture_run_results',
  artifact_version: 'v2',
  matrix_version: matrix.matrix_version,
  matrix_artifact_path: 'cognitive-os/fixtures/mvp-001-canonical-coverage-matrix-v3.json',
  fixture_artifact_path: 'cognitive-os/fixtures/mvp-001-canonical-coverage-fixture-v1.json',
  harness_artifact_path: 'cognitive-os/fixtures/run-mvp-001-canonical-coverage-matrix-v3.ts',
  generated_at: '2026-08-04T18:10:00Z',
  provenance: {
    execution_mode: 'isolated in-memory SQLite fixture',
    live_database_access: false,
    live_canonical_node_mutation: false,
    treatment_authority: 'controlled fixture only; production alias application remains unauthorized',
    fixture_input_sha256: { baseline: sha256(fixture.entries), treatment: sha256({entries: fixture.entries, patches: fixture.treatment.patches}) },
    matrix_sha256: sha256(matrix),
  },
  baseline: {
    run_1: baselineRun1, run_2: baselineRun2,
    deterministic: stableEqual(baselineRun1, baselineRun2),
    classification_counts: countClassifications(baselineRun1),
  },
  treatment: {
    run_1: treatmentRun1, run_2: treatmentRun2,
    deterministic: stableEqual(treatmentRun1, treatmentRun2),
    classification_counts: countClassifications(treatmentRun1),
  },
  baseline_to_treatment: {
    changed_row_ids: deltas.filter((row) => row.changed).map((row) => row.row_id),
    rows: deltas,
  },
};

if (process.argv.includes('--write')) {
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${outputPath}\n`);
} else {
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

if (!artifact.baseline.deterministic || !artifact.treatment.deterministic) {
  process.exitCode = 1;
}
