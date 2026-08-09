/**
 * Ordered migration registry for mem-graph.
 *
 * Convention:
 *  - Version 1 captures the existing baseline (memories, synapses, tags,
 *    FTS5, triggers, decay_matrix, cognitive_events, policy_candidates,
 *    policy_evaluations). New databases have v1 applied at first boot;
 *    pre-existing databases adopt v1 with a `pre_hash` snapshot so future
 *    drift is detectable.
 *  - Each subsequent version is additive. Never rewrite an applied
 *    migration; create a new version instead.
 */

import { SCHEMA_SQL, DECAY_MATRIX_SEED } from '../db.js';
import { COGNITIVE_SCHEMA_SQL } from '../cognitive/schema.js';
import type { Migration } from './registry.js';

/**
 * v1 — baseline. Captures everything that existed before the migration
 * runner. The post_check confirms memories and cognitive_events tables
 * exist with at least one row of expected shape.
 */
const v1: Migration = {
  version: 1,
  name: 'baseline-mem-graph-cognitive',
  sql: [
    SCHEMA_SQL,
    DECAY_MATRIX_SEED,
    COGNITIVE_SCHEMA_SQL,
  ].join('\n;\n'),
  post_check: `SELECT
    CASE
      WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories')
       AND EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='cognitive_events')
      THEN 1 ELSE 0
    END AS ok`,
};

export const MIGRATIONS: ReadonlyArray<Migration> = [v1];
