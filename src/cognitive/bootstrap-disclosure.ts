import { createHash } from 'node:crypto';
import type {
  AgentBootstrapResult,
  CompactBootstrapV1,
  CompactExpansion,
  CompactMemoryReference,
  CompactPolicyReference,
  CompactSourceReference,
  CompactStatement,
  CompactStatementAuthority,
  CompactStatementLane,
  CompactStatementRole,
  CompactTaskSlot,
  TaskStateBootstrapEnvelope,
  TrustedSemanticRoleContext,
} from './types.js';

export const COMPACT_DISCLOSURE_VERSION = '1.0.0' as const;
export const DEFAULT_COMPACT_BUDGET_BYTES = 8192;

export interface ProjectCompactBootstrapOptions {
  profile: 'full' | 'agent';
  budget?: number;
  trustedRoleContext?: TrustedSemanticRoleContext;
}

const POSITIVE_DECIMAL_REGEX = /^[1-9][0-9]*$/;

/**
 * Validate and safely parse an epistemic record ID into a positive safe integer.
 * Bare parseInt is strictly forbidden because it allows trailing characters (e.g. '12junk' -> 12).
 */
export function parseEpistemicRecordId(id: string | number | undefined): number | null {
  if (typeof id === 'number') {
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  if (typeof id === 'string') {
    if (!POSITIVE_DECIMAL_REGEX.test(id)) return null;
    const num = Number(id);
    return Number.isSafeInteger(num) && num > 0 ? num : null;
  }
  return null;
}

/**
 * Valid, whitespace-free canonical JSON serializer with sorted object keys.
 * Omit undefined object properties, encode undefined array entries as null,
 * reject non-finite numbers and circular references.
 * Round-trip guarantee: JSON.parse(canonicalJson(val)) deep-equals val.
 */
export function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined || typeof value === 'symbol' || typeof value === 'function') {
    throw new TypeError(`Unsupported top-level value for canonical JSON: ${typeof value}`);
  }
  return serializeCanonical(value, seen);
}

function serializeCanonical(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot serialize non-finite number: ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') {
    throw new TypeError('Do not know how to serialize a BigInt');
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported type for serialization: ${typeof value}`);
  }

  if (seen.has(value)) {
    throw new TypeError('Converting circular structure to JSON');
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => {
        if (item === undefined || typeof item === 'symbol' || typeof item === 'function') {
          return 'null';
        }
        return serializeCanonical(item, seen);
      });
      return `[${items.join(',')}]`;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const val = record[key];
      if (val === undefined || typeof val === 'symbol' || typeof val === 'function') {
        continue;
      }
      entries.push(`${JSON.stringify(key)}:${serializeCanonical(val, seen)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export const stableJson = canonicalJson;

/**
 * Unicode-safe truncation operating on code points while tracking actual UTF-8 byte length.
 * Prevents surrogate pair splitting and emoji bisection.
 */
export function truncateUtf8CodePoints(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; bytes: number } {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) {
    return { text, truncated: false, bytes: totalBytes };
  }
  let accumulatedBytes = 0;
  const selectedCodePoints: string[] = [];
  for (const point of Array.from(text)) {
    const pointBytes = Buffer.byteLength(point, 'utf8');
    if (accumulatedBytes + pointBytes > maxBytes) {
      break;
    }
    selectedCodePoints.push(point);
    accumulatedBytes += pointBytes;
  }
  return {
    text: selectedCodePoints.join(''),
    truncated: true,
    bytes: accumulatedBytes,
  };
}

export function sourceStableKey(src: CompactSourceReference): string {
  if (src.kind === 'memory') return `memory:${src.project_id}:${src.id}`;
  if (src.kind === 'cognitive_event') {
    return `cognitive_event:${src.project_id}:${src.task_id ?? ''}:${src.event_id ?? ''}`;
  }
  if (src.kind === 'epistemic_record') return `epistemic_record:${src.project_id}:${src.record_id ?? ''}`;
  if (src.kind === 'cognitive_policy') return `cognitive_policy:${src.project_id}:${src.policy_id ?? ''}`;
  if (src.kind === 'artifact') return `artifact:${src.project_id}:${src.path ?? ''}`;
  if (src.kind === 'operator_receipt') return `operator_receipt:${src.project_id}:${src.receipt_id ?? ''}`;
  return `${src.kind}:${src.project_id}:${src.id ?? src.record_id ?? src.receipt_id ?? ''}`;
}

export function groupAndDeduplicateStatements(statements: CompactStatement[]): CompactStatement[] {
  const map = new Map<string, CompactStatement>();
  for (const stmt of statements) {
    const key = `${stmt.semantic_role ?? ''}:::${stmt.preview}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...stmt, sources: [...stmt.sources] });
    } else {
      for (const src of stmt.sources) {
        const srcKey = sourceStableKey(src);
        if (!existing.sources.some((s) => sourceStableKey(s) === srcKey)) {
          existing.sources.push(src);
        }
      }
      if (stmt.truncated) existing.truncated = true;
      if (stmt.review_state === 'contradiction_review_required') {
        existing.review_state = 'contradiction_review_required';
      }
    }
  }
  return Array.from(map.values()).map((s) => {
    s.sources.sort((a, b) => sourceStableKey(a).localeCompare(sourceStableKey(b)));
    return s;
  });
}

const LANE_PRIORITY: Record<CompactStatementLane, number> = {
  governing: 0,
  current_state: 1,
  open_state: 2,
  evidence: 3,
  context_only: 4,
};

export function compareStatements(a: CompactStatement, b: CompactStatement): number {
  const laneDiff = (LANE_PRIORITY[a.lane] ?? 99) - (LANE_PRIORITY[b.lane] ?? 99);
  if (laneDiff !== 0) return laneDiff;
  const aProj = a.sources[0]?.project_id ?? '';
  const bProj = b.sources[0]?.project_id ?? '';
  const projDiff = aProj.localeCompare(bProj);
  if (projDiff !== 0) return projDiff;
  const aKind = a.sources[0]?.kind ?? '';
  const bKind = b.sources[0]?.kind ?? '';
  const kindDiff = aKind.localeCompare(bKind);
  if (kindDiff !== 0) return kindDiff;
  const aId = a.sources[0] ? sourceStableKey(a.sources[0]) : '';
  const bId = b.sources[0] ? sourceStableKey(b.sources[0]) : '';
  const idDiff = aId.localeCompare(bId);
  if (idDiff !== 0) return idDiff;
  return a.preview.localeCompare(b.preview);
}

function deriveAdoptionStatus(
  envelope?: TaskStateBootstrapEnvelope,
): 'not_applicable' | 'verified' | 'unverified' {
  if (!envelope || envelope.status === 'unavailable') {
    return envelope ? 'unverified' : 'not_applicable';
  }
  const adoptionVerdict = (
    envelope.packet?.verification as { adoption?: { status?: string } } | undefined
  )?.adoption;
  if (!adoptionVerdict || !adoptionVerdict.status) {
    return 'not_applicable';
  }
  return adoptionVerdict.status === 'verified' ? 'verified' : 'unverified';
}

function cleanSourceReference(raw: Partial<CompactSourceReference>): CompactSourceReference {
  const clean: CompactSourceReference = {
    kind: raw.kind ?? 'memory',
    project_id: raw.project_id ?? '',
  };
  if (raw.id !== undefined) clean.id = raw.id;
  if (raw.event_id !== undefined) clean.event_id = raw.event_id;
  if (raw.task_id !== undefined) clean.task_id = raw.task_id;
  if (raw.record_id !== undefined) clean.record_id = String(raw.record_id);
  if (raw.policy_id !== undefined) clean.policy_id = raw.policy_id;
  if (raw.path !== undefined) clean.path = raw.path;
  if (raw.receipt_id !== undefined) clean.receipt_id = raw.receipt_id;
  if (raw.version !== undefined && raw.version !== null) clean.version = raw.version;
  if (raw.title !== undefined) clean.title = raw.title;
  if (raw.preview !== undefined) clean.preview = raw.preview;
  if (raw.truncated !== undefined) clean.truncated = raw.truncated;
  return clean;
}

function manifestItemIndex(itemId: string): number {
  const match = /\|constraint:(\d+)$/.exec(itemId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareTaskStateItems(
  a: { item_id: string; source: unknown },
  b: { item_id: string; source: unknown },
): number {
  const indexDiff = manifestItemIndex(a.item_id) - manifestItemIndex(b.item_id);
  if (indexDiff !== 0) return indexDiff;
  const idDiff = a.item_id.localeCompare(b.item_id);
  if (idDiff !== 0) return idDiff;
  return sourceStableKey(cleanSourceReference(a.source as Partial<CompactSourceReference>))
    .localeCompare(sourceStableKey(cleanSourceReference(b.source as Partial<CompactSourceReference>)));
}

export function buildExpansionRoute(
  source: CompactSourceReference | null,
  intent: 'read' | 'query' | 'diff' | 'trace' | 'policy' | 'refresh',
  profile: 'full' | 'agent',
  projectScope: { project_id: string; include_global: boolean; bootstrap_query?: string },
  extraArgs?: { from_as_of?: string; to_as_of?: string },
): { route_available: boolean; access_tracking: CompactExpansion['access_tracking']; route?: CompactExpansion['route']; reason?: CompactExpansion['reason'] } {
  if (intent === 'refresh') {
    if (!projectScope.bootstrap_query || projectScope.bootstrap_query.trim() === '') {
      return { route_available: false, access_tracking: 'none', reason: 'route_unavailable' };
    }
    return {
      route_available: true,
      access_tracking: 'none',
      route: {
        tool: 'cognitive_agent_bootstrap',
        arguments: {
          query: projectScope.bootstrap_query,
          project_id: projectScope.project_id,
          include_global: projectScope.include_global,
          response_mode: 'compact',
        },
      },
    };
  }

  if (intent === 'query') {
    if (profile === 'agent') {
      return {
        route_available: true,
        access_tracking: 'none',
        route: {
          tool: 'epistemic_inspect',
          operation: 'query',
          arguments: {
            operation: 'query',
            project_id: projectScope.project_id,
            include_global: projectScope.include_global,
          },
        },
      };
    }
    return {
      route_available: true,
      access_tracking: 'none',
      route: {
        tool: 'epistemic_query',
        arguments: {
          project_id: projectScope.project_id,
          include_global: projectScope.include_global,
        },
      },
    };
  }

  if (!source) {
    return { route_available: false, access_tracking: 'none', reason: 'source_unavailable' };
  }

  // Scope verification: Reject foreign or unrequested-global sources
  const isExactProject = source.project_id === projectScope.project_id;
  const isAllowedGlobal = projectScope.include_global && source.project_id === '_global';
  if (!isExactProject && !isAllowedGlobal) {
    return { route_available: false, access_tracking: 'none', reason: 'source_unavailable' };
  }

  if (source.kind === 'memory') {
    if (typeof source.id !== 'number' || source.id <= 0) {
      return { route_available: false, access_tracking: 'none', reason: 'route_unavailable' };
    }
    if (profile === 'agent') {
      return {
        route_available: true,
        access_tracking: 'touches_access_counters',
        route: {
          tool: 'memory_read',
          operation: 'get',
          arguments: {
            operation: 'get',
            id: source.id,
            project_id: projectScope.project_id,
            include_global: projectScope.include_global,
          },
        },
      };
    }
    return {
      route_available: true,
      access_tracking: 'touches_access_counters',
      route: {
        tool: 'memory_get',
        arguments: { id: source.id },
      },
    };
  }

  if (source.kind === 'cognitive_event') {
    const taskId = source.task_id;
    if (!taskId) {
      return { route_available: false, access_tracking: 'none', reason: 'source_unavailable' };
    }
    // Neither event tool accepts event_id; omit event_id to satisfy destination schemas
    if (profile === 'agent') {
      return {
        route_available: true,
        access_tracking: 'none',
        route: {
          tool: 'cognitive_event_read',
          arguments: {
            project_id: projectScope.project_id,
            task_id: taskId,
          },
        },
      };
    }
    return {
      route_available: true,
      access_tracking: 'none',
      route: {
        tool: 'cognitive_event_trace',
        arguments: {
          project_id: projectScope.project_id,
          task_id: taskId,
        },
      },
    };
  }

  if (source.kind === 'epistemic_record') {
    const numericId = parseEpistemicRecordId(source.record_id);
    if (numericId === null) {
      return { route_available: false, access_tracking: 'none', reason: 'route_unavailable' };
    }

    if (intent === 'diff') {
      if (!extraArgs?.from_as_of || !extraArgs?.to_as_of) {
        return { route_available: false, access_tracking: 'none', reason: 'route_unavailable' };
      }
      if (profile === 'agent') {
        return {
          route_available: true,
          access_tracking: 'none',
          route: {
            tool: 'epistemic_inspect',
            operation: 'diff',
            arguments: {
              operation: 'diff',
              record_id: numericId,
              project_id: projectScope.project_id,
              include_global: projectScope.include_global,
              from_as_of: extraArgs.from_as_of,
              to_as_of: extraArgs.to_as_of,
            },
          },
        };
      }
      return {
        route_available: true,
        access_tracking: 'none',
        route: {
          tool: 'epistemic_concept_diff',
          arguments: {
            record_id: numericId,
            project_id: projectScope.project_id,
            include_global: projectScope.include_global,
            from_as_of: extraArgs.from_as_of,
            to_as_of: extraArgs.to_as_of,
          },
        },
      };
    }

    // Default intent is get
    if (profile === 'agent') {
      return {
        route_available: true,
        access_tracking: 'none',
        route: {
          tool: 'epistemic_inspect',
          operation: 'get',
          arguments: {
            operation: 'get',
            record_id: numericId,
            project_id: projectScope.project_id,
            include_global: projectScope.include_global,
          },
        },
      };
    }
    return {
      route_available: true,
      access_tracking: 'none',
      route: {
        tool: 'epistemic_get',
        arguments: {
          record_id: numericId,
          project_id: projectScope.project_id,
          include_global: projectScope.include_global,
        },
      },
    };
  }

  if (source.kind === 'cognitive_policy') {
    if (intent !== 'policy' || !source.policy_id || profile === 'agent') {
      return { route_available: false, access_tracking: 'none', reason: 'route_unavailable' };
    }
    return {
      route_available: true,
      access_tracking: 'none',
      route: {
        tool: 'cognitive_policy_lookup',
        arguments: {
          project_id: projectScope.project_id,
          trigger_type: 'request_type',
          trigger_value: 'current_canonical_guidance',
        },
      },
    };
  }

  // Artifact and operator_receipt sources have no dedicated read tool in active profiles
  if (source.kind === 'artifact' || source.kind === 'operator_receipt') {
    return { route_available: false, access_tracking: 'none', reason: 'route_unavailable' };
  }

  return { route_available: false, access_tracking: 'unknown', reason: 'route_unavailable' };
}

/**
 * Pure projection from composed bootstrap result into deterministic CompactBootstrapV1 envelope.
 * Strictly performs no I/O, touches zero databases, and issues zero tool calls.
 */
export function projectCompactBootstrap(
  composed: AgentBootstrapResult & { task_state?: TaskStateBootstrapEnvelope },
  options: ProjectCompactBootstrapOptions,
): CompactBootstrapV1 {
  const profile = options.profile;
  const budgetLimit = options.budget ?? DEFAULT_COMPACT_BUDGET_BYTES;
  const projectScope = {
    project_id: composed.scope.project_id,
    include_global: composed.scope.include_global,
    bootstrap_query: options.trustedRoleContext?.bootstrap_query,
  };

  const warnings: string[] = [];
  const unresolved: string[] = [];
  const expansions: CompactExpansion[] = [];

  const truncatedPreviewKeys = new Set<string>();
  let itemsOmitted = 0;
  let totalContentBytesOmitted = 0;
  let requiredContentOmitted = options.trustedRoleContext?.required_content_omitted === true;
  const canonicalContentOmissions: Array<{ source: CompactSourceReference; expected_version: null }> = [];
  const canonicalHistorySources: CompactSourceReference[] = [];

  // 1. Recover warnings and unresolved from composed sources
  const rawWarnings = composed.task_state?.packet?.warnings ?? [];
  const contradictionPresent = rawWarnings.includes('explicit_contradiction_present');

  for (const w of rawWarnings) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  if (composed.task_state?.packet?.unresolved) {
    for (const u of composed.task_state.packet.unresolved) {
      if (!unresolved.includes(u)) unresolved.push(u);
    }
  }
  if (composed.task_state?.status === 'unavailable' && composed.task_state.reason) {
    if (!unresolved.includes(composed.task_state.reason)) unresolved.push(composed.task_state.reason);
  }

  // Determine affected contradiction sources
  const affectedContradictionKeys = new Set<string>();
  if (options.trustedRoleContext?.affected_contradiction_sources) {
    for (const src of options.trustedRoleContext.affected_contradiction_sources) {
      affectedContradictionKeys.add(
        sourceStableKey({
          kind: src.kind as any,
          project_id: src.project_id ?? projectScope.project_id,
          id: src.id,
          record_id: src.record_id ? String(src.record_id) : undefined,
          task_id: src.task_id,
          event_id: src.event_id,
        }),
      );
    }
  }

  const memoryReviewState = (projectId: string, id: number): CompactMemoryReference['review_state'] =>
    contradictionPresent && affectedContradictionKeys.has(`memory:${projectId}:${id}`)
      ? 'contradiction_review_required'
      : 'none';

  // 2. Filter contaminated inputs: only allow exact-project or explicitly enabled _global
  const isCandidateInScope = (candProjectId: string): boolean => {
    return candProjectId === projectScope.project_id || (projectScope.include_global && candProjectId === '_global');
  };

  const scopedCanonical = composed.canonical_snapshot.records.filter((rec) => isCandidateInScope(rec.project_id));
  const scopedGoverning = composed.guidance.governing.filter((rec) => isCandidateInScope(rec.project_id));
  const scopedExcluded = composed.guidance.excluded.filter((rec) => isCandidateInScope(rec.project_id));
  const scopedPolicies = composed.policy_lookup.candidates.filter((pol) => isCandidateInScope(pol.project_id));

  // 3. Guidance mapping
  const canonical: CompactMemoryReference[] = scopedCanonical.map((rec) => {
    const rawSummary = rec.summary ?? rec.title;
    const truncated = truncateUtf8CodePoints(rawSummary, 160);
    const itemKey = `memory:${rec.project_id}:${rec.id}`;
    if (truncated.truncated) truncatedPreviewKeys.add(itemKey);

    const fullBytes = (rec as any).content_bytes ?? (rec.content ? Buffer.byteLength(rec.content, 'utf8') : null);
    if (fullBytes !== null && fullBytes > truncated.bytes) {
      totalContentBytesOmitted += fullBytes - truncated.bytes;
      canonicalContentOmissions.push({
        source: cleanSourceReference({
          kind: 'memory',
          id: rec.id,
          project_id: rec.project_id,
          title: rec.title,
        }),
        expected_version: null,
      });
    }

    const res: CompactMemoryReference = {
      id: rec.id,
      project_id: rec.project_id,
      layer: rec.layer,
      category: rec.category,
      title: rec.title,
      status: rec.status,
      lifecycle: rec.lifecycle,
      truncated: truncated.truncated,
      review_state: memoryReviewState(rec.project_id, rec.id),
    };
    if (truncated.text) res.preview = truncated.text;
    if (rec.status !== 'active') {
      res.eligibility = 'contextual_ineligible';
      canonicalHistorySources.push(cleanSourceReference({
        kind: 'memory',
        id: rec.id,
        project_id: rec.project_id,
        title: rec.title,
      }));
    }
    return res;
  });

  const governingCandidates: CompactMemoryReference[] = scopedGoverning.map((rec) => {
    const rawSummary = rec.summary ?? rec.snippet ?? rec.title;
    const truncated = truncateUtf8CodePoints(rawSummary, 160);
    const itemKey = `memory:${rec.project_id}:${rec.id}`;
    if (truncated.truncated) truncatedPreviewKeys.add(itemKey);

    const fullBytes = (rec as any).content_bytes ?? null;
    if (fullBytes !== null && fullBytes > truncated.bytes) {
      totalContentBytesOmitted += fullBytes - truncated.bytes;
    }

    const res: CompactMemoryReference = {
      id: rec.id,
      project_id: rec.project_id,
      layer: rec.layer,
      category: rec.category,
      title: rec.title,
      status: rec.status,
      lifecycle: rec.lifecycle,
      truncated: truncated.truncated,
      review_state: memoryReviewState(rec.project_id, rec.id),
      eligibility: 'governing_eligible',
    };
    if (truncated.text) res.preview = truncated.text;
    return res;
  });

  const contextualCandidates: CompactMemoryReference[] = scopedExcluded.map((rec) => {
    const rawSummary = rec.snippet ?? rec.title;
    const truncated = truncateUtf8CodePoints(rawSummary, 120);
    const itemKey = `memory:${rec.project_id}:${rec.id}`;
    if (truncated.truncated) truncatedPreviewKeys.add(itemKey);

    const fullBytes = (rec as any).content_bytes ?? null;
    if (fullBytes !== null && fullBytes > truncated.bytes) {
      totalContentBytesOmitted += fullBytes - truncated.bytes;
    }

    const res: CompactMemoryReference = {
      id: rec.id,
      project_id: rec.project_id,
      layer: rec.layer,
      category: rec.category ?? null,
      title: rec.title,
      status: rec.status ?? 'active',
      lifecycle: rec.lifecycle ?? 'contextual',
      truncated: truncated.truncated,
      review_state: memoryReviewState(rec.project_id, rec.id),
      eligibility: 'contextual_ineligible',
    };
    if (truncated.text) res.preview = truncated.text;
    return res;
  });

  const policyCandidates: CompactPolicyReference[] = scopedPolicies.map((pol) => {
    const truncated = truncateUtf8CodePoints(pol.statement, 160);
    const itemKey = `policy:${pol.project_id}:${pol.policy_id}`;
    if (truncated.truncated) truncatedPreviewKeys.add(itemKey);

    const res: CompactPolicyReference = {
      policy_id: pol.policy_id,
      project_id: pol.project_id,
      title: pol.title,
      status: pol.status,
      authority: 'candidate_only',
      truncated: truncated.truncated,
    };
    if (truncated.text) res.preview = truncated.text;
    return res;
  });

  // 4. Task State recovery with multi-source grouping and trusted semantic binding
  let taskObjective: CompactTaskSlot = { status: 'unresolved', reason: 'task_objective_unresolved' };
  let taskDone: CompactTaskSlot = { status: 'unresolved', reason: 'definition_of_done_unresolved' };
  let taskNextAction: CompactTaskSlot = { status: 'unresolved', reason: 'expected_next_action_unresolved' };
  let taskConstraints: CompactBootstrapV1['task']['constraints'] = {
    status: 'unresolved',
    items: [],
    reason: 'task_constraints_unresolved',
  };

  const currentStatements: CompactStatement[] = [];
  const openStatements: CompactStatement[] = [];
  const evidenceStatements: CompactStatement[] = [];
  const contextOnlyStatements: CompactStatement[] = [];

  const packet = composed.task_state?.packet;

  if (packet) {
    const mapItemToStatement = (
      item: {
        item_id: string;
        preview: string;
        lane_membership: string;
        source: unknown;
        source_version: string | number | null;
      },
      role: CompactStatementRole | undefined,
      lane: CompactStatementLane,
      authority: CompactStatementAuthority,
      isRequiredTaskItem = false,
    ): CompactStatement => {
      const srcRef = cleanSourceReference(item.source as CompactSourceReference);
      if (item.source_version !== undefined && item.source_version !== null) {
        srcRef.version = item.source_version;
      }

      const truncated = truncateUtf8CodePoints(item.preview, 200);
      if (truncated.truncated) {
        truncatedPreviewKeys.add(item.item_id);
        if (isRequiredTaskItem) {
          requiredContentOmitted = true;
        }
      }

      const srcKey = sourceStableKey(srcRef);
      const isStatementContradicted =
        contradictionPresent &&
        affectedContradictionKeys.size > 0 &&
        affectedContradictionKeys.has(srcKey);

      const stmt: CompactStatement = {
        preview: truncated.text,
        lane,
        authority,
        review_state: isStatementContradicted ? 'contradiction_review_required' : 'none',
        sources: [srcRef],
        truncated: truncated.truncated,
      };
      if (role !== undefined) stmt.semantic_role = role;
      return stmt;
    };

    const attachOrGroupSlot = (
      existingSlot: CompactTaskSlot,
      role: CompactStatementRole,
      lane: CompactStatementLane,
      authority: CompactStatementAuthority,
      item: {
        item_id: string;
        preview: string;
        lane_membership: string;
        source: unknown;
        source_version: string | number | null;
      },
      reason?: string,
    ): CompactTaskSlot => {
      const newStmt = mapItemToStatement(item, role, lane, authority, lane === 'governing');
      if (existingSlot.statement) {
        // Group sources if preview matches, or add additional sources
        for (const src of newStmt.sources) {
          const srcKey = sourceStableKey(src);
          if (!existingSlot.statement.sources.some((s) => sourceStableKey(s) === srcKey)) {
            existingSlot.statement.sources.push(src);
          }
        }
        if (newStmt.truncated) existingSlot.statement.truncated = true;
        if (newStmt.review_state === 'contradiction_review_required') {
          existingSlot.statement.review_state = 'contradiction_review_required';
        }
        return existingSlot;
      }
      const slot: CompactTaskSlot = {
        status: lane === 'governing' ? 'governing' : 'context_only',
        statement: newStmt,
      };
      if (reason) slot.reason = reason;
      return slot;
    };

    // Recover from packet.governing
    for (const item of [...(packet.governing ?? [])].sort(compareTaskStateItems)) {
      if (item.item_id.endsWith('|objective')) {
        taskObjective = attachOrGroupSlot(taskObjective, 'objective', 'governing', 'adopted_task_orientation_only', item);
      } else if (item.item_id.endsWith('|definition_of_done')) {
        taskDone = attachOrGroupSlot(taskDone, 'definition_of_done', 'governing', 'adopted_task_orientation_only', item);
      } else if (item.item_id.endsWith('|expected_next_action')) {
        taskNextAction = attachOrGroupSlot(taskNextAction, 'expected_next_action', 'governing', 'adopted_task_orientation_only', item);
      } else if (item.item_id.includes('|constraint:')) {
        taskConstraints.items.push(mapItemToStatement(item, 'constraint', 'governing', 'adopted_task_orientation_only', true));
      }
    }

    // Trusted semantic role check for constraints
    if (taskConstraints.items.length > 0) {
      taskConstraints.status = 'resolved';
      delete taskConstraints.reason;
    } else if (options.trustedRoleContext?.constraints_declared_empty === true) {
      taskConstraints = { status: 'resolved', items: [] };
    } else {
      taskConstraints = { status: 'unresolved', items: [], reason: 'task_constraints_unresolved' };
    }

    // Recover from packet.context_only
    for (const item of [...(packet.context_only ?? [])].sort(compareTaskStateItems)) {
      if (taskObjective.status === 'unresolved' && item.item_id.endsWith('|objective')) {
        taskObjective = attachOrGroupSlot(taskObjective, 'objective', 'context_only', 'context_only', item, 'manifest_unadopted');
      } else if (taskDone.status === 'unresolved' && item.item_id.endsWith('|definition_of_done')) {
        taskDone = attachOrGroupSlot(taskDone, 'definition_of_done', 'context_only', 'context_only', item, 'manifest_unadopted');
      } else if (taskNextAction.status === 'unresolved' && item.item_id.endsWith('|expected_next_action')) {
        taskNextAction = attachOrGroupSlot(taskNextAction, 'expected_next_action', 'context_only', 'context_only', item, 'manifest_unadopted');
      } else if (taskConstraints.status === 'unresolved' && item.item_id.includes('|constraint:')) {
        taskConstraints.items.push(mapItemToStatement(item, 'constraint', 'context_only', 'context_only', false));
      } else {
        contextOnlyStatements.push(mapItemToStatement(item, undefined, 'context_only', 'context_only', false));
      }
    }

    if (taskConstraints.status === 'unresolved' && taskConstraints.items.length > 0) {
      taskConstraints.status = 'context_only';
      taskConstraints.reason = 'manifest_unadopted';
    }

    // Current state, open state, evidence
    for (const item of packet.current_state ?? []) {
      currentStatements.push(mapItemToStatement(item, 'current_state', 'current_state', 'evidence_only', false));
    }
    for (const item of packet.open_state ?? []) {
      openStatements.push(mapItemToStatement(item, 'open_state', 'open_state', 'evidence_only', false));
    }
    for (const item of packet.evidence ?? []) {
      evidenceStatements.push(mapItemToStatement(item, 'evidence', 'evidence', 'evidence_only', false));
    }
  }

  // Deduplicate and stably sort statements
  taskConstraints.items = groupAndDeduplicateStatements(taskConstraints.items);

  for (const slot of [taskObjective, taskDone, taskNextAction]) {
    slot.statement?.sources.sort((a, b) => sourceStableKey(a).localeCompare(sourceStableKey(b)));
  }

  const sortStatements = (list: CompactStatement[]): CompactStatement[] =>
    groupAndDeduplicateStatements(list).sort(compareStatements);

  const sortedCurrent = sortStatements(currentStatements);
  const sortedOpen = sortStatements(openStatements);
  const sortedEvidence = sortStatements(evidenceStatements);
  const sortedContextOnly = sortStatements(contextOnlyStatements);

  // 5. Expansions: provide expansion to verify top governing candidates in partial/unresolved states
  const addExpansion = (exp: CompactExpansion): void => {
    const expKey = `${exp.reason}:${exp.source ? sourceStableKey(exp.source) : 'none'}`;
    if (!expansions.some((e) => `${e.reason}:${e.source ? sourceStableKey(e.source) : 'none'}` === expKey)) {
      expansions.push(exp);
    }
  };

  for (const id of composed.canonical_snapshot.unresolved_or_out_of_scope_ids) {
    const unresolvedCode = `canonical_source_unavailable:${id}`;
    if (!unresolved.includes(unresolvedCode)) unresolved.push(unresolvedCode);
    addExpansion({
      reason: 'source_unavailable',
      source: cleanSourceReference({ kind: 'memory', id, project_id: projectScope.project_id }),
      expected_version: null,
      route_available: false,
      access_tracking: 'none',
    });
  }

  for (const omission of canonicalContentOmissions) {
    const routeInfo = buildExpansionRoute(omission.source, 'read', profile, projectScope);
    addExpansion({
      reason: 'content_omitted',
      source: omission.source,
      expected_version: omission.expected_version,
      route_available: routeInfo.route_available,
      access_tracking: routeInfo.access_tracking,
      ...(routeInfo.route ? { route: routeInfo.route } : {}),
    });
  }

  for (const source of canonicalHistorySources) {
    const routeInfo = buildExpansionRoute(source, 'read', profile, projectScope);
    addExpansion({
      reason: 'history_requested',
      source,
      expected_version: null,
      route_available: routeInfo.route_available,
      access_tracking: routeInfo.access_tracking,
      ...(routeInfo.route ? { route: routeInfo.route } : {}),
    });
  }

  for (const mismatch of options.trustedRoleContext?.version_mismatches ?? []) {
    const source = cleanSourceReference(mismatch.source);
    const routeInfo = buildExpansionRoute(source, 'refresh', profile, projectScope);
    if (!unresolved.includes('refresh_required')) unresolved.push('refresh_required');
    addExpansion({
      reason: 'version_mismatch',
      source,
      expected_version: mismatch.expected_version,
      route_available: routeInfo.route_available,
      access_tracking: routeInfo.access_tracking,
      ...(routeInfo.route ? { route: routeInfo.route } : {}),
    });
  }

  const taskAdoptedAndVerifiedPrelim = deriveAdoptionStatus(composed.task_state) === 'verified';
  const taskObjectiveResolvedPrelim = taskObjective.status === 'governing';
  const taskDoneResolvedPrelim = taskDone.status === 'governing';
  const taskConstraintsResolvedPrelim = taskConstraints.status === 'resolved';
  const taskNextActionResolvedPrelim = taskNextAction.status === 'governing';
  const hasContradictedRequiredPrelim =
    taskObjective.statement?.review_state === 'contradiction_review_required' ||
    taskDone.statement?.review_state === 'contradiction_review_required' ||
    taskNextAction.statement?.review_state === 'contradiction_review_required' ||
    taskConstraints.items.some((i) => i.review_state === 'contradiction_review_required');
  const noUnresolvedPrelim = unresolved.length === 0;
  const isCompleteOrientationCandidate =
    taskAdoptedAndVerifiedPrelim &&
    taskObjectiveResolvedPrelim &&
    taskDoneResolvedPrelim &&
    taskConstraintsResolvedPrelim &&
    taskNextActionResolvedPrelim &&
    !hasContradictedRequiredPrelim &&
    noUnresolvedPrelim &&
    !requiredContentOmitted &&
    composed.task_state?.status === 'assembled';

  if (!isCompleteOrientationCandidate) {
    for (const cand of governingCandidates.slice(0, 5)) {
      const srcRef = cleanSourceReference({
        kind: 'memory',
        id: cand.id,
        project_id: cand.project_id,
        title: cand.title,
      });
      const routeInfo = buildExpansionRoute(srcRef, 'read', profile, projectScope);
      const candKey = sourceStableKey(srcRef);
      const reason =
        contradictionPresent && affectedContradictionKeys.size > 0 && affectedContradictionKeys.has(candKey)
          ? 'contradiction_requires_review'
          : 'verify_authority';

      addExpansion({
        reason,
        source: srcRef,
        expected_version: null,
        route_available: routeInfo.route_available,
        access_tracking: routeInfo.access_tracking,
        ...(routeInfo.route ? { route: routeInfo.route } : {}),
      });
    }
  }

  // 6. Assemble envelope shell
  const taskStateStatus: CompactBootstrapV1['orientation']['task_state'] =
    composed.task_state === undefined
      ? 'not_requested'
      : composed.task_state?.status === 'assembled'
        ? 'assembled'
        : 'unavailable';

  const applicability = composed.task_state?.packet?.applicability ?? 'unknown';

  const envelope: CompactBootstrapV1 = {
    disclosure_version: COMPACT_DISCLOSURE_VERSION,
    response_mode: 'compact',
    profile,
    scope: {
      project_id: composed.scope.project_id,
      include_global: composed.scope.include_global,
      global_inclusion: composed.scope.global_inclusion,
    },
    orientation: {
      status: isCompleteOrientationCandidate ? 'complete' : 'partial',
      requires_expansion: !isCompleteOrientationCandidate,
      task_state: taskStateStatus,
      applicability,
    },
    task: {
      objective: taskObjective,
      definition_of_done: taskDone,
      constraints: taskConstraints,
      next_action: taskNextAction,
    },
    guidance: {
      canonical: canonical.sort((a, b) => a.id - b.id),
      governing_candidates: governingCandidates.sort((a, b) => a.id - b.id),
      contextual_candidates: contextualCandidates.sort((a, b) => a.id - b.id),
      policy_candidates: policyCandidates.sort((a, b) => a.policy_id.localeCompare(b.policy_id)),
    },
    state: {
      current: sortedCurrent,
      open: sortedOpen,
      evidence: sortedEvidence,
      context_only: sortedContextOnly,
    },
    warnings: warnings.sort(),
    unresolved: unresolved.sort(),
    expansions,
    omissions: {
      previews_truncated: truncatedPreviewKeys.size,
      items_omitted: itemsOmitted,
      content_bytes_omitted: totalContentBytesOmitted > 0 ? totalContentBytesOmitted : null,
      required_content_omitted: requiredContentOmitted,
    },
    source_snapshot: {
      bootstrap_digest: composed.bootstrap_digest,
      task_state_envelope_digest: composed.task_state?.envelope_digest ?? null,
      task_state_packet_digest: composed.task_state?.packet?.packet_digest ?? null,
    },
    verification: {
      required: true,
      authority_notice:
        'Compact orientation is source-backed projection only. Manifest status, retrieval rank, repetition, and compact inclusion do not independently grant authority. Verify canonical role, adoption, scope, applicability, and current evidence before relying on claims. Expansion routes invoke external read tools that may record access tracking.',
      adoption_status: deriveAdoptionStatus(composed.task_state),
    },
    mutation: {
      database_writes: 0,
      events_appended: 0,
      access_tracking: 'not_touched',
      receipt_persistence: 'none',
    },
    budget: {
      limit_bytes: budgetLimit,
      serialized_bytes: 0,
      within_budget: true,
    },
    compact_digest: '0'.repeat(64),
  };

  // 7. Deterministic Byte Budgeting Priority Ladder (§7)
  const syncOmissions = (): void => {
    envelope.omissions.previews_truncated = truncatedPreviewKeys.size;
    envelope.omissions.items_omitted = itemsOmitted;
    envelope.omissions.content_bytes_omitted = totalContentBytesOmitted > 0 ? totalContentBytesOmitted : null;
    envelope.omissions.required_content_omitted = requiredContentOmitted;
  };
  const measure = (): number => {
    syncOmissions();
    envelope.budget.serialized_bytes = Buffer.byteLength(canonicalJson(envelope), 'utf8');
    return Buffer.byteLength(canonicalJson(envelope), 'utf8');
  };

  // Stage 1: Shorten optional contextual and canonical previews
  if (measure() > budgetLimit) {
    for (const cand of envelope.guidance.contextual_candidates) {
      if (cand.preview) {
        totalContentBytesOmitted += Buffer.byteLength(cand.preview, 'utf8');
        cand.preview = '';
        cand.truncated = true;
        truncatedPreviewKeys.add(`memory:${cand.project_id}:${cand.id}`);
        if (measure() <= budgetLimit) break;
      }
    }
  }

  if (measure() > budgetLimit) {
    for (const rec of envelope.guidance.canonical) {
      if (rec.preview) {
        totalContentBytesOmitted += Buffer.byteLength(rec.preview, 'utf8');
        rec.preview = '';
        rec.truncated = true;
        truncatedPreviewKeys.add(`memory:${rec.project_id}:${rec.id}`);
        if (measure() <= budgetLimit) break;
      }
    }
  }

  // Stage 2: Omit optional context & evidence items
  if (measure() > budgetLimit && envelope.guidance.contextual_candidates.length > 0) {
    for (const cand of envelope.guidance.contextual_candidates) {
      const srcRef = cleanSourceReference({ kind: 'memory', id: cand.id, project_id: cand.project_id, title: cand.title });
      const routeInfo = buildExpansionRoute(srcRef, 'read', profile, projectScope);
      addExpansion({
        reason: 'content_omitted',
        source: srcRef,
        expected_version: null,
        route_available: routeInfo.route_available,
        access_tracking: routeInfo.access_tracking,
        ...(routeInfo.route ? { route: routeInfo.route } : {}),
      });
      itemsOmitted++;
    }
    envelope.guidance.contextual_candidates = [];
  }

  if (measure() > budgetLimit && envelope.state.context_only.length > 0) {
    for (const stmt of envelope.state.context_only) {
      for (const src of stmt.sources) {
        const routeInfo = buildExpansionRoute(src, src.kind === 'cognitive_event' ? 'trace' : 'read', profile, projectScope);
        addExpansion({
          reason: 'content_omitted',
          source: src,
          expected_version: src.version ?? null,
          route_available: routeInfo.route_available,
          access_tracking: routeInfo.access_tracking,
          ...(routeInfo.route ? { route: routeInfo.route } : {}),
        });
      }
    }
    itemsOmitted += envelope.state.context_only.length;
    envelope.state.context_only = [];
  }

  if (measure() > budgetLimit && envelope.state.evidence.length > 0) {
    for (const stmt of envelope.state.evidence) {
      for (const src of stmt.sources) {
        const routeInfo = buildExpansionRoute(src, src.kind === 'cognitive_event' ? 'trace' : 'read', profile, projectScope);
        addExpansion({
          reason: 'content_omitted',
          source: src,
          expected_version: src.version ?? null,
          route_available: routeInfo.route_available,
          access_tracking: routeInfo.access_tracking,
          ...(routeInfo.route ? { route: routeInfo.route } : {}),
        });
      }
    }
    itemsOmitted += envelope.state.evidence.length;
    envelope.state.evidence = [];
  }

  // Stage 3: Shorten policy previews
  if (measure() > budgetLimit) {
    for (const pol of envelope.guidance.policy_candidates) {
      if (pol.preview) {
        totalContentBytesOmitted += Buffer.byteLength(pol.preview, 'utf8');
        pol.preview = '';
        pol.truncated = true;
        truncatedPreviewKeys.add(`policy:${pol.project_id}:${pol.policy_id}`);
        if (measure() <= budgetLimit) break;
      }
    }
  }

  // Stage 4: Omit policy candidates
  if (measure() > budgetLimit && envelope.guidance.policy_candidates.length > 0) {
    for (const pol of envelope.guidance.policy_candidates) {
      const srcRef: CompactSourceReference = {
        kind: 'cognitive_policy',
        project_id: pol.project_id,
        policy_id: pol.policy_id,
        title: pol.title,
      };
      const routeInfo = buildExpansionRoute(srcRef, 'policy', profile, projectScope);
      addExpansion({
        reason: 'content_omitted',
        source: srcRef,
        expected_version: null,
        route_available: routeInfo.route_available,
        access_tracking: routeInfo.access_tracking,
        ...(routeInfo.route ? { route: routeInfo.route } : {}),
      });
    }
    itemsOmitted += envelope.guidance.policy_candidates.length;
    envelope.guidance.policy_candidates = [];
  }

  // Stage 5: Shorten current/open previews
  if (measure() > budgetLimit) {
    for (const stmt of [...envelope.state.current, ...envelope.state.open]) {
      if (stmt.preview) {
        totalContentBytesOmitted += Buffer.byteLength(stmt.preview, 'utf8');
        stmt.preview = '';
        stmt.truncated = true;
        truncatedPreviewKeys.add(sourceStableKey(stmt.sources[0]));
        if (measure() <= budgetLimit) break;
      }
    }
  }

  // Stage 6: Shorten governing candidate previews
  if (measure() > budgetLimit) {
    for (const gov of envelope.guidance.governing_candidates) {
      if (gov.preview) {
        totalContentBytesOmitted += Buffer.byteLength(gov.preview, 'utf8');
        gov.preview = '';
        gov.truncated = true;
        truncatedPreviewKeys.add(`memory:${gov.project_id}:${gov.id}`);
        if (measure() <= budgetLimit) break;
      }
    }
  }

  // Update omissions counts
  envelope.omissions.previews_truncated = truncatedPreviewKeys.size;
  envelope.omissions.items_omitted = itemsOmitted;
  envelope.omissions.content_bytes_omitted = totalContentBytesOmitted > 0 ? totalContentBytesOmitted : null;
  envelope.omissions.required_content_omitted = requiredContentOmitted;

  // Stably sort expansions
  envelope.expansions.sort((a, b) =>
    a.reason.localeCompare(b.reason) ||
    (a.source?.kind ?? '').localeCompare(b.source?.kind ?? '') ||
    (a.source ? sourceStableKey(a.source) : '').localeCompare(b.source ? sourceStableKey(b.source) : ''),
  );

  // 8. Derive Orientation Status (§5.1 & Invariant P0-3)
  const taskAdoptedAndVerified = envelope.verification.adoption_status === 'verified';
  const taskObjectiveResolved = envelope.task.objective.status === 'governing';
  const taskDoneResolved = envelope.task.definition_of_done.status === 'governing';
  const taskConstraintsResolved = envelope.task.constraints.status === 'resolved';
  const taskNextActionResolved = envelope.task.next_action.status === 'governing';
  const hasContradictedRequiredStatement =
    envelope.task.objective.statement?.review_state === 'contradiction_review_required' ||
    envelope.task.definition_of_done.statement?.review_state === 'contradiction_review_required' ||
    envelope.task.next_action.statement?.review_state === 'contradiction_review_required' ||
    envelope.task.constraints.items.some((item) => item.review_state === 'contradiction_review_required');
  const noUnresolved = envelope.unresolved.length === 0;

  const couldBeComplete =
    taskAdoptedAndVerified &&
    taskObjectiveResolved &&
    taskDoneResolved &&
    taskConstraintsResolved &&
    taskNextActionResolved &&
    !hasContradictedRequiredStatement &&
    noUnresolved &&
    !envelope.omissions.required_content_omitted &&
    envelope.omissions.items_omitted === 0 &&
    envelope.expansions.length === 0 &&
    envelope.orientation.task_state === 'assembled' &&
    measure() <= budgetLimit;

  if (couldBeComplete) {
    envelope.orientation.status = 'complete';
    envelope.orientation.requires_expansion = false;
  } else {
    envelope.orientation.status = 'partial';
    envelope.orientation.requires_expansion = true;
  }

  // 9. Fixed-Point Byte Count Stabilization (§7)
  let bytes = 0;
  for (let iter = 0; iter < 4; iter++) {
    envelope.budget.serialized_bytes = bytes;
    envelope.budget.within_budget = bytes <= envelope.budget.limit_bytes;
    bytes = Buffer.byteLength(canonicalJson(envelope), 'utf8');
    if (envelope.budget.serialized_bytes === bytes) {
      break;
    }
    if (iter === 3 && envelope.budget.serialized_bytes !== bytes) {
      throw new Error('Compact envelope byte count failed to converge within 4 passes');
    }
  }

  if (bytes > budgetLimit) {
    envelope.budget.within_budget = false;
    if (!envelope.warnings.includes('compact_budget_overflow')) {
      envelope.warnings.push('compact_budget_overflow');
      envelope.warnings.sort();
    }
    // Overflow forces partial status!
    envelope.orientation.status = 'partial';
    envelope.orientation.requires_expansion = true;

    // Re-run stabilization with the added warning and updated status
    bytes = Buffer.byteLength(canonicalJson(envelope), 'utf8');
    for (let iter = 0; iter < 4; iter++) {
      envelope.budget.serialized_bytes = bytes;
      bytes = Buffer.byteLength(canonicalJson(envelope), 'utf8');
      if (envelope.budget.serialized_bytes === bytes) break;
    }
  } else {
    envelope.budget.within_budget = true;
  }

  // 10. Compute Compact Digest over canonical JSON excluding compact_digest
  const { compact_digest: _, ...digestSource } = envelope;
  envelope.compact_digest = createHash('sha256').update(canonicalJson(digestSource), 'utf8').digest('hex');

  return envelope;
}
