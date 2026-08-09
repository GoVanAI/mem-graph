/**
 * Epistemic Memory MCP tools — Step 7 of EPB-001.
 *
 * Per [[283]] Step 7 acceptance:
 *   - thin Zod adapters only; domain logic lives below the adapter;
 *   - read tools (epistemic_get, epistemic_query, epistemic_integrity_check)
 *     are zero-write and never touch access counters, events, receipts,
 *     or projections;
 *   - mutation tools (epistemic_admit, epistemic_append_receipt) return
 *     stable error codes from EPB-001 D17 and fail closed;
 *   - bounds: default limit=50, hard cap=500 (EPB-001 D18);
 *   - no CRUD-style delete or update tool exists.
 *
 * Slice 1 ships 5 tools:
 *   - epistemic_admit (mutation)
 *   - epistemic_get (read)
 *   - epistemic_query (read)
 *   - epistemic_append_receipt (mutation)
 *   - epistemic_integrity_check (read)
 *
 * Relation mutation (Option B) is intentionally NOT exposed. contradictions
 * and review_queue arrive with Step 8 maintenance lane.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDatabase } from '../db.js';
import { jsonResult } from '../util.js';
import {
  admitEpistemicRecord,
  appendEpistemicReceipt,
  EpistemicAdmissionError,
} from '../epistemic/persistence.js';
import {
  integrityAudit,
  projectCurrentState,
  asOfQuery,
} from '../epistemic/projections.js';

const EPISTEMIC_STATUSES = [
  'verified',
  'corroborated',
  'inferred',
  'reported',
  'assumed',
  'contested',
  'stale',
  'retracted',
] as const;

const SCOPES = ['exact-project', '_global'] as const;

const RECEIPT_TYPES = [
  'ChallengeReceipt',
  'BeliefUseReceipt',
  'DecisionOutcomeReceipt',
  'ContradictionSignal',
  'ReviewDeadlineReceipt',
] as const;

const ADMIT_INPUT = {
  idempotency_key: z.string().min(1).max(256),
  record_id: z.number().int().positive().optional(),
  expected_revision: z.number().int().nonnegative().optional(),
  previous_revision_id: z.string().uuid().optional(),
  project_id: z.string().min(1),
  scope: z.enum(SCOPES),
  statement: z.string().min(1),
  epistemic_status: z.enum(EPISTEMIC_STATUSES),
  verification_level: z.string().min(1),
  source_quality: z.string().min(1),
  confidence: z.number().min(0).max(1),
  valid_from: z.string().min(1),
  valid_until: z.string().nullable().optional(),
  source_memory_id: z.number().int().positive().nullable().optional(),
  supersedes_record_id: z.number().int().positive().nullable().optional(),
  superseded_by_record_id: z.number().int().positive().nullable().optional(),
  provenance: z
    .object({
      excerpt_hash: z.string().nullable().optional(),
      observed_at: z.string().nullable().optional(),
      observed_by_role: z.string().nullable().optional(),
      authority_input: z.unknown().optional(),
    })
    .optional(),
  task_id: z.string().min(1),
  session_id: z.string().optional(),
  observed_at: z.string().optional(),
} as const;

const RECEIPT_INPUT = {
  idempotency_key: z.string().min(1).max(256),
  record_id: z.number().int().positive(),
  revision_id: z.string().uuid(),
  receipt_type: z.enum(RECEIPT_TYPES),
  receipt_payload: z.unknown(),
  independence_key: z.string().nullable().optional(),
  observed_at: z.string().min(1),
  task_id: z.string().min(1),
  project_id: z.string().min(1),
  session_id: z.string().optional(),
} as const;

const QUERY_INPUT = {
  project_id: z.string().min(1),
  include_global: z.boolean().optional(),
  scope: z.enum(SCOPES).optional(),
  epistemic_status: z.enum(EPISTEMIC_STATUSES).optional(),
  limit: z.number().int().positive().max(500).default(50),
} as const;

const GET_INPUT = {
  record_id: z.number().int().positive(),
  project_id: z.string().min(1),
  include_global: z.boolean().optional(),
  as_of: z.string().optional(),
} as const;

function formatError(e: unknown): { code: string; message: string } {
  if (e instanceof EpistemicAdmissionError) {
    return { code: e.code, message: e.message };
  }
  const message = e instanceof Error ? e.message : String(e);
  // Stable contract: surface EPISTEMIC_PAYLOAD_INVALID and any other
  // admission gate codes verbatim. Anything else falls through to
  // INTERNAL_ERROR so callers can branch.
  if (message.startsWith('EPISTEMIC_PAYLOAD_INVALID')) {
    return { code: 'EPISTEMIC_PAYLOAD_INVALID', message };
  }
  return { code: 'INTERNAL_ERROR', message };
}

export function registerEpistemicTools(server: McpServer): void {
  // ─── Mutation: epistemic_admit ─────────────────────────────────────
  server.tool(
    'epistemic_admit',
    'Atomically admit a new or revised epistemic record. The transaction appends a typed BeliefRevised source event, an immutable revision row, an immutable provenance row, and upserts the current projection. Refuses non-empty relations with RELATION_PERSISTENCE_NOT_ADOPTED. Stale expected_revision fails closed with STALE_REVISION. Idempotent on idempotency_key.',
    ADMIT_INPUT,
    async (input) => {
      try {
        const result = admitEpistemicRecord(getDatabase('memory'), input);
        return jsonResult({ ok: true, ...result });
      } catch (e) {
        const err = formatError(e);
        return jsonResult({ ok: false, ...err });
      }
    },
  );

  // ─── Mutation: epistemic_append_receipt ────────────────────────────
  server.tool(
    'epistemic_append_receipt',
    'Append an immutable epistemic receipt (challenge, use, outcome, contradiction signal, or review deadline) linked to an existing revision. Receipts are append-only evidence; they do not mutate the current projection.',
    RECEIPT_INPUT,
    async (input) => {
      try {
        const result = appendEpistemicReceipt(getDatabase('memory'), input);
        return jsonResult({ ok: true, ...result });
      } catch (e) {
        const err = formatError(e);
        return jsonResult({ ok: false, ...err });
      }
    },
  );

  // ─── Read: epistemic_get ───────────────────────────────────────────
  server.tool(
    'epistemic_get',
    'Read a single epistemic record by id. Zero-write; never touches access counters, events, receipts, or projections. Optional as_of returns the record state at that cutoff.',
    GET_INPUT,
    async (input) => {
      const db = getDatabase('memory');
      try {
        if (input.as_of) {
          const asOf = asOfQuery(db, input.record_id, input.as_of);
          if (!asOf) {
            return jsonResult({
              ok: false,
              code: 'OUT_OF_SCOPE',
              message: `record ${input.record_id} has no state at or before ${input.as_of}`,
            });
          }
          return jsonResult({ ok: true, record: asOf, mode: 'as_of' });
        }
        const rows = projectCurrentState(db).filter((r) => r.record_id === input.record_id);
        if (rows.length === 0) {
          return jsonResult({
            ok: false,
            code: 'OUT_OF_SCOPE',
            message: `record ${input.record_id} does not exist`,
          });
        }
        const row = rows[0];
        // Enforce project_id scope unless include_global is set.
        if (!input.include_global && row.project_id !== input.project_id) {
          return jsonResult({
            ok: false,
            code: 'OUT_OF_SCOPE',
            message: `record ${input.record_id} belongs to project ${row.project_id}`,
          });
        }
        return jsonResult({ ok: true, record: row, mode: 'current' });
      } catch (e) {
        return jsonResult({ ok: false, ...formatError(e) });
      }
    },
  );

  // ─── Read: epistemic_query ─────────────────────────────────────────
  server.tool(
    'epistemic_query',
    'List epistemic records filtered by project_id (default exact-project) and optional epistemic_status / scope. Zero-write; default limit=50, hard cap=500. Returns the current projection state.',
    QUERY_INPUT,
    async (input) => {
      const db = getDatabase('memory');
      try {
        const all = projectCurrentState(db);
        const filtered = all.filter((r) => {
          if (!input.include_global && r.project_id !== input.project_id) return false;
          if (input.include_global && r.project_id !== input.project_id && r.scope !== '_global') return false;
          if (input.scope && r.scope !== input.scope) return false;
          if (input.epistemic_status && r.epistemic_status !== input.epistemic_status) return false;
          return true;
        });
        const records = filtered.slice(0, input.limit);
        return jsonResult({
          ok: true,
          total_matched: filtered.length,
          returned: records.length,
          limit: input.limit,
          records,
        });
      } catch (e) {
        return jsonResult({ ok: false, ...formatError(e) });
      }
    },
  );

  // ─── Read: epistemic_integrity_check ───────────────────────────────
  server.tool(
    'epistemic_integrity_check',
    'Read-only integrity audit over revisions and projection. Reports 5 stable codes (MISSING_REVISION, WRONG_SCOPE_REVISION, FORWARD_DATED_REVISION, DUPLICATE_REVISION_NUMBER, INCONSISTENT_PROJECTION). Zero-write.',
    {},
    async () => {
      const db = getDatabase('memory');
      try {
        const report = integrityAudit(db);
        return jsonResult(report);
      } catch (e) {
        return jsonResult({ ok: false, ...formatError(e) });
      }
    },
  );
}
