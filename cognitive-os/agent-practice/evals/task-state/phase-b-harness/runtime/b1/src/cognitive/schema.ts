/**
 * Additive schema for the Cognitive OS sidecar.  It intentionally does not
 * alter any of mem-graph's existing tables or triggers.
 */
export const COGNITIVE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cognitive_events (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'DecisionMade',
    'ExecutionObserved',
    'EvidenceObserved',
    'BeliefRevised',
    'ReflectionProposed',
    'PolicyCandidateCreated',
    'PolicyRetrieved',
    'PolicyEvaluated'
  )),
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  idempotency_key TEXT UNIQUE,
  payload TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  idempotency_hash TEXT
);

CREATE INDEX IF NOT EXISTS cognitive_events_project_sequence_idx
  ON cognitive_events(project_id, sequence);
CREATE INDEX IF NOT EXISTS cognitive_events_task_sequence_idx
  ON cognitive_events(task_id, sequence);
CREATE INDEX IF NOT EXISTS cognitive_events_type_sequence_idx
  ON cognitive_events(event_type, sequence);
CREATE INDEX IF NOT EXISTS cognitive_events_correlation_sequence_idx
  ON cognitive_events(correlation_id, sequence);

CREATE TRIGGER IF NOT EXISTS cognitive_events_reject_update
BEFORE UPDATE ON cognitive_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'cognitive_events is append-only: updates are rejected');
END;

CREATE TRIGGER IF NOT EXISTS cognitive_events_reject_delete
BEFORE DELETE ON cognitive_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'cognitive_events is append-only: deletes are rejected');
END;

CREATE TABLE IF NOT EXISTS policy_candidates (
  policy_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_value TEXT NOT NULL,
  action_json TEXT NOT NULL,
  exclusions_json TEXT NOT NULL,
  verifier_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'strengthened', 'revised', 'rejected')),
  evaluation_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  inconclusive_count INTEGER NOT NULL DEFAULT 0,
  source_event_id TEXT NOT NULL UNIQUE REFERENCES cognitive_events(event_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS policy_candidates_lookup_idx
  ON policy_candidates(project_id, trigger_type, trigger_value, status);
CREATE INDEX IF NOT EXISTS policy_candidates_source_event_idx
  ON policy_candidates(source_event_id);

CREATE TABLE IF NOT EXISTS policy_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policy_candidates(policy_id),
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed', 'inconclusive')),
  metrics_json TEXT NOT NULL,
  guardrail_regression INTEGER NOT NULL CHECK(guardrail_regression IN (0, 1)),
  source_event_id TEXT NOT NULL UNIQUE REFERENCES cognitive_events(event_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS policy_evaluations_policy_idx
  ON policy_evaluations(policy_id);
CREATE INDEX IF NOT EXISTS policy_evaluations_project_idx
  ON policy_evaluations(project_id);
`;
