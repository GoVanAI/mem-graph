import { createHash } from 'node:crypto';

/** Contract v1 stable classifications.  This module is deliberately data-only:
 * callers provide snapshots from whatever read-only surfaces they own. */
export const TASK_STATE_WARNING_CODES = [
  'cross_project_source',
  'global_source_not_authorized',
  'missing_required_source',
  'source_version_mismatch',
  'event_chain_invalid',
  'missing_evidence',
  'review_due',
  'explicit_contradiction_present',
] as const;
export const TASK_STATE_UNRESOLVED_CODES = [
  'missing_task_manifest',
  'task_identity_unresolved',
  'manifest_adoption_unverified',
  'required_lane_unresolved',
  'source_not_found',
  'source_out_of_scope',
  'source_version_unverified',
  'event_projection_unsupported',
] as const;
export const TASK_STATE_V11_UNRESOLVED_CODES = [
  'adoption_receipt_missing', 'adoption_receipt_malformed', 'adoption_contract_unsupported', 'adoption_signature_invalid', 'adoption_signer_untrusted', 'adoption_key_revoked', 'adoption_key_not_yet_valid', 'adoption_key_expired', 'adoption_epoch_expired', 'adoption_receipt_revoked', 'adoption_receipt_not_yet_valid', 'adoption_receipt_expired', 'adoption_receipt_ttl_exceeded', 'adoption_manifest_mismatch', 'adoption_scope_mismatch', 'adoption_capability_insufficient', 'trust_registry_unavailable',
] as const;

export type TaskStateWarningCode = (typeof TASK_STATE_WARNING_CODES)[number];
export type TaskStateUnresolvedCode = (typeof TASK_STATE_UNRESOLVED_CODES)[number] | (typeof TASK_STATE_V11_UNRESOLVED_CODES)[number];
export type TaskStateCode = TaskStateWarningCode | TaskStateUnresolvedCode;
export type TaskStateLane = 'governing' | 'current_state' | 'open_state' | 'evidence' | 'context_only' | 'warnings';
export type LaneRequirement = 'required' | 'optional' | 'disabled';

export type TaskStateSourceRef =
  | { kind: 'memory'; id: number; project_id: string; expected_updated_at?: string; content_sha256?: string }
  | { kind: 'cognitive_event'; event_id: string; project_id: string; task_id: string; expected_event_hash?: string }
  | { kind: 'epistemic_record'; record_id: string; project_id: string; expected_revision?: number }
  | { kind: 'artifact'; project_id: string; path: string; sha256: string };
export interface OperatorReceiptRef { kind: 'operator_receipt'; receipt_id: string; project_id: string; task_id: string }

export interface TaskStateSourcedStatement {
  statement: string;
  required: boolean;
  sources: TaskStateSourceRef[];
}

export interface TaskStateManifest {
  schema_version: '1.0.0' | '1.1.0';
  manifest_id: string;
  revision: number;
  project_id: string;
  task_id: string;
  include_global?: boolean;
  adoption: { status: 'proposed' | 'operator_adopted' | 'superseded'; source: TaskStateSourceRef | OperatorReceiptRef };
  task: {
    objective: TaskStateSourcedStatement;
    definition_of_done: TaskStateSourcedStatement;
    constraints: TaskStateSourcedStatement[];
    expected_next_action?: TaskStateSourcedStatement;
  };
  lane_requirements: Record<TaskStateLane, LaneRequirement>;
  governing_sources?: TaskStateSourceRef[];
  event_scope: {
    project_id: string;
    task_id: string;
    correlation_id?: string;
    after_sequence?: number;
    observed_after?: string;
    allow_legacy_v1_context: boolean;
  };
  review_policy?: {
    review_after?: string;
    last_validated_at?: string;
    validation_sources?: TaskStateSourceRef[];
  };
  limits: { max_items_per_lane: number; max_preview_characters?: number };
}

interface VersionedSource {
  project_id: string;
  authoritative_version_token_available?: boolean;
  operator_adoption_verified?: boolean;
  external_to_manifest?: boolean;
}
export interface TaskStateMemorySource extends VersionedSource {
  id: number;
  updated_at?: string;
  content_sha256?: string;
  content?: string;
  status?: 'active' | 'superseded' | 'archived' | 'invalid';
}
export interface TaskStateEpistemicSource extends VersionedSource {
  record_id: string;
  revision?: number;
  statement?: string;
}
export interface TaskStateArtifactSource extends VersionedSource {
  path: string;
  sha256?: string;
  preview?: string;
}
export interface TaskStateEventSource extends VersionedSource {
  event_id: string;
  task_id: string;
  sequence: number;
  event_hash?: string;
  event_type?: string;
  schema_version?: number;
  observed_at?: string;
  correlation_id?: string | null;
  causation_id?: string | null;
  integrity_valid?: boolean;
  payload?: Record<string, unknown>;
  task_state?: {
    version: '1.0.0'; state_id: string; role: 'current_state' | 'open_state' | 'evidence' | 'completion' | 'warning';
    status: 'current' | 'open' | 'blocked' | 'pending' | 'resolved' | 'completed' | 'superseded'; statement: string;
    supports?: TaskStateSourceRef[]; supersedes?: TaskStateSourceRef[]; review_after?: string;
  };
}
export interface TaskStateContradictionReceipt {
  receipt_id: string; project_id: string; task_id: string; left: TaskStateSourceRef; right: TaskStateSourceRef; explicit: boolean;
}
export interface TaskStateInputSources {
  memories?: TaskStateMemorySource[];
  events?: TaskStateEventSource[];
  epistemic_records?: TaskStateEpistemicSource[];
  artifacts?: TaskStateArtifactSource[];
  event_chain?: { project_id: string; task_id: string; valid: boolean; failing_sequence?: number };
  validation_after_deadline?: Array<{ source: TaskStateSourceRef; validated_at: string }>;
  contradiction_receipts?: TaskStateContradictionReceipt[];
}

export interface AssembleTaskStatePacketInput {
  project_id: string;
  task_id: string;
  include_global?: boolean;
  manifest?: TaskStateManifest | null;
  sources?: TaskStateInputSources;
  evaluation_time?: string;
  classification_contract_version?: '1.0.0' | '1.1.0';
  adoption_verdict?: import('./operator-adoption.js').AdoptionVerificationVerdictV1;
}

export interface TaskStateItem {
  lane_membership: TaskStateLane;
  item_id: string;
  source: TaskStateSourceRef;
  source_version: string | number | null;
  preview: string;
  exclusion_reasons?: string[];
  estimated_tokens: number;
}
export interface TaskStatePacket {
  contract_version: '1.0.0' | '1.1.0';
  scope: { project_id: string; task_id: string; include_global: boolean; global_inclusion: 'disabled' | 'explicit' };
  lane_requirements: Record<TaskStateLane, LaneRequirement>;
  governing: TaskStateItem[];
  current_state: TaskStateItem[];
  open_state: TaskStateItem[];
  evidence: TaskStateItem[];
  context_only: TaskStateItem[];
  warnings: TaskStateWarningCode[];
  unresolved: TaskStateUnresolvedCode[];
  applicability: 'unknown' | 'review_due' | 'reviewed';
  limits: { max_items_per_lane: number; max_preview_characters: number; estimated_tokens: number };
  verification: { required: true; source_references: TaskStateSourceRef[]; authority_notice: string; adoption?: import('./operator-adoption.js').AdoptionVerificationVerdictV1 };
  mutation: { database_writes: 0; events_appended: 0; access_tracking: 'not_touched'; receipt_persistence: 'none' };
  packet_digest: string;
}

const allLanes: TaskStateLane[] = ['governing', 'current_state', 'open_state', 'evidence', 'context_only', 'warnings'];
const noRequirements = (): Record<TaskStateLane, LaneRequirement> => Object.fromEntries(allLanes.map((lane) => [lane, 'disabled'])) as Record<TaskStateLane, LaneRequirement>;
const sourceKey = (source: TaskStateSourceRef): string => {
  switch (source.kind) {
    case 'memory': return `memory|${source.project_id}|${source.id}`;
    case 'cognitive_event': return `cognitive_event|${source.project_id}|${source.task_id}|${source.event_id}`;
    case 'epistemic_record': return `epistemic_record|${source.project_id}|${source.record_id}`;
    case 'artifact': return `artifact|${source.project_id}|${source.path}`;
  }
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function stableJson(value: unknown): string {
  const seen = new Set<object>();
  const encode = (item: unknown, inArray: boolean): string | undefined => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Task-state packet values must be finite');
      return JSON.stringify(item);
    }
    if (item === undefined) return inArray ? 'null' : undefined;
    if (typeof item !== 'object') throw new Error('Task-state packet values must be JSON values');
    if (seen.has(item)) throw new Error('Task-state packet values cannot be circular');
    seen.add(item);
    const result = Array.isArray(item)
      ? `[${item.map((entry) => encode(entry, true) ?? 'null').join(',')}]`
      : `{${Object.keys(item).sort().flatMap((key) => {
        const encoded = encode((item as Record<string, unknown>)[key], false);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      }).join(',')}}`;
    seen.delete(item);
    return result;
  };
  return encode(value, false) ?? 'null';
}
const digest = (value: unknown): string => createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
const digestProjection = <T extends Record<string, unknown>>(packet: T): T => {
  const adoption = (packet.verification as { adoption?: Record<string, unknown> } | undefined)?.adoption;
  if (!adoption) return packet;
  const { evaluated_at: _diagnosticOnly, ...boundAdoption } = adoption;
  return { ...packet, verification: { ...(packet.verification as Record<string, unknown>), adoption: boundAdoption } } as T;
};
const toPreview = (text: string | undefined, max: number): string => (text ?? '').slice(0, max);
const tokenEstimate = (text: string): number => text.length === 0 ? 0 : Math.ceil(text.length / 4);

function findSource(ref: TaskStateSourceRef, sources: TaskStateInputSources): VersionedSource | undefined {
  switch (ref.kind) {
    // Locate by stable kind identity first so an identity collision in another
    // project is classified as cross-project rather than silently as absent.
    case 'memory': return sources.memories?.find((entry) => entry.id === ref.id && entry.project_id === ref.project_id)
      ?? sources.memories?.find((entry) => entry.id === ref.id);
    case 'cognitive_event': return sources.events?.find((entry) => entry.event_id === ref.event_id && entry.project_id === ref.project_id && entry.task_id === ref.task_id)
      ?? sources.events?.find((entry) => entry.event_id === ref.event_id);
    case 'epistemic_record': return sources.epistemic_records?.find((entry) => entry.record_id === ref.record_id && entry.project_id === ref.project_id)
      ?? sources.epistemic_records?.find((entry) => entry.record_id === ref.record_id);
    case 'artifact': return sources.artifacts?.find((entry) => entry.path === ref.path && entry.project_id === ref.project_id)
      ?? sources.artifacts?.find((entry) => entry.path === ref.path);
  }
}

function actualVersion(ref: TaskStateSourceRef, found: VersionedSource): string | number | undefined {
  if (ref.kind === 'memory') {
    const memory = found as TaskStateMemorySource;
    if (ref.expected_updated_at !== undefined) return memory.updated_at;
    if (ref.content_sha256 !== undefined) return memory.content_sha256;
    return memory.updated_at ?? memory.content_sha256;
  }
  if (ref.kind === 'cognitive_event') return (found as TaskStateEventSource).event_hash;
  if (ref.kind === 'epistemic_record') return (found as TaskStateEpistemicSource).revision;
  return (found as TaskStateArtifactSource).sha256;
}
function expectedVersion(ref: TaskStateSourceRef): string | number | undefined {
  if (ref.kind === 'memory') return ref.expected_updated_at ?? ref.content_sha256;
  if (ref.kind === 'cognitive_event') return ref.expected_event_hash;
  if (ref.kind === 'epistemic_record') return ref.expected_revision;
  return ref.sha256;
}
function versionMatches(ref: TaskStateSourceRef, found: VersionedSource, actual: string | number | undefined): boolean {
  if (ref.kind === 'memory') {
    const memory = found as TaskStateMemorySource;
    if (ref.expected_updated_at !== undefined) return memory.updated_at === ref.expected_updated_at;
    if (ref.content_sha256 !== undefined) return memory.content_sha256 === ref.content_sha256;
    return true;
  }
  return expectedVersion(ref) === undefined || expectedVersion(ref) === actual;
}

interface SourceVerification {
  found?: VersionedSource;
  version?: string | number;
  verified: boolean;
}

/**
 * Deterministically assemble Contract v1 state from caller-owned snapshots.
 * It intentionally has no Database dependency and never performs I/O.
 */
export function assembleTaskStatePacket(input: AssembleTaskStatePacketInput): TaskStatePacket {
  const snapshot = clone(input);
  const sources = snapshot.sources ?? {};
  const manifest = snapshot.manifest ?? undefined;
  const warnings = new Set<TaskStateWarningCode>();
  const unresolved = new Set<TaskStateUnresolvedCode>();
  const includeGlobal = snapshot.include_global === true && manifest?.include_global === true;
  const requirements = manifest?.lane_requirements ?? noRequirements();
  const maxItems = Math.max(1, Math.min(50, manifest?.limits.max_items_per_lane ?? 1));
  const maxPreview = Math.max(0, Math.min(4000, manifest?.limits.max_preview_characters ?? 500));
  const references: TaskStateSourceRef[] = [];
  const lanes: Record<Exclude<TaskStateLane, 'warnings'>, TaskStateItem[]> = {
    governing: [], current_state: [], open_state: [], evidence: [], context_only: [],
  };

  const scope = { project_id: snapshot.project_id, task_id: snapshot.task_id, include_global: includeGlobal, global_inclusion: includeGlobal ? 'explicit' as const : 'disabled' as const };
  let applicability: TaskStatePacket['applicability'] = 'unknown';
  const verifySource = (ref: TaskStateSourceRef): SourceVerification => {
    references.push(ref);
    if (ref.project_id === '_global' && !includeGlobal) {
      warnings.add('global_source_not_authorized');
      return { verified: false };
    }
    if (ref.project_id !== snapshot.project_id && ref.project_id !== '_global') {
      warnings.add('cross_project_source');
      return { verified: false };
    }
    const found = findSource(ref, sources);
    if (!found) {
      unresolved.add('source_not_found');
      return { verified: false };
    }
    if (found.project_id !== ref.project_id || (found.project_id !== snapshot.project_id && found.project_id !== '_global')) {
      warnings.add('cross_project_source');
      return { found, verified: false };
    }
    if (ref.kind === 'memory') {
      const memory = found as TaskStateMemorySource;
      if (memory.status !== undefined && memory.status !== 'active') {
        unresolved.add('source_out_of_scope');
        return { found, verified: false };
      }
    }
    const version = actualVersion(ref, found);
    if (found.authoritative_version_token_available === false || version === undefined) {
      unresolved.add('source_version_unverified');
      return { found, verified: false };
    }
    if (!versionMatches(ref, found, version)) {
      warnings.add('source_version_mismatch');
      return { found, version, verified: false };
    }
    if (ref.kind === 'cognitive_event') {
      const event = found as TaskStateEventSource;
      const outsideBound = event.task_id !== snapshot.task_id
        || (manifest?.event_scope.after_sequence !== undefined && event.sequence <= manifest.event_scope.after_sequence)
        || (manifest?.event_scope.observed_after !== undefined && (event.observed_at ?? '') <= manifest.event_scope.observed_after)
        || (manifest?.event_scope.correlation_id !== undefined && event.correlation_id !== manifest.event_scope.correlation_id);
      if (outsideBound) {
        unresolved.add('source_out_of_scope');
        return { found, version, verified: false };
      }
      if (event.integrity_valid === false) {
        warnings.add('event_chain_invalid');
        return { found, version, verified: false };
      }
    }
    return { found, version, verified: true };
  };
  const add = (lane: Exclude<TaskStateLane, 'warnings'>, item: TaskStateItem): void => {
    if (requirements[lane] !== 'disabled') lanes[lane].push(item);
  };
  const itemFrom = (
    lane: Exclude<TaskStateLane, 'warnings'>,
    ref: TaskStateSourceRef,
    version: string | number | undefined,
    preview: string,
    suffix = '',
    exclusionReasons?: string[],
  ): TaskStateItem => {
    const clipped = toPreview(preview, maxPreview);
    const reasons = lane === 'context_only' ? [...new Set(exclusionReasons ?? ['contextual_non_authoritative'])].sort() : undefined;
    return {
      lane_membership: lane, item_id: `${sourceKey(ref)}${suffix}`, source: ref, source_version: version ?? null,
      preview: clipped, estimated_tokens: tokenEstimate(clipped), ...(reasons ? { exclusion_reasons: reasons } : {}),
    };
  };

  if (manifest && allLanes.every((lane) => requirements[lane] === 'disabled')) {
    const identityMatches = manifest.project_id === snapshot.project_id
      && manifest.task_id === snapshot.task_id
      && manifest.event_scope.project_id === snapshot.project_id
      && manifest.event_scope.task_id === snapshot.task_id;
    const disabledUnresolved: TaskStateUnresolvedCode[] = identityMatches ? [] : ['task_identity_unresolved'];
    if (manifest.schema_version === '1.1.0' && snapshot.adoption_verdict?.status !== 'verified') disabledUnresolved.push(...(snapshot.adoption_verdict?.failure_codes ?? ['trust_registry_unavailable', 'manifest_adoption_unverified']) as TaskStateUnresolvedCode[]);
    const packetWithoutDigest = {
      contract_version: manifest.schema_version === '1.1.0' ? '1.1.0' as const : '1.0.0' as const, scope, lane_requirements: requirements,
      ...lanes, warnings: [] as TaskStateWarningCode[], unresolved: disabledUnresolved, applicability,
      limits: { max_items_per_lane: maxItems, max_preview_characters: maxPreview, estimated_tokens: 0 },
      verification: {
        required: true as const, source_references: [] as TaskStateSourceRef[],
        authority_notice: 'Packet membership is source-backed only. Manifest status, retrieval rank, repetition, event type, and age do not independently grant authority.',
        ...(manifest.schema_version === '1.1.0' && snapshot.adoption_verdict ? { adoption: snapshot.adoption_verdict } : {}),
      },
      mutation: { database_writes: 0 as const, events_appended: 0 as const, access_tracking: 'not_touched' as const, receipt_persistence: 'none' as const },
    };
    return { ...packetWithoutDigest, packet_digest: digest({ classification_contract_version: snapshot.classification_contract_version ?? '1.0.0', manifest, ...digestProjection(packetWithoutDigest) }) };
  }

  if (!manifest) {
    unresolved.add('missing_task_manifest');
  } else {
    if (manifest.project_id !== snapshot.project_id || manifest.task_id !== snapshot.task_id || manifest.event_scope.project_id !== snapshot.project_id || manifest.event_scope.task_id !== snapshot.task_id) {
      unresolved.add('task_identity_unresolved');
    }

    const identityMatches = manifest.project_id === snapshot.project_id
      && manifest.task_id === snapshot.task_id
      && manifest.event_scope.project_id === snapshot.project_id
      && manifest.event_scope.task_id === snapshot.task_id;
    const manifestAdoptionSource = manifest.adoption.source;
    const receiptAdoption = manifestAdoptionSource.kind === 'operator_receipt';
    const adoption = receiptAdoption ? { verified: false } : verifySource(manifestAdoptionSource as TaskStateSourceRef);
    const adopted = manifest.adoption.status === 'operator_adopted' && identityMatches
      && (manifest.schema_version === '1.1.0'
        ? snapshot.adoption_verdict?.status === 'verified'
        : adoption.verified && adoption.found?.operator_adoption_verified === true && adoption.found.external_to_manifest === true);
    const manifestExclusionReason = manifest.adoption.status === 'proposed'
      ? 'manifest_proposed'
      : manifest.adoption.status === 'superseded'
        ? 'manifest_superseded'
        : !identityMatches
          ? 'task_identity_unresolved'
          : 'manifest_adoption_unverified';
    if (manifest.adoption.status === 'operator_adopted' && !adopted) unresolved.add('manifest_adoption_unverified');
    if (manifest.adoption.status !== 'operator_adopted' && !receiptAdoption) {
      add('context_only', itemFrom('context_only', manifestAdoptionSource as TaskStateSourceRef, adoption.version, `Manifest ${manifest.manifest_id} is ${manifest.adoption.status}.`, `|manifest:${manifest.manifest_id}`, [manifestExclusionReason]));
    }
    if (manifest.schema_version === '1.1.0' && snapshot.adoption_verdict?.status !== 'verified') {
      for (const code of snapshot.adoption_verdict?.failure_codes ?? ['trust_registry_unavailable', 'manifest_adoption_unverified']) unresolved.add(code as TaskStateUnresolvedCode);
    }

    const statements: Array<[string, TaskStateSourcedStatement]> = [
      ['objective', manifest.task.objective], ['definition_of_done', manifest.task.definition_of_done],
      ...manifest.task.constraints.map((statement, index) => [`constraint:${index}`, statement] as [string, TaskStateSourcedStatement]),
      ...(manifest.task.expected_next_action ? [['expected_next_action', manifest.task.expected_next_action] as [string, TaskStateSourcedStatement]] : []),
    ];
    for (const [name, statement] of statements) {
      const checked = statement.sources.map((ref) => ({ ref, result: verifySource(ref) }));
      const sourceVerified = checked.filter(({ result }) => result.verified);
      if (statement.required && sourceVerified.length === 0) warnings.add('missing_required_source');
      if (adopted && sourceVerified.length > 0) {
        for (const { ref, result } of sourceVerified) add('governing', itemFrom('governing', ref, result.version, statement.statement, `|${name}`));
      } else if (!adopted || sourceVerified.length === 0) {
        for (const { ref, result } of checked.filter(({ result }) => result.verified)) {
          add('context_only', itemFrom('context_only', ref, result.version, statement.statement, `|${name}`, [manifestExclusionReason]));
        }
      }
    }
    for (const ref of manifest.governing_sources ?? []) verifySource(ref);

    const chain = sources.event_chain;
    if (chain && chain.project_id === snapshot.project_id && chain.task_id === snapshot.task_id && !chain.valid) warnings.add('event_chain_invalid');

    const scopedEvents = (sources.events ?? []).filter((event) => event.project_id === snapshot.project_id && event.task_id === snapshot.task_id)
      .sort((left, right) => left.sequence - right.sequence || left.event_id.localeCompare(right.event_id));
    for (const event of scopedEvents) {
      const eventRef: TaskStateSourceRef = { kind: 'cognitive_event', event_id: event.event_id, project_id: event.project_id, task_id: event.task_id, expected_event_hash: event.event_hash };
      const result = verifySource(eventRef);
      if (!result.verified) continue;
      // Contract v1 deliberately leaves task-state envelope projection unsupported.
      if (event.task_state) {
        unresolved.add('event_projection_unsupported');
        add('context_only', itemFrom('context_only', eventRef, result.version, event.task_state.statement, `|envelope:${event.task_state.state_id}`, ['event_projection_unsupported']));
      }
      if (event.schema_version === 1 && manifest.event_scope.allow_legacy_v1_context) {
        add('context_only', itemFrom('context_only', eventRef, result.version, 'Legacy v1 event; contextual only.', '|legacy', ['legacy_v1_context_allowed']));
      }
      const provenance = event.payload;
      const sourceEvent = typeof provenance?.source_event_id === 'string' ? provenance.source_event_id : undefined;
      const sourceMemory = typeof provenance?.source_memory_id === 'number' ? provenance.source_memory_id : undefined;
      if (event.schema_version === 2 && event.event_type === 'EvidenceObserved' && (sourceEvent || sourceMemory !== undefined)) {
        const support: TaskStateSourceRef = sourceEvent
          ? { kind: 'cognitive_event', event_id: sourceEvent, project_id: event.project_id, task_id: event.task_id }
          : { kind: 'memory', id: sourceMemory as number, project_id: event.project_id };
        const supportResult = verifySource(support);
        if (identityMatches && supportResult.verified) add('evidence', itemFrom('evidence', eventRef, result.version, `EvidenceObserved supports ${sourceKey(support)}.`, '|evidence'));
      }
    }

    const review = manifest.review_policy;
    if (review?.review_after && (snapshot.evaluation_time ?? '') > review.review_after) {
      const permittedValidationSources = new Set(review.validation_sources?.map(sourceKey) ?? []);
      const refreshed = (sources.validation_after_deadline ?? []).some((entry) => entry.validated_at > review.review_after!
        && (permittedValidationSources.size === 0 || permittedValidationSources.has(sourceKey(entry.source)))
        && verifySource(entry.source).verified);
      if (refreshed) applicability = 'reviewed';
      else { applicability = 'review_due'; warnings.add('review_due'); }
    } else if (review) applicability = 'reviewed';

    const manifestRefs = new Set(statements.flatMap(([, statement]) => statement.sources.map(sourceKey)));
    for (const receipt of sources.contradiction_receipts ?? []) {
      if (receipt.explicit && receipt.project_id === snapshot.project_id && receipt.task_id === snapshot.task_id
        && manifestRefs.has(sourceKey(receipt.left)) && manifestRefs.has(sourceKey(receipt.right))
        && verifySource(receipt.left).verified && verifySource(receipt.right).verified) warnings.add('explicit_contradiction_present');
    }
  }

  for (const lane of ['governing', 'current_state', 'open_state', 'evidence', 'context_only'] as const) {
    lanes[lane] = lanes[lane].sort((left, right) => left.item_id.localeCompare(right.item_id)).slice(0, maxItems);
    if (requirements[lane] === 'required' && lanes[lane].length === 0) unresolved.add('required_lane_unresolved');
  }
  if (requirements.evidence === 'required' && lanes.evidence.length === 0) warnings.add('missing_evidence');
  const warningList = requirements.warnings === 'disabled' ? [] : [...warnings].sort() as TaskStateWarningCode[];
  if (requirements.warnings === 'required' && warningList.length === 0) unresolved.add('required_lane_unresolved');
  const unresolvedList = [...unresolved].sort() as TaskStateUnresolvedCode[];
  const totalTokens = Object.values(lanes).flat().reduce((total, item) => total + item.estimated_tokens, 0);
  const packetWithoutDigest = {
    contract_version: manifest?.schema_version === '1.1.0' ? '1.1.0' as const : '1.0.0' as const, scope, lane_requirements: requirements,
    ...lanes, warnings: warningList, unresolved: unresolvedList,
    applicability,
    limits: { max_items_per_lane: maxItems, max_preview_characters: maxPreview, estimated_tokens: totalTokens },
    verification: {
      required: true as const,
      source_references: [...new Map(references.map((ref) => [sourceKey(ref), ref])).values()].sort((left, right) => sourceKey(left).localeCompare(sourceKey(right))),
      authority_notice: 'Packet membership is source-backed only. Manifest status, retrieval rank, repetition, event type, and age do not independently grant authority.',
      ...(manifest?.schema_version === '1.1.0' && snapshot.adoption_verdict ? { adoption: snapshot.adoption_verdict } : {}),
    },
    mutation: { database_writes: 0 as const, events_appended: 0 as const, access_tracking: 'not_touched' as const, receipt_persistence: 'none' as const },
  };
  return { ...packetWithoutDigest, packet_digest: digest({ classification_contract_version: snapshot.classification_contract_version ?? '1.0.0', manifest: manifest ?? null, ...digestProjection(packetWithoutDigest) }) };
}
