#!/usr/bin/env node
// diagnose-pd-05.mjs
//
// One-shot diagnostic for pd-05-wrong-project. Captures the raw bootstrap
// response text, parses it, and prints structured trace information.
//
// Read-only on production code under src/. Uses a fresh disposable
// MEM_GRAPH_DIR.

import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');

const clockAnchor = '2026-09-07T12:00:00.000Z';
const disposableDir = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'mem-graph-diag-pd05-'));
process.env.MEM_GRAPH_DIR = disposableDir;

const toolFiles = [
  'src/tools/cognitive.js',
  'src/tools/memory-search.js',
  'src/tools/memory-write.js',
  'src/tools/memory-tags.js',
  'src/tools/memory-graph.js',
  'src/tools/epistemic.js',
  'src/tools/sql.js',
  'src/tools/memory-orient.js',
  'src/tools/memory-import.js',
];

const captured = {};
const stub = {
  tool(name, _d, _s, handler) { captured[name] = handler; },
};

for (const rel of toolFiles) {
  const mod = await import(pathToFileURL(resolve(REPO_ROOT, rel)).href);
  const register = Object.values(mod).find(
    (v) => typeof v === 'function' && /^register[A-Z][a-zA-Z]+Tools$/.test(v.name),
  );
  if (!register) continue;
  if (rel.endsWith('cognitive.js')) register(stub, {});
  else register(stub);
}

function anchorOffset(offsetMs) {
  return new Date(new Date(clockAnchor).getTime() + offsetMs).toISOString();
}

// Seed pd-05 records exactly as cases.json specifies.
const seed = [
  { id: 107, project_id: 'fixture-alpha', role: 'governing', summary: 'Allowed source.' },
  { id: 108, project_id: 'fixture-beta', role: 'governing', summary: 'Foreign source.' },
  { id: 109, project_id: '_global', role: 'governing', summary: 'Global source not requested.' },
];

const dbMod = await import(pathToFileURL(resolve(REPO_ROOT, 'src/db.js')).href);
dbMod.initDatabase('memory');
const db = dbMod.getDatabase('memory');

const insert = db.prepare(`
  INSERT INTO memories
    (id, layer, project_id, category, title, slug, content, summary,
     lifecycle, status, confidence, importance_score, created_at, updated_at)
  VALUES
    (?, 'episodic', ?, ?, ?, ?, ?, ?,
     'milestone', 'active', 1.0, 1.0, ?, ?)
`);
for (let i = 0; i < seed.length; i++) {
  const r = seed[i];
  const offset = -((seed.length - i) * 1000);
  insert.run(r.id, r.project_id, r.role, `Record ${r.id}`, `fixture-${r.id}`, JSON.stringify(r), r.summary, anchorOffset(offset), anchorOffset(offset));
}

// Confirm seeds.
const seeded = db.prepare(`SELECT id, project_id, category, summary FROM memories ORDER BY id`).all();

const handler = captured['cognitive_agent_bootstrap'];
const input = {
  query: 'current implementation',
  project_id: 'fixture-alpha',
  include_global: false,
};

const result = await handler(input);
const text = result.content[0].text;
let parsed;
try { parsed = JSON.parse(text); } catch (e) { parsed = { _parse_error: e.message, raw_text: text }; }

// Dump trace.
const trace = {
  seeded_records: seeded,
  input,
  request_bytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
  response_bytes: Buffer.byteLength(text, 'utf8'),
  is_error: result.isError === true,
  response_top_level_keys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
  response_parsed: parsed,
};

console.log(JSON.stringify(trace, null, 2));

rmSync(disposableDir, { recursive: true, force: true });
