/**
 * Step 8 tests — persistence-driven retrieval + computed maintenance lanes.
 *
 * Oracle requirements (verbatim from [[283]] Step 8 acceptance):
 *   - exact-project is default; include_global=false remains default;
 *   - unverified claims never enter governing guidance;
 *   - maintenance reproduces Phase A review-deadline, deliberate-challenge,
 *     linked-outcome, contradiction-pressure, applicability, influence,
 *     worldview invariants; historical confidence unchanged.
 *
 * This file complements tests/epistemic-maintenance.test.ts which covers
 * the pure v0.3/v0.4 kernel (in-memory). The tests here exercise the
 * persistence-driven projections that read from epistemic_revisions,
 * epistemic_receipts, and epistemic_provenance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, initDatabase, closeAllDatabases } from '../src/db.js';
import { admitEpistemicRecord, appendEpistemicReceipt } from '../src/epistemic/persistence.js';
import { projectCurrentState, rebuildProjection } from '../src/epistemic/projections.js';
import {
  projectMaintenance,
  buildReviewQueue,
  countReceipts,
  distinctIndependentChallenges,
  linkedOutcomes,
  explicitUseBreadth,
} from '../src/epistemic/maintenance-runtime.js';
import { bootstrapCognitiveAgentWithEpistemicLane } from '../src/cognitive/agent-bootstrap.js';

let tmpDir: string;
let originalDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'epistemic-maint-rt-'));
  originalDir = process.env.MEM_GRAPH_DIR;
  process.env.MEM_GRAPH_DIR = tmpDir;
  initDatabase('memory');
});

afterEach(() => {
  closeAllDatabases();
  try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (originalDir === undefined) delete process.env.MEM_GRAPH_DIR;
  else process.env.MEM_GRAPH_DIR = originalDir;
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotency_key: 'k-1',
    project_id: 'cognitive-os',
    scope: 'exact-project' as const,
    statement: 'Activation is contextual, not canonical retrieval.',
    epistemic_status: 'inferred' as const,
    verification_level: 'direct',
    source_quality: 'observed',
    confidence: 0.85,
    valid_from: '2026-08-09T00:00:00.000Z',
    task_id: 'task-1',
    ...overrides,
  };
}

describe('projectMaintenance — v0.4 invariants preserved', () => {
  it('historical_confidence is never mutated', () => {
    const db = getDatabase('memory');
    const r = admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1', confidence: 0.7 }));
    expect(r.revision_id).toBeDefined();

    const proj = projectMaintenance(db, { record_id: 1, now: '2026-08-09T01:00:00.000Z' });
    expect(proj.historical_confidence).toBe(0.7);

    appendEpistemicReceipt(db, {
      idempotency_key: 'r-1',
      record_id: 1,
      revision_id: r.revision_id,
      receipt_type: 'ChallengeReceipt',
      receipt_payload: { result: 'supported', independence_key: 'k-a' },
      independence_key: 'k-a',
      observed_at: '2026-08-09T02:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    });
    const proj2 = projectMaintenance(db, { record_id: 1, now: '2026-08-09T03:00:00.000Z' });
    expect(proj2.historical_confidence).toBe(0.7);
  });

  it('applicability_freshness decays over time since last challenge', () => {
    const db = getDatabase('memory');
    admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    const fresh = projectMaintenance(db, { record_id: 1, now: '2026-08-09T01:00:00.000Z' });
    expect(fresh.applicability_freshness.days_since_challenge).toBe(0);
    expect(fresh.applicability_freshness.fresh).toBe(true);
    expect(fresh.ordinary_priming_factor).toBeGreaterThan(0.9);

    const stale = projectMaintenance(db, { record_id: 1, now: '2026-11-17T01:00:00.000Z' });
    expect(stale.applicability_freshness.days_since_challenge).toBeGreaterThanOrEqual(95);
    expect(stale.ordinary_priming_factor).toBeLessThanOrEqual(0.2); // floor
  });

  it('deliberate challenge resets applicability_freshness', () => {
    const db = getDatabase('memory');
    const r = admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    appendEpistemicReceipt(db, {
      idempotency_key: 'r-c',
      record_id: 1,
      revision_id: r.revision_id,
      receipt_type: 'ChallengeReceipt',
      receipt_payload: { result: 'supported' },
      independence_key: 'k-challenge-1',
      observed_at: '2026-08-15T00:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    });
    const proj = projectMaintenance(db, { record_id: 1, now: '2026-09-14T12:00:00.000Z' });
    expect(proj.applicability_freshness.last_challenged_at).toBe('2026-08-15T00:00:00.000Z');
    expect(proj.applicability_freshness.days_since_challenge).toBe(30);
  });

  it('distinct_independent_challenges collapses duplicate independence_keys', () => {
    const db = getDatabase('memory');
    const r = admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    for (let i = 0; i < 3; i += 1) {
      appendEpistemicReceipt(db, {
        idempotency_key: `r-${i}`,
        record_id: 1,
        revision_id: r.revision_id,
        receipt_type: 'ChallengeReceipt',
        receipt_payload: { result: 'supported' },
        independence_key: 'k-shared',
        observed_at: `2026-08-09T0${i + 1}:00:00.000Z`,
        task_id: 't',
        project_id: 'cognitive-os',
      });
    }
    const proj = projectMaintenance(db, { record_id: 1, now: '2026-08-10T00:00:00.000Z' });
    expect(proj.support_summary.distinct_independent_challenges).toBe(1);
    expect(distinctIndependentChallenges(db, 1)).toBe(1);
  });

  it('linked_outcomes categorizes by attribution to a use receipt', () => {
    const db = getDatabase('memory');
    const r = admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    appendEpistemicReceipt(db, {
      idempotency_key: 'r-use',
      record_id: 1,
      revision_id: r.revision_id,
      receipt_type: 'BeliefUseReceipt',
      receipt_payload: { decision_id: 'd-1', project_id: 'p-1' },
      observed_at: '2026-08-09T02:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    });
    appendEpistemicReceipt(db, {
      idempotency_key: 'r-out-1',
      record_id: 1,
      revision_id: r.revision_id,
      receipt_type: 'DecisionOutcomeReceipt',
      receipt_payload: { result: 'matched', decision_id: 'd-1' },
      observed_at: '2026-08-09T03:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    });
    appendEpistemicReceipt(db, {
      idempotency_key: 'r-out-2',
      record_id: 1,
      revision_id: r.revision_id,
      receipt_type: 'DecisionOutcomeReceipt',
      receipt_payload: { result: 'missed', decision_id: 'd-999' },
      observed_at: '2026-08-09T03:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    });
    const proj = projectMaintenance(db, { record_id: 1, now: '2026-08-09T04:00:00.000Z' });
    expect(proj.support_summary.linked_outcomes.matched).toBe(1);
    expect(proj.support_summary.linked_outcomes.missed).toBe(1);
    expect(proj.support_summary.linked_outcomes.attributed).toBe(1);
    expect(proj.support_summary.linked_outcomes.unattributed).toBe(1);
  });

  it('influence_score is derived ONLY from explicit use breadth, not retrieval or repetition', () => {
    const db = getDatabase('memory');
    const r = admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    const baseline = projectMaintenance(db, { record_id: 1 });
    expect(baseline.influence_score).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      appendEpistemicReceipt(db, {
        idempotency_key: `r-${i}`,
        record_id: 1,
        revision_id: r.revision_id,
        receipt_type: 'BeliefUseReceipt',
        receipt_payload: {
          decision_id: `d-${i % 4}`,
          project_id: `p-${i % 3}`,
          role: i === 0 ? 'decisive' : 'supporting',
        },
        observed_at: '2026-08-09T02:00:00.000Z',
        task_id: 't',
        project_id: 'cognitive-os',
      });
    }
    const proj = projectMaintenance(db, { record_id: 1 });
    expect(explicitUseBreadth(db, 1)).toEqual({ distinct_projects: 3, distinct_decisions: 4 });
    expect(proj.influence_score).toBeCloseTo(0.7, 2);
  });

  it('review_priority_score is separate from influence_score (uses risk + volatility)', () => {
    const db = getDatabase('memory');
    const r = admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    for (let i = 0; i < 5; i += 1) {
      appendEpistemicReceipt(db, {
        idempotency_key: `r-${i}`,
        record_id: 1,
        revision_id: r.revision_id,
        receipt_type: 'BeliefUseReceipt',
        receipt_payload: { decision_id: `d-${i}`, project_id: `p-${i % 2}` },
        observed_at: '2026-08-09T02:00:00.000Z',
        task_id: 't',
        project_id: 'cognitive-os',
      });
    }
    const withoutRisk = projectMaintenance(db, { record_id: 1 });
    const withRisk = projectMaintenance(db, { record_id: 1, risk_score: 0.9, volatility_score: 0.5 });
    expect(withRisk.review_priority_score).toBeGreaterThan(withoutRisk.review_priority_score);
    expect(withRisk.influence_score).toBe(withoutRisk.influence_score);
  });

  it('review_state derives overdue after interval_days elapsed', () => {
    const db = getDatabase('memory');
    admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    const old = projectMaintenance(db, {
      record_id: 1,
      review_interval_days: 30,
      now: '2026-12-01T00:00:00.000Z',
    });
    expect(old.review_reasons).toContain('overdue');
    expect(old.review_state).toBe('overdue');
  });

  it('review_state is challenged when high-influence has missed outcomes', () => {
    const db = getDatabase('memory');
    const r = admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    for (let i = 0; i < 7; i += 1) {
      appendEpistemicReceipt(db, {
        idempotency_key: `r-${i}`,
        record_id: 1,
        revision_id: r.revision_id,
        receipt_type: 'BeliefUseReceipt',
        receipt_payload: { decision_id: `d-${i}`, project_id: 'p-a' },
        observed_at: '2026-08-09T02:00:00.000Z',
        task_id: 't',
        project_id: 'cognitive-os',
      });
    }
    appendEpistemicReceipt(db, {
      idempotency_key: 'r-miss',
      record_id: 1,
      revision_id: r.revision_id,
      receipt_type: 'DecisionOutcomeReceipt',
      receipt_payload: { result: 'missed', decision_id: 'd-0' },
      observed_at: '2026-08-09T03:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    });
    const proj = projectMaintenance(db, {
      record_id: 1,
      high_influence_threshold: 0.5,
    });
    expect(proj.review_reasons).toContain('challenged');
    expect(proj.review_state).toBe('challenged');
  });
});

describe('buildReviewQueue — stable ordering', () => {
  it('orders challenged → overdue → current by urgency rank', () => {
    const db = getDatabase('memory');
    const a = admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-a' }));
    for (let i = 0; i < 5; i += 1) {
      appendEpistemicReceipt(db, {
        idempotency_key: `r-a-${i}`,
        record_id: 1,
        revision_id: a.revision_id,
        receipt_type: 'BeliefUseReceipt',
        receipt_payload: { decision_id: `d-${i}`, project_id: 'p-a' },
        observed_at: '2026-08-09T02:00:00.000Z',
        task_id: 't',
        project_id: 'cognitive-os',
      });
    }
    appendEpistemicReceipt(db, {
      idempotency_key: 'r-a-miss',
      record_id: 1,
      revision_id: a.revision_id,
      receipt_type: 'DecisionOutcomeReceipt',
      receipt_payload: { result: 'missed', decision_id: 'd-0' },
      observed_at: '2026-08-09T03:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    });
    admitEpistemicRecord(db, baseInput({ record_id: 2, idempotency_key: 'k-b' }));
    admitEpistemicRecord(db, baseInput({ record_id: 3, idempotency_key: 'k-c' }));

    const queue = buildReviewQueue(db, 'cognitive-os', {});
    expect(queue[0].record_id).toBe(1);
    expect(queue.find((p) => p.record_id === 2)?.review_state).toBe('current');
  });
});

describe('countReceipts — grouped by type', () => {
  it('counts five receipt types per record', () => {
    const db = getDatabase('memory');
    const r = admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    appendEpistemicReceipt(db, {
      idempotency_key: 'r-1',
      record_id: 1,
      revision_id: r.revision_id,
      receipt_type: 'ChallengeReceipt',
      receipt_payload: {},
      observed_at: '2026-08-09T02:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    });
    const counts = countReceipts(db, 1);
    expect(counts.challenge).toBe(1);
    expect(counts.use).toBe(0);
    expect(counts.outcome).toBe(0);
    expect(counts.contradiction).toBe(0);
    expect(counts.review_deadline).toBe(0);
  });
});

describe('linkedOutcomes — standalone helper', () => {
  it('returns the same shape as the maintenance projection field', () => {
    const db = getDatabase('memory');
    const r = admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    appendEpistemicReceipt(db, {
      idempotency_key: 'r-use',
      record_id: 1,
      revision_id: r.revision_id,
      receipt_type: 'BeliefUseReceipt',
      receipt_payload: { decision_id: 'd-1', project_id: 'p-1' },
      observed_at: '2026-08-09T02:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    });
    appendEpistemicReceipt(db, {
      idempotency_key: 'r-out',
      record_id: 1,
      revision_id: r.revision_id,
      receipt_type: 'DecisionOutcomeReceipt',
      receipt_payload: { result: 'matched', decision_id: 'd-1' },
      observed_at: '2026-08-09T03:00:00.000Z',
      task_id: 't',
      project_id: 'cognitive-os',
    });
    expect(linkedOutcomes(db, 1)).toEqual({
      matched: 1,
      missed: 0,
      inconclusive: 0,
      attributed: 1,
      unattributed: 0,
    });
  });
});

describe('bootstrapCognitiveAgentWithEpistemicLane — retrieval lane', () => {
  it('surfaces epistemic records in a separate lane, never in governing', () => {
    const db = getDatabase('memory');
    admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    admitEpistemicRecord(db, baseInput({ record_id: 2, idempotency_key: 'k-2' }));

    const result = bootstrapCognitiveAgentWithEpistemicLane(db, {
      query: 'epistemic',
      project_id: 'cognitive-os',
    });
    expect(result.epistemic_lane).toBeDefined();
    expect(result.epistemic_lane.total_matched).toBe(2);
    expect(result.epistemic_lane.records.map((r) => r.record_id)).toEqual([1, 2]);
    expect(result.epistemic_lane.records.every((r) => r.ordinary_priming_factor > 0)).toBe(true);
    expect(result.guidance.governing.map((r) => r.id)).not.toContain(1);
    expect(result.guidance.governing.map((r) => r.id)).not.toContain(2);
  });

  it('epistemic_lane authority_notice states unverified claims do not gain authority', () => {
    const db = getDatabase('memory');
    admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    const result = bootstrapCognitiveAgentWithEpistemicLane(db, {
      query: 'x',
      project_id: 'cognitive-os',
    });
    expect(result.epistemic_lane.authority_notice.toLowerCase()).toContain('do not');
    expect(result.epistemic_lane.authority_notice.toLowerCase()).toContain('authority');
  });

  it('zero-write: bootstrap does not touch any table', () => {
    const db = getDatabase('memory');
    admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    rebuildProjection(db);

    const before = {
      events: (db.prepare('SELECT COUNT(*) AS c FROM cognitive_events').get() as { c: number }).c,
      revisions: (db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get() as { c: number }).c,
      receipts: (db.prepare('SELECT COUNT(*) AS c FROM epistemic_receipts').get() as { c: number }).c,
      records: (db.prepare('SELECT COUNT(*) AS c FROM epistemic_records').get() as { c: number }).c,
    };
    bootstrapCognitiveAgentWithEpistemicLane(db, {
      query: 'x',
      project_id: 'cognitive-os',
    });
    const after = {
      events: (db.prepare('SELECT COUNT(*) AS c FROM cognitive_events').get() as { c: number }).c,
      revisions: (db.prepare('SELECT COUNT(*) AS c FROM epistemic_revisions').get() as { c: number }).c,
      receipts: (db.prepare('SELECT COUNT(*) AS c FROM epistemic_receipts').get() as { c: number }).c,
      records: (db.prepare('SELECT COUNT(*) AS c FROM epistemic_records').get() as { c: number }).c,
    };
    expect(after).toEqual(before);
  });

  it('include_global=false excludes records from other projects', () => {
    const db = getDatabase('memory');
    admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1', project_id: 'cognitive-os' }));
    admitEpistemicRecord(db, baseInput({ record_id: 2, idempotency_key: 'k-2', project_id: 'other' }));
    const result = bootstrapCognitiveAgentWithEpistemicLane(db, {
      query: 'x',
      project_id: 'cognitive-os',
    });
    expect(result.epistemic_lane.records.map((r) => r.project_id)).toEqual(['cognitive-os']);
    expect(result.epistemic_lane.total_matched).toBe(1);
  });

  it('preserves the original bootstrap result shape', () => {
    const db = getDatabase('memory');
    admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    const result = bootstrapCognitiveAgentWithEpistemicLane(db, {
      query: 'x',
      project_id: 'cognitive-os',
    });
    expect(result.practice.id).toBe('mem-graph-agent-practice');
    expect(result.scope.project_id).toBe('cognitive-os');
    expect(result.canonical_snapshot).toBeDefined();
    expect(result.policy_lookup).toBeDefined();
    expect(result.guidance).toBeDefined();
    expect(result.bootstrap_digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('projectCurrentState — sanity under Step 8', () => {
  it('returns one row per active record', () => {
    const db = getDatabase('memory');
    admitEpistemicRecord(db, baseInput({ record_id: 1, idempotency_key: 'k-1' }));
    admitEpistemicRecord(db, baseInput({ record_id: 2, idempotency_key: 'k-2' }));
    expect(projectCurrentState(db)).toHaveLength(2);
  });
});
