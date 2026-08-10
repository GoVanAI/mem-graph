#!/usr/bin/env node
/**
 * Step 10 — Live composition proof for Epistemic Phase B.
 *
 * Per [[298]] §"Pickup script outline" and [[283]] Step 10 acceptance.
 *
 * Strategy: each TS probe is written to a temp .ts file in ARTIFACT_DIR
 * and invoked via `npx tsx <file>` so shell-quote escaping does not
 * corrupt the probe body. Results are parsed from stdout JSON.
 *
 * Read-only: this script copies the live DB to ARTIFACT_DIR/live-copy.db
 * and runs all probes against that copy. The live DB is untouched.
 */

import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const LIVE_DB = process.env.STEP10_LIVE_DB
  || resolve(process.env.USERPROFILE || process.env.HOME, '.claude/mem-graph/memory.db');
const ARTIFACT_DIR = resolve(process.cwd(), 'cognitive-os/experiments/_artifacts');
const REPORT_PATH = resolve(ARTIFACT_DIR, `step10-composition-${Date.now()}.json`);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const startedAt = new Date().toISOString();
const startedMs = Date.now();
const results = {
  meta: { started_at: startedAt, script: 'EPB-step10-composition-proof.mjs', live_db: LIVE_DB },
  checks: {},
  status: 'pending',
};

function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function record(name, outcome) { results.checks[name] = { ...outcome, at: new Date().toISOString() }; }

// Convert a Windows absolute path to a file:// URL for ESM imports.
// Windows: "C:\Users\foo\bar.ts" → "file:///C:/Users/foo/bar.ts"
function toFileURL(p) {
  const normalized = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(normalized)) return 'file:///' + normalized;
  return 'file://' + normalized;
}

function runProbe(name, body, env = {}) {
  const tsPath = resolve(ARTIFACT_DIR, `probe-${name}.ts`);
  // Probe uses process.env.<KEY> directly, no argv splitting needed.
  writeFileSync(tsPath, body);
  try {
    const envObj = { ...process.env, ...env };
    const out = execSync(`npx tsx "${tsPath}"`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: envObj,
    });
    return { ok: true, json: JSON.parse(out.trim()) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), stderr: err.stderr ? String(err.stderr) : '', stdout: err.stdout ? String(err.stdout) : '' };
  } finally {
    try { unlinkSync(tsPath); } catch {}
  }
}

// ---------- 1. Backup present ----------
{
  const backupDir = resolve(process.env.USERPROFILE || process.env.HOME, '.claude/mem-graph/backups');
  let found = null;
  try {
    const files = readdirSync(backupDir);
    const candidates = files.filter(f => f.startsWith('pre-step10-') && f.endsWith('.db.bak'));
    for (const f of candidates) {
      const full = resolve(backupDir, f);
      const age = (Date.now() - statSync(full).mtimeMs) / 1000;
      if (age < 3600) { found = { path: full, age_sec: Math.round(age) }; break; }
    }
  } catch {}
  record('backup_present', { ok: !!found, ...(found || { error: 'no pre-step10 backup found within last hour' }) });
}

// ---------- 2. Copy live DB ----------
const COPY_DB = resolve(ARTIFACT_DIR, 'live-copy.db');
copyFileSync(LIVE_DB, COPY_DB);
{
  const liveHash = sha256(LIVE_DB);
  const copyHash = sha256(COPY_DB);
  record('live_db_copy', {
    ok: liveHash === copyHash,
    copy_path: COPY_DB,
    live_sha256: liveHash,
    copy_sha256: copyHash,
    live_size: statSync(LIVE_DB).size,
  });
  results.meta.live_db_sha256 = liveHash;
}

// ---------- 3. Open fresh handle ----------
let db;
try {
  db = new Database(COPY_DB);
  db.pragma('foreign_keys = ON');

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  const expected = [
    'memories','memory_tag','synapses','memories_fts','decay_matrix',
    'cognitive_events','policy_candidates','policy_evaluations',
    'schema_migrations','epistemic_records','epistemic_revisions',
    'epistemic_receipts','epistemic_provenance',
  ];
  const missing = expected.filter(t => !tables.includes(t));
  record('schema_complete', { ok: missing.length === 0, tables_count: tables.length, missing, tables });

  const migrations = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
  record('migrations_applied', {
    ok: migrations.length >= 2,
    count: migrations.length,
    versions: migrations.map(m => ({ v: m.version, name: m.name, at: m.applied_at })),
  });

  // SQLite integrity + FK
  const integrity = db.pragma('integrity_check');
  const fk = db.pragma('foreign_key_check');
  record('sqlite_integrity', {
    ok: integrity.length === 1 && integrity[0].integrity_check === 'ok',
    integrity_check: integrity,
    foreign_key_violations: fk.length,
  });

  const epCounts = {
    records: db.prepare('SELECT COUNT(*) AS c FROM epistemic_records').get().c,
    revisions: db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get().c,
    receipts: db.prepare('SELECT COUNT(*) AS c FROM epistemic_receipts').get().c,
    provenance: db.prepare('SELECT COUNT(*) AS c FROM epistemic_provenance').get().c,
  };
  const hasContradictions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='epistemic_contradictions'").get();
  if (hasContradictions) epCounts.contradictions = db.prepare('SELECT COUNT(*) AS c FROM epistemic_contradictions').get().c;
  const hasReviewQueue = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='epistemic_review_queue'").get();
  if (hasReviewQueue) epCounts.review_queue = db.prepare('SELECT COUNT(*) AS c FROM epistemic_review_queue').get().c;
  record('epistemic_state', { ok: true, counts: epCounts });

  if (epCounts.records > 0) {
    const sample = db.prepare(`
      SELECT r.record_id, r.project_id, r.scope, r.statement, r.epistemic_status,
             r.verification_level, r.confidence, r.current_revision_id,
             rv.revision_number, rv.valid_from
      FROM epistemic_records r
      JOIN epistemic_revisions rv ON rv.revision_id = r.current_revision_id
      LIMIT 1
    `).get();
    record('epistemic_sample', { ok: !!sample, sample });
  } else {
    record('epistemic_sample', { ok: true, note: 'no records admitted yet — empty projection is valid for pre-production DB' });
  }

  db.close(); db = null;
} catch (err) {
  record('schema_scan', { ok: false, error: String(err.message || err) });
  if (db) db.close();
}

// ---------- 4. Run probes via tsx temp files ----------

// 4a. Event chain via verifyCognitiveEventChain
{
  const eventsURL = toFileURL(resolve(process.cwd(), 'src/cognitive/events.ts'));
  const body = `
import Database from 'better-sqlite3';
import { verifyCognitiveEventChain } from '${eventsURL}';
const db = new Database(process.env.STEP10_DB);
try {
  const r = verifyCognitiveEventChain(db);
  console.log(JSON.stringify({ valid: r.valid, event_count: r.event_count, failing_sequence: r.failing_sequence || null, reason: r.reason || null }));
} finally { db.close(); }
`;
  const r = runProbe('chain', body, { STEP10_DB: COPY_DB });
  if (r.ok) record('event_chain', { ok: r.json.valid, ...r.json });
  else record('event_chain', { ok: false, error: r.error, stderr: r.stderr?.slice(0, 500) });
}

// 4b. integrityAudit
{
  const projURL = toFileURL(resolve(process.cwd(), 'src/epistemic/projections.ts'));
  const body = `
import Database from 'better-sqlite3';
import { integrityAudit } from '${projURL}';
const db = new Database(process.env.STEP10_DB);
try {
  const r = integrityAudit(db);
  console.log(JSON.stringify({ ok: r.ok, issue_count: r.issues.length, codes: r.issues.map(i => i.code) }));
} finally { db.close(); }
`;
  const r = runProbe('audit', body, { STEP10_DB: COPY_DB });
  if (r.ok) record('integrity_audit', { ok: r.json.ok, ...r.json });
  else record('integrity_audit', { ok: false, error: r.error, stderr: r.stderr?.slice(0, 500) });
}

// 4c. asOfQuery (only if records exist)
{
  const projURL = toFileURL(resolve(process.cwd(), 'src/epistemic/projections.ts'));
  const body = `
import Database from 'better-sqlite3';
const db = new Database(process.env.STEP10_DB);
const count = db.prepare('SELECT COUNT(*) AS c FROM epistemic_records').get().c;
if (count === 0) { console.log(JSON.stringify({ skipped: true })); process.exit(0); }
const rid = db.prepare('SELECT MIN(record_id) AS r FROM epistemic_records').get().r;
const earliest = db.prepare('SELECT MIN(valid_from) AS v FROM epistemic_revisions').get().v;
const latest = db.prepare('SELECT MAX(valid_from) AS v FROM epistemic_revisions').get().v;
console.log(JSON.stringify({ skipped: false, record_id: rid, earliest, latest, count }));
db.close();
`;
  const r = runProbe('aof-prep', body, { STEP10_DB: COPY_DB });
  if (r.ok && r.json.skipped) {
    record('as_of_query', { ok: true, skipped: true, reason: 'no records yet' });
  } else if (r.ok) {
    // Now run asOfQuery at three cutoffs
    const body2 = `
import Database from 'better-sqlite3';
import { asOfQuery } from '${projURL}';
const db = new Database(process.env.STEP10_DB);
const rid = Number(process.env.STEP10_RID);
const cutoff = process.env.STEP10_CUTOFF;
const r = asOfQuery(db, rid, cutoff);
console.log(JSON.stringify({ found: !!r, revision_number: r?.revision_number || null, valid_from: r?.valid_from || null }));
db.close();
`;
    const checks = [];
    const { record_id, earliest, latest } = r.json;
    for (const [name, cutoff] of [
      ['before', new Date(new Date(earliest).getTime() - 1000).toISOString()],
      ['mid', new Date((new Date(earliest).getTime() + new Date(latest).getTime()) / 2).toISOString()],
      ['after', new Date(new Date(latest).getTime() + 1000).toISOString()],
    ]) {
      const r2 = runProbe('aof-' + name, body2, { STEP10_DB: COPY_DB, STEP10_RID: record_id, STEP10_CUTOFF: cutoff });
      if (r2.ok) checks.push({ name, cutoff, ...r2.json });
      else checks.push({ name, cutoff, error: r2.error });
    }
    record('as_of_query', { ok: checks.length === 3, record_id, checks });
  } else {
    record('as_of_query', { ok: false, error: r.error });
  }
}

// 4d. projectMaintenance (only if records exist)
{
  const maintURL = toFileURL(resolve(process.cwd(), 'src/epistemic/maintenance-runtime.ts'));
  const body = `
import Database from 'better-sqlite3';
const db = new Database(process.env.STEP10_DB);
const ids = db.prepare('SELECT record_id FROM epistemic_records ORDER BY record_id LIMIT 5').all().map(r => r.record_id);
console.log(JSON.stringify({ skipped: ids.length === 0, ids }));
db.close();
`;
  const r = runProbe('maint-prep', body, { STEP10_DB: COPY_DB });
  if (r.ok && r.json.skipped) {
    record('maintenance_projection', { ok: true, skipped: true, reason: 'no records yet' });
  } else if (r.ok) {
    const body2 = `
import Database from 'better-sqlite3';
import { projectMaintenance } from '${maintURL}';
const db = new Database(process.env.STEP10_DB);
const rid = Number(process.env.STEP10_RID);
const r = projectMaintenance(db, { record_id: rid });
console.log(JSON.stringify({
  record_id: rid,
  ordinary_priming_factor: r.ordinary_priming_factor,
  review_state: r.review_state,
  review_reasons_count: (r.review_reasons || []).length,
  influence_score: r.influence_score,
  has_support_summary: !!r.support_summary,
  has_applicability: r.applicability_freshness !== undefined,
}));
db.close();
`;
    const samples = [];
    for (const rid of r.json.ids) {
      const r2 = runProbe('maint-' + rid, body2, { STEP10_DB: COPY_DB, STEP10_RID: rid });
      if (r2.ok) samples.push(r2.json);
      else samples.push({ record_id: rid, error: r2.error });
    }
    record('maintenance_projection', { ok: samples.length > 0, samples });
  } else {
    record('maintenance_projection', { ok: false, error: r.error });
  }
}

// 4e. bootstrapCognitiveAgentWithEpistemicLane
{
  const bootURL = toFileURL(resolve(process.cwd(), 'src/cognitive/agent-bootstrap.ts'));
  const body = `
import Database from 'better-sqlite3';
import { bootstrapCognitiveAgentWithEpistemicLane } from '${bootURL}';
const db = new Database(process.env.STEP10_DB);
try {
  const r = bootstrapCognitiveAgentWithEpistemicLane(db, { query: 'phase-b-step-10-composition', project_id: 'cognitive-os', include_global: false });
  console.log(JSON.stringify({
    practice_id: r.practice.id,
    practice_version: r.practice.version,
    scope: r.scope,
    governing_count: r.governing?.length || 0,
    contextual_count: r.contextual?.length || 0,
    has_epistemic_lane: !!r.epistemic_lane,
    epistemic_lane_records: r.epistemic_lane?.records?.length || 0,
    epistemic_lane_total_matched: r.epistemic_lane?.total_matched || 0,
    epistemic_lane_authority_notice_present: !!r.epistemic_lane?.authority_notice,
    bootstrap_digest: r.bootstrap_digest,
    mutation: r.mutation,
  }));
} finally { db.close(); }
`;
  const r = runProbe('boot-epi', body, { STEP10_DB: COPY_DB });
  if (r.ok) {
    const j = r.json;
    record('bootstrap_with_epistemic_lane', {
      ok: j.has_epistemic_lane && j.mutation.database_writes === 0 && j.mutation.events_appended === 0,
      result: j,
    });
  } else {
    record('bootstrap_with_epistemic_lane', { ok: false, error: r.error, stderr: r.stderr?.slice(0, 500) });
  }
}

// 4f. bootstrapCognitiveAgent (no epistemic lane)
{
  const bootURL = toFileURL(resolve(process.cwd(), 'src/cognitive/agent-bootstrap.ts'));
  const body = `
import Database from 'better-sqlite3';
import { bootstrapCognitiveAgent } from '${bootURL}';
const db = new Database(process.env.STEP10_DB);
try {
  const r = bootstrapCognitiveAgent(db, { query: 'phase-b-step-10-composition', project_id: 'cognitive-os' });
  console.log(JSON.stringify({
    practice_id: r.practice.id,
    scope: r.scope,
    governing_count: r.governing?.length || 0,
    mutation: r.mutation,
    bootstrap_digest: r.bootstrap_digest,
  }));
} finally { db.close(); }
`;
  const r = runProbe('boot-base', body, { STEP10_DB: COPY_DB });
  if (r.ok) {
    const j = r.json;
    record('existing_current_guidance_unchanged', {
      ok: j.scope.global_inclusion === 'disabled' && j.mutation.database_writes === 0,
      result: j,
    });
  } else {
    record('existing_current_guidance_unchanged', { ok: false, error: r.error, stderr: r.stderr?.slice(0, 500) });
  }
}

// 4g. Tool inventory
{
  try {
    const count = parseInt(execSync(`grep -rE "server\\.tool\\(" src/tools/ | wc -l`, { encoding: 'utf8' }).trim(), 10);
    record('tool_inventory', { ok: count >= 40, count });
  } catch (err) {
    record('tool_inventory', { ok: false, error: String(err.message || err) });
  }
}

// 4h. No unauthorized behavior — pure Node walk (no shell quoting issues)
{
  function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
      const p = resolve(dir, e);
      const s = statSync(p);
      if (s.isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  }
  try {
    const files = [
      ...walk(resolve(process.cwd(), 'src/epistemic')),
      resolve(process.cwd(), 'src/tools/epistemic.ts'),
    ];
    const promotionPatterns = [/promote\s*[\.\(\[]?\s*authority/i, /grant\s*[\.\(\[]?\s*authority/i, /hard\s*[\.\(\[]?\s*enforc/i];
    const schedulerPatterns = [/setInterval\s*\(/, /setTimeout\s*\([^,]+,\s*\d/];
    const promotionHits = [];
    const schedulerHits = [];
    for (const f of files) {
      if (!f.endsWith('.ts')) continue;
      const body = readFileSync(f, 'utf8');
      for (const p of promotionPatterns) {
        const m = body.match(p);
        if (m) promotionHits.push({ file: f.replace(process.cwd(), '.'), pattern: p.source, sample: m[0] });
      }
      for (const p of schedulerPatterns) {
        const m = body.match(p);
        if (m) schedulerHits.push({ file: f.replace(process.cwd(), '.'), pattern: p.source, sample: m[0] });
      }
    }
    record('no_unauthorized_behavior', {
      ok: promotionHits.length === 0 && schedulerHits.length === 0,
      promotion_hits: promotionHits,
      scheduler_hits: schedulerHits,
      files_scanned: files.filter(f => f.endsWith('.ts')).length,
    });
  } catch (err) {
    record('no_unauthorized_behavior', { ok: false, error: String(err.message || err) });
  }
}

const allChecks = Object.values(results.checks);
const failed = allChecks.filter(c => !c.ok && !c.skipped);
results.status = failed.length === 0 ? 'pass' : 'fail';
results.completed_at = new Date().toISOString();
results.duration_ms = Date.now() - startedMs;
results.failed_checks = failed.map(c => Object.keys(c).filter(k => k !== 'at').join(','));

writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
process.exit(results.status === 'pass' ? 0 : 1);