import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { findPolicyCandidates } from './policy.js';
import { diagnoseCurrentGuidance } from './retrieval.js';
import type {
  AgentBootstrapCanonicalRecord,
  AgentBootstrapInput,
  AgentBootstrapResult,
} from './types.js';

export const AGENT_PRACTICE_ID = 'mem-graph-agent-practice' as const;
export const AGENT_PRACTICE_VERSION = '1.0.0' as const;
export const COGNITIVE_OS_CANONICAL_BOOTSTRAP_IDS = [253, 254] as const;

interface CanonicalMemoryRow extends AgentBootstrapCanonicalRecord {
  content: string;
}

function normalizeCanonicalIds(input: AgentBootstrapInput): number[] {
  const requested =
    input.canonical_ids ??
    (input.project_id === 'cognitive-os' ? [...COGNITIVE_OS_CANONICAL_BOOTSTRAP_IDS] : []);
  return [...new Set(requested)]
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, 20)
    .sort((left, right) => left - right);
}

function readCanonicalSnapshot(
  db: Database.Database,
  input: AgentBootstrapInput,
  ids: number[],
): AgentBootstrapCanonicalRecord[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const scope = input.include_global
    ? "(project_id = ? OR project_id = '_global')"
    : 'project_id = ?';
  const rows = db
    .prepare(
      `SELECT id, layer, project_id, category, title, content, summary, status,
              lifecycle, confidence, importance_score, updated_at
       FROM memories
       WHERE id IN (${placeholders}) AND ${scope}
       ORDER BY id ASC`,
    )
    .all(...ids, input.project_id) as CanonicalMemoryRow[];

  return rows.map((row) => {
    if (input.include_canonical_content === true) return row;
    const { content: _content, ...metadata } = row;
    return metadata;
  });
}

/**
 * Compose the mandatory agent bootstrap from existing read surfaces only.
 * This function deliberately avoids memory access counters, graph expansion,
 * event append, policy evaluation, and every write-capable operation.
 */
export function bootstrapCognitiveAgent(
  db: Database.Database,
  input: AgentBootstrapInput,
): AgentBootstrapResult {
  const requestedIds = normalizeCanonicalIds(input);
  const canonicalRecords = readCanonicalSnapshot(db, input, requestedIds);
  const foundIds = new Set(canonicalRecords.map((record) => record.id));
  const includeGlobal = input.include_global === true;
  const scopedCandidates = findPolicyCandidates(db, {
    project_id: input.project_id,
    trigger_type: 'request_type',
    trigger_value: 'current_canonical_guidance',
  });
  const candidates = includeGlobal
    ? scopedCandidates
    : scopedCandidates.filter((candidate) => candidate.project_id === input.project_id);
  const guidance = diagnoseCurrentGuidance(db, input);
  const digestInput = {
    practice: `${AGENT_PRACTICE_ID}@${AGENT_PRACTICE_VERSION}`,
    project_id: input.project_id,
    include_global: includeGlobal,
    canonical: canonicalRecords.map((record) => [
      record.id,
      record.project_id,
      record.status,
      record.updated_at,
    ]),
    policies: candidates.map((candidate) => [candidate.policy_id, candidate.status]),
    governing: guidance.governing.map((record) => record.id),
    excluded: guidance.excluded.map((record) => [record.id, record.exclusion_reasons]),
  };

  return {
    practice: {
      id: AGENT_PRACTICE_ID,
      version: AGENT_PRACTICE_VERSION,
      status: 'adopted_advisory',
      hard_enforcement: false,
      authority_notice:
        'Bootstrap, retrieval rank, and governing eligibility do not grant authority. Verify canonical role, adoption, scope, applicability, and current evidence; user and system instructions remain higher priority.',
    },
    scope: {
      project_id: input.project_id,
      include_global: includeGlobal,
      global_inclusion: includeGlobal ? 'explicit' : 'disabled',
    },
    canonical_snapshot: {
      requested_ids: requestedIds,
      unresolved_or_out_of_scope_ids: requestedIds.filter((id) => !foundIds.has(id)),
      content_included: input.include_canonical_content === true,
      records: canonicalRecords,
    },
    policy_lookup: {
      trigger_type: 'request_type',
      trigger_value: 'current_canonical_guidance',
      authority: 'candidate_only',
      candidates,
    },
    guidance,
    verification: {
      required: true,
      instruction:
        'Select only governing-lane records that match the task, then fetch selected records directly when full content or authority verification is still needed. Treat excluded records as context, never as current guidance.',
    },
    mutation: {
      database_writes: 0,
      events_appended: 0,
      access_tracking: 'not_touched',
      receipt_persistence: 'none',
    },
    bootstrap_digest: createHash('sha256').update(JSON.stringify(digestInput)).digest('hex'),
  };
}
