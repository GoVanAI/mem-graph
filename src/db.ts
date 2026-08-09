import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { runMigrations } from './migrations/registry.js';
import { MIGRATIONS } from './migrations/index.js';
import { SCHEMA_SQL, DECAY_MATRIX_SEED } from './migrations/baseline.js';

export { SCHEMA_SQL, DECAY_MATRIX_SEED };

const DEFAULT_MEMORY_DIR = join(homedir(), '.local', 'share', 'mem-graph');

export function getMemoryDir(): string {
  return process.env.MEM_GRAPH_DIR ?? DEFAULT_MEMORY_DIR;
}

// Schema note — `category` is intentionally free-text (no CHECK constraint).
//   Standard taxonomy (from the memory_add zod schema): decision, handoff,
//     finding, issue, preference, note, context, todo.
//   First-class additions surfaced as discoverable conventions:
//     commitment, open_question, trigger.
//   Any other value is permitted; the operator is the source of truth and
//   may surface new categories without a schema migration. A future
//   agent-as-author iteration may revisit this when LLM-extracted categories
//   need bounded vocabulary to prevent drift.
//
// SCHEMA_SQL and DECAY_MATRIX_SEED live in ./migrations/baseline.ts so that
// ./migrations/index.ts can import them without creating a circular
// dependency with this module. They are re-exported here for backward
// compatibility with tests and external callers.

const KNOWN_DATABASES: Record<string, 'memory'> = {
  memory: 'memory',
};

const databases = new Map<string, Database.Database>();

function ensureMemorySchema(db: Database.Database): void {
  // EPB-001 D4/D15/D16: every schema change is recorded in
  // schema_migrations. v1 captures the existing baseline so fresh
  // databases and pre-migration databases converge to the same state.
  const result = runMigrations(db, MIGRATIONS, { applied_by: 'mem-graph-init' });
  if (!result.ok) {
    if (result.code === 'REPAIR_REQUIRED') {
      throw new Error(`REPAIR_REQUIRED: ${result.message}`);
    }
    throw new Error(`Migration failed: ${result.message}`);
  }
}

export function initDatabase(name: string): Database.Database {
  if (databases.has(name)) return databases.get(name)!;

  const dir = getMemoryDir();
  const filePath = join(dir, `${name}.db`);
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (KNOWN_DATABASES[name] === 'memory') {
    ensureMemorySchema(db);
  }

  databases.set(name, db);
  return db;
}

export function getDatabase(name: string): Database.Database {
  const db = databases.get(name);
  if (!db) {
    throw new Error(`Database not initialized: ${name}. Call initDatabase() first.`);
  }
  return db;
}

export function listDatabases(): string[] {
  return Array.from(databases.keys());
}

export function isMemoryEmpty(db: Database.Database): boolean {
  const row = db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number };
  return row.c === 0;
}

export function closeAllDatabases(): void {
  for (const db of databases.values()) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  databases.clear();
}
