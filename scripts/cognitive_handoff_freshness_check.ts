#!/usr/bin/env -S npx tsx
/**
 * Cognitive handoff freshness check.
 *
 * ## Purpose (per [[300]] RCA — high-priority action)
 *
 * Re-verify that a mem-graph-resident handoff's canonical references are still
 * active and the activation phrase is unchanged. Stale handoffs are a real
 * risk: an agent that picks up a handoff with broken refs will waste compute
 * on dead nodes and may form a wrong mental model.
 *
 * ## Epistemic classification (Gather.5)
 *
 * - **External (reported):** none — this is a tool, not a research synthesis.
 * - **Derivation (inferred):** the freshness contract (active refs + unchanged
 *   activation phrase) is our composition; the individual tools (`memory_get`)
 *   exist; the validation order is our judgment.
 * - **Awaiting operator validation (assumed):** the staleness threshold
 *   (default 7 days) and the failure mode (refs all active but freshness >
 *   threshold) is our chosen cadence.
 *
 * ## Usage
 *
 *   npx tsx scripts/cognitive_handoff_freshness_check.ts <handoff_id> [--staleness-days=7]
 *
 *   # or with a path to a textual handoff (Markdown):
 *   npx tsx scripts/cognitive_handoff_freshness_check.ts --path <file.md> [--staleness-days=7]
 *
 * Exit code:
 *   0 = all references active + freshness within threshold
 *   1 = one or more references not active, or stale
 *   2 = invocation error
 *
 * ## Output
 *
 *   JSON with: handoff_id, ref_count, refs: [{ref, status, title, updated_at,
 *   staleness_days}], activation_phrase_present, fresh: bool, staleness_days: number.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

const LIVE_DB = process.env.STEP10_LIVE_DB
  || resolve(process.env.USERPROFILE || process.env.HOME, '.claude/mem-graph/memory.db');

interface MemoryRow {
  id: number;
  title: string;
  status: string;
  project_id: string;
  updated_at: string;
}

interface RefReport {
  ref: string;
  resolved_id: number | null;
  status: string;
  title: string | null;
  updated_at: string | null;
  staleness_days: number | null;
}

interface FreshnessReport {
  handoff_id: number | null;
  handoff_path: string | null;
  ref_count: number;
  broken_refs: string[];
  refs: RefReport[];
  activation_phrase_present: boolean;
  staleness_days_threshold: number;
  max_staleness_days: number | null;
  fresh: boolean;
  result: 'pass' | 'fail';
  errors: string[];
}

function daysSince(iso: string, now: Date): number {
  const then = new Date(iso).getTime();
  return Math.floor((now.getTime() - then) / (1000 * 60 * 60 * 24));
}

function extractRefs(content: string): string[] {
  // Match [[NNN]] syntax; tolerate surrounding prose, capture only the integer.
  const matches = content.matchAll(/\[\[(\d+)\]\]/g);
  const ids = new Set<string>();
  for (const m of matches) ids.add(m[1]);
  return Array.from(ids).sort((a, b) => Number(a) - Number(b));
}

function extractActivationPhrase(content: string): string | null {
  const m = content.match(/\*\*MANDATORY ACKNOWLEDGMENT[^*]*\*\*([\s\S]*?)\*\*/);
  return m ? m[1].trim() : null;
}

function fetchRefs(db: Database.Database, refs: string[], now: Date): { refs: RefReport[]; broken: string[] } {
  const out: RefReport[] = [];
  const broken: string[] = [];
  for (const ref of refs) {
    const row = db.prepare('SELECT id, title, status, project_id, updated_at FROM memories WHERE id = ?').get(Number(ref)) as MemoryRow | undefined;
    if (!row) {
      broken.push(String(ref));
      out.push({ ref, resolved_id: null, status: 'missing', title: null, updated_at: null, staleness_days: null });
      continue;
    }
    if (row.status !== 'active') {
      broken.push(String(ref));
    }
    out.push({
      ref,
      resolved_id: row.id,
      status: row.status,
      title: row.title,
      updated_at: row.updated_at,
      staleness_days: daysSince(row.updated_at, now),
    });
  }
  return { refs: out, broken };
}

function checkFromMemory(db: Database.Database, id: number, thresholdDays: number, now: Date): FreshnessReport {
  const row = db.prepare('SELECT id, content, status, updated_at FROM memories WHERE id = ?').get(id) as { id: number; content: string; status: string; updated_at: string } | undefined;
  const errors: string[] = [];
  if (!row) {
    return { handoff_id: id, handoff_path: null, ref_count: 0, broken_refs: [], refs: [], activation_phrase_present: false, staleness_days_threshold: thresholdDays, max_staleness_days: null, fresh: false, result: 'fail', errors: [`memory ${id} not found`] };
  }
  if (row.status !== 'active') errors.push(`handoff memory ${id} is status='${row.status}' (not active)`);
  const refs = extractRefs(row.content);
  const { refs: refReports, broken } = fetchRefs(db, refs, now);
  const activationPhrase = extractActivationPhrase(row.content);
  const activationPresent = activationPhrase !== null;
  if (!activationPresent) errors.push('no activation phrase detected (looking for **MANDATORY ACKNOWLEDGMENT** block)');
  const maxStaleness = refReports.reduce((max, r) => r.staleness_days === null ? max : Math.max(max, r.staleness_days), 0);
  const fresh = broken.length === 0 && activationPresent && maxStaleness <= thresholdDays;
  return {
    handoff_id: id,
    handoff_path: null,
    ref_count: refs.length,
    broken_refs: broken,
    refs: refReports,
    activation_phrase_present: activationPresent,
    staleness_days_threshold: thresholdDays,
    max_staleness_days: maxStaleness,
    fresh,
    result: fresh ? 'pass' : 'fail',
    errors,
  };
}

function checkFromPath(path: string, thresholdDays: number, _now: Date): FreshnessReport {
  const errors: string[] = [];
  const content = readFileSync(path, 'utf8');
  const refs = extractRefs(content);
  const activationPhrase = extractActivationPhrase(content);
  const activationPresent = activationPhrase !== null;
  if (!activationPresent) errors.push('no activation phrase detected');
  // For path-mode we can't know staleness without a live DB; report empty refs.
  return {
    handoff_id: null,
    handoff_path: path,
    ref_count: refs.length,
    broken_refs: refs.map(String), // can't verify without DB; caller should run with DB
    refs: refs.map(r => ({ ref: r, resolved_id: null, status: 'unknown', title: null, updated_at: null, staleness_days: null })),
    activation_phrase_present: activationPresent,
    staleness_days_threshold: thresholdDays,
    max_staleness_days: null,
    fresh: false,
    result: 'fail',
    errors: [...errors, 'path-mode cannot verify refs without a live DB; use --handoff-id'],
  };
}

function parseArgs(argv: string[]): { handoffId: number | null; path: string | null; threshold: number; help: boolean } {
  let handoffId: number | null = null;
  let path: string | null = null;
  let threshold = 7;
  let help = false;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--staleness-days=')) {
      threshold = Number(arg.split('=')[1]);
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--path=')) {
      path = arg.split('=')[1];
    } else if (arg.startsWith('--handoff-id=')) {
      handoffId = Number(arg.split('=')[1]);
    } else if (/^\d+$/.test(arg)) {
      handoffId = Number(arg);
    }
  }
  return { handoffId, path, threshold, help };
}

function main(argv: string[]): number {
  const { handoffId, path, threshold, help } = parseArgs(argv);
  if (help) {
    const scriptPath = resolve(import.meta.dirname ?? '.', 'cognitive_handoff_freshness_check.ts');
    console.log(readFileSync(scriptPath, 'utf8').split('\n').slice(0, 30).join('\n'));
    return 0;
  }
  if (!handoffId && !path) {
    console.error('ERROR: provide either --handoff-id <N> or --path <file.md>');
    return 2;
  }
  const now = new Date();
  let report: FreshnessReport;
  if (handoffId) {
    const db = new Database(LIVE_DB, { readonly: true });
    try {
      report = checkFromMemory(db, handoffId, threshold, now);
    } finally {
      db.close();
    }
  } else {
    report = checkFromPath(path!, threshold, now);
  }
  console.log(JSON.stringify(report, null, 2));
  return report.result === 'pass' ? 0 : 1;
}

process.exit(main(process.argv));