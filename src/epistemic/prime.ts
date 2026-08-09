import { z } from 'zod';
import type {
  CompactPrime,
  CompilePrimeInput,
  CompilePrimeResult,
  EpistemicRecord,
  PrimeReference,
  PrimeDebugEntry,
  PrimeMode,
  RelevanceScorer,
  ValidationIssue,
} from './types.js';
import {
  compareStableText,
  evaluateScopeApplicability,
  sortValidationIssues,
  validateCompactPrime,
  validateEpistemicRecord,
} from './validate.js';

type Limits = { records: number; contradictions: number; questions: number; actions: number };
type Ranked = { record: EpistemicRecord; score: number; relevance: number; scope: number; recency: number; lifecycle: number; authority: number };

const DEFAULT_LIMITS: Limits = { records: 8, contradictions: 4, questions: 3, actions: 3 };
const IsoTimestampSchema = z.iso.datetime({ offset: true });

function issue(code: string, path: Array<string | number>, message: string, record_id?: string): ValidationIssue {
  return { code, path, message, severity: 'error', ...(record_id ? { record_id } : {}) };
}

/** Deterministic, dependency-free relevance for v0.3's pure compiler. */
export const defaultRelevanceScorer: RelevanceScorer = (query, record) => {
  const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const queryTokens = new Set(tokens(query));
  if (!queryTokens.size) return 0;
  const documentTokens = new Set(tokens(`${record.statement} ${record.type} ${record.assertion_kind}`));
  let overlap = 0;
  for (const token of queryTokens) if (documentTokens.has(token)) overlap += 1;
  return overlap / queryTokens.size;
};

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function resolvedLimits(input: CompilePrimeInput, issues: ValidationIssue[]): Limits | undefined {
  const supplied = (input as CompilePrimeInput & { limits?: Partial<Limits> }).limits ?? {};
  const result = { ...DEFAULT_LIMITS, ...supplied };
  const valid = (key: keyof Limits, min: number, max: number) => {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) {
      issues.push(issue('PRIME_LIMIT_INVALID', ['limits', key], `${key} must be an integer from ${min} to ${max}.`));
    }
  };
  valid('records', 1, 8); valid('contradictions', 1, 4); valid('questions', 0, 3); valid('actions', 0, 3);
  return issues.some((entry) => entry.severity === 'error') ? undefined : result;
}

function lifecycle(record: EpistemicRecord, mode: PrimeMode, now: number): { eligible: boolean; fitness: number; reason?: string } {
  const from = record.scope.valid_from ? Date.parse(record.scope.valid_from) : undefined;
  const until = record.scope.valid_until ? Date.parse(record.scope.valid_until) : undefined;
  if (from !== undefined && from > now) return { eligible: false, fitness: 0, reason: 'not yet valid' };
  if (mode !== 'historical' && until !== undefined && until < now) return { eligible: false, fitness: 0, reason: 'expired' };
  if (mode !== 'historical' && ['rejected', 'superseded', 'archived'].includes(record.status)) {
    return { eligible: false, fitness: 0, reason: `lifecycle status ${record.status}` };
  }
  if (mode === 'ordinary' && record.type === 'action' && record.status === 'completed') {
    return { eligible: false, fitness: 0, reason: 'completed action' };
  }
  if (mode !== 'historical' && record.type !== 'action' && record.status === 'completed') {
    return { eligible: false, fitness: 0, reason: 'completed record outside historical mode' };
  }
  const fitness: Record<string, number> = mode === 'historical'
    ? { active: 1, disputed: 0.9, conditional: 0.85, proposed: 0.65, completed: 0.55, superseded: 0.35, rejected: 0.25, archived: 0.2 }
    : { active: 1, disputed: 0.9, conditional: 0.85, proposed: 0.65, completed: 1, superseded: 0, rejected: 0, archived: 0 };
  return { eligible: true, fitness: fitness[record.status] ?? 0 };
}

function authorityVisibility(record: EpistemicRecord, verifiedAuthorityIds?: ReadonlySet<string>): number {
  if (verifiedAuthorityIds?.has(record.id)
    && (record.type === 'decision' || record.type === 'policy' || record.type === 'preference' || record.type === 'action')
    && (record.status === 'active' || record.status === 'conditional')) {
    if (record.authority === 'system_governing') return 1;
    if (record.authority === 'operator_adopted') return 0.8;
  }
  return record.authority === 'advisory' ? 0.25 : 0;
}

function compareRanked(left: Ranked, right: Ranked): number {
  return right.score - left.score || Date.parse(right.record.updated_at) - Date.parse(left.record.updated_at) || compareStableText(left.record.id, right.record.id);
}

function reference(record: EpistemicRecord, role: string): PrimeReference {
  return { id: record.id, reason: `${role}: ${record.type} in matching scope.` };
}

function hasContradiction(left: EpistemicRecord, right: EpistemicRecord): boolean {
  return left.relations.some((relation) => relation.type === 'contradicts' && relation.target_id === right.id)
    || right.relations.some((relation) => relation.type === 'contradicts' && relation.target_id === left.id);
}

/**
 * Compiles a bounded read-only prime. Diversity is only applied to a candidate
 * whose score is within 0.02 of the next best candidate, avoiding a type bonus
 * that would hide materially more relevant records.
 */
export function compileCompactPrime(input: CompilePrimeInput, scorer?: RelevanceScorer): CompilePrimeResult {
  const issues: ValidationIssue[] = [];
  const debug: PrimeDebugEntry[] = [];
  const shape = input as CompilePrimeInput & { mode?: PrimeMode; current_focus?: string };
  const nowValid = IsoTimestampSchema.safeParse(input.now).success;
  const now = Date.parse(input.now);
  if (!nowValid || !Number.isFinite(now)) issues.push(issue('PRIME_NOW_INVALID', ['now'], 'now must be an ISO 8601 timestamp with a timezone offset.'));
  if (!input.query?.trim()) issues.push(issue('PRIME_QUERY_INVALID', ['query'], 'query must be non-empty.'));
  if (!shape.current_focus?.trim()) issues.push(issue('PRIME_CURRENT_FOCUS_INVALID', ['current_focus'], 'current_focus must be non-empty.'));
  const mode = shape.mode ?? 'ordinary';
  if (!['ordinary', 'historical', 'completion'].includes(mode)) issues.push(issue('PRIME_MODE_INVALID', ['mode'], 'mode must be ordinary, historical, or completion.'));
  const limits = resolvedLimits(input, issues);
  if (issues.length || !limits) return { ok: false, issues: sortValidationIssues(issues), debug };
  const relevanceScorer = scorer ?? input.relevance_scorer ?? defaultRelevanceScorer;

  const exclusions: Array<{ id: string; reason: string }> = [];
  const valid: EpistemicRecord[] = [];
  const seenRecordIds = new Set<string>();
  for (const [index, record] of input.records.entries()) {
    const validated = validateEpistemicRecord(record, { evaluationTime: input.now });
    if (!validated.ok) {
      const detail = validated.issues.find((entry) => entry.severity === 'error')?.code ?? 'SCHEMA_INVALID';
      const invalidId = typeof record?.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(record.id)
        ? record.id
        : `invalid.record.${index + 1}`;
      exclusions.push({ id: invalidId, reason: `invalid record: ${detail}` });
      issues.push(...validated.issues);
      debug.push({ id: invalidId, eligible: false, exclusion_reason: `invalid record: ${detail}` });
      continue;
    }
    issues.push(...validated.issues);
    if (seenRecordIds.has(validated.value!.id)) {
      issues.push(issue('PRIME_CATALOG_DUPLICATE', ['records', index, 'id'], 'Record IDs must be unique in the compilation catalog.', validated.value!.id));
      exclusions.push({ id: validated.value!.id, reason: 'invalid record: PRIME_CATALOG_DUPLICATE' });
      debug.push({ id: validated.value!.id, eligible: false, exclusion_reason: 'invalid record: PRIME_CATALOG_DUPLICATE' });
      continue;
    }
    seenRecordIds.add(validated.value!.id);
    valid.push(validated.value!);
  }

  const catalog = new Map(valid.map((record) => [record.id, record]));
  const closedValid: EpistemicRecord[] = [];
  for (const record of valid) {
    const closed = validateEpistemicRecord(record, { catalog, evaluationTime: input.now });
    const unresolved = closed.issues.filter((entry) => entry.code === 'REFERENCE_UNRESOLVED');
    if (unresolved.length > 0) {
      issues.push(...unresolved);
      exclusions.push({ id: record.id, reason: 'invalid record: REFERENCE_UNRESOLVED' });
      debug.push({ id: record.id, eligible: false, exclusion_reason: 'invalid record: REFERENCE_UNRESOLVED' });
    } else {
      closedValid.push(record);
    }
  }

  const ranked: Ranked[] = [];
  for (const record of closedValid) {
    const life = lifecycle(record, mode, now);
    if (!life.eligible) { exclusions.push({ id: record.id, reason: life.reason! }); debug.push({ id: record.id, eligible: false, exclusion_reason: life.reason }); continue; }
    const scope = evaluateScopeApplicability(record.scope, input.scope);
    if (!scope.eligible) { exclusions.push({ id: record.id, reason: scope.reason! }); debug.push({ id: record.id, eligible: false, exclusion_reason: scope.reason }); continue; }
    const relevance = clamp(relevanceScorer(input.query, record));
    if (relevance <= 0) { exclusions.push({ id: record.id, reason: 'no query relevance' }); debug.push({ id: record.id, eligible: false, relevance, exclusion_reason: 'no query relevance' }); continue; }
    const recency = clamp(1 - Math.max(0, now - Date.parse(record.updated_at)) / (365 * 24 * 60 * 60 * 1000));
    const authority = authorityVisibility(record, input.verified_authority_ids);
    ranked.push({ record, relevance, scope: scope.score, recency, lifecycle: life.fitness, authority,
      score: 0.45 * relevance + 0.25 * scope.score + 0.15 * recency + 0.10 * life.fitness + 0.05 * authority });
  }
  ranked.sort(compareRanked);

  const contradictionEligible = ranked.filter((candidate) => candidate.record.type !== 'question' && candidate.record.type !== 'action');
  const primaryPool = contradictionEligible.filter((candidate) => {
    if (candidate.record.status !== 'disputed') return true;
    return contradictionEligible.some((other) => other !== candidate && hasContradiction(candidate.record, other.record));
  });
  for (const candidate of contradictionEligible) {
    if (candidate.record.status === 'disputed' && !primaryPool.includes(candidate)) exclusions.push({ id: candidate.record.id, reason: 'disputed without an eligible contradiction' });
  }
  const selected: Ranked[] = [];
  const seenTypes = new Set<string>();
  while (selected.length < limits.records) {
    // A direct challenger belongs in the contradiction lane, not an accidental
    // second primary summary of the same unresolved claim.
    const remaining = primaryPool.filter((candidate) => !selected.includes(candidate)
      && !selected.some((primary) => hasContradiction(primary.record, candidate.record)));
    if (!remaining.length) break;
    const best = remaining[0];
    const diverse = remaining.filter((candidate) => !seenTypes.has(candidate.record.type) && candidate.score >= best.score - 0.02);
    const picked = diverse[0] ?? best;
    selected.push(picked); seenTypes.add(picked.record.type);
  }

  const contradictionRefs = ranked.filter((candidate) => !selected.includes(candidate)
    && selected.some((primary) => hasContradiction(primary.record, candidate.record)))
    .slice(0, limits.contradictions).map((candidate) => reference(candidate.record, 'contradicts selected record'));
  const lanes = (type: 'question' | 'action', limit: number, role: string) => ranked
    .filter((candidate) => candidate.record.type === type).slice(0, limit).map((candidate) => reference(candidate.record, role));
  const prime: CompactPrime = {
    schema_version: '0.3', generated_at: input.now, query: input.query, scope: { ...input.scope }, current_focus: shape.current_focus!,
    record_refs: selected.map((candidate) => reference(candidate.record, 'selected')),
    contradiction_refs: contradictionRefs, open_question_refs: lanes('question', limits.questions, 'open question'),
    recommended_action_refs: lanes('action', limits.actions, 'recommended action'),
    exclusions: exclusions.sort((a, b) => compareStableText(a.id, b.id) || compareStableText(a.reason, b.reason)),
    audit: { candidate_count: input.records.length, eligible_count: ranked.length, included_count: selected.length, contradiction_count: contradictionRefs.length, mutation: 'none' },
  };
  const outputValidation = validateCompactPrime(prime, {
    catalog: new Map(closedValid.map((record) => [record.id, record])),
    mode,
  });
  issues.push(...outputValidation.issues);
  debug.push(...ranked.map(({ record, score, relevance, scope, recency, lifecycle: lifecycleFitness, authority }) => ({ id: record.id, eligible: true, total_score: score, relevance, scope_specificity: scope, recency, lifecycle_fitness: lifecycleFitness, authority_visibility: authority })));
  debug.sort((left, right) => compareStableText(left.id, right.id));
  return {
    ok: !issues.some((entry) => entry.severity === 'error'), value: prime, issues: sortValidationIssues(issues),
    debug,
  };
}
