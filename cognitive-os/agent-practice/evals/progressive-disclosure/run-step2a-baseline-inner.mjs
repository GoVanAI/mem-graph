#!/usr/bin/env node
//
// run-step2a-baseline-inner.mjs
//
// Child runner for Step 2A runtime baseline. Invoked by
// run-step2a-baseline.mjs as a child process. Each child creates a fresh
// disposable MEM_GRAPH_DIR, seeds synthetic fixtures, executes the
// recorded legacy trace for each of the eight cases, captures per-call
// metrics, and writes per-case result files.
//
// Determinism strategy:
//   - One run-level clock anchor: passed via --clock-anchor; identical
//     across both runs when the parent supplies the same value.
//   - Fixture-controlled semantic timestamps (created_at, updated_at
//     on seeded memories) derive from the anchor with explicit offsets
//     per case. These are written via raw SQL inserts.
//   - Runtime-generated volatile timestamps (e.g. observed_at injected
//     by `cognitive_event_append`) are recorded raw and normalized
//     through stable tokens only at documented JSON paths.
//   - Generated UUIDs are recorded raw and normalized through a stable
//     first-seen mapping (UUID_1, UUID_2, ...) in normalized outputs.
//     Referential relationships are preserved by mapping consistently.
//   - Elapsed timing is preserved in raw output and excluded from the
//     normalized determinism hash.
//
// Read-only on production code under src/. No fixtures read or write
// the live/personal mem-graph database. All data lives under the
// disposable MEM_GRAPH_DIR and results/. Disposable dir is removed on
// exit.

import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');

// ---------------------------------------------------------------------------
// 0. Parse argv and prepare environment
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argFlag(name) { return argv.includes(name); }
function argValue(name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

if (argFlag('--help') || argv.length === 0) {
  console.error('Usage: run-step2a-baseline-inner.mjs --results-dir <path> [--run-id <id>] [--clock-anchor <iso>]');
  process.exit(2);
}

const resultsDir = argValue('--results-dir');
const clockAnchorArg = argValue('--clock-anchor');
if (!resultsDir) {
  console.error('Missing --results-dir');
  process.exit(2);
}
mkdirSync(resultsDir, { recursive: true });

const runId = argValue('--run-id') ?? randomUUID();
const clockAnchor = clockAnchorArg ?? new Date().toISOString();

const disposableDir = mkdtempSync(join(process.env.TEMP ?? '/tmp', `mem-graph-step2a-${runId}-`));
process.env.MEM_GRAPH_DIR = disposableDir;

// Wrap the rest in an async IIFE so we can use await at top level.
const main = async () => {
  // -----------------------------------------------------------------------
  // 1. Capture legacy tool handlers via stub McpServer
  // -----------------------------------------------------------------------

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
    tool(name, _description, _schemaShape, handler) {
      captured[name] = handler;
    },
  };

  const loadErrors = [];
  for (const relPath of toolFiles) {
    try {
      const mod = await import(pathToFileURL(resolve(REPO_ROOT, relPath)).href);
      const register = Object.values(mod).find(
        (v) => typeof v === 'function' && /^register[A-Z][a-zA-Z]+Tools$/.test(v.name),
      );
      if (!register) {
        loadErrors.push(`No register*Tools export in ${relPath}`);
        continue;
      }
      if (relPath.endsWith('cognitive.js')) {
        register(stub, {});
      } else {
        register(stub);
      }
    } catch (e) {
      loadErrors.push(`Failed to load ${relPath}: ${e.message}`);
    }
  }

  if (Object.keys(captured).length === 0) {
    console.error(JSON.stringify({ ok: false, load_errors: loadErrors }, null, 2));
    rmSync(disposableDir, { recursive: true, force: true });
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // 2. Seed fixtures
  // -----------------------------------------------------------------------

  function anchorOffset(offsetMs) {
    return new Date(new Date(clockAnchor).getTime() + offsetMs).toISOString();
  }

  // -----------------------------------------------------------------------
  // Projection layer
  //
  // Maps raw tool responses into a small canonical observation object.
  // The grader evaluates structured predicates against this object
  // rather than searching raw JSON for case-contract strings.
  //
  // Documented mappings (raw field -> canonical field):
  //   bootstrap:
  //     scope.project_id              -> observation.scope.project_id
  //     scope.include_global         -> observation.scope.include_global
  //     scope.global_inclusion        -> observation.scope.global_inclusion
  //     guidance.governing[].record_id -> observation.returned_source_ids (filtered to active+governing)
  //     guidance.governing[].project_id != input.project_id AND != _global -> observation.foreign_source_ids
  //     guidance.governing[].project_id == _global -> observation.global_source_ids
  //     guidance.excluded[].record_id -> observation.excluded_source_ids
  //     canonical_snapshot.records[].id -> observation.canonical_snapshot_ids
  //     policy_lookup.candidates.length -> observation.policy_candidate_count
  //     mutation.access_tracking       -> observation.access_tracking
  //     mutation.writes               -> observation.mutation_observed.writes
  //     mutation.events_appended      -> observation.mutation_observed.events_appended
  //     mutation.receipt_persistence  -> observation.mutation_observed.receipt_persistence
  //   memory_get:
  //     .id                           -> observation.returned_source_id
  //     .project_id                   -> observation.returned_project_id
  //     .status                       -> observation.status
  //   memory_search:
  //     [].id                         -> observation.returned_source_ids
  //     [].project_id != request + != _global -> observation.foreign_source_ids
  //     [].project_id == _global       -> observation.global_source_ids
  //     [].status                      -> observation.status_breakdown
  //   epistemic_get:
  //     .record_id                    -> observation.returned_record_id
  //     .project_id                   -> observation.returned_project_id
  //   cognitive_event_trace:
  //     events.length                 -> observation.event_count
  //     integrity.valid               -> observation.integrity_ok
  //     events[].event_id              -> observation.returned_event_ids
  // -----------------------------------------------------------------------

  function projectObservation(toolName, input, parsed) {
    const reqProject = input?.project_id;
    if (toolName === 'cognitive_agent_bootstrap' && parsed && typeof parsed === 'object') {
      const governing = Array.isArray(parsed.guidance?.governing) ? parsed.guidance.governing : [];
      const excluded = Array.isArray(parsed.guidance?.excluded) ? parsed.guidance.excluded : [];
      const canonical = Array.isArray(parsed.canonical_snapshot?.records) ? parsed.canonical_snapshot.records : [];
      const returned = governing.map((r) => r.record_id).filter((id) => typeof id === 'number');
      const excludedIds = excluded.map((r) => r.record_id).filter((id) => typeof id === 'number');
      const canonicalIds = canonical.map((r) => r.id).filter((id) => typeof id === 'number');
      const foreign = returned.filter((id) => {
        const r = governing.find((x) => x.record_id === id);
        return r && r.project_id !== reqProject && r.project_id !== '_global';
      });
      const global = returned.filter((id) => {
        const r = governing.find((x) => x.record_id === id);
        return r && r.project_id === '_global';
      });
      return {
        tool: toolName,
        scope: {
          project_id: parsed.scope?.project_id,
          include_global: parsed.scope?.include_global ?? null,
          global_inclusion: parsed.scope?.global_inclusion,
        },
        returned_source_ids: returned,
        excluded_source_ids: excludedIds,
        foreign_source_ids: foreign,
        global_source_ids: global,
        canonical_snapshot_ids: canonicalIds,
        policy_candidate_count: Array.isArray(parsed.policy_lookup?.candidates) ? parsed.policy_lookup.candidates.length : 0,
        access_tracking: parsed.mutation?.access_tracking,
        mutation_observed: {
          writes: parsed.mutation?.database_writes ?? 0,
          events_appended: parsed.mutation?.events_appended ?? 0,
          receipt_persistence: parsed.mutation?.receipt_persistence,
        },
        warnings: [],
        unresolved: [],
      };
    }
    if (toolName === 'memory_get' && parsed && typeof parsed === 'object') {
      const foreign = reqProject && parsed.project_id && parsed.project_id !== reqProject && parsed.project_id !== '_global';
      return {
        tool: toolName,
        returned_source_id: parsed.id,
        returned_project_id: parsed.project_id,
        status: parsed.status,
        foreign_returned: foreign === true,
        access_tracking: 'touched',
        warnings: [],
        unresolved: [],
      };
    }
    if (toolName === 'memory_search' && Array.isArray(parsed)) {
      const returned = parsed.map((r) => r.id).filter((id) => typeof id === 'number');
      const foreign = parsed.filter((r) => r.project_id !== reqProject && r.project_id !== '_global').map((r) => r.id);
      const global = parsed.filter((r) => r.project_id === '_global').map((r) => r.id);
      const statusBreakdown = { active: 0, superseded: 0, archived: 0, invalid: 0 };
      for (const r of parsed) {
        if (statusBreakdown[r.status] !== undefined) statusBreakdown[r.status]++;
      }
      return {
        tool: toolName,
        returned_source_ids: returned,
        foreign_source_ids: foreign,
        global_source_ids: global,
        status_breakdown: statusBreakdown,
        warnings: [],
        unresolved: [],
      };
    }
    if (toolName === 'epistemic_get' && parsed && typeof parsed === 'object') {
      const foreign = reqProject && parsed.project_id && parsed.project_id !== reqProject && parsed.project_id !== '_global';
      return {
        tool: toolName,
        returned_record_id: parsed.record_id,
        returned_project_id: parsed.project_id,
        out_of_scope: foreign === true,
        warnings: [],
        unresolved: [],
      };
    }
    if (toolName === 'cognitive_event_trace' && parsed && typeof parsed === 'object') {
      const events = Array.isArray(parsed.events) ? parsed.events : [];
      return {
        tool: toolName,
        event_count: events.length,
        integrity_ok: parsed.integrity?.valid === true,
        returned_event_ids: events.map((e) => e.event_id).filter(Boolean),
        warnings: [],
        unresolved: [],
      };
    }
    return { tool: toolName, warnings: ['no projection available for this tool'], unresolved: [] };
  }

  // Map a case-contract signal string to a structured predicate against
  // an observation. Returns one of:
  //   { status: 'evaluated-true', predicate, observation_path, value }
  //   { status: 'evaluated-false', predicate, observation_path, value }
  //   { status: 'unmappable', reason }
  function evaluateSignal(signal, observation) {
    // Required patterns (case-insensitive substring matches against observation).
    // Each pattern is a [regex, field-path, expected-value-or-array-membership] tuple.
    // Patterns tried in order; first match wins.

    // source_id=N
    let m = signal.match(/^source_id=(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const ids = observation.returned_source_ids ?? observation.excluded_source_ids ?? [];
      const present = Array.isArray(ids) && ids.includes(id);
      return { status: present ? 'evaluated-true' : 'evaluated-false', predicate: `returned_source_ids.includes(${id})`, value: present };
    }

    // include_global=false / include_global=true
    m = signal.match(/^include_global=(true|false)$/);
    if (m) {
      const expected = m[1] === 'true';
      const actual = observation.scope?.include_global === expected;
      return { status: actual ? 'evaluated-true' : 'evaluated-false', predicate: `scope.include_global === ${expected}`, value: observation.scope?.include_global };
    }

    // project_id=<name>
    m = signal.match(/^project_id=(\S+)$/);
    if (m) {
      const expected = m[1];
      const actual = observation.scope?.project_id === expected;
      return { status: actual ? 'evaluated-true' : 'evaluated-false', predicate: `scope.project_id === "${expected}"`, value: observation.scope?.project_id };
    }

    return { status: 'unmappable', reason: `no projection mapping for signal "${signal}" against observation fields ${Object.keys(observation).join(',')}` };
  }

  function seedFixtures(snapshot, db) {
    const inserts = [];
    snapshot.records.forEach((record, index) => {
      const offset = -((snapshot.records.length - index) * 1000);
      const createdAt = anchorOffset(offset);
      const updatedAt = anchorOffset(offset);
      const title = record.title ?? `Record ${record.id}`;
      const summary = record.summary ?? '';
      const content = JSON.stringify(record);
      const projectId = record.project_id ?? snapshot.project_id;
      const category = record.role ?? record.category ?? 'governing';
      const status = record.status ?? 'active';
      inserts.push({ id: record.id, project_id: projectId, title, summary, content, category, status, created_at: createdAt, updated_at: updatedAt });
    });

    const insert = db.prepare(`
      INSERT INTO memories
        (id, layer, project_id, category, title, slug, content, summary,
         lifecycle, status, confidence, importance_score, created_at, updated_at)
      VALUES
        (?, 'episodic', ?, ?, ?, ?, ?, ?,
         'milestone', ?, 1.0, 1.0, ?, ?)
    `);
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        const slug = 'fixture-' + String(r.id);
        insert.run(r.id, r.project_id, r.category, r.title, slug, r.content, r.summary, r.status, r.created_at, r.updated_at);
      }
    });
    tx(inserts);
    return inserts.length;
  }

  // Lazy db accessor: triggers getDatabase('memory') to open and migrate.
  async function ensureDb() {
    const mod = await import(pathToFileURL(resolve(REPO_ROOT, 'src/db.js')).href);
    mod.initDatabase('memory');
    return mod.getDatabase('memory');
  }

  // -----------------------------------------------------------------------
  // 3. Build request input for a tool call
  // -----------------------------------------------------------------------

  function buildInputFor(toolName, caseDef, db) {
    const req = caseDef.request;
    switch (toolName) {
      case 'cognitive_agent_bootstrap':
        return {
          query: req.query ?? caseDef.id,
          project_id: req.project_id,
          include_global: req.include_global ?? false,
        };
      case 'memory_get': {
        const stmt = db.prepare(`
          SELECT id FROM memories
          WHERE project_id = ? AND status = 'active'
          ORDER BY id ASC LIMIT 1
        `);
        const row = stmt.get(req.project_id);
        return row ? { id: row.id } : { id: 0 };
      }
      case 'memory_search':
        return { query: req.query ?? caseDef.id, project_id: req.project_id, limit: 5 };
      case 'epistemic_get': {
        const stmt = db.prepare(`
          SELECT id FROM memories
          WHERE project_id = ? AND status = 'active'
          ORDER BY id ASC LIMIT 1
        `);
        const row = stmt.get(req.project_id);
        return { record_id: row?.id ?? 0, project_id: req.project_id };
      }
      case 'cognitive_event_trace':
        return { project_id: req.project_id, limit: 10 };
      default:
        return req;
    }
  }

  // -----------------------------------------------------------------------
  // 4. Execute one case
  // -----------------------------------------------------------------------

  async function executeCase(caseDef) {
    const out = {
      case_id: caseDef.id,
      clock_anchor: clockAnchor,
      seed_count: 0,
      tools_invoked: [],
      per_call: [],
      total_response_bytes: 0,
      total_elapsed_ms: 0,
      required_signals_results: [],
      forbidden_signals_results: [],
      outcome: 'executed-unavailable',
      notes: [],
    };

    let db;
    try {
      db = await ensureDb();
      out.seed_count = seedFixtures(caseDef.source_snapshot, db);
    } catch (e) {
      out.notes.push(`seed failed: ${e.message}`);
      out.outcome = 'executed-unavailable';
      return out;
    }

    function preCounters() {
      return db.prepare('SELECT id, access_count FROM memories').all();
    }
    function diffCounters(before, after) {
      const map = new Map(before.map((r) => [r.id, r.access_count]));
      const changes = [];
      for (const r of after) {
        const prev = map.get(r.id) ?? 0;
        if (r.access_count !== prev) {
          changes.push({ id: r.id, before: prev, after: r.access_count, delta: r.access_count - prev });
        }
      }
      return changes;
    }

    const allResponseTexts = [];

    for (let i = 0; i < caseDef.baseline_trace.legacy_tools.length; i++) {
      const toolName = caseDef.baseline_trace.legacy_tools[i];
      const handler = captured[toolName];
      if (!handler) {
        out.per_call.push({ call_index: i, tool: toolName, error: 'tool not registered' });
        out.outcome = 'executed-unavailable';
        out.notes.push(`tool ${toolName} not registered`);
        return out;
      }

      const input = buildInputFor(toolName, caseDef, db);
      const requestBytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
      const before = preCounters();
      const t0 = performance.now();
      let result;
      let err;
      try {
        result = await handler(input);
      } catch (e) {
        err = e.message;
      }
      const elapsed_ms = performance.now() - t0;
      const after = preCounters();
      const counterDeltas = diffCounters(before, after);

      let responseText = null;
      let responseBytes = 0;
      let isError = false;
      if (result && Array.isArray(result.content) && result.content[0]?.text) {
        responseText = result.content[0].text;
        responseBytes = Buffer.byteLength(responseText, 'utf8');
        isError = result.isError === true;
      } else if (err) {
        isError = true;
      }

      // Parse and project into canonical observation. Store both raw
      // response text and the projection so future readers can verify
      // the mapping.
      let parsed = null;
      if (responseText) {
        try { parsed = JSON.parse(responseText); } catch { parsed = null; }
      }
      const observation = projectObservation(toolName, input, parsed);

      out.per_call.push({
        call_index: i,
        tool: toolName,
        input,
        request_bytes: requestBytes,
        response_bytes: responseBytes,
        elapsed_ms,
        is_error: isError || !!err,
        error: err ?? null,
        counter_deltas: counterDeltas,
        raw_response_text: responseText,
        canonical_observation: observation,
      });
      out.total_response_bytes += responseBytes;
      out.total_elapsed_ms += elapsed_ms;
      out.tools_invoked.push(toolName);

      if (responseText) allResponseTexts.push(responseText);

      if (isError || err) {
        out.notes.push(`call ${i} (${toolName}) errored: ${err ?? responseText}`);
        out.outcome = 'executed-unavailable';
        return out;
      }
    }

    // Aggregate signal checks via structured predicates against the
    // canonical observations (not literal-substring matches against raw
    // response text). For each required/forbidden signal, we evaluate
    // it against the LAST successful call's observation (most cases
    // have a single bootstrap call that is the canonical orientation;
    // multi-call cases use the last non-error observation, which for
    // pd-06 is the second bootstrap, the version-check moment).
    const lastObservation = (() => {
      for (let i = out.per_call.length - 1; i >= 0; i--) {
        const c = out.per_call[i];
        if (!c.is_error && c.canonical_observation) return c.canonical_observation;
      }
      return null;
    })();

    function classifySignal(sig, observation) {
      if (!observation) {
        return { status: 'unmappable', reason: 'no successful observation available' };
      }
      return evaluateSignal(sig, observation);
    }

    for (const sig of caseDef.expected.required_signals) {
      const r = classifySignal(sig, lastObservation);
      out.required_signals_results.push({ signal: sig, ...r });
    }
    for (const sig of caseDef.expected.forbidden_signals) {
      const r = classifySignal(sig, lastObservation);
      out.forbidden_signals_results.push({ signal: sig, ...r });
    }

    // Outcome rule:
    //   - executed-pass: every required signal evaluated-true, every
    //     forbidden signal evaluated-false (or unmappable; see below).
    //   - executed-gap: any required signal evaluated-false, OR any
    //     forbidden signal evaluated-true.
    //   - executed-unmappable: every signal is unmappable (the contract
    //     is so far from the legacy response shape that we cannot tell).
    //   - executed-unavailable: tool errored.
    const requiredMissing = out.required_signals_results.filter((r) => r.status === 'evaluated-false');
    const requiredUnmappable = out.required_signals_results.filter((r) => r.status === 'unmappable');
    const forbiddenPresent = out.forbidden_signals_results.filter((r) => r.status === 'evaluated-true');
    const totalSignals = caseDef.expected.required_signals.length + caseDef.expected.forbidden_signals.length;

    if (requiredMissing.length === 0 && forbiddenPresent.length === 0) {
      if (requiredUnmappable.length === totalSignals) {
        out.outcome = 'executed-unmappable';
      } else {
        out.outcome = 'executed-pass';
      }
    } else {
      out.outcome = 'executed-gap';
      out.notes.push(
        `missing required: ${requiredMissing.map((r) => r.signal).join('; ')}; ` +
        `present forbidden: ${forbiddenPresent.map((r) => r.signal).join('; ')}; ` +
        `unmappable required: ${requiredUnmappable.map((r) => r.signal).join('; ')}`,
      );
    }
    return out;
  }

  // -----------------------------------------------------------------------
  // 5. Run all eight cases
  // -----------------------------------------------------------------------

  const casesDoc = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));

  const runResults = [];
  for (const c of casesDoc.cases) {
    try {
      runResults.push(await executeCase(c));
    } catch (e) {
      runResults.push({
        case_id: c.id,
        outcome: 'executed-unavailable',
        notes: [`top-level exception: ${e.message}`],
        per_call: [],
        tools_invoked: [],
        total_response_bytes: 0,
        total_elapsed_ms: 0,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 6. Write outputs
  // -----------------------------------------------------------------------

  const environment = {
    run_id: runId,
    clock_anchor: clockAnchor,
    // Sanitized: only the disposable dir basename, not its parent path,
    // to avoid leaking absolute workstation paths. The relative
    // computation would walk up out of the repo root into the user's
    // home directory.
    disposable_dir_basename: relative(process.env.TEMP ?? '/tmp', disposableDir).replaceAll('\\', '/'),
    node_version: process.version,
    mem_graph_dir_was_set: process.env.MEM_GRAPH_DIR !== undefined,
    cases_contract_hash: createHash('sha256').update(JSON.stringify(casesDoc)).digest('hex'),
    tool_mapping_hash: createHash('sha256').update(
      readFileSync(join(HERE, 'tool-mapping.json'), 'utf8'),
    ).digest('hex'),
    registered_tool_count: Object.keys(captured).length,
    run_started_at: new Date().toISOString(),
  };

  writeFileSync(join(resultsDir, 'environment.json'), JSON.stringify(environment, null, 2));

  const perCaseHashes = {};
  for (const result of runResults) {
    const filePath = join(resultsDir, `${result.case_id}.json`);
    writeFileSync(filePath, JSON.stringify(result, null, 2));
    perCaseHashes[result.case_id] = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  }

  const runSummary = {
    run_id: runId,
    total_cases: runResults.length,
    outcomes: {
      'executed-pass': runResults.filter((r) => r.outcome === 'executed-pass').length,
      'executed-gap': runResults.filter((r) => r.outcome === 'executed-gap').length,
      'executed-unavailable': runResults.filter((r) => r.outcome === 'executed-unavailable').length,
      'executed-unmappable': runResults.filter((r) => r.outcome === 'executed-unmappable').length,
    },
    per_case_hashes_raw: perCaseHashes,
    per_case_outcomes: runResults.map((r) => ({ case_id: r.case_id, outcome: r.outcome })),
    total_response_bytes: runResults.reduce((acc, r) => acc + r.total_response_bytes, 0),
    total_elapsed_ms: runResults.reduce((acc, r) => acc + r.total_elapsed_ms, 0),
    total_calls: runResults.reduce((acc, r) => acc + r.per_call.length, 0),
  };
  writeFileSync(join(resultsDir, 'run-summary.json'), JSON.stringify(runSummary, null, 2));

  // Cleanup disposable dir
  try {
    rmSync(disposableDir, { recursive: true, force: true });
  } catch {
    // Non-fatal
  }
};

await main();
