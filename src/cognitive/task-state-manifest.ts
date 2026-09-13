import { z } from 'zod';
import type { OperatorReceiptRef, TaskStateManifest, TaskStateSourceRef } from './task-state.js';

type UnknownRecord = Record<string, unknown>;

export type TaskStateManifestValidation =
  | { ok: true; manifest: TaskStateManifest }
  | { ok: false; error: string };

const lanes = ['governing', 'current_state', 'open_state', 'evidence', 'context_only', 'warnings'] as const;
const laneValues = new Set(['required', 'optional', 'disabled']);
const sha256 = /^[a-f0-9]{64}$/;
const scopedId = /^\S+$/;
const artifactPath = /^(?![A-Za-z]:)(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$/;
const rfc3339DateTime = z.iso.datetime({ offset: true });

function object(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: UnknownRecord, allowed: string[], required: string[]): boolean {
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.includes(key));
}

function string(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function scoped(value: unknown): value is string {
  return string(value) && scopedId.test(value);
}

function dateTime(value: unknown): value is string {
  return rfc3339DateTime.safeParse(value).success;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as UnknownRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function sourceRef(value: unknown): value is TaskStateSourceRef {
  if (!object(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'memory') {
    return exactKeys(value, ['kind', 'id', 'project_id', 'expected_updated_at', 'content_sha256'], ['kind', 'id', 'project_id'])
      && Number.isInteger(value.id) && (value.id as number) > 0 && scoped(value.project_id)
      && (value.expected_updated_at === undefined || dateTime(value.expected_updated_at))
      && (value.content_sha256 === undefined || (typeof value.content_sha256 === 'string' && sha256.test(value.content_sha256)));
  }
  if (value.kind === 'cognitive_event') {
    return exactKeys(value, ['kind', 'event_id', 'project_id', 'task_id', 'expected_event_hash'], ['kind', 'event_id', 'project_id', 'task_id'])
      && string(value.event_id) && scoped(value.project_id) && scoped(value.task_id)
      && (value.expected_event_hash === undefined || (typeof value.expected_event_hash === 'string' && sha256.test(value.expected_event_hash)));
  }
  if (value.kind === 'epistemic_record') {
    return exactKeys(value, ['kind', 'record_id', 'project_id', 'expected_revision'], ['kind', 'record_id', 'project_id'])
      && string(value.record_id) && scoped(value.project_id)
      && (value.expected_revision === undefined || (Number.isInteger(value.expected_revision) && (value.expected_revision as number) >= 1));
  }
  if (value.kind === 'artifact') {
    return exactKeys(value, ['kind', 'project_id', 'path', 'sha256'], ['kind', 'project_id', 'path', 'sha256'])
      && scoped(value.project_id) && string(value.path, 500) && artifactPath.test(value.path)
      && typeof value.sha256 === 'string' && sha256.test(value.sha256);
  }
  return false;
}
function operatorReceiptRef(value: unknown): value is OperatorReceiptRef {
  return object(value) && exactKeys(value, ['kind', 'receipt_id', 'project_id', 'task_id'], ['kind', 'receipt_id', 'project_id', 'task_id'])
    && value.kind === 'operator_receipt' && typeof value.receipt_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.receipt_id)
    && scoped(value.project_id) && scoped(value.task_id);
}

function sourceList(value: unknown, min: number, max: number): value is TaskStateSourceRef[] {
  return Array.isArray(value)
    && value.length >= min
    && value.length <= max
    && value.every(sourceRef)
    && new Set(value.map(stableJson)).size === value.length;
}

function statement(value: unknown): boolean {
  return object(value) && exactKeys(value, ['statement', 'required', 'sources'], ['statement', 'required', 'sources'])
    && string(value.statement, 4000) && typeof value.required === 'boolean' && sourceList(value.sources, 1, 20);
}

/**
 * Runtime validation for the normative v1 manifest shape. This receives only
 * the caller manifest; source snapshots and any authority decision stay
 * server-owned in task-state-server.ts.
 */
export function validateTaskStateManifest(value: unknown): TaskStateManifestValidation {
  if (!object(value)) return { ok: false, error: 'manifest must be an object' };
  const allowed = ['schema_version', 'manifest_id', 'revision', 'project_id', 'task_id', 'include_global', 'adoption', 'task', 'lane_requirements', 'governing_sources', 'event_scope', 'review_policy', 'limits'];
  const required = ['schema_version', 'manifest_id', 'revision', 'project_id', 'task_id', 'adoption', 'task', 'lane_requirements', 'event_scope', 'limits'];
  if (!exactKeys(value, allowed, required)) return { ok: false, error: 'manifest has invalid keys' };
  if (!['1.0.0', '1.1.0'].includes(value.schema_version as string) || !string(value.manifest_id, 160) || !Number.isInteger(value.revision) || (value.revision as number) < 1 || !scoped(value.project_id) || !scoped(value.task_id) || (value.include_global !== undefined && typeof value.include_global !== 'boolean')) {
    return { ok: false, error: 'manifest identity is invalid' };
  }
  const validAdoptionSource = value.schema_version === '1.1.0' ? operatorReceiptRef(value.adoption && (value.adoption as UnknownRecord).source) : sourceRef(value.adoption && (value.adoption as UnknownRecord).source);
  if (!object(value.adoption) || !exactKeys(value.adoption, ['status', 'source'], ['status', 'source']) || !['proposed', 'operator_adopted', 'superseded'].includes(value.adoption.status as string) || !validAdoptionSource) {
    return { ok: false, error: 'manifest adoption is invalid' };
  }
  if (!object(value.task) || !exactKeys(value.task, ['objective', 'definition_of_done', 'constraints', 'expected_next_action'], ['objective', 'definition_of_done', 'constraints']) || !statement(value.task.objective) || !statement(value.task.definition_of_done) || !Array.isArray(value.task.constraints) || value.task.constraints.length > 50 || !value.task.constraints.every(statement) || (value.task.expected_next_action !== undefined && !statement(value.task.expected_next_action))) {
    return { ok: false, error: 'manifest task statements are invalid' };
  }
  if (!object(value.lane_requirements) || !exactKeys(value.lane_requirements, [...lanes], [...lanes]) || !lanes.every((lane) => laneValues.has((value.lane_requirements as UnknownRecord)[lane] as string))) {
    return { ok: false, error: 'manifest lane requirements are invalid' };
  }
  if (value.governing_sources !== undefined && !sourceList(value.governing_sources, 0, 50)) return { ok: false, error: 'manifest governing sources are invalid' };
  if (!object(value.event_scope) || !exactKeys(value.event_scope, ['project_id', 'task_id', 'correlation_id', 'after_sequence', 'observed_after', 'allow_legacy_v1_context'], ['project_id', 'task_id', 'allow_legacy_v1_context']) || !scoped(value.event_scope.project_id) || !scoped(value.event_scope.task_id) || typeof value.event_scope.allow_legacy_v1_context !== 'boolean' || (value.event_scope.correlation_id !== undefined && !string(value.event_scope.correlation_id)) || (value.event_scope.after_sequence !== undefined && (!Number.isInteger(value.event_scope.after_sequence) || (value.event_scope.after_sequence as number) < 0)) || (value.event_scope.observed_after !== undefined && !dateTime(value.event_scope.observed_after))) {
    return { ok: false, error: 'manifest event scope is invalid' };
  }
  if (value.review_policy !== undefined) {
    if (!object(value.review_policy) || !exactKeys(value.review_policy, ['review_after', 'last_validated_at', 'validation_sources'], []) || (value.review_policy.review_after !== undefined && !dateTime(value.review_policy.review_after)) || (value.review_policy.last_validated_at !== undefined && !dateTime(value.review_policy.last_validated_at)) || (value.review_policy.validation_sources !== undefined && !sourceList(value.review_policy.validation_sources, 0, 50))) return { ok: false, error: 'manifest review policy is invalid' };
  }
  if (!object(value.limits) || !exactKeys(value.limits, ['max_items_per_lane', 'max_preview_characters'], ['max_items_per_lane']) || !Number.isInteger(value.limits.max_items_per_lane) || (value.limits.max_items_per_lane as number) < 1 || (value.limits.max_items_per_lane as number) > 50 || (value.limits.max_preview_characters !== undefined && (!Number.isInteger(value.limits.max_preview_characters) || (value.limits.max_preview_characters as number) < 0 || (value.limits.max_preview_characters as number) > 4000))) return { ok: false, error: 'manifest limits are invalid' };
  return { ok: true, manifest: value as unknown as TaskStateManifest };
}
