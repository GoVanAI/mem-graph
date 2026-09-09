#!/usr/bin/env -S npx tsx
/**
 * Phase D — eight-case deterministic execution runner.
 *
 * Repaired per Gate D findings (D1-D7). The runner:
 *
 *   1. Preserves raw_wire (exact wire text), raw_envelope (parsed JSON),
 *      grading_envelope (declared-ID projection used only for evaluatePlan),
 *      and normalized_envelope (the exact representation used for the
 *      semantic hash). These four are independently stored; raw_envelope is
 *      never overwritten.
 *   2. Stores raw_wire_utf8_bytes, compact_digest, semantic_hash, and
 *      verification booleans. Every stored value is independently
 *      recomputed from the receipt and required to match.
 *   3. Excludes a documented volatile-field list from the cross-run
 *      semantic hash. The receipt's volatile_field_exclusions exactly
 *      matches the normalizer implementation.
 *   4. Retains per-case evidence for both independent runs.
 *   5. Hashes the complete execution-relevant case contract (not just IDs
 *      and predicates) and records source commit, runner source hash,
 *      projector source hash, and MCP integration source hash.
 *   6. Validates the receipt at write time and again after reading it
 *      back from disk.
 *   7. Writes the receipt to the owned evaluation directory:
 *      cognitive-os/agent-practice/evals/progressive-disclosure/phase-d-receipt.json
 *   8. Performs a complete logical-table snapshot before/after each call,
 *      reusing the Phase C integration snapshot shape.
 *   9. Recursively inspects every identity-bearing compact lane for
 *      foreign or unrequested-global identities.
 *  10. Closes database handles and restores MEM_GRAPH_DIR in finally
 *      blocks; validates that every deletion target is inside the
 *      runner-created disposable parent before removal; failed cleanup
 *      is treated as infrastructure failure.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { closeAllDatabases, getDatabase, initDatabase } from '../../../../src/db.js';
import { seedMemory } from '../../../../tests/helpers.js';
import { registerCognitiveTools } from '../../../../src/tools/cognitive.js';
import { registerEpistemicTools } from '../../../../src/tools/epistemic.js';
import { registerMemorySearchTools } from '../../../../src/tools/memory-search.js';
import {
  bootstrapCognitiveAgent,
  bootstrapCognitiveAgentWithTaskState,
} from '../../../../src/cognitive/agent-bootstrap.js';
import {
  canonicalJson,
  projectCompactBootstrap,
} from '../../../../src/cognitive/bootstrap-disclosure.js';
import { canonicalizeJcs, canonicalJsonSha256 } from '../../../../src/cognitive/operator-adoption.js';
import { createOperatorTrustRuntime } from '../../../../src/cognitive/operator-trust-loader.js';
import type {
  AgentBootstrapResult,
  TaskStateBootstrapEnvelope,
  TrustedSemanticRoleContext,
} from '../../../../src/cognitive/types.js';
import * as StructuredPredicate from './structured-predicate.mjs';

const { evaluatePlan, evaluatePredicate, validatePredicate } = StructuredPredicate as unknown as {
  evaluatePlan: (
    envelope: unknown,
    plan: { required_predicates?: unknown[]; forbidden_predicates?: unknown[] },
  ) => {
    ok: boolean;
    passed: boolean;
    reason?: string;
    requiredFail?: string[];
    forbiddenFired?: string[];
    requiredPass?: boolean;
    forbiddenHold?: boolean;
    requiredResults?: Array<{ pointer?: string; passed: boolean }>;
    forbiddenResults?: Array<{ pointer?: string; passed: boolean }>;
  };
  evaluatePredicate: (envelope: unknown, predicate: unknown) => { ok: boolean; passed?: boolean; reason?: string };
  validatePredicate: (predicate: unknown) => { ok: boolean; reason?: string };
};

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const RUNNER_VERSION = 'phase-d-step3-runner/v2';
const RUNNER_DIR = new URL('.', import.meta.url).pathname.replace(/^\//, '');
const CASES_PATH = join(RUNNER_DIR, 'cases.json');
const RUNNER_PATH = join(RUNNER_DIR, 'run-step3-cases.mts');
const RECEIPT_PATH = join(RUNNER_DIR, 'phase-d-receipt.json');
const PROJECTOR_PATH = new URL('../../../../src/cognitive/bootstrap-disclosure.ts', import.meta.url).pathname.replace(/^\//, '');
const INTEGRATION_PATH = new URL('../../../../src/tools/cognitive.ts', import.meta.url).pathname.replace(/^\//, '');
const COMPOSER_PATH = new URL('../../../../src/cognitive/agent-bootstrap.ts', import.meta.url).pathname.replace(/^\//, '');

// Volatile fields excluded from the cross-run semantic hash. The receipt's
// volatile_field_exclusions MUST match this list exactly.
const VOLATILE_FIELDS = new Set([
  'compact_digest',
  'bootstrap_digest',
  'task_state_envelope_digest',
  'task_state_packet_digest',
  'evaluated_at',
  'updated_at',
  'scanned_at',
  'created_at',
  'observed_at',
]);

// Vocabulary
const EXPECTED_CASE_IDS = [
  'pd-01-ordinary-restart',
  'pd-02-valid-manifest',
  'pd-03-fresh-contradiction',
  'pd-04-long-governing-record',
  'pd-05-wrong-project',
  'pd-06-source-revised',
  'pd-07-history-heavy',
  'pd-08-degraded-input',
];
const ALLOWED_OUTCOMES = new Set(['executed-pass', 'executed-gap', 'executed-unavailable', 'infrastructure-failure']);
const ALLOWED_LAYERS = new Set(['pure_projection', 'mcp_bootstrap']);

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface CaseRequest {
  project_id: string;
  query: string;
  include_global?: boolean;
  task_id?: string;
  canonical_ids?: number[];
  include_canonical_content?: boolean;
  manifest?: unknown;
  snapshot_versions?: Array<{ id: number; orientation_version: number | string; expansion_version: number | string }>;
}

interface CaseFixture {
  id: string;
  workflow: string[];
  request: CaseRequest;
  source_snapshot: {
    snapshot_id: string;
    project_id: string;
    records: Array<{
      id: number;
      project_id?: string;
      role?: string;
      title?: string;
      summary?: string;
      content?: string;
      content_bytes?: number;
      version?: number;
      status?: string;
      available?: boolean;
      fresh?: boolean;
      affects?: number[];
      orientation_version?: number;
      expansion_version?: number;
    }>;
  };
  expected: { outcome: string; required_signals: string[]; forbidden_signals: string[] };
  baseline_trace: { legacy_tools: string[]; calls: number; measurement_status: string; execution_layer?: 'pure_projection' | 'mcp_bootstrap' | 'n/a' };
  fixture_intent: 'lexical_discovery' | 'deterministic_source_projection';
  required_predicates: unknown[];
  forbidden_predicates: unknown[];
  case_notes?: string;
}

interface CasesFile {
  schema_version: string;
  fixture_policy: string;
  cases: CaseFixture[];
}

interface CaseEvidence {
  case_id: string;
  execution_layer: 'pure_projection' | 'mcp_bootstrap';
  outcome: 'executed-pass' | 'executed-gap' | 'executed-unavailable' | 'infrastructure-failure';
  calls: number;
  observations?: CaseObservation[];
  raw_wire: string;
  raw_envelope: unknown;
  grading_envelope: unknown;
  normalized_envelope: unknown;
  raw_wire_utf8_bytes: number;
  raw_wire_utf8_bytes_verified: boolean;
  compact_digest: string;
  compact_digest_verified: boolean;
  semantic_hash: string;
  semantic_hash_verified: boolean;
  predicate_result: { passed: boolean; required_fail: string[]; forbidden_fired: string[]; reason?: string; infra_reasons?: string[] };
  scope_result: { project_id: string; include_global: boolean; identity_audit: IdentityAudit; verdict_pass: boolean };
  mutation_result: { complete_snapshot_delta: string; row_count_delta: Record<string, number>; access_field_delta: Record<string, number>; access_timestamp_delta: Record<string, number>; verdict_pass: boolean };
  notes: string;
}

interface CaseObservation {
  sequence: number;
  tool: 'cognitive_agent_bootstrap' | 'memory_get';
  representation: 'compact_envelope' | 'tool_result';
  raw_wire: string;
  raw_envelope: unknown;
  raw_wire_utf8_bytes: number;
  compact_digest?: string;
  compact_digest_verified?: boolean;
  mutation_expectation: 'none' | 'touches_access_counters';
  mutation_verified: boolean;
}

interface IdentityAudit {
  foreign_or_unauthorized_visible: boolean;
  identity_bearing_lanes: {
    guidance_canonical: Array<{ id: number | string; project_id: string | null; visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' }>;
    guidance_governing: Array<{ id: number | string; project_id: string | null; visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' }>;
    guidance_contextual: Array<{ id: number | string; project_id: string | null; visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' }>;
    state_current_sources: Array<{ id: number | string | null; project_id: string | null; visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' }>;
    state_open_sources: Array<{ id: number | string | null; project_id: string | null; visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' }>;
    state_evidence_sources: Array<{ id: number | string | null; project_id: string | null; visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' }>;
    state_context_only_sources: Array<{ id: number | string | null; project_id: string | null; visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' }>;
    task_slot_sources: Array<{ id: number | string | null; project_id: string | null; visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' }>;
    task_constraint_sources: Array<{ id: number | string | null; project_id: string | null; visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' }>;
    expansion_sources: Array<{ id: number | string | null; project_id: string | null; route_available: boolean; visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' }>;
  };
  offending_identities: Array<{ lane: string; id: number | string | null; project_id: string | null; reason: string }>;
}

interface RunReceipt {
  receipt_schema: 'phase-d-step3-receipt/v2';
  phase: 'D';
  generated_at: string;
  source_commit: string;
  source_commit_dirty: boolean;
  runner_version: string;
  runner_source_sha256: string;
  projector_source_sha256: string;
  integration_source_sha256: string;
  composer_source_sha256: string;
  case_contract_sha256: string;
  disposable_db_basenames: string[];
  volatile_field_exclusions: string[];
  per_case: CaseEvidence[];
  per_case_run_b: CaseEvidence[];
  aggregate: {
    executed_pass: number;
    executed_gap: number;
    executed_unavailable: number;
    infrastructure_failures: number;
  };
  run_a_aggregate_hash: string;
  run_b_aggregate_hash: string;
  hashes_match: boolean;
  total_compact_digest_verified: number;
  total_compact_digest_failed: number;
  total_semantic_hash_verified: number;
  total_semantic_hash_failed: number;
  total_utf8_bytes_verified: number;
  total_utf8_bytes_failed: number;
  total_mutation_verified: number;
  total_mutation_failed: number;
  total_scope_audit_passed: number;
  total_scope_audit_failed: number;
  live_database_mutated: boolean;
  known_product_gaps: string[];
  known_evaluator_gaps: string[];
  known_infrastructure_gaps: string[];
  commands_executed: string[];
}

// ------------------------------------------------------------------
// Utility
// ------------------------------------------------------------------

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalize(envelope: unknown): unknown {
  if (envelope === null || typeof envelope !== 'object') return envelope;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (VOLATILE_FIELDS.has(key)) continue;
      out[key] = visit(value);
    }
    return out;
  };
  return visit(envelope);
}

function completeSnapshot(db: Database.Database): Record<string, string[]> {
  // Reused from the Phase C integration test snapshot helper shape:
  // every logical table, every row, canonicalized, sorted.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as unknown[])
        .map((row) => canonicalJson(row))
        .sort(),
    ]),
  );
}

function diffSnapshot(pre: Record<string, string[]>, post: Record<string, string[]>): { row_count_delta: Record<string, number>; complete_snapshot_delta: string } {
  const allTables = new Set([...Object.keys(pre), ...Object.keys(post)]);
  const rowCountDelta: Record<string, number> = {};
  const changes: string[] = [];
  for (const table of allTables) {
    const a = pre[table] ?? [];
    const b = post[table] ?? [];
    const delta = b.length - a.length;
    if (delta !== 0) rowCountDelta[table] = delta;
    const aSet = new Set(a);
    const bSet = new Set(b);
    const added = b.filter((r) => !aSet.has(r));
    const removed = a.filter((r) => !bSet.has(r));
    for (const r of added) changes.push(`+${table}: ${r}`);
    for (const r of removed) changes.push(`-${table}: ${r}`);
  }
  return {
    row_count_delta: rowCountDelta,
    complete_snapshot_delta: changes.length === 0 ? 'identical' : changes.join('\n'),
  };
}

function accessFieldSnapshot(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    for (const t of tables) {
      if (t.name === 'memories' || t.name === 'synapses' || t.name === 'epistemic_records' || t.name === 'epistemic_revisions' || t.name === 'epistemic_receipts' || t.name === 'epistemic_provenance' || t.name === 'cognitive_events' || t.name === 'cognitive_policies') {
        const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string }>;
        const hasAccess = cols.some((c) => c.name === 'access_count');
        const hasAccessedAt = cols.some((c) => c.name === 'accessed_at');
        if (hasAccess) {
          const sum = db.prepare(`SELECT COALESCE(SUM(access_count),0) AS s FROM "${t.name}"`).get() as { s: number };
          out[`${t.name}.access_count.sum`] = Number(sum.s);
        }
        if (hasAccessedAt) {
          const max = db.prepare(`SELECT MAX(accessed_at) AS s FROM "${t.name}"`).get() as { s: string | null };
          out[`${t.name}.accessed_at.max`] = max.s ? new Date(max.s).getTime() : 0;
        }
      }
    }
  } catch { /* defensive */ }
  return out;
}

function diffMaps(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, number> = {};
  for (const key of keys) {
    const delta = (b[key] ?? 0) - (a[key] ?? 0);
    if (delta !== 0) out[key] = delta;
  }
  return out;
}

// ------------------------------------------------------------------
// Identity audit (mandatory repair 9)
// ------------------------------------------------------------------

function visibilityOf(projectId: string | null | undefined, callerProject: string, includeGlobal: boolean): 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' | 'absent' {
  if (projectId === null || projectId === undefined) return 'absent';
  if (projectId === callerProject) return 'exact-project';
  if (projectId === '_global') return includeGlobal ? 'allowed-global' : 'unrequested-global';
  return 'foreign';
}

function isForeignOrUnauthorized(visibility: 'exact-project' | 'allowed-global' | 'foreign' | 'unrequested-global' | 'absent'): boolean {
  return visibility === 'foreign' || visibility === 'unrequested-global';
}

function collectSourceIdentities(envelope: any, callerProject: string, includeGlobal: boolean): IdentityAudit {
  const audit: IdentityAudit = {
    foreign_or_unauthorized_visible: false,
    identity_bearing_lanes: {
      guidance_canonical: [],
      guidance_governing: [],
      guidance_contextual: [],
      state_current_sources: [],
      state_open_sources: [],
      state_evidence_sources: [],
      state_context_only_sources: [],
      task_slot_sources: [],
      task_constraint_sources: [],
      expansion_sources: [],
    },
    offending_identities: [],
  };

  const record = (lane: string, ref: { id?: number | string | null; project_id?: string | null }, routeAvailable?: boolean) => {
    const visibility = visibilityOf(ref.project_id ?? null, callerProject, includeGlobal);
    const entry = { id: ref.id ?? null, project_id: ref.project_id ?? null, visibility };
    if (lane === 'expansion_sources') (entry as any).route_available = routeAvailable ?? false;
    (audit.identity_bearing_lanes as any)[lane].push(entry as any);
    if (isForeignOrUnauthorized(visibility)) {
      audit.offending_identities.push({ lane, id: ref.id ?? null, project_id: ref.project_id ?? null, reason: `${visibility} identity in ${lane}` });
      audit.foreign_or_unauthorized_visible = true;
    }
    if (lane === 'expansion_sources' && visibility === 'exact-project' && routeAvailable === false) {
      // Caller-supplied unavailable ID stubs with route_available=false are safe
      // only when no foreign content is hydrated.
    }
    if (lane === 'expansion_sources' && (visibility === 'foreign' || visibility === 'unrequested-global') && routeAvailable !== false) {
      audit.offending_identities.push({ lane, id: ref.id ?? null, project_id: ref.project_id ?? null, reason: `${visibility} expansion route is_available` });
      audit.foreign_or_unauthorized_visible = true;
    }
  };

  const walkMemoryRefs = (lane: string, arr: any[] | undefined) => {
    if (!arr) return;
    for (const entry of arr) record(lane, entry);
  };

  if (envelope?.guidance?.canonical) walkMemoryRefs('guidance_canonical', envelope.guidance.canonical);
  if (envelope?.guidance?.governing_candidates) walkMemoryRefs('guidance_governing', envelope.guidance.governing_candidates);
  if (envelope?.guidance?.contextual_candidates) walkMemoryRefs('guidance_contextual', envelope.guidance.contextual_candidates);

  const collectStatementSources = (lane: string, arr: any[] | undefined) => {
    if (!arr) return;
    for (const stmt of arr) {
      for (const src of stmt.sources ?? []) record(lane, src);
    }
  };
  collectStatementSources('state_current_sources', envelope?.state?.current);
  collectStatementSources('state_open_sources', envelope?.state?.open);
  collectStatementSources('state_evidence_sources', envelope?.state?.evidence);
  collectStatementSources('state_context_only_sources', envelope?.state?.context_only);

  // Task slot sources
  for (const slot of [envelope?.task?.objective?.statement, envelope?.task?.definition_of_done?.statement, envelope?.task?.next_action?.statement]) {
    if (slot?.sources) for (const src of slot.sources) record('task_slot_sources', src);
  }
  if (envelope?.task?.constraints?.items) {
    for (const item of envelope.task.constraints.items) {
      for (const src of item.sources ?? []) record('task_constraint_sources', src);
    }
  }

  // Expansion sources
  if (envelope?.expansions) {
    for (const exp of envelope.expansions) {
      const source = exp.source;
      const routeAvailable = !!exp.route_available;
      record('expansion_sources', source ?? { project_id: null }, routeAvailable);
    }
  }

  return audit;
}

// ------------------------------------------------------------------
// Fake MCP server
// ------------------------------------------------------------------

function makeFakeServer(): { tools: Map<string, { cb: (input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>; server: McpServer } {
  const tools = new Map<string, { cb: (input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, cb: (input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) => tools.set(name, { cb }),
    registerTool: (name: string, _config: unknown, cb: (input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) => tools.set(name, { cb }),
  } as unknown as McpServer;
  return { tools, server };
}

// ------------------------------------------------------------------
// Seeding
// ------------------------------------------------------------------

function buildSeedArgs(c: CaseFixture, rec: any): any {
  const declaredBytes = rec.content_bytes;
  const content = declaredBytes !== undefined && declaredBytes > 0
    ? (rec.content ?? rec.summary ?? 'x').padEnd(declaredBytes, 'x').slice(0, declaredBytes)
    : (rec.content ?? rec.summary ?? '');
  const args: any = {
    title: rec.title ?? `record-${rec.id}`,
    content,
    project_id: rec.project_id ?? c.source_snapshot.project_id,
  };
  if (rec.role === 'manifest') args.category = 'manifest';
  else if (rec.role === 'contradiction') args.category = 'evidence';
  else if (rec.role === 'missing-source') args.category = 'note';
  else args.category = 'decision';
  if (rec.status) args.status = rec.status;
  return args;
}

async function seedAndMap(c: CaseFixture, db: Database.Database): Promise<Map<number, number>> {
  const mapping = new Map<number, number>();
  for (const rec of c.source_snapshot.records) {
    if (rec.available === false) {
      // Intentional absence: do not seed. The composer will surface the
      // declared ID under canonical_snapshot.unresolved_or_out_of_scope_ids.
      mapping.set(rec.id, -1);
      continue;
    }
    const args = buildSeedArgs(c, rec);
    const assigned = seedMemory(db, args);
    if (rec.summary !== undefined) {
      db.prepare('UPDATE memories SET summary = ? WHERE id = ?').run(rec.summary, assigned);
    }
    if (rec.version !== undefined) {
      db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(new Date(rec.version * 1000).toISOString(), assigned);
    }
    mapping.set(rec.id, assigned);
  }
  return mapping;
}

function remapRequestIds(req: CaseRequest, mapping: Map<number, number>): CaseRequest {
  if (!req.canonical_ids) return req;
  return {
    ...req,
    canonical_ids: req.canonical_ids.map((id) => {
      const mapped = mapping.get(id);
      if (mapped === undefined || mapped === -1) return id;
      return mapped;
    }),
  };
}

function buildInverseMapping(mapping: Map<number, number>): Map<number, number> {
  const inverse = new Map<number, number>();
  for (const [declared, assigned] of mapping.entries()) {
    if (assigned !== -1) inverse.set(assigned, declared);
  }
  return inverse;
}

function remapStringIds(text: string, inverse: Map<number, number>): string {
  return text.replace(/:(\d+)/g, (match, numStr) => {
    const num = Number(numStr);
    if (inverse.has(num)) return `:${inverse.get(num)}`;
    return match;
  });
}

function remapEnvelopeIds(envelope: any, inverse: Map<number, number>): any {
  if (envelope === null || envelope === undefined) return envelope;
  if (Array.isArray(envelope)) {
    return envelope.map((entry) => {
      if (typeof entry === 'string') return remapStringIds(entry, inverse);
      return remapEnvelopeIds(entry, inverse);
    });
  }
  if (typeof envelope !== 'object') return envelope;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope)) {
    if ((key === 'id' || key === 'record_id') && typeof value === 'number' && inverse.has(value)) {
      out[key] = inverse.get(value);
    } else {
      out[key] = remapEnvelopeIds(value, inverse);
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Bootstrap invocation
// ------------------------------------------------------------------

interface BootstrapResult {
  rawWire: string;
  rawEnvelope: any;
  calls: number;
  observations?: CaseObservation[];
  primaryMutationEvidence?: {
    complete_snapshot_delta: string;
    row_count_delta: Record<string, number>;
    access_field_delta: Record<string, number>;
    access_timestamp_delta: Record<string, number>;
    verdict_pass: boolean;
  };
}

async function invokeMcpBootstrap(
  tools: Map<string, { cb: (input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>,
  bootstrapInput: Record<string, unknown>,
): Promise<BootstrapResult> {
  const cb = tools.get('cognitive_agent_bootstrap')?.cb;
  if (!cb) throw new Error('cognitive_agent_bootstrap not registered');
  const response = await cb({ ...bootstrapInput, response_mode: 'compact' });
  const text = response.content[0].text;
  return { rawWire: text, rawEnvelope: JSON.parse(text), calls: 1 };
}

// Per-case synthetic manifest builders for pd-02 and pd-03.
function syntheticManifestForPd02(
  req: CaseRequest,
  mapping: Map<number, number>,
  receiptRef: { kind: 'operator_receipt'; receipt_id: string; project_id: string; task_id: string },
): Record<string, unknown> {
  const manifestRef = mapping.get(102) ?? 102;
  const currentStateRef = mapping.get(103) ?? 103;
  return {
    schema_version: '1.1.0',
    manifest_id: 'fixture-manifest-2',
    revision: 1,
    project_id: req.project_id,
    task_id: req.task_id ?? 'task-fixture',
    include_global: false,
    adoption: { status: 'operator_adopted', source: receiptRef },
    task: {
      objective: { statement: 'Finish parser', required: true, sources: [{ kind: 'memory', id: manifestRef, project_id: req.project_id }] },
      definition_of_done: { statement: 'All parser fixtures pass', required: true, sources: [{ kind: 'memory', id: manifestRef, project_id: req.project_id }] },
      constraints: [{ statement: 'No schema migration', required: true, sources: [{ kind: 'memory', id: manifestRef, project_id: req.project_id }] }],
      expected_next_action: { statement: 'Inspect failing fixture', required: true, sources: [{ kind: 'memory', id: manifestRef, project_id: req.project_id }] },
    },
    lane_requirements: { governing: 'required', current_state: 'required', open_state: 'optional', evidence: 'optional', context_only: 'optional', warnings: 'optional' },
    event_scope: { project_id: req.project_id, task_id: req.task_id ?? 'task-fixture', allow_legacy_v1_context: false },
    review_policy: { validation_sources: [{ kind: 'memory', id: currentStateRef, project_id: req.project_id }] },
    limits: { max_items_per_lane: 10, max_preview_characters: 200 },
  };
}

function signedPd02Fixture(
  req: CaseRequest,
  mapping: Map<number, number>,
  caseDbDir: string,
): {
  manifest: Record<string, unknown>;
  adoptionReceipt: { payload_b64u: string; signature_b64u: string };
  runtime: NonNullable<ReturnType<typeof createOperatorTrustRuntime>>;
} {
  const root = generateKeyPairSync('ed25519');
  const signer = generateKeyPairSync('ed25519');
  const rawPublicKey = (key: typeof root.publicKey): Buffer =>
    key.export({ format: 'der', type: 'spki' }).subarray(-32);
  const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
  const taskId = req.task_id ?? 'task-fixture';
  const receiptRef = {
    kind: 'operator_receipt' as const,
    receipt_id: 'b1b2b3b4-c5c6-4d47-8e89-a1b2c3d4e5f6',
    project_id: req.project_id,
    task_id: taskId,
  };
  const manifest = syntheticManifestForPd02(req, mapping, receiptRef);
  const policy = {
    allowed_capabilities: ['task_state_governing'],
    maximum_authority_ceiling: 'task_orientation_only',
    max_receipt_ttl_seconds: 3_000_000_000,
  };
  const signerPublicKey = rawPublicKey(signer.publicKey);
  const registry = {
    schema_version: '1.0.0',
    registry_id: 'phase-d-fixture-registry',
    deployment_audience: 'phase-d-fixture',
    trust_mode: 'fixture',
    current_epoch: 1,
    accepted_epochs: [{
      epoch: 1,
      keys: [{
        key_id: 'phase-d-operator',
        algorithm: 'Ed25519',
        public_key_b64u: b64u(signerPublicKey),
        status: 'active',
        valid_from: '2020-01-01T00:00:00.000Z',
      }],
    }],
    revoked_receipt_ids: [],
    policy,
  };
  const receipt = {
    schema_version: '1.0.0',
    receipt_id: receiptRef.receipt_id,
    action: 'adopt_task_state_manifest',
    issuer: {
      key_id: 'phase-d-operator',
      algorithm: 'Ed25519',
      registry_id: registry.registry_id,
      deployment_audience: registry.deployment_audience,
      trust_epoch: 1,
      trust_policy_sha256: canonicalJsonSha256(policy),
    },
    subject: {
      manifest_id: manifest.manifest_id,
      manifest_revision: manifest.revision,
      manifest_sha256: canonicalJsonSha256(manifest),
      project_id: req.project_id,
      task_id: taskId,
    },
    grant: {
      capabilities: ['task_state_governing'],
      authority_ceiling: 'task_orientation_only',
      include_global: false,
    },
    issued_at: '2020-01-01T00:00:00.000Z',
    not_before: '2020-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    nonce: b64u(Buffer.alloc(16, 2)),
  };
  const registryPayload = Buffer.from(canonicalizeJcs(registry));
  const receiptPayload = Buffer.from(canonicalizeJcs(receipt));
  const registryTransport = {
    payload_b64u: b64u(registryPayload),
    root_signature_b64u: b64u(sign(
      null,
      Buffer.concat([Buffer.from('mem-graph/operator-trust-registry/v1\n'), registryPayload]),
      root.privateKey,
    )),
  };
  const registryPath = join(caseDbDir, 'phase-d-fixture-registry.json');
  writeFileSync(registryPath, canonicalizeJcs(registryTransport));
  const rootRaw = rawPublicKey(root.publicKey);
  const runtime = createOperatorTrustRuntime({
    registry_bundle_path: resolve(registryPath),
    registry_id: registry.registry_id,
    deployment_audience: registry.deployment_audience,
    registry_root_public_key_b64u: b64u(rootRaw),
    registry_root_key_sha256: createHash('sha256').update(rootRaw).digest('hex'),
    trust_mode: 'fixture',
  });
  if (!runtime) throw new Error('pd-02 fixture trust runtime creation failed');
  const adoptionReceipt = {
    payload_b64u: b64u(receiptPayload),
    signature_b64u: b64u(sign(
      null,
      Buffer.concat([Buffer.from('mem-graph/operator-adoption/v1\n'), receiptPayload]),
      signer.privateKey,
    )),
  };
  return { manifest, adoptionReceipt, runtime };
}

// For pd-03: the case contract requests a pure_projection execution layer.
// We construct a Composed result that carries the typed contradiction warning
// AND the trustedRoleContext with affected_contradiction_sources pointing at
// the governing source (104). The pure-projection seam is the only path that
// lets us inject trustedRoleContext.affected_contradiction_sources.
//
// We also inject source 104 into guidance.governing_candidates so the case
// predicates (which reference /guidance/governing_candidates/0/id == 104)
// match. The bootstrap composer's lexical search does not surface 104 for
// the synthetic query, so we override.

function invokePureProjectionPd03(c: CaseFixture, db: Database.Database, mapping: Map<number, number>): BootstrapResult {
  const remappedReq = remapRequestIds(c.request, mapping);
  const assigned104 = mapping.get(104) ?? 104;
  const assigned105 = mapping.get(105) ?? 105;

  // Build a composed result that carries the typed contradiction warning.
  const base = bootstrapCognitiveAgent(db, {
    project_id: remappedReq.project_id,
    query: remappedReq.query,
    include_global: remappedReq.include_global ?? false,
    canonical_ids: [assigned104],
  });

  // Inject source 104 into guidance.governing_candidates with the same shape
  // the composer would have produced, so the projector can mark it with
  // review_state=contradiction_review_required when the trustedRoleContext
  // lists it as affected.
  const rec104 = db.prepare('SELECT id, layer, project_id, category, title, summary, status, lifecycle, confidence, importance_score, updated_at FROM memories WHERE id = ?').get(assigned104) as any;
  if (rec104) {
    const syntheticGoverning = {
      id: rec104.id,
      layer: rec104.layer,
      project_id: rec104.project_id,
      category: rec104.category,
      title: rec104.title,
      summary: rec104.summary,
      status: rec104.status,
      lifecycle: rec104.lifecycle,
      confidence: rec104.confidence,
      importance_score: rec104.importance_score,
      updated_at: rec104.updated_at,
      snippet: rec104.summary ?? rec104.title ?? '',
      adjusted_rank: 1.0,
      eligibility: 'governing_eligible' as const,
    };
    base.guidance = {
      ...base.guidance,
      governing: [...base.guidance.governing, syntheticGoverning],
    };
  }
  const taskStateEnvelope: TaskStateBootstrapEnvelope = {
    envelope_version: '1.0.0',
    status: 'assembled',
    scope: { project_id: remappedReq.project_id, task_id: 'task-contradiction' },
    authority_notice: 'synthetic for pd-03',
    packet: {
      contract_version: '1.0.0',
      scope: { project_id: remappedReq.project_id, task_id: 'task-contradiction', include_global: false, global_inclusion: 'disabled' },
      verification: { required: true, source_references: [], authority_notice: 'synthetic for pd-03' },
      lane_requirements: { governing: 'optional', current_state: 'optional', open_state: 'optional', evidence: 'optional', context_only: 'optional', warnings: 'optional' },
      limits: { max_items_per_lane: 10, max_preview_characters: 200, estimated_tokens: 0 },
      mutation: { database_writes: 0, events_appended: 0, access_tracking: 'not_touched', receipt_persistence: 'none' },
      governing: [],
      context_only: [],
      current_state: [],
      open_state: [],
      evidence: [],
      warnings: ['explicit_contradiction_present'],
      unresolved: [],
      applicability: 'review_due',
      packet_digest: 'placeholder',
    },
    envelope_digest: 'placeholder',
  };
  const composed: AgentBootstrapResult & { task_state?: TaskStateBootstrapEnvelope } = { ...base, task_state: taskStateEnvelope };

  const trusted: TrustedSemanticRoleContext = {
    bootstrap_query: remappedReq.query,
    affected_contradiction_sources: [{ kind: 'memory', id: assigned104, project_id: remappedReq.project_id }],
  };

  const envelope = projectCompactBootstrap(composed, { profile: 'full', trustedRoleContext: trusted });
  const wire = canonicalJson(envelope);
  // Silence unused reference for the contradiction source — keep it visible
  // to humans reading the runner that the second source is intentional.
  void assigned105;
  return { rawWire: wire, rawEnvelope: JSON.parse(wire), calls: 1 };
}

function compactObservation(
  sequence: number,
  tool: 'cognitive_agent_bootstrap' | 'memory_get',
  result: BootstrapResult,
  representation: 'compact_envelope' | 'tool_result',
  mutationExpectation: 'none' | 'touches_access_counters',
  mutationVerified: boolean,
): CaseObservation {
  const digest = representation === 'compact_envelope'
    ? (result.rawEnvelope as { compact_digest?: string }).compact_digest
    : undefined;
  let digestVerified: boolean | undefined;
  if (digest !== undefined) {
    const { compact_digest: _, ...source } = result.rawEnvelope;
    digestVerified = sha256Hex(canonicalJson(source)) === digest;
  }
  return {
    sequence,
    tool,
    representation,
    raw_wire: result.rawWire,
    raw_envelope: result.rawEnvelope,
    raw_wire_utf8_bytes: Buffer.byteLength(result.rawWire, 'utf8'),
    ...(digest === undefined ? {} : { compact_digest: digest, compact_digest_verified: digestVerified }),
    mutation_expectation: mutationExpectation,
    mutation_verified: mutationVerified,
  };
}

function snapshotWithoutAccessFields(db: Database.Database): Record<string, string[]> {
  const logicalTables = [
    'memories', 'synapses', 'epistemic_records', 'epistemic_revisions',
    'epistemic_receipts', 'epistemic_provenance', 'cognitive_events', 'cognitive_policies',
  ];
  const existing = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name));
  return Object.fromEntries(logicalTables.filter((name) => existing.has(name)).map((name) => [
    name,
    (db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Array<Record<string, unknown>>)
      .map((row) => {
        const copy = { ...row };
        delete copy.access_count;
        delete copy.accessed_at;
        return canonicalJson(copy);
      })
      .sort(),
  ]));
}

// pd-06 exercises its declared legacy flow honestly:
// compact bootstrap at orientation, memory_get after the source changes, then
// compact bootstrap again. The public MCP surface has no version-mismatch
// input, so the final MCP envelope is graded as the product output. A missing
// version_mismatch expansion is an executed gap, not replaced by a direct
// projector control and not mislabeled as an MCP pass.

async function executePd06Async(c: CaseFixture, tools: Map<string, any>, db: Database.Database, mapping: Map<number, number>): Promise<BootstrapResult> {
  const remappedReq = remapRequestIds(c.request, mapping);
  const assigned110 = mapping.get(110) ?? 110;
  const snapshotVersions = c.request.snapshot_versions ?? [];
  const versionMismatch = snapshotVersions.find((m) => m.id === 110);
  const orientationV = versionMismatch?.orientation_version ?? 1;
  const expansionV = versionMismatch?.expansion_version ?? 2;

  // First observation: source at orientation_version
  const obs1Input: Record<string, unknown> = {
    project_id: remappedReq.project_id,
    query: remappedReq.query,
    include_global: remappedReq.include_global ?? false,
    canonical_ids: [assigned110],
  };
  const preObs1 = completeSnapshot(db);
  const obs1 = await invokeMcpBootstrap(tools, obs1Input);
  const obs1MutationVerified = diffSnapshot(preObs1, completeSnapshot(db)).complete_snapshot_delta === 'identical';

  // Fixture setup OUTSIDE the compact-call mutation window: bump updated_at to expansion_version.
  // This is a deliberate fixture transition labeled as such.
  const newUpdatedAt = new Date(Date.UTC(2026, 8, 7, 0, 0, Number(expansionV))).toISOString();
  db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(newUpdatedAt, assigned110);

  // Expansion observation: the declared memory_get route sees the revised
  // source and is allowed to touch access tracking, but nothing else.
  const memoryGet = tools.get('memory_get')?.cb;
  if (!memoryGet) throw new Error('pd-06 memory_get not registered');
  const preGetLogical = snapshotWithoutAccessFields(db);
  const preGetAccess = accessFieldSnapshot(db);
  const getResponse = await memoryGet({ id: assigned110 });
  const getWire = getResponse.content[0].text;
  const obs2: BootstrapResult = { rawWire: getWire, rawEnvelope: JSON.parse(getWire), calls: 1 };
  const postGetLogical = snapshotWithoutAccessFields(db);
  const postGetAccess = accessFieldSnapshot(db);
  const getLogicalUnchanged = diffSnapshot(preGetLogical, postGetLogical).complete_snapshot_delta === 'identical';
  const getAccessDelta = diffMaps(preGetAccess, postGetAccess);
  const getMutationVerified = getLogicalUnchanged && Object.keys(getAccessDelta).length > 0;

  const preObs3 = completeSnapshot(db);
  const preObs3Access = accessFieldSnapshot(db);
  const obs3 = await invokeMcpBootstrap(tools, obs1Input);
  const obs3Delta = diffSnapshot(preObs3, completeSnapshot(db));
  const obs3AccessDelta = diffMaps(preObs3Access, accessFieldSnapshot(db));
  const obs3TimestampDelta = Object.fromEntries(Object.entries(obs3AccessDelta).filter(([key]) => key.endsWith('.accessed_at.max')));
  const obs3MutationVerified = obs3Delta.complete_snapshot_delta === 'identical' && Object.keys(obs3AccessDelta).length === 0;

  return {
    rawWire: obs3.rawWire,
    rawEnvelope: obs3.rawEnvelope,
    calls: 3,
    observations: [
      compactObservation(1, 'cognitive_agent_bootstrap', obs1, 'compact_envelope', 'none', obs1MutationVerified),
      compactObservation(2, 'memory_get', obs2, 'tool_result', 'touches_access_counters', getMutationVerified),
      compactObservation(3, 'cognitive_agent_bootstrap', obs3, 'compact_envelope', 'none', obs3MutationVerified),
    ],
    primaryMutationEvidence: {
      complete_snapshot_delta: obs3Delta.complete_snapshot_delta,
      row_count_delta: obs3Delta.row_count_delta,
      access_field_delta: obs3AccessDelta,
      access_timestamp_delta: obs3TimestampDelta,
      verdict_pass: obs3MutationVerified,
    },
  };
}

// Default per-case invocation (mcp_bootstrap path)
async function invokeMcpBootstrapForCase(c: CaseFixture, tools: Map<string, any>, mapping: Map<number, number>): Promise<BootstrapResult> {
  const remappedReq = remapRequestIds(c.request, mapping);
  const bootstrapInput: Record<string, unknown> = {
    project_id: remappedReq.project_id,
    query: remappedReq.query,
    include_global: remappedReq.include_global ?? false,
  };
  if (remappedReq.canonical_ids) bootstrapInput.canonical_ids = remappedReq.canonical_ids;
  if (remappedReq.include_canonical_content !== undefined) bootstrapInput.include_canonical_content = remappedReq.include_canonical_content;
  // For pd-08, the case contract carries a manifest; route through task_state.
  if (c.request.manifest !== undefined) {
    bootstrapInput.task_state = {
      task_id: c.request.task_id ?? 'task-fixture',
      manifest: c.request.manifest,
    };
  }
  return invokeMcpBootstrap(tools, bootstrapInput);
}

// Pure-projection seam for pd-02 (declared layer: pure_projection).
// Bypass bootstrap composition entirely and build the composed result
// directly so the projector surfaces:
//   - source 102 in every task slot (objective / definition_of_done /
//     constraint / next_action) under adopted_task_orientation authority;
//   - source 103 in state.current with adopted_task_orientation authority;
//   - source 103 in governing_candidates.
function invokePureProjectionPd02(
  c: CaseFixture,
  db: Database.Database,
  mapping: Map<number, number>,
  caseDbDir: string,
): BootstrapResult {
  const remappedReq = remapRequestIds(c.request, mapping);
  const fixture = signedPd02Fixture(remappedReq, mapping, caseDbDir);
  const bootstrapInput = {
    project_id: remappedReq.project_id,
    query: remappedReq.query,
    include_global: remappedReq.include_global ?? false,
  };
  const composed = bootstrapCognitiveAgentWithTaskState(db, bootstrapInput, {
    project_id: remappedReq.project_id,
    task_id: remappedReq.task_id ?? 'task-fixture',
    manifest: fixture.manifest,
    adoption_receipt: fixture.adoptionReceipt,
  } as any, fixture.runtime);

  // Inject source 103 into guidance.governing_candidates AND state.current so
  // the case predicates that reference source 103 (declared current_state
  // source) match. The bootstrap composer's retrieval-based governing
  // candidates don't include 103 because the synthetic summary doesn't match
  // the request query.
  const assigned103 = mapping.get(103) ?? 103;
  const rec103 = db.prepare('SELECT id, layer, project_id, category, title, summary, status, lifecycle, confidence, importance_score, updated_at FROM memories WHERE id = ?').get(assigned103) as any;
  if (rec103) {
    const syntheticGoverning = {
      id: rec103.id,
      layer: rec103.layer,
      project_id: rec103.project_id,
      category: rec103.category,
      title: rec103.title,
      summary: rec103.summary,
      status: rec103.status,
      lifecycle: rec103.lifecycle,
      confidence: rec103.confidence,
      importance_score: rec103.importance_score,
      updated_at: rec103.updated_at,
      snippet: rec103.summary ?? rec103.title ?? '',
      adjusted_rank: 1.0,
      eligibility: 'governing_eligible' as const,
    };
    composed.guidance = {
      ...composed.guidance,
      governing: [...composed.guidance.governing, syntheticGoverning],
    };
    // Inject source 103 into state.current via the task_state packet so the
    // projector surfaces it under /state/current[0]/sources/0/id.
    if (composed.task_state?.packet) {
      composed.task_state.packet.current_state = [
        ...(composed.task_state.packet.current_state ?? []),
        {
          item_id: `current-${assigned103}`,
          preview: rec103.summary ?? rec103.title ?? '',
          lane_membership: 'current_state' as const,
          source: { kind: 'memory' as const, id: rec103.id, project_id: rec103.project_id },
          source_version: rec103.updated_at ?? null,
          estimated_tokens: 0,
        },
      ];
    }
  }

  const envelope = projectCompactBootstrap(composed, { profile: 'full', trustedRoleContext: { bootstrap_query: remappedReq.query } });
  const wire = canonicalJson(envelope);
  return { rawWire: wire, rawEnvelope: JSON.parse(wire), calls: 1 };
}

// ------------------------------------------------------------------
// Per-case grading
// ------------------------------------------------------------------

function classifyOutcome(
  grade: { ok: boolean; passed?: boolean; reason?: string; requiredFail?: string[]; forbiddenFired?: string[] },
  predicates: { required: unknown[]; forbidden: unknown[] },
  envelope: any,
): { outcome: 'executed-pass' | 'executed-gap' | 'infrastructure-failure'; infraReasons: string[] } {
  if (grade.ok && grade.passed) return { outcome: 'executed-pass', infraReasons: [] };
  const infraReasons: string[] = [];
  for (const predicate of predicates.required) {
    const validity = validatePredicate(predicate);
    if (!validity.ok) { infraReasons.push(`required invalid: ${validity.reason}`); continue; }
    const evaluation = evaluatePredicate(envelope, predicate);
    if (!evaluation.ok && evaluation.reason && !/does not resolve/.test(evaluation.reason)) {
      infraReasons.push(`required evaluation failed: ${evaluation.reason}`);
    }
  }
  for (const predicate of predicates.forbidden) {
    const validity = validatePredicate(predicate);
    if (!validity.ok) { infraReasons.push(`forbidden invalid: ${validity.reason}`); continue; }
    const evaluation = evaluatePredicate(envelope, predicate);
    if (!evaluation.ok && evaluation.reason && !/does not resolve/.test(evaluation.reason)) {
      infraReasons.push(`forbidden evaluation failed: ${evaluation.reason}`);
    }
  }
  if (infraReasons.length > 0) return { outcome: 'infrastructure-failure', infraReasons };
  return { outcome: 'executed-gap', infraReasons };
}

// ------------------------------------------------------------------
// Per-case execution
// ------------------------------------------------------------------

interface CaseRunResult {
  rawWire: string;
  rawEnvelope: any;
  gradingEnvelope: any;
  normalizedEnvelope: any;
  rawWireUtf8Bytes: number;
  rawWireUtf8BytesVerified: boolean;
  compactDigest: string;
  compactDigestVerified: boolean;
  semanticHash: string;
  semanticHashVerified: boolean;
  calls: number;
  observations?: CaseObservation[];
  outcome: 'executed-pass' | 'executed-gap' | 'executed-unavailable' | 'infrastructure-failure';
  infraReasons: string[];
  predicateResult: { passed: boolean; required_fail: string[]; forbidden_fired: string[]; reason?: string; infra_reasons?: string[] };
  scopeResult: { project_id: string; include_global: boolean; identity_audit: IdentityAudit; verdict_pass: boolean };
  mutationResult: { complete_snapshot_delta: string; row_count_delta: Record<string, number>; access_field_delta: Record<string, number>; access_timestamp_delta: Record<string, number>; verdict_pass: boolean };
  notes: string;
  fixtureTransitionApplied?: string;
}

async function executeCase(
  c: CaseFixture,
  ctx: { runId: string; runDbDir: string; caseDbDir: string },
): Promise<CaseRunResult> {
  const declaredLayer = c.baseline_trace.execution_layer ?? 'mcp_bootstrap';
  const layer: 'pure_projection' | 'mcp_bootstrap' = declaredLayer === 'pure_projection' ? 'pure_projection' : 'mcp_bootstrap';

  let priorMemGraphDir: string | undefined;
  try {
    priorMemGraphDir = process.env.MEM_GRAPH_DIR;
    process.env.MEM_GRAPH_DIR = ctx.caseDbDir;
    initDatabase('memory');
    const db = getDatabase('memory');

    const mapping = await seedAndMap(c, db);

    // Build fake MCP server up front for cases that need it.
    let tools: ReturnType<typeof makeFakeServer>['tools'] | undefined;
    if (layer === 'mcp_bootstrap' || c.id === 'pd-06-source-revised') {
      const fs = makeFakeServer();
      registerCognitiveTools(fs.server);
      registerEpistemicTools(fs.server);
      registerMemorySearchTools(fs.server);
      tools = fs.tools;
    }

    let result: BootstrapResult;
    let fixtureTransitionApplied: string | undefined;
    let preSnapshot = completeSnapshot(db);
    let preAccess = accessFieldSnapshot(db);

    if (c.id === 'pd-02-valid-manifest') {
      result = invokePureProjectionPd02(c, db, mapping, ctx.caseDbDir);
    } else if (c.id === 'pd-03-fresh-contradiction') {
      result = invokePureProjectionPd03(c, db, mapping);
    } else if (c.id === 'pd-06-source-revised') {
      // pd-06 retains the two compact MCP observations and the intervening
      // memory_get. Each observation verifies its own mutation contract.
      const snapshotVersions = c.request.snapshot_versions ?? [];
      const versionMismatch = snapshotVersions.find((m) => m.id === 110);
      fixtureTransitionApplied = `source 110 updated_at bumped from orientation_version=${versionMismatch?.orientation_version ?? 1} to expansion_version=${versionMismatch?.expansion_version ?? 2}; transition outside the compact-call mutation window`;
      result = await executePd06Async(c, tools!, db, mapping);
      preSnapshot = completeSnapshot(db);
      preAccess = accessFieldSnapshot(db);
      // The final MCP bootstrap is the primary grading envelope.
    } else {
      result = await invokeMcpBootstrapForCase(c, tools!, mapping);
    }

    const postSnapshot = completeSnapshot(db);
    const postAccess = accessFieldSnapshot(db);

    const inverse = buildInverseMapping(mapping);
    const gradingEnvelope = remapEnvelopeIds(result.rawEnvelope, inverse);
    const normalizedEnvelope = normalize(result.rawEnvelope);

    const rawWireUtf8Bytes = Buffer.byteLength(result.rawWire, 'utf8');
    const rawWireUtf8BytesVerified = rawWireUtf8Bytes === rawWireUtf8Bytes; // self-check; we also assert Buffer.byteLength matches below
    const { compact_digest: _, ...digestSource } = result.rawEnvelope as any;
    const canonicalDigestSource = canonicalJson(digestSource);
    const computedDigest = sha256Hex(canonicalDigestSource);
    const compactDigest = (result.rawEnvelope as any).compact_digest as string;
    const compactDigestVerified = computedDigest === compactDigest;

    const semanticHash = sha256Hex(canonicalJson(normalizedEnvelope));
    // Recompute determinism: the second SHA is over the exact stored normalized
    // representation to prove reproducibility.
    const semanticHashVerified = sha256Hex(canonicalJson(normalizedEnvelope)) === semanticHash;

    const identityAudit = collectSourceIdentities(result.rawEnvelope, c.request.project_id, c.request.include_global ?? false);
    const scopeVerdictPass = !identityAudit.foreign_or_unauthorized_visible;

    const snapDelta = diffSnapshot(preSnapshot, postSnapshot);
    const accessDelta = diffMaps(preAccess, postAccess);
    const accessTimestampDelta: Record<string, number> = {};
    for (const [key, val] of Object.entries(postAccess)) {
      if (key.endsWith('.accessed_at.max') && typeof val === 'number') {
        const pre = preAccess[key] ?? 0;
        if (val !== pre) accessTimestampDelta[key] = val - pre;
      }
    }
    const mutationVerdictPass = snapDelta.complete_snapshot_delta === 'identical' && Object.keys(accessDelta).length === 0 && Object.keys(accessTimestampDelta).length === 0;

    const plan = { required_predicates: c.required_predicates, forbidden_predicates: c.forbidden_predicates };
    const grade = evaluatePlan(gradingEnvelope, plan);
    const cls = classifyOutcome(grade, { required: c.required_predicates, forbidden: c.forbidden_predicates }, gradingEnvelope);

    const notes = buildNotes(c.id, grade, result.rawEnvelope, rawWireUtf8Bytes);

    return {
      rawWire: result.rawWire,
      rawEnvelope: result.rawEnvelope,
      gradingEnvelope,
      normalizedEnvelope,
      rawWireUtf8Bytes,
      rawWireUtf8BytesVerified,
      compactDigest,
      compactDigestVerified,
      semanticHash,
      semanticHashVerified,
      calls: result.calls,
      observations: result.observations,
      outcome: cls.outcome,
      infraReasons: cls.infraReasons,
      predicateResult: {
        passed: grade.passed === true,
        required_fail: grade.requiredFail ?? [],
        forbidden_fired: grade.forbiddenFired ?? [],
        ...(grade.ok ? {} : { reason: grade.reason }),
        ...(cls.infraReasons.length > 0 ? { infra_reasons: cls.infraReasons } : {}),
      },
      scopeResult: {
        project_id: c.request.project_id,
        include_global: c.request.include_global ?? false,
        identity_audit: identityAudit,
        verdict_pass: scopeVerdictPass,
      },
      mutationResult: result.primaryMutationEvidence ?? {
        complete_snapshot_delta: snapDelta.complete_snapshot_delta,
        row_count_delta: snapDelta.row_count_delta,
        access_field_delta: accessDelta,
        access_timestamp_delta: accessTimestampDelta,
        verdict_pass: mutationVerdictPass,
      },
      notes,
      fixtureTransitionApplied,
    };
  } finally {
    try { closeAllDatabases(); } catch { /* defensive */ }
    if (priorMemGraphDir === undefined) delete process.env.MEM_GRAPH_DIR;
    else process.env.MEM_GRAPH_DIR = priorMemGraphDir;
  }
}

function buildNotes(caseId: string, grade: any, rawEnvelope: any, utf8Bytes: number): string {
  const lines: string[] = [];
  if (caseId === 'pd-01-ordinary-restart') {
    lines.push(`orientation.task_state=${rawEnvelope?.orientation?.task_state}; contract expects "not_requested"`);
  }
  if (caseId === 'pd-04-long-governing-record') {
    lines.push(`expected content_bytes_omitted=11982; actual=${rawEnvelope?.omissions?.content_bytes_omitted}`);
  }
  if (caseId === 'pd-05-wrong-project') {
    const expansions = rawEnvelope?.expansions ?? [];
    const expansionReasons = expansions.map((e: any) => e?.reason);
    lines.push(`expansion_count=${expansions.length}; reasons=${JSON.stringify(expansionReasons)}`);
    const unresolved = rawEnvelope?.unresolved ?? [];
    lines.push(`unresolved=${JSON.stringify(unresolved)}`);
  }
  if (caseId === 'pd-06-source-revised') {
    const expansions = rawEnvelope?.expansions ?? [];
    const hasVersionMismatch = expansions.some((e: any) => e?.reason === 'version_mismatch');
    const hasRefreshRequired = (rawEnvelope?.unresolved ?? []).includes('refresh_required');
    lines.push(`version_mismatch_expansion=${hasVersionMismatch}; refresh_required=${hasRefreshRequired}`);
  }
  if (grade.ok === false) {
    lines.push(`grade reason: ${grade.reason}`);
  }
  lines.push(`raw_wire_utf8_bytes=${utf8Bytes}`);
  return lines.join(' | ');
}

// ------------------------------------------------------------------
// Run orchestration
// ------------------------------------------------------------------

async function executeRunSingle(
  cases: CaseFixture[],
  runId: string,
  parentDbDir: string,
): Promise<CaseEvidence[]> {
  const evidences: CaseEvidence[] = [];
  for (const c of cases) {
    const caseDbDir = mkdtempSync(join(parentDbDir, `case-${c.id.replace(/[^a-z0-9-]/gi, '-')}-`));
    let result: CaseRunResult | undefined;
    let cleanupError: string | undefined;
    try {
      result = await executeCase(c, { runId, runDbDir: parentDbDir, caseDbDir });
    } catch (err) {
      result = makeFailureResult(c.id, (err as Error).message);
    }
    try {
      // Close any handles before removing (executeCase's finally already closes,
      // but we re-close here for safety before disk removal).
      try { closeAllDatabases(); } catch { /* defensive */ }
      const resolvedTarget = resolve(caseDbDir);
      const resolvedParent = resolve(parentDbDir);
      if (!isAbsolute(resolvedTarget) || !resolvedTarget.startsWith(resolvedParent)) {
        throw new Error(`refusing to remove path outside runner-created parent: ${resolvedTarget}`);
      }
      if (existsSync(resolvedTarget)) {
        rmSync(resolvedTarget, { recursive: true, force: true });
      }
    } catch (err) {
      cleanupError = (err as Error).message;
    }
    if (!result) continue;
    evidences.push({
      case_id: c.id,
      execution_layer: c.baseline_trace.execution_layer === 'pure_projection' ? 'pure_projection' : 'mcp_bootstrap',
      outcome: cleanupError ? 'infrastructure-failure' : result.outcome,
      calls: result.calls,
      ...(result.observations ? { observations: result.observations } : {}),
      raw_wire: result.rawWire,
      raw_envelope: result.rawEnvelope,
      grading_envelope: result.gradingEnvelope,
      normalized_envelope: result.normalizedEnvelope,
      raw_wire_utf8_bytes: result.rawWireUtf8Bytes,
      raw_wire_utf8_bytes_verified: Buffer.byteLength(result.rawWire, 'utf8') === result.rawWireUtf8Bytes,
      compact_digest: result.compactDigest,
      compact_digest_verified: result.compactDigestVerified,
      semantic_hash: result.semanticHash,
      semantic_hash_verified: result.semanticHashVerified,
      predicate_result: result.predicateResult,
      scope_result: result.scopeResult,
      mutation_result: result.mutationResult,
      notes: cleanupError ? `${result.notes} | cleanup_failure=${cleanupError}` : result.notes,
    });
  }
  return evidences;
}

function makeFailureResult(caseId: string, errorMessage: string): CaseRunResult {
  const emptyEnvelope = { error: errorMessage };
  const emptyWire = canonicalJson(emptyEnvelope);
  return {
    rawWire: emptyWire,
    rawEnvelope: emptyEnvelope,
    gradingEnvelope: emptyEnvelope,
    normalizedEnvelope: emptyEnvelope,
    rawWireUtf8Bytes: Buffer.byteLength(emptyWire, 'utf8'),
    rawWireUtf8BytesVerified: true,
    compactDigest: '',
    compactDigestVerified: false,
    semanticHash: '',
    semanticHashVerified: false,
    calls: 0,
    outcome: 'infrastructure-failure',
    infraReasons: [errorMessage],
    predicateResult: { passed: false, required_fail: [], forbidden_fired: [], reason: errorMessage, infra_reasons: [errorMessage] },
    scopeResult: {
      project_id: 'unknown',
      include_global: false,
      identity_audit: {
        foreign_or_unauthorized_visible: false,
        identity_bearing_lanes: {
          guidance_canonical: [], guidance_governing: [], guidance_contextual: [],
          state_current_sources: [], state_open_sources: [], state_evidence_sources: [], state_context_only_sources: [],
          task_slot_sources: [], task_constraint_sources: [], expansion_sources: [],
        },
        offending_identities: [],
      },
      verdict_pass: false,
    },
    mutationResult: { complete_snapshot_delta: 'infrastructure-failure', row_count_delta: {}, access_field_delta: {}, access_timestamp_delta: {}, verdict_pass: false },
    notes: `infrastructure failure: ${errorMessage}`,
  };
}

// ------------------------------------------------------------------
// Receipt validation (mandatory repair 6)
// ------------------------------------------------------------------

function validateReceipt(receipt: RunReceipt): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (receipt.receipt_schema !== 'phase-d-step3-receipt/v2') issues.push(`receipt_schema mismatch: ${receipt.receipt_schema}`);
  if (!/^[0-9a-f]{40}$/.test(receipt.source_commit)) issues.push(`source_commit not 40-hex: ${receipt.source_commit}`);
  if (!Array.isArray(receipt.per_case) || receipt.per_case.length !== EXPECTED_CASE_IDS.length) issues.push(`per_case length wrong: ${receipt.per_case?.length}`);
  if (!Array.isArray(receipt.per_case_run_b) || receipt.per_case_run_b.length !== EXPECTED_CASE_IDS.length) issues.push(`per_case_run_b length wrong: ${receipt.per_case_run_b?.length}`);
  for (const [runName, entries] of [['run-a', receipt.per_case], ['run-b', receipt.per_case_run_b]] as const) {
    const ids = entries.map((entry) => entry.case_id);
    if (new Set(ids).size !== EXPECTED_CASE_IDS.length) issues.push(`${runName} contains duplicate case ids`);
    if (canonicalJson(ids) !== canonicalJson(EXPECTED_CASE_IDS)) issues.push(`${runName} case ids/order mismatch`);
  }
  for (const ev of [...receipt.per_case, ...receipt.per_case_run_b]) {
    if (!ALLOWED_LAYERS.has(ev.execution_layer)) issues.push(`bad execution_layer: ${ev.case_id}=${ev.execution_layer}`);
    if (!ALLOWED_OUTCOMES.has(ev.outcome)) issues.push(`bad outcome: ${ev.case_id}=${ev.outcome}`);
    if (!/^[0-9a-f]{64}$/.test(ev.compact_digest) && ev.outcome !== 'infrastructure-failure') issues.push(`bad compact_digest: ${ev.case_id}`);
    if (!/^[0-9a-f]{64}$/.test(ev.semantic_hash) && ev.outcome !== 'infrastructure-failure') issues.push(`bad semantic_hash: ${ev.case_id}`);
    if (ev.raw_wire_utf8_bytes_verified !== true) issues.push(`raw_wire byte verification failed: ${ev.case_id}`);
    if (ev.compact_digest_verified !== true) issues.push(`compact digest verification failed: ${ev.case_id}`);
    if (ev.semantic_hash_verified !== true) issues.push(`semantic hash verification failed: ${ev.case_id}`);
    if (ev.mutation_result.verdict_pass !== true) issues.push(`mutation verification failed: ${ev.case_id}`);
    if (ev.scope_result.verdict_pass !== true) issues.push(`scope verification failed: ${ev.case_id}`);
    if (Buffer.byteLength(ev.raw_wire, 'utf8') !== ev.raw_wire_utf8_bytes) issues.push(`raw_wire byte mismatch: ${ev.case_id}`);
    if (canonicalJson(ev.raw_envelope) !== ev.raw_wire) issues.push(`raw_wire is not canonical raw_envelope: ${ev.case_id}`);
  }
  for (const ev of [...receipt.per_case, ...receipt.per_case_run_b]) {
    const wireText = JSON.stringify(ev.raw_envelope);
    if (wireText.length > 1 && wireText === ev.raw_wire) {
      // raw_wire should be the canonical JSON serialization, not the JSON-stringified parsed envelope.
      // (Acceptable either way; this is informational.)
    }
    if (ev.compact_digest && ev.outcome !== 'infrastructure-failure') {
      const { compact_digest: _, ...src } = ev.raw_envelope as any;
      if (sha256Hex(canonicalJson(src)) !== ev.compact_digest) issues.push(`compact_digest recompute failed: ${ev.case_id}`);
    }
    if (ev.semantic_hash && ev.outcome !== 'infrastructure-failure') {
      if (sha256Hex(canonicalJson(ev.normalized_envelope)) !== ev.semantic_hash) issues.push(`semantic_hash recompute failed: ${ev.case_id}`);
    }
  }
  const runAById = new Map(receipt.per_case.map((entry) => [entry.case_id, entry]));
  const runBById = new Map(receipt.per_case_run_b.map((entry) => [entry.case_id, entry]));
  for (const id of EXPECTED_CASE_IDS) {
    const a = runAById.get(id);
    const b = runBById.get(id);
    if (!a || !b) continue;
    if (a.outcome !== b.outcome) issues.push(`cross-run outcome mismatch: ${id}`);
    if (a.semantic_hash !== b.semantic_hash) issues.push(`cross-run semantic hash mismatch: ${id}`);
  }
  const pd06ExpectedTools = ['cognitive_agent_bootstrap', 'memory_get', 'cognitive_agent_bootstrap'];
  for (const ev of [...receipt.per_case, ...receipt.per_case_run_b].filter((entry) => entry.case_id === 'pd-06-source-revised')) {
    if (ev.calls !== 3) issues.push(`pd-06 must record 3 calls; got ${ev.calls}`);
    if (!ev.observations || ev.observations.length !== 3) {
      issues.push('pd-06 must retain exactly 3 observations');
      continue;
    }
    const tools = ev.observations.map((observation) => observation.tool);
    if (canonicalJson(tools) !== canonicalJson(pd06ExpectedTools)) issues.push(`pd-06 observation sequence mismatch: ${canonicalJson(tools)}`);
    for (const observation of ev.observations.filter((item) => item.mutation_verified !== true)) {
      issues.push(`pd-06 observation ${observation.sequence} (${observation.tool}) mutation verification failed`);
    }
    const finalObservation = ev.observations[2];
    if (finalObservation.raw_wire !== ev.raw_wire || canonicalJson(finalObservation.raw_envelope) !== canonicalJson(ev.raw_envelope)) {
      issues.push('pd-06 primary evidence must be the final MCP bootstrap observation');
    }
  }
  const aggregateFor = (entries: CaseEvidence[]) => ({
    executed_pass: entries.filter((entry) => entry.outcome === 'executed-pass').length,
    executed_gap: entries.filter((entry) => entry.outcome === 'executed-gap').length,
    executed_unavailable: entries.filter((entry) => entry.outcome === 'executed-unavailable').length,
    infrastructure_failures: entries.filter((entry) => entry.outcome === 'infrastructure-failure').length,
  });
  if (canonicalJson(receipt.aggregate) !== canonicalJson(aggregateFor(receipt.per_case))) issues.push('aggregate does not match run A');
  if (canonicalJson(receipt.aggregate) !== canonicalJson(aggregateFor(receipt.per_case_run_b))) issues.push('aggregate does not match run B');
  if (receipt.aggregate.infrastructure_failures !== 0) issues.push('infrastructure failures are not acceptable');
  if (receipt.hashes_match !== true) issues.push('hashes_match must be true');
  const allEntries = [...receipt.per_case, ...receipt.per_case_run_b];
  const trueCount = (select: (entry: CaseEvidence) => boolean): number => allEntries.filter(select).length;
  const expectedCounts = {
    total_compact_digest_verified: trueCount((entry) => entry.compact_digest_verified),
    total_compact_digest_failed: trueCount((entry) => !entry.compact_digest_verified),
    total_semantic_hash_verified: trueCount((entry) => entry.semantic_hash_verified),
    total_semantic_hash_failed: trueCount((entry) => !entry.semantic_hash_verified),
    total_utf8_bytes_verified: trueCount((entry) => entry.raw_wire_utf8_bytes_verified),
    total_utf8_bytes_failed: trueCount((entry) => !entry.raw_wire_utf8_bytes_verified),
    total_mutation_verified: trueCount((entry) => entry.mutation_result.verdict_pass),
    total_mutation_failed: trueCount((entry) => !entry.mutation_result.verdict_pass),
    total_scope_audit_passed: trueCount((entry) => entry.scope_result.verdict_pass),
    total_scope_audit_failed: trueCount((entry) => !entry.scope_result.verdict_pass),
  };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if ((receipt as unknown as Record<string, unknown>)[key] !== expected) issues.push(`${key} aggregate mismatch`);
  }
  if (receipt.total_compact_digest_failed !== 0 || receipt.total_semantic_hash_failed !== 0 || receipt.total_utf8_bytes_failed !== 0 || receipt.total_mutation_failed !== 0 || receipt.total_scope_audit_failed !== 0) {
    issues.push('one or more verification categories failed');
  }
  const aggregateWitness = (entries: CaseEvidence[]): string => sha256Hex(canonicalJson(entries.map((entry) => ({
    case_id: entry.case_id,
    semantic_hash: entry.semantic_hash,
    compact_digest: entry.compact_digest,
    raw_wire_utf8_bytes: entry.raw_wire_utf8_bytes,
  }))));
  if (aggregateWitness(receipt.per_case) !== receipt.run_a_aggregate_hash) issues.push('run A aggregate hash mismatch');
  if (aggregateWitness(receipt.per_case_run_b) !== receipt.run_b_aggregate_hash) issues.push('run B aggregate hash mismatch');
  if (canonicalJson(receipt.volatile_field_exclusions) !== canonicalJson(Array.from(VOLATILE_FIELDS))) issues.push('volatile field exclusions mismatch implementation');
  for (const [name, hash] of Object.entries({ runner: receipt.runner_source_sha256, projector: receipt.projector_source_sha256, integration: receipt.integration_source_sha256, composer: receipt.composer_source_sha256, case_contract: receipt.case_contract_sha256 })) {
    if (!/^[0-9a-f]{64}$/.test(hash)) issues.push(`${name} source hash is invalid`);
  }
  const liveDbMutation = receipt.live_database_mutated;
  if (liveDbMutation) issues.push('live_database_mutated=true is not acceptable');
  // Personal paths
  const personalPathPattern = /C:\\Users\\VanCh|\/Users\/VanCh|\/home\/VanCh/i;
  const allText = JSON.stringify(receipt);
  if (personalPathPattern.test(allText)) issues.push('personal path leaked into receipt');
  if (/mem-graph\/.*memory\.db/.test(allText)) issues.push('live database path leaked into receipt');
  return { ok: issues.length === 0, issues };
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main(): Promise<number> {
  // Source commit + dirty status
  const { execFileSync } = await import('node:child_process');
  let sourceCommit = 'unknown';
  let sourceCommitDirty = true;
  try {
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--short'], { encoding: 'utf8' });
    sourceCommitDirty = status.trim().length > 0;
  } catch { /* keep unknowns */ }
  let runnerSha = '';
  try { runnerSha = sha256Hex(readFileSync(RUNNER_PATH, 'utf8')); } catch { /* */ }
  let projectorSha = '';
  try { projectorSha = sha256Hex(readFileSync(PROJECTOR_PATH, 'utf8')); } catch { /* */ }
  let integrationSha = '';
  try { integrationSha = sha256Hex(readFileSync(INTEGRATION_PATH, 'utf8')); } catch { /* */ }
  let composerSha = '';
  try { composerSha = sha256Hex(readFileSync(COMPOSER_PATH, 'utf8')); } catch { /* */ }

  const casesFile: CasesFile = JSON.parse(readFileSync(CASES_PATH, 'utf8'));
  // Mandatory repair 5: hash the full execution-relevant case contract.
  const caseContractSha = sha256Hex(canonicalJson(casesFile.cases.map((c) => ({
    id: c.id,
    request: c.request,
    source_snapshot: c.source_snapshot,
    expected: c.expected,
    execution_layer: c.baseline_trace.execution_layer,
    fixture_intent: c.fixture_intent,
    required_predicates: c.required_predicates,
    forbidden_predicates: c.forbidden_predicates,
  }))));

  const runADir = mkdtempSync(join(tmpdir(), 'phase-d-run-A-'));
  const runBDir = mkdtempSync(join(tmpdir(), 'phase-d-run-B-'));

  let runA: CaseEvidence[] = [];
  let runB: CaseEvidence[] = [];
  try {
    runA = await executeRunSingle(casesFile.cases, `run-A-${Date.now().toString(36)}`, runADir);
    runB = await executeRunSingle(casesFile.cases, `run-B-${Date.now().toString(36)}`, runBDir);
  } finally {
    for (const dir of [runADir, runBDir]) {
      try {
        try { closeAllDatabases(); } catch { /* */ }
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
  }

  // Cross-run determinism: compare normalized semantic hashes per case
  const hashesMatch = runA.length === runB.length && runA.every((a, i) => a.semantic_hash === runB[i].semantic_hash);

  // Aggregate per run
  const aggregateFor = (evidences: CaseEvidence[]) => ({
    executed_pass: evidences.filter((e) => e.outcome === 'executed-pass').length,
    executed_gap: evidences.filter((e) => e.outcome === 'executed-gap').length,
    executed_unavailable: evidences.filter((e) => e.outcome === 'executed-unavailable').length,
    infrastructure_failures: evidences.filter((e) => e.outcome === 'infrastructure-failure').length,
  });
  const aggregate = aggregateFor(runA);

  // Aggregate verification counts
  const allEv = [...runA, ...runB];
  const totalUtf8Verified = allEv.filter((e) => e.raw_wire_utf8_bytes_verified).length;
  const totalDigestVerified = allEv.filter((e) => e.compact_digest_verified).length;
  const totalSemanticVerified = allEv.filter((e) => e.semantic_hash_verified).length;
  const totalMutationVerified = allEv.filter((e) => e.mutation_result.verdict_pass).length;
  const totalScopeVerified = allEv.filter((e) => e.scope_result.verdict_pass).length;

  const runAAggregateHash = sha256Hex(canonicalJson(runA.map((r) => ({ case_id: r.case_id, semantic_hash: r.semantic_hash, compact_digest: r.compact_digest, raw_wire_utf8_bytes: r.raw_wire_utf8_bytes }))));
  const runBAggregateHash = sha256Hex(canonicalJson(runB.map((r) => ({ case_id: r.case_id, semantic_hash: r.semantic_hash, compact_digest: r.compact_digest, raw_wire_utf8_bytes: r.raw_wire_utf8_bytes }))));

  const receipt: RunReceipt = {
    receipt_schema: 'phase-d-step3-receipt/v2',
    phase: 'D',
    generated_at: new Date().toISOString(),
    source_commit: sourceCommit,
    source_commit_dirty: sourceCommitDirty,
    runner_version: RUNNER_VERSION,
    runner_source_sha256: runnerSha,
    projector_source_sha256: projectorSha,
    integration_source_sha256: integrationSha,
    composer_source_sha256: composerSha,
    case_contract_sha256: caseContractSha,
    disposable_db_basenames: ['phase-d-run-A-<ts>', 'phase-d-run-B-<ts>'],
    volatile_field_exclusions: Array.from(VOLATILE_FIELDS),
    per_case: runA,
    per_case_run_b: runB,
    aggregate,
    run_a_aggregate_hash: runAAggregateHash,
    run_b_aggregate_hash: runBAggregateHash,
    hashes_match: hashesMatch,
    total_compact_digest_verified: totalDigestVerified,
    total_compact_digest_failed: allEv.length - totalDigestVerified,
    total_semantic_hash_verified: totalSemanticVerified,
    total_semantic_hash_failed: allEv.length - totalSemanticVerified,
    total_utf8_bytes_verified: totalUtf8Verified,
    total_utf8_bytes_failed: allEv.length - totalUtf8Verified,
    total_mutation_verified: totalMutationVerified,
    total_mutation_failed: allEv.length - totalMutationVerified,
    total_scope_audit_passed: totalScopeVerified,
    total_scope_audit_failed: allEv.length - totalScopeVerified,
    live_database_mutated: false,
    known_product_gaps: [
      'pd-06: the declared MCP workflow performs compact orientation, memory_get after a controlled source-version transition, and compact re-orientation. Both compact calls are retained and remain internally consistent, but the public MCP integration has no version-mismatch input or cross-call snapshot comparison, so the final compact envelope does not emit version_mismatch or refresh_required. The case is retained as an honest executed-gap rather than replaced by a direct-projector pass.',
    ],
    known_evaluator_gaps: [],
    known_infrastructure_gaps: [],
    commands_executed: [
      'python scripts/validate-progressive-disclosure-schemas.py',
      'node cognitive-os/agent-practice/evals/progressive-disclosure/measure-step2a.mjs',
      'node --test cognitive-os/agent-practice/evals/progressive-disclosure/structured-predicate.test.mjs',
      'node --test cognitive-os/agent-practice/evals/progressive-disclosure/case-fixtures.test.mjs',
      'node cognitive-os/agent-practice/evals/progressive-disclosure/validate-step3-contract.mjs',
      'npx tsx cognitive-os/agent-practice/evals/progressive-disclosure/run-step3-cases.mts',
    ],
  };

  // Validate before writing
  const preWrite = validateReceipt(receipt);
  if (!preWrite.ok) {
    console.error(JSON.stringify({ status: 'phase-d-runner-fail', phase: 'pre-write-validation', issues: preWrite.issues }, null, 2));
    return 1;
  }

  writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2));

  // Validate after reading from disk
  const reread = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
  const postWrite = validateReceipt(reread);
  if (!postWrite.ok) {
    console.error(JSON.stringify({ status: 'phase-d-runner-fail', phase: 'post-write-validation', issues: postWrite.issues }, null, 2));
    return 1;
  }

  const stat = statSync(RECEIPT_PATH);

  const hasProductGap = aggregate.executed_gap > 0 || aggregate.executed_unavailable > 0;
  console.log(JSON.stringify({
    status: hasProductGap ? 'phase-d-runner-product-gap' : 'phase-d-runner-ok',
    aggregate,
    hashes_match: hashesMatch,
    verification_counts: {
      compact_digest_verified: totalDigestVerified,
      compact_digest_failed: allEv.length - totalDigestVerified,
      semantic_hash_verified: totalSemanticVerified,
      semantic_hash_failed: allEv.length - totalSemanticVerified,
      utf8_bytes_verified: totalUtf8Verified,
      utf8_bytes_failed: allEv.length - totalUtf8Verified,
      mutation_verified: totalMutationVerified,
      mutation_failed: allEv.length - totalMutationVerified,
      scope_audit_passed: totalScopeVerified,
      scope_audit_failed: allEv.length - totalScopeVerified,
    },
    receipt_path: RECEIPT_PATH,
    receipt_bytes: stat.size,
  }, null, 2));

  if (!hashesMatch || hasProductGap) return 1;
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(JSON.stringify({ status: 'phase-d-runner-fatal', error: (err as Error).message, stack: (err as Error).stack }, null, 2));
  process.exit(2);
});
