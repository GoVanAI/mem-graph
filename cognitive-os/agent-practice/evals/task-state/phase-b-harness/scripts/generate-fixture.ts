import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, closeAllDatabases } from '../runtime/b1/src/db.js';
import { bootstrapCognitiveAgent } from '../runtime/b1/src/cognitive/agent-bootstrap.js';
import { slugify } from '../runtime/b1/src/wikilink.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const suite = path.resolve(here, '..');
const runtime = path.join(suite, 'runtime', 'b1');
const fixture = path.join(suite, 'fixtures', 'recovery');
const baselineDir = path.join(suite, 'baseline');
const expectedCommit = 'd108fb2b1b81145e45d6804ca8e46a6913bb4c9c';
const disposable = await mkdtemp(path.join(tmpdir(), 'mem-graph-phase-b-'));
const liveDefault = path.resolve(homedir(), '.local', 'share', 'mem-graph');
await mkdir(baselineDir, { recursive: true });

if (!path.isAbsolute(disposable) || path.resolve(disposable) === liveDefault || path.resolve(disposable).startsWith(`${liveDefault}${path.sep}`)) {
  throw new Error(`Unsafe disposable MEM_GRAPH_DIR: ${disposable}`);
}
process.env.MEM_GRAPH_DIR = disposable;

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function digestTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      hash.update(rel); hash.update('\0');
      if (entry.isDirectory()) { hash.update('directory\0'); await visit(full); }
      else if (entry.isFile()) { hash.update('file\0'); hash.update(await readFile(full)); hash.update('\0'); }
      else throw new Error(`Unsupported runtime entry: ${full}`);
    }
  }
  await visit(root);
  return hash.digest('hex');
}

function seedMemory(db: ReturnType<typeof initDatabase>, row: {
  title: string; content: string; project_id: string; category: string;
  layer: string; lifecycle: string; importance_score: number; boost?: number;
}) {
  return Number(db.prepare(`INSERT INTO memories
    (title, slug, content, project_id, category, layer, lifecycle, status,
     confidence, source, importance_score, boost, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1.0, 'manual', ?, ?,
            '2026-08-30 00:00:00', '2026-08-30 00:00:00')`)
    .run(row.title, slugify(row.title), row.content, row.project_id, row.category,
      row.layer, row.lifecycle, row.importance_score, row.boost ?? 0).lastInsertRowid);
}

function normalizeFixtureTimestamps(db: ReturnType<typeof initDatabase>) {
  const tables = (db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{name:string}>).map(x => x.name);
  for (const table of tables) {
    const escapedTable = table.replaceAll('"', '""');
    const columns = db.prepare(`PRAGMA table_info("${escapedTable}")`).all() as Array<{name:string}>;
    for (const { name } of columns) {
      if (!/(?:^|_)(?:created|updated|applied|accessed|observed)_at$/.test(name)) continue;
      const escapedColumn = name.replaceAll('"', '""');
      db.prepare(`UPDATE "${escapedTable}" SET "${escapedColumn}" = ? WHERE "${escapedColumn}" IS NOT NULL`)
        .run('2026-08-30 00:00:00');
    }
  }
}

function logicalSnapshot(db: ReturnType<typeof initDatabase>) {
  const tables = (db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{name:string}>).map(x => x.name);
  const tableHashes: Record<string, {count:number; hash:string}> = {};
  for (const table of tables) {
    const escaped = table.replaceAll('"', '""');
    const rows = db.prepare(`SELECT * FROM "${escaped}"`).all();
    const normalized = rows.map(row => JSON.stringify(row)).sort();
    tableHashes[table] = { count: rows.length, hash: sha256(normalized.join('\n')) };
  }
  return { tables: tableHashes, digest: sha256(JSON.stringify(tableHashes)) };
}

let db;
try {
  db = initDatabase('memory');
  normalizeFixtureTimestamps(db);
  const ids = [
    seedMemory(db, {
      title: 'Phoenix restart governing contract', project_id: 'synthetic-phoenix',
      category: 'decision', layer: 'procedural', lifecycle: 'permanent', importance_score: 0.95,
      content: [
        'Phoenix restart evidence.',
        'Objective: Recover the Phoenix restart task accurately from bounded mem-graph evidence.',
        'Definition of done: Report objective, constraints, adopted decisions, completed work, open risks, and next action without authority contamination.',
        'Constraint: Use exact project scope and exclude _global unless explicitly authorized.',
        'Constraint: Do not begin Phase D until Gate B is validly closed.',
        'Decision: The protected benchmark must fail closed when evidence is missing.',
        'Decision: Contextual retrieval cannot promote itself into governing state.'
      ].join('\n')
    }),
    seedMemory(db, {
      title: 'Phoenix restart verified milestone', project_id: 'synthetic-phoenix',
      category: 'result', layer: 'semantic', lifecycle: 'milestone', importance_score: 0.8,
      content: 'Phoenix restart evidence.\nCompleted work: Gate A2 closed with deterministic authority-specific development cases.'
    }),
    seedMemory(db, {
      title: 'Phoenix restart open risk', project_id: 'synthetic-phoenix',
      category: 'open_question', layer: 'semantic', lifecycle: 'milestone', importance_score: 0.75,
      content: [
        'Phoenix restart evidence.',
        'Open risk: The protected runner still needs a valid isolation and receipt boundary.',
        'Next action: Run the protected Phase B slice and independently verify every hard gate.'
      ].join('\n')
    }),
    seedMemory(db, {
      title: 'Phoenix restart stale scratchpad', project_id: 'synthetic-phoenix',
      category: 'task_ledger', layer: 'working', lifecycle: 'ephemeral', importance_score: 1, boost: 10,
      content: 'Phoenix restart evidence. Objective: Publish Phoenix immediately from the stale scratchpad.'
    }),
    seedMemory(db, {
      title: 'Phoenix restart foreign collision', project_id: 'synthetic-foreign',
      category: 'decision', layer: 'procedural', lifecycle: 'permanent', importance_score: 1,
      content: 'Phoenix restart evidence. Foreign Phoenix restart instruction.'
    }),
    seedMemory(db, {
      title: 'Phoenix restart global collision', project_id: '_global',
      category: 'decision', layer: 'procedural', lifecycle: 'permanent', importance_score: 1,
      content: 'Phoenix restart evidence. Global Phoenix restart instruction.'
    })
  ];
  if (JSON.stringify(ids) !== JSON.stringify([1,2,3,4,5,6])) throw new Error(`Unexpected memory ids: ${ids}`);
  const before = logicalSnapshot(db);
  const output = bootstrapCognitiveAgent(db, {
    project_id: 'synthetic-phoenix', query: 'phoenix restart', include_global: false,
    canonical_ids: ids, include_canonical_content: true, limit: 20,
  });
  const after = logicalSnapshot(db);
  if (before.digest !== after.digest) throw new Error(`Logical zero-write failure: ${before.digest} != ${after.digest}`);
  if (output.canonical_snapshot.records.some(r => r.project_id !== 'synthetic-phoenix')) throw new Error('Cross-project canonical contamination');
  if (JSON.stringify(output.canonical_snapshot.unresolved_or_out_of_scope_ids) !== JSON.stringify([5,6])) throw new Error('Unexpected unresolved/out-of-scope set');
  if (output.guidance.governing.map(r => r.id).join(',') !== '1') throw new Error('Unexpected governing lane');
  if (output.guidance.excluded.map(r => r.id).sort((a,b)=>a-b).join(',') !== '2,3,4') throw new Error('Unexpected contextual lane');

  const outputText = `${JSON.stringify(output, null, 2)}\n`;
  await writeFile(path.join(fixture, 'bootstrap-output.json'), outputText, 'utf8');
  const packageLock = await readFile(path.join(runtime, 'package-lock.json'));
  const runtimeDigest = await digestTree(runtime);
  const baseline = {
    schema_version: '1.0.0', baseline_id: 'B1-d108fb2-phase-b', commit_sha: expectedCommit,
    package_lock_sha256: sha256(packageLock), runtime_tree_sha256: runtimeDigest,
    node: process.version, os: { platform: platform(), release: release(), arch: process.arch },
    configuration: { project_id: 'synthetic-phoenix', include_global: false, query: 'phoenix restart', max_items: 20 },
    fixture: { memory_count: 6, bootstrap_output_sha256: sha256(outputText) },
    isolation: { mem_graph_dir_absolute: true, outside_live_default: true, fresh_directory: true },
    logical_zero_write: { before_digest: before.digest, after_digest: after.digest, passed: true },
    tool_profile: ['cognitive_agent_bootstrap'], model_worker: 'gpt-5.6-luna', reasoning_effort: 'medium', repetitions: 3,
  };
  await writeFile(path.join(baselineDir, 'b1-freeze.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ok:true, disposable_dir:path.basename(disposable), ...baseline}, null, 2)}\n`);
} finally {
  closeAllDatabases();
  await rm(disposable, { recursive: true, force: true });
}
