# EPB-001: Epistemic Phase B Persistence and Admission Contract

Status: **draft for operator adoption** (Step 0 of [[283]])  
Date: 2026-08-09  
Owner: M3 (proposed) — operator must explicitly adopt  
Project: `cognitive-os`  
Stable task identity: `epistemic-kernel-activation-phase-b`  
Authoritative pickup artifact: [[283]]  
Governing references: [[253]] (tracker), [[254]] (scope boundary), [[252]] (M3 role), `MVP-002-typed-admission-projection-integrity.md`, `EPISTEMIC_MEMORY_V0_3_IMPLEMENTATION_HANDOFF.md`, `EPISTEMIC_MEMORY_V0_4_STALE_BELIEF_CONTROL.md`, `src/cognitive/{events,policy,schema}.ts` (existing templates)

## Purpose

Define the durable contract for Epistemic Memory Phase B — versioned, transactional SQLite persistence and admission — so that [[283]] Steps 2–7 have an unambiguous specification to implement against. This document is the artifact that an operator DecisionMade event adopts. Until adoption, the contract is a proposal.

## Scope boundary

In scope:

- `epistemic_records`, `epistemic_revisions`, `epistemic_receipts`, `epistemic_provenance` (current projection, contradiction projection, review projection, support summary projection)
- Versioned migration runner and `schema_migrations` ledger
- Event-contract registry and accepted epistemic event vocabulary
- Atomic admission service with idempotency and optimistic concurrency
- Minimal MCP adapter surface (zero-write reads, narrow mutations)
- Read-only retrieval and maintenance lanes for bootstrap/priming

Out of scope (explicit non-goals):

- General ontology, TypeDB, TypeQL, or inference engine
- Synapses reinterpreted as epistemic relations
- Hooks, schedulers, unattended repair, or automatic policy promotion
- Hard enforcement of any contract
- Cross-project or `_global` scope unless explicitly authorized
- Automatic contradiction triggers, recurring review schedules, or cross-project influence graphs
- First-class semantic relation persistence **unless Option B is adopted below**

## Locked invariants

Inherited from [[283]] §"Locked invariants" and adopted verbatim:

1. Existing memories, FTS, tags, synapses, decay, cognitive events, policy candidates, retrieval ranking, and current-guidance behavior remain backward compatible.
2. Existing cognitive event history remains readable and hash-verifiable without rewrite.
3. Every new epistemic write is structurally and semantically validated before durable mutation.
4. One retryable request has one idempotency key bound to one canonical normalized input. Identical retry returns the original result; changed content fails closed.
5. Corrections, retractions, status changes, confidence revisions, and relation changes append revisions or receipts. History is never updated or deleted in place.
6. The current-state table is a projection. Immutable revisions and receipts are canonical persistence; projection state must be deletable and reproducible.
7. Admission is atomic in this order inside one outer transaction: validate and normalize → resolve idempotency and expected version → append typed cognitive source event → append immutable revision/receipt rows → refresh affected projections → run scoped integrity checks → commit. Any failure rolls back every write, including the event.
8. Authority values in an epistemic record are claims. Admission never makes them governing. Binding eligibility still requires a separately verified authority identity.
9. Exact-project is the default. Cross-project and `_global` scope require explicit representation and authorization. Cross-scope relations fail closed.
10. Retrieval, repetition, eligibility, confidence, and semantic similarity do not establish truth or authority.
11. Historic confidence is not decayed. Maintenance changes current applicability, priming, review state, or creates a new revision from new evidence.
12. No relation is stored in synapses.
13. No hook, scheduler, unattended repair, automatic admission, or policy promotion enters this phase.
14. Read-only MCP paths do not touch access counters, events, receipts, projections, or timestamps unless their contract explicitly says otherwise.
15. Public documents and fixtures remain clean-room and contain no deployment-local memory IDs or machine-specific paths.

## Decision matrix

Every row below must be adopted (operator marks **Adopted** or **Revised**) before Step 2 begins.

| # | Decision | Recommended value | Alternative | Required operator action |
|---|---|---|---|---|
| D1 | Canonical identity | `record_id` (monotonic INTEGER PK), `revision_id` (UUIDv4), `(record_id, revision_number)` UNIQUE | Composite string key | Adopted / Revised |
| D2 | Source of truth | Immutable `epistemic_revisions` + `epistemic_receipts`; `epistemic_records` is rebuildable projection | Add columnar history | Adopted / Revised |
| D3 | Event vocabulary | Reuse `EvidenceObserved` (D3a); introduce `BeliefRevised` (D3b) in Slice 1; gate `ContradictionRecorded` and `BeliefSuperseded` to later slices | Add all event types now | Adopted / Revised |
| D4 | Schema versioning | `schema_migrations` table, ordered registry, SHA-256 checksums; `event_type` CHECK evolves via migration only | Bump-and-hope | Adopted / Revised |
| D5 | Timestamps | `source_observed_at`, `valid_from`, `valid_until`, `revision_created_at`, `event_observed_at`, `projection_updated_at` (all ISO-8601 UTC TEXT) | Unix epoch | Adopted / Revised |
| D6 | Concurrency | `expected_revision` parameter; create requires `expected_revision = 0`; stale writers fail with `STALE_REVISION` | Last-write-wins | Adopted / Revised |
| D7 | Idempotency | SHA-256 of canonical normalized JSON request envelope; stored in `idempotency_hash`; identical retry returns original `event_id` and revision | Opaque client token | Adopted / Revised |
| D8 | Correction semantics | Append `BeliefRevised` event with `revision_id` + `previous_revision_id`; never mutate in place | UPDATE SQL | Adopted / Revised |
| D9 | Retraction semantics | New `status='retracted'` revision; prior revisions remain immutable and audit-visible | Soft-delete column | Adopted / Revised |
| D10 | Supersession semantics | New revision with `superseded_by_record_id` link; supersession is a revision, not a delete | Pointer table | Adopted / Revised |
| D11 | Provenance storage | `epistemic_provenance` table: `source_memory_id` (FK), `source_event_id` (FK), `excerpt_hash`, `observed_at`, `recorded_by`, `observed_by_role` | JSON column | Adopted / Revised |
| D12 | Future-evidence handling | Reject `source_observed_at > revision_created_at + skew` (default 60s) with `FUTURE_EVIDENCE` | Accept with flag | Adopted / Revised |
| D13 | Authority storage | `authority_input` JSON column recording the authority verification input; admission never grants authority | Boolean flag | Adopted / Revised |
| D14 | Receipt vocabulary (Slice 1) | `ChallengeReceipt`, `BeliefUseReceipt`, `DecisionOutcomeReceipt`, `ContradictionSignal` (types in `epistemic_receipts`); `ReviewDeadlineReceipt` follows in Slice 3 | Single receipt type | Adopted / Revised |
| D15 | Backup / forward migration | Pre-migration SHA-256 hash recorded in `schema_migrations`; rollback is restoring the pre-migration backup only; forward migration is idempotent | Generated rollback SQL | Adopted / Revised |
| D16 | Interrupted migration recovery | `schema_migrations` row written inside the same transaction as the DDL; on restart, verify checksum vs applied migration; partial state triggers `REPAIR_REQUIRED` and refuses to boot | Best-effort resume | Adopted / Revised |
| D17 | MCP error vocabulary | Stable uppercase codes: `STALE_REVISION`, `IDEMPOTENCY_KEY_CONFLICT`, `IDEMPOTENCY_PAYLOAD_MISMATCH`, `FUTURE_EVIDENCE`, `RELATION_PERSISTENCE_NOT_ADOPTED`, `INVALID_EVENT_VERSION`, `SCHEMA_MIGRATION_REQUIRED`, `READ_ONLY_LANE`, `OUT_OF_SCOPE` | HTTP-style codes | Adopted / Revised |
| D18 | MCP query limits | Default `limit = 50`, hard cap `limit = 500`; `as_of` accepts ISO-8601 UTC; `include_receipts` defaults `false` | No limit | Adopted / Revised |
| D19 | No-write guarantee for read tools | `epistemic_get`, `epistemic_query`, `epistemic_integrity_check`, `epistemic_contradictions`, `epistemic_review_queue` MUST NOT touch access counters, events, receipts, or projections | Allow access bumps | Adopted / Revised |
| D20 | Integration boundary with `memories` | `epistemic_records.source_memory_id` may FK to `memories(id)` ON DELETE SET NULL; never auto-create or auto-update a memory from an epistemic admission | Two-way coupling | Adopted / Revised |
| **D21** | **Semantic-relation decision** | **Option A: refuse non-empty relations with `RELATION_PERSISTENCE_NOT_ADOPTED` in Slice 1** | **Option B: narrow adopted relation slice (see below)** | **Adopted A / Adopted B / Revised** |

## Mandatory semantic-relation decision (D21)

The pure `EpistemicRecord` type from `src/epistemic/types.ts` contains a `relations` field. First-class runtime relation persistence is **not already authorized**.

**Option A (recommended): initial safe slice**

- `admitEpistemicRecord` and `reviseEpistemicRecord` accept only records whose `relations` array is empty.
- Non-empty array → stable error `RELATION_PERSISTENCE_NOT_ADOPTED` (`HTTP 422` analog).
- First-class relation storage and mutation remain behind Gate B (separate experiment contract).

**Option B (only if operator explicitly adopts): narrow relation slice**

If adopted, Option B must additionally specify:

- Named relation ownership (which relations are admitted in Slice 1)
- Allowed endpoint types (record-to-record, record-to-memory, record-to-event)
- Same-scope rules and cross-scope rejection
- Causation/provenance requirements per relation kind
- Correction behavior (always via revision; never in place)
- Rebuild and integrity checks
- One demonstrated high-value query that justifies the cost
- Dedicated `epistemic_relations` table; **never** store relations in synapses

**M3 must not infer Option B from [[282]], the pure TypeScript schema, or [[283]].** Option B requires the operator to mark "Adopted B" on D21 and to specify each sub-bullet above.

## Schema sketch (subject to adopted decisions)

```sql
-- Versioned migrations ledger
CREATE TABLE schema_migrations (
  version        INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  checksum       TEXT NOT NULL,         -- SHA-256 of the migration body
  applied_at     TEXT NOT NULL,
  applied_by     TEXT NOT NULL,
  pre_hash       TEXT,                   -- SHA-256 of DB before this migration
  rollback_sql   TEXT                    -- nullable; rollback = restore backup only
);

-- Immutable revision log
CREATE TABLE epistemic_revisions (
  revision_id            TEXT PRIMARY KEY,            -- UUIDv4
  record_id              INTEGER NOT NULL,
  revision_number        INTEGER NOT NULL,
  previous_revision_id   TEXT REFERENCES epistemic_revisions(revision_id),
  record_payload         TEXT NOT NULL,               -- canonical normalized JSON
  valid_from             TEXT NOT NULL,               -- ISO-8601 UTC
  valid_until            TEXT,                        -- nullable; supersession marker
  supersedes_record_id   INTEGER,
  superseded_by_record_id INTEGER,
  source_event_id        TEXT NOT NULL REFERENCES cognitive_events(event_id),
  created_at             TEXT NOT NULL,
  UNIQUE(record_id, revision_number)
);
CREATE INDEX idx_revisions_record ON epistemic_revisions(record_id, revision_number DESC);
CREATE INDEX idx_revisions_valid_from ON epistemic_revisions(valid_from);

-- Append-only receipts
CREATE TABLE epistemic_receipts (
  receipt_id     TEXT PRIMARY KEY,            -- UUIDv4
  record_id      INTEGER NOT NULL,
  revision_id    TEXT NOT NULL REFERENCES epistemic_revisions(revision_id),
  source_event_id TEXT NOT NULL REFERENCES cognitive_events(event_id),
  receipt_type   TEXT NOT NULL CHECK (receipt_type IN
                    ('ChallengeReceipt','BeliefUseReceipt','DecisionOutcomeReceipt',
                     'ContradictionSignal','ReviewDeadlineReceipt')),
  receipt_payload TEXT NOT NULL,              -- canonical normalized JSON
  independence_key TEXT,
  observed_at    TEXT NOT NULL,
  recorded_at    TEXT NOT NULL
);
CREATE INDEX idx_receipts_record ON epistemic_receipts(record_id, receipt_type);
CREATE INDEX idx_receipts_revision ON epistemic_receipts(revision_id);

-- Immutable provenance
CREATE TABLE epistemic_provenance (
  provenance_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id            INTEGER NOT NULL,
  revision_id          TEXT NOT NULL REFERENCES epistemic_revisions(revision_id),
  source_memory_id     INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  source_event_id      TEXT NOT NULL REFERENCES cognitive_events(event_id),
  excerpt_hash         TEXT,                  -- SHA-256 of quoted source excerpt
  observed_at          TEXT NOT NULL,
  recorded_by          TEXT NOT NULL,
  observed_by_role     TEXT,
  authority_input      TEXT                   -- JSON; admission never grants authority
);
CREATE INDEX idx_provenance_record ON epistemic_provenance(record_id);

-- Current projection (rebuildable, deletable, reproducible)
CREATE TABLE epistemic_records (
  record_id              INTEGER PRIMARY KEY,
  project_id             TEXT NOT NULL,
  scope                  TEXT NOT NULL,        -- default 'exact-project'
  statement              TEXT NOT NULL,
  epistemic_status       TEXT NOT NULL CHECK (epistemic_status IN
                          ('verified','corroborated','inferred','reported',
                           'assumed','contested','stale','retracted')),
  verification_level     TEXT NOT NULL,
  source_quality         TEXT NOT NULL,
  confidence             REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  valid_from             TEXT NOT NULL,
  valid_until            TEXT,
  current_revision_id    TEXT NOT NULL REFERENCES epistemic_revisions(revision_id),
  source_event_id        TEXT NOT NULL REFERENCES cognitive_events(event_id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  superseded_by_record_id INTEGER REFERENCES epistemic_records(record_id),
  CHECK (scope IN ('exact-project','_global'))
);

-- Contradiction projection (rebuildable)
CREATE TABLE epistemic_contradictions (
  contradiction_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         TEXT NOT NULL,
  topic              TEXT NOT NULL,
  record_a_id        INTEGER NOT NULL REFERENCES epistemic_records(record_id),
  record_b_id        INTEGER NOT NULL REFERENCES epistemic_records(record_id),
  source_event_id    TEXT NOT NULL REFERENCES cognitive_events(event_id),
  status             TEXT NOT NULL CHECK (status IN ('open','scoped_apart','resolved','retracted')),
  resolution_policy  TEXT,
  impact             TEXT,
  resolved_by        TEXT,
  created_at         TEXT NOT NULL,
  resolved_at        TEXT,
  UNIQUE(record_a_id, record_b_id, topic)
);

-- Review projection (rebuildable; derived from maintenance)
CREATE TABLE epistemic_review_queue (
  review_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id          INTEGER NOT NULL REFERENCES epistemic_records(record_id),
  project_id         TEXT NOT NULL,
  reason             TEXT NOT NULL CHECK (reason IN
                       ('overdue','review_due','worldview_audit','contradicted')),
  next_review_at     TEXT NOT NULL,
  review_priority_score REAL NOT NULL,
  influence_score    REAL NOT NULL,
  ordinary_priming_factor REAL NOT NULL,
  last_evaluated_at  TEXT NOT NULL
);
```

## Reusable templates

Copy, do not reinvent:

- `src/cognitive/events.ts:127` — `eventHash` (deterministic SHA-256)
- `src/cognitive/events.ts:168` — `appendCognitiveEvent` transactional pattern
- `src/cognitive/policy.ts:128` — event-first atomic projection pattern
- `src/cognitive/schema.ts:6` — `event_type` CHECK constraint (must evolve via migration only)
- `src/db.ts:163` — `CREATE TABLE IF NOT EXISTS` startup pattern (to be replaced by migration runner)

## Non-goals reaffirmed

- No replacement of `memories`, `FTS`, `tags`, `synapses`, `decay`, or current retrieval.
- No `loop-eng` or `turn-shape` changes (Phase 9 will integrate through `[[285]]` after Steps 0–8 succeed).
- No multi-host schema synchronization.
- No performance optimization of FTS5/BM25 substrate.
- No long-running calibration analysis.

## Verification (Step 0 acceptance)

| # | Verification | Oracle |
|---|---|---|
| V1 | Every D1–D21 row marked **Adopted** or **Revised** with concrete values | Direct inspection of this document post-adoption |
| V2 | Operator DecisionMade event appended with `correlation_id=epistemic-kernel-activation-phase-b` and `trigger_type=contract_adoption` | `memory_changes` since adoption timestamp |
| V3 | DecisionMade event passes hash-chain verification | `cognitive_event_trace` end-to-end |
| V4 | D21 explicitly chooses A or B; if B, every sub-bullet specified | Direct inspection |
| V5 | Existing memories/event chain unchanged (sanity) | Pre/post row counts |

## Open risks

- `cognitive_events.event_type` CHECK constraint evolution requires a migration that temporarily allows both old and new event types. R20 risk: if migration is interrupted, partial CHECK state is possible. Mitigation: D16 interrupted-recovery + `REPAIR_REQUIRED`.
- Relation Option B, if adopted, adds significant scope. R21 risk: scope creep delays Step 6. Mitigation: Gate B is a separate contract; Option A is the safe default.
- Idempotency hash collisions (SHA-256 over canonical JSON) are astronomically rare but possible. R7 risk: false retry matches. Mitigation: idempotency_hash column also stores the canonical payload; verify on retry.

## Update provenance

- 2026-08-09: Created from [[283]] Step 0 specification by M3. Source session: `72e0e805-61b5-4f8b-9ecb-5d19eba379f4`. Awaiting operator adoption.
