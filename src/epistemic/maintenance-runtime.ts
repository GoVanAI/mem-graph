/**
 * Persistence-driven belief maintenance projection.
 *
 * Per EPB-001 D14 and [[283]] Step 8 maintenance lane: project a record's
 * present-day influence and review state from immutable revisions and
 * receipts without rewriting historical confidence.
 *
 * Deterministic, computed view. No new tables — the projection reads from
 * the existing epistemic_revisions, epistemic_receipts, and epistemic_provenance
 * tables. Per [[283]] Locked Invariant #11, historical confidence is never
 * decayed; only present applicability, priming, and review state change.
 *
 * Seven preserved invariants from v0.4 stale-belief-control:
 *   - historical_confidence      — never mutated
 *   - support_summary            — derived from independent challenges + linked outcomes
 *   - applicability_freshness     — derived from most-recent deliberate challenge
 *   - influence_score            — derived from explicit meaningful use breadth only
 *   - review_priority_score      — separate blend of risk + volatility + influence
 *   - ordinary_priming_factor    — bounded present-day selection factor
 *   - audit_visibility           — full visibility for due / challenged / overdue
 */

import type Database from 'better-sqlite3';

export type ReviewReason = 'overdue' | 'review_due' | 'worldview_audit' | 'challenged' | 'current';
export type ReviewUrgency = 'challenged' | 'overdue' | 'worldview_audit' | 'review_due' | 'current';

export interface ReceiptCounts {
  challenge: number;
  use: number;
  outcome: number;
  contradiction: number;
  review_deadline: number;
}

export interface LinkedOutcomeSummary {
  matched: number;
  missed: number;
  inconclusive: number;
  attributed: number;
  unattributed: number;
}

export interface BeliefMaintenanceProjection {
  record_id: number;
  historical_confidence: number;
  support_summary: {
    distinct_independent_challenges: number;
    linked_outcomes: LinkedOutcomeSummary;
    contradiction_signals: number;
  };
  applicability_freshness: {
    last_challenged_at: string | null;
    last_updated_at: string;
    days_since_challenge: number;
    fresh: boolean;
  };
  influence_score: number;
  review_priority_score: number;
  ordinary_priming_factor: number;
  review_state: ReviewUrgency;
  review_reasons: ReviewReason[];
}

export interface ProjectMaintenanceInput {
  record_id: number;
  /** Review policy fields — risk/volatility/interval/influence thresholds. */
  review_after?: string | null;
  review_interval_days?: number;
  risk_score?: number;
  volatility_score?: number;
  high_influence_threshold?: number;
  worldview_project_threshold?: number;
  worldview_distinct_project_threshold?: number;
  worldview_use_threshold?: number;
  applicability_floor?: number;
  /** Reference time (defaults to now). */
  now?: string;
}

const DEFAULT_REVIEW_INTERVAL_DAYS = 90;
const DEFAULT_HIGH_INFLUENCE_THRESHOLD = 0.7;
const DEFAULT_WORLDVIEW_PROJECT_THRESHOLD = 3;
const DEFAULT_WORLDVIEW_DISTINCT_PROJECT_THRESHOLD = 2;
const DEFAULT_WORLDVIEW_USE_THRESHOLD = 5;
const DEFAULT_APPLICABILITY_FLOOR = 0.2;

function daysBetween(later: Date, earlier: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 86_400_000));
}

/**
 * Count receipts per type for a record.
 */
export function countReceipts(
  db: Database.Database,
  recordId: number,
): ReceiptCounts {
  const rows = db
    .prepare(
      `SELECT receipt_type, COUNT(*) AS c
         FROM epistemic_receipts
         WHERE record_id = ?
         GROUP BY receipt_type`,
    )
    .all(recordId) as Array<{ receipt_type: string; c: number }>;
  const counts: ReceiptCounts = {
    challenge: 0,
    use: 0,
    outcome: 0,
    contradiction: 0,
    review_deadline: 0,
  };
  for (const r of rows) {
    if (r.receipt_type === 'ChallengeReceipt') counts.challenge = r.c;
    else if (r.receipt_type === 'BeliefUseReceipt') counts.use = r.c;
    else if (r.receipt_type === 'DecisionOutcomeReceipt') counts.outcome = r.c;
    else if (r.receipt_type === 'ContradictionSignal') counts.contradiction = r.c;
    else if (r.receipt_type === 'ReviewDeadlineReceipt') counts.review_deadline = r.c;
  }
  return counts;
}

/**
 * Distinct independent challenge count — same independence_key collapses
 * per v0.4 duplicate-rejection invariant.
 */
export function distinctIndependentChallenges(
  db: Database.Database,
  recordId: number,
): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT independence_key
         FROM epistemic_receipts
         WHERE record_id = ? AND receipt_type = 'ChallengeReceipt'
           AND independence_key IS NOT NULL`,
    )
    .all(recordId) as Array<{ independence_key: string }>;
  return rows.length;
}

/**
 * Most-recent deliberate challenge timestamp for a record, or null.
 */
export function lastChallengeAt(
  db: Database.Database,
  recordId: number,
): string | null {
  const row = db
    .prepare(
      `SELECT MAX(observed_at) AS last
         FROM epistemic_receipts
         WHERE record_id = ? AND receipt_type = 'ChallengeReceipt'`,
    )
    .get(recordId) as { last: string | null };
  return row?.last ?? null;
}

/**
 * Distinct projects and decisions the record has been used in. Used for
 * the influence_score (only from explicit meaningful use breadth).
 */
export function explicitUseBreadth(
  db: Database.Database,
  recordId: number,
): { distinct_projects: number; distinct_decisions: number } {
  const projects = db
    .prepare(
      `SELECT DISTINCT json_extract(receipt_payload, '$.project_id') AS pid
         FROM epistemic_receipts
         WHERE record_id = ? AND receipt_type = 'BeliefUseReceipt'`,
    )
    .all(recordId) as Array<{ pid: string | null }>;
  const decisions = db
    .prepare(
      `SELECT DISTINCT json_extract(receipt_payload, '$.decision_id') AS did
         FROM epistemic_receipts
         WHERE record_id = ? AND receipt_type = 'BeliefUseReceipt'`,
    )
    .all(recordId) as Array<{ did: string | null }>;
  return {
    distinct_projects: projects.filter((p) => p.pid !== null).length,
    distinct_decisions: decisions.filter((d) => d.did !== null).length,
  };
}

/**
 * Linked outcome receipts grouped by result. v0.4 says only receipts with
 * a matching same-belief, same-decision BeliefUseReceipt are "attributed."
 * For Slice 1 we treat the existence of a BeliefUseReceipt with the same
 * decision_id as evidence of attribution; this is a conservative first
 * pass and the inference can be tightened later without changing the API.
 */
export function linkedOutcomes(
  db: Database.Database,
  recordId: number,
): LinkedOutcomeSummary {
  const rows = db
    .prepare(
      `SELECT json_extract(receipt_payload, '$.result') AS result
         FROM epistemic_receipts
         WHERE record_id = ? AND receipt_type = 'DecisionOutcomeReceipt'`,
    )
    .all(recordId) as Array<{ result: string | null }>;
  const useDecisions = db
    .prepare(
      `SELECT DISTINCT json_extract(receipt_payload, '$.decision_id') AS did
         FROM epistemic_receipts
         WHERE record_id = ? AND receipt_type = 'BeliefUseReceipt'`,
    )
    .all(recordId) as Array<{ did: string | null }>;
  const attributedDecisionIds = new Set(
    useDecisions.map((u) => u.did).filter((d): d is string => d !== null),
  );
  const summary: LinkedOutcomeSummary = {
    matched: 0,
    missed: 0,
    inconclusive: 0,
    attributed: 0,
    unattributed: 0,
  };
  for (const r of rows) {
    if (r.result === 'matched') summary.matched += 1;
    else if (r.result === 'missed') summary.missed += 1;
    else summary.inconclusive += 1;
  }
  // attribution requires the outcome receipt payload to carry decision_id matching a use
  const outcomeRows = db
    .prepare(
      `SELECT json_extract(receipt_payload, '$.decision_id') AS did
         FROM epistemic_receipts
         WHERE record_id = ? AND receipt_type = 'DecisionOutcomeReceipt'`,
    )
    .all(recordId) as Array<{ did: string | null }>;
  for (const o of outcomeRows) {
    if (o.did !== null && attributedDecisionIds.has(o.did)) {
      summary.attributed += 1;
    } else {
      summary.unattributed += 1;
    }
  }
  return summary;
}

/**
 * Project the maintenance state for a single record. Pure function over
 * the immutable tables; no writes.
 */
export function projectMaintenance(
  db: Database.Database,
  input: ProjectMaintenanceInput,
): BeliefMaintenanceProjection {
  const record = db
    .prepare(
      `SELECT confidence, valid_from, updated_at
         FROM epistemic_records WHERE record_id = ?`,
    )
    .get(input.record_id) as
    | { confidence: number; valid_from: string; updated_at: string }
    | undefined;
  if (!record) {
    throw new Error(`record_id ${input.record_id} does not exist`);
  }

  const intervalDays = input.review_interval_days ?? DEFAULT_REVIEW_INTERVAL_DAYS;
  const highInfluenceThreshold = input.high_influence_threshold ?? DEFAULT_HIGH_INFLUENCE_THRESHOLD;
  const worldviewProjectThreshold =
    input.worldview_project_threshold ?? DEFAULT_WORLDVIEW_PROJECT_THRESHOLD;
  const worldviewDistinctProjectThreshold =
    input.worldview_distinct_project_threshold ?? DEFAULT_WORLDVIEW_DISTINCT_PROJECT_THRESHOLD;
  const worldviewUseThreshold = input.worldview_use_threshold ?? DEFAULT_WORLDVIEW_USE_THRESHOLD;
  const applicabilityFloor = input.applicability_floor ?? DEFAULT_APPLICABILITY_FLOOR;

  const nowDate = input.now ? new Date(input.now) : new Date();
  const updatedDate = new Date(record.updated_at);

  const distinctChallenges = distinctIndependentChallenges(db, input.record_id);
  const linked = linkedOutcomes(db, input.record_id);
  const use = explicitUseBreadth(db, input.record_id);
  const lastChallengedIso = lastChallengeAt(db, input.record_id);

  // Concession: applicability_freshness computed from most-recent deliberate
  // challenge, or from record.updated_at when no challenge exists.
  const lastChallengedDate = lastChallengedIso ? new Date(lastChallengedIso) : null;
  const refDate = lastChallengedDate ?? updatedDate;
  const daysSinceChallenge = daysBetween(nowDate, refDate);

  // Concession: applicability decays linearly from 1.0 over one interval,
  // bounded by applicability_floor.
  const intervalProgress = Math.min(1, daysSinceChallenge / intervalDays);
  const applicabilityFactor = Math.max(
    applicabilityFloor,
    1 - intervalProgress,
  );

  // Concession: influence_score is computed ONLY from explicit meaningful
  // use breadth (distinct projects + distinct decisions). It is never
  // influenced by retrieval count or repetition.
  const influenceScore = Math.min(
    1,
    (use.distinct_projects + use.distinct_decisions) / 10,
  );

  // Concession: review_priority_score is a separate blend that may
  // include risk and volatility in addition to influence. Risk and
  // volatility defaults are 0 (no explicit policy set yet); the blend
  // reflects that the operator-supplied policy is the input.
  const riskScore = input.risk_score ?? 0;
  const volatilityScore = input.volatility_score ?? 0;
  const reviewPriorityScore = Math.min(
    1,
    0.5 * influenceScore + 0.3 * riskScore + 0.2 * volatilityScore,
  );

  // Concession: ordinary_priming_factor is bounded present-day selection
  // factor. It is the product of applicability and a base selection
  // factor (1.0), minus ordinary decay. Historical confidence is not
  // multiplied in.
  const ordinaryPrimingFactor = applicabilityFactor;

  // Concession: review_state derives from freshness, challenges, and
  // high-influence threshold. Audit visibility is always full for
  // due / challenged / overdue; the factor governs only ordinary
  // selection, not audit surfacing.
  const reasons: ReviewReason[] = ['current'];
  let urgency: ReviewUrgency = 'current';

  if (linked.missed > 0 && influenceScore >= highInfluenceThreshold) {
    reasons.push('challenged');
    urgency = 'challenged';
  }
  if (daysSinceChallenge >= intervalDays) {
    reasons.push('overdue');
    urgency = urgency === 'current' ? 'overdue' : urgency;
  }
  if (
    use.distinct_projects >= worldviewProjectThreshold &&
    use.distinct_decisions >= worldviewDistinctProjectThreshold &&
    linked.attributed >= worldviewUseThreshold
  ) {
    reasons.push('worldview_audit');
    urgency = urgency === 'current' ? 'worldview_audit' : urgency;
  }
  if (input.review_after && new Date(input.review_after) <= nowDate) {
    reasons.push('review_due');
    urgency = urgency === 'current' ? 'review_due' : urgency;
  }
  // Dedupe reasons preserving order
  const dedupedReasons: ReviewReason[] = [];
  for (const r of reasons) if (!dedupedReasons.includes(r)) dedupedReasons.push(r);

  return {
    record_id: input.record_id,
    historical_confidence: record.confidence,
    support_summary: {
      distinct_independent_challenges: distinctChallenges,
      linked_outcomes: linked,
      contradiction_signals: countReceipts(db, input.record_id).contradiction,
    },
    applicability_freshness: {
      last_challenged_at: lastChallengedIso,
      last_updated_at: record.updated_at,
      days_since_challenge: daysSinceChallenge,
      fresh: applicabilityFactor >= applicabilityFloor,
    },
    influence_score: influenceScore,
    review_priority_score: reviewPriorityScore,
    ordinary_priming_factor: ordinaryPrimingFactor,
    review_state: urgency,
    review_reasons: dedupedReasons,
  };
}

/**
 * Build a stable review queue from the projections of all records in a
 * project. Returns the v0.4 stable ordering:
 *   challenged → overdue → worldview_audit → review_due → influence desc → id asc
 */
export function buildReviewQueue(
  db: Database.Database,
  project_id: string,
  options: { include_global?: boolean; limit?: number } = {},
): BeliefMaintenanceProjection[] {
  const includeGlobal = options.include_global === true;
  const scope = includeGlobal
    ? "(project_id = ? OR project_id = '_global')"
    : 'project_id = ?';
  const records = db
    .prepare(`SELECT record_id FROM epistemic_records WHERE ${scope} ORDER BY record_id ASC`)
    .all(project_id) as Array<{ record_id: number }>;
  const projections = records.map((r) =>
    projectMaintenance(db, { record_id: r.record_id }),
  );

  const urgencyRank: Record<ReviewUrgency, number> = {
    challenged: 0,
    overdue: 1,
    worldview_audit: 2,
    review_due: 3,
    current: 4,
  };
  projections.sort((a, b) => {
    const ru = urgencyRank[a.review_state] - urgencyRank[b.review_state];
    if (ru !== 0) return ru;
    // Within the same urgency, descending influence
    if (b.influence_score !== a.influence_score) return b.influence_score - a.influence_score;
    // Then ascending record_id
    return a.record_id - b.record_id;
  });
  return projections.slice(0, options.limit ?? 100);
}
