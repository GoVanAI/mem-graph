# mem-graph

mem-graph is a local-first MCP server for persistent, graph-relational agent
memory. It combines layered SQLite storage, FTS5/BM25 retrieval, wikilink and
automatically discovered synapses, spreading activation, and synaptic decay.
Its additive Cognitive OS layer provides hash-linked evidence, scoped guidance,
candidate-policy evaluation, and a read-only bootstrap for portable agent
practice across MCP-capable clients.

## Purpose

mem-graph is an experimental reference implementation and proving ground for
memory that agents can inspect, carry across sessions, and use without treating
retrieval as authority. The memory substrate stores and retrieves durable
relationships; Cognitive OS adds an evidence-governed workflow for deciding
which scoped guidance is eligible for direct authority verification. Candidate
policies remain advisory and cannot expand an agent's permissions.

The repository is not presented as production-ready and has not been
benchmarked against peer systems.

Building on mem-sol v1's relational foundation, the repository includes:

- **Layered memory model** — five discrete layers (`working`, `episodic`, `procedural`, `semantic`, `partner`) with layer-aware decay and retrieval
- **Wikilinks** — markdown-style `[[reference]]` syntax in memory content creates hard, operator-curated edges
- **BM25 auto-linking** — on every insert, soft edges are auto-created to textually-overlapping memories in the same project
- **Spreading activation** — retrieval is text-match + neighborhood traversal with weight attenuation, not pure FTS
- **Synaptic decay** — synapse weights erode over time, with separate rates per layer pair and per connection type, and access-based exemption for hot edges
- **Cognitive OS sidecar** — immutable evidence events, scoped candidate-policy evaluation, governing/contextual guidance lanes, and a read-only agent bootstrap
- **Portable agent practice** — one machine-readable advisory contract generates Codex, Claude, Gemini, and generic-host adapters plus deterministic compliance evaluation

The current release is `v0.3.0`. It adds the Cognitive OS and portable
agent-practice implementation documented below without removing the existing
memory and graph tools.

## Install

Clone, install, and register as an MCP server:

```bash
git clone https://github.com/GoVanAI/mem-graph
cd mem-graph
npm install
```

Add this entry to your MCP client config (e.g., `~/.config/opencode/opencode.jsonc` or Claude Code's MCP config):

```jsonc
{
  "mcpServers": {
    "mem-graph": {
      "command": "npm",
      "args": ["start", "--prefix", "/absolute/path/to/mem-graph"],
      "env": {
        "MEM_GRAPH_DIR": "/absolute/path/to/your/mem-graph-db"
      }
    }
  }
}
```

Replace both placeholder paths with absolute paths on your machine. The server reads `MEM_GRAPH_DIR` literally — `~` is not expanded at runtime. Default (without `MEM_GRAPH_DIR`) is `~/.local/share/mem-graph/memory.db`.

## Run (locally)

```bash
npm start
```

## Tests

```bash
npm test           # run once, exits 0 on success
npm run test:watch # watch mode for development
```

The Vitest suite exercises the substrate, Cognitive OS sidecar, and
agent-practice contract in-memory via `:memory:` SQLite. See `tests/` for
fixtures and `tests/helpers.ts` for the `createInMemoryDb()` factory.

## Configuration

The MCP reads:
- `MEM_GRAPH_DIR` — directory for the SQLite database. Default: `~/.local/share/mem-graph/`. The DB file is `memory.db` inside. Override by setting the env var before launch.

## Tools (35)

| Group | Tools |
|---|---|
| SQL (4) | `sql_query`, `sql_execute`, `sql_introspect`, `list_databases` |
| Orient (4) | `memory_overview`, `memory_prime`, `memory_projects`, `memory_categories` |
| Search (5) | `memory_search`, `memory_recent`, `memory_get`, `memory_changes`, `memory_stats` |
| Write (7) | `memory_add`, `memory_update`, `memory_supersede`, `memory_mark`, `memory_boost`, `memory_tag_add`, `memory_tag_remove` |
| Graph (6) | `memory_synapse_create`, `memory_synapse_traverse`, `memory_activate`, `memory_decay`, `memory_spread_stats`, `memory_stale` |
| Import (1) | `memory_import_from_mem_sol` |
| Cognitive OS (8) | `cognitive_agent_bootstrap`, `cognitive_event_append`, `cognitive_event_trace`, `cognitive_policy_create`, `cognitive_policy_lookup`, `cognitive_policy_evaluate`, `cognitive_current_guidance_search`, `cognitive_current_guidance_diagnose` |

### `memory_add` write pipeline

On every `memory_add`:
1. Insert into `memories` (FTS5 triggers fire automatically)
2. Insert tags into `memory_tag` (junction table, no JSON)
3. Extract `[[wikilinks]]` from content, resolve to memory ids (id → title → slug), upsert synapses
4. Run BM25 auto-link against same-project memories, upsert `bm25_auto` synapses
5. Enforce 50/50 synapse cap (prune lowest-weight `bm25_auto` if exceeded)
6. Return: `{ id, wikilinks_resolved, broken_wikilinks, auto_links_created }`

### `memory_activate` (the headline graph tool)

Spreading activation retrieval. Inputs: `query` (FTS5 string), `max_hop_depth` (default 2), `min_synapse_weight` (default 0.3), `limit_cap` (default 20), `land_on_layers` (default all except working), `pass_through_layers` (default `[semantic]`), `project_id` (optional).

The recursive CTE carries a `path` column so the pass-through check can correctly verify "any ancestor in the path is a pass-through layer" (the v1 review's critical issue 1 is fixed here).

### Cognitive OS guidance and evidence

The Cognitive OS sidecar records immutable, hash-linked learning events;
projects candidate policies from that evidence; evaluates them without
automatic authority promotion; and provides an active, exact-project current-
guidance search before optional graph expansion. That MCP guidance surface
mechanically excludes working or ephemeral memories and non-governing
categories. It admits only normalized `decision`, `policy`, `process`,
`preference`, `commitment`, and `handoff` categories, allowing non-working,
non-ephemeral handoffs to remain candidates for direct authority verification.

`cognitive_current_guidance_diagnose` instead classifies the bounded active
candidate set into governing and contextual/ineligible lanes with stable
reasons (`working_layer`, `ephemeral_lifecycle`,
`category_not_governing`) and never changes access tracking. Policy
evaluations can preserve correlation and causation IDs in their append-only
event evidence. This is retrieval eligibility—not authority or automatic
policy promotion. Legacy `memory_search` and `memory_activate` semantics are
unchanged. See the historical
[`MVP-001 proof contract`](cognitive-os/experiments/MVP-001-current-guidance-retrieval.md).

### Agent practice and bootstrap

The adopted vendor-neutral practice is defined in
[`cognitive-os/agent-practice/practice.v1.json`](cognitive-os/agent-practice/practice.v1.json).
It generates human guidance and Codex, Claude, Gemini, and generic host
adapters. The repo-scoped `$mem-graph-practice` skill applies the same workflow.

`cognitive_agent_bootstrap` composes exact-project scope, an optional canonical
record snapshot, candidate-policy lookup, and governing/contextual guidance
diagnosis in one strictly read-only call. It performs no database writes,
event append, access-count update, graph expansion, or durable receipt. Its
output is observable bootstrap evidence, not authority or validation. Global
records remain excluded unless `include_global=true` is explicit.

Regenerate and verify adapters with:

```bash
npm run practice:generate
npm run practice:check
```

Deterministic transcript grading runs locally:

```bash
npm run practice:grade -- cognitive-os/agent-practice/evals/fixtures/compliant-tracker-update.json
```

An independent MiniMax qualitative review is opt-in and dry-runs by default.
The exact model ID is deliberately configurable because account labels and API
model identifiers can differ:

```bash
npm run practice:minimax -- --transcript cognitive-os/agent-practice/evals/fixtures/compliant-tracker-update.json --model <minimax-model-id>
npm run practice:minimax -- --transcript <redacted-transcript.json> --model <minimax-model-id> --execute
```

The qualitative model cannot override deterministic trace facts. The wrapper
rejects likely secrets and sends data only with explicit `--execute`. Hard
enforcement remains disabled unless repeated evaluation failures justify a
separately authorized blocking mechanism. Executing the MiniMax review also
requires an independently installed and authenticated `mmx` CLI; dry-run mode
does not make an external call.

This repository state does not install host hooks or hook-driven blocking.
The bootstrap and compliance grader are observable advisory mechanisms, not
permission or continuation controls.

### Epistemic Memory Phase 0 kernel

The repository includes a pure, side-effect-free epistemic reasoning kernel at
[`src/epistemic/`](src/epistemic/). It provides strict v0.3 records and
validation, bounded compact-prime compilation, neutral synthesis, and v0.4
stale-belief maintenance with deliberate challenge, belief-use, linked-outcome,
contradiction, freshness, influence, and review-queue projections.

The stable public import surface is
[`src/epistemic/index.ts`](src/epistemic/index.ts). Start with the
[Phase 0 implementation report](docs/EPISTEMIC_MEMORY_PHASE0_IMPLEMENTATION_REPORT.md),
then consult the
[v0.3 implementation handoff](docs/EPISTEMIC_MEMORY_V0_3_IMPLEMENTATION_HANDOFF.md)
and [v0.4 stale-belief contract](docs/EPISTEMIC_MEMORY_V0_4_STALE_BELIEF_CONTROL.md).
All fixtures are synthetic and live under
[`tests/fixtures/epistemic/`](tests/fixtures/epistemic/).

Phase 0 is deliberately dormant: it performs no SQLite access, memory writes,
event appends, MCP registration, retrieval integration, scheduling, policy
promotion, or authority grant. Schema-valid authority remains non-binding unless
the caller independently verifies it. Later persistence and runtime integration
require separate operator-approved contracts.

### Cognitive OS roadmap and historical milestone contracts

The original proof sequence is preserved in [`cognitive-os/ROADMAP.md`](cognitive-os/ROADMAP.md).
Operator decision event 36 retired the former MVP-001-to-MVP-002 tripwire as an
active blocker; the old contracts remain historical evidence rather than live
authority. Current sequencing lives in the deployment's operator/project-
configured canonical tracker when one exists. MVP-002's
[frozen proof contract](cognitive-os/experiments/MVP-002-typed-admission-projection-integrity.md)
still documents the narrow typed-admission design and its non-goals.

### `memory_stale` (operational hygiene)

Find entries not accessed in N days. Inputs: `days` (default 30), `project_id` (optional), `lifecycle` (allow-list: `permanent`, `milestone`, `ephemeral`), `layer` (allow-list: `working`, `episodic`, `procedural`, `semantic`, `partner`), `limit` (default 50, max 500).

Each result row includes `never_accessed: boolean` (true when `accessed_at IS NULL`), making the cold-set cohort grep-able in JSON output. NULLs sort first — never-accessed entries surface at the top of the result set.

### `memory_tag_add` / `memory_tag_remove` (quiet curation)

Tag curation tools that touch only the `memory_tag` junction table. Do NOT re-run wikilink extraction or BM25 auto-link. Do NOT bump `accessed_at` / `access_count` (tag curation is not a read). Idempotent: re-adding the same tag returns `added: false`; removing a missing tag returns `removed: false`.

### `memory_import_from_mem_sol` (v1 → v2 migration)

One-shot migration from a mem-sol v1 SQLite DB. Pipeline: insert memories (FTS5 triggers fire) → parse JSON tags into `memory_tag` → two-pass wikilink extraction (handles forward references) → migrate v1 `memory_links` as wikilink synapses. Idempotent on `(project_id, title)`. Auto-link is deferred to next activation.

Field-mapping highlights: `project` → `project_id`, `relevance_score` → `importance_score`, JSON-encoded tags → junction rows. Layer defaults to `episodic` for v1 entries (configurable). Source field remapped to `import` for all v1 origins.

## Schema

See `src/db.ts` for the canonical DDL. Quick reference:

- **`memories`** — relational layer; columns: `id`, `layer`, `title`, `slug`, `content`, `project_id`, `category`, `lifecycle`, `status`, `confidence`, `boost`, `summary`, `session_id`, `source`, `created_at`, `updated_at`, `accessed_at`, `access_count`, `importance_score`, `expires_at`, `refresh_strategy`
- **`memory_tag`** — junction table, `(memory_id, tag)` PK with `ON DELETE CASCADE`
- **`synapses`** — graph edges; `source_id`, `target_id`, `connection_type` (`wikilink` / `bm25_auto` / `parent_child`), `weight` (0.0–5.0), `access_count`
- **`memories_fts`** — FTS5 mirror of `memories` (porter stemmer + 2/3-char prefix), kept in sync by triggers
- **`decay_matrix`** — `(source_layer, target_layer, connection_type) → decay_rate`; wildcard `*` for target_layer
- **`cognitive_events`** — append-only, hash-linked Cognitive OS evidence ledger
- **`policy_candidates`** — scoped candidate-policy projection; evaluation does not automatically promote status
- **`policy_evaluations`** — explicit policy outcome and guardrail evidence

### Five layers

| Layer | Purpose | Decay (vs same layer) |
|---|---|---|
| `working` | In-progress, in-flight | Aggressive (0.70 wikilink, 0.40 bm25) |
| `episodic` | Session events, time-anchored | Moderate (0.95 wikilink, 0.88 bm25) |
| `semantic` | Connective tissue, conceptual | Stable (0.99 wikilink, 0.93 bm25) |
| `procedural` | How-to, never-fade rules | Highly stable (0.995 wikilink, 0.98 bm25) |
| `partner` | User model, prefs | Most stable (0.999 wikilink, 0.97 bm25) |

## Locked decisions (v2 design doc §12 + review fixes)

| # | Decision | Choice |
|---|---|---|
| D1 | Tag storage | **Junction table** `memory_tag` |
| D2 | Wikilink direction | **author = source** |
| D3 | Cycle prevention | **NOT EXISTS** subquery |
| D4 | Decay frequency | **Tool exposed, runs via cron** |
| D5 | Synapse cap | **50 in + 50 out per memory**, enforced on insert |
| D6 | Wikilink rendering | **Auto-render to title** in tool output |
| D7 | access_count on synapses | **Both memories and synapses** |
| D8 | ID format | **Integer, autoincrement** |

## Project context

- The MCP is project-local, while the default database is user-global at `~/.local/share/mem-graph/memory.db`.
- Register the server under the `mem-graph` name in any compatible MCP client. Displayed tool prefixes are client-dependent (for example, OpenCode and Codex render them differently).
- Mem-graph coexists with mem-sol v1 — they are independent servers, independent databases.

## Out of scope (explicitly deferred)

- cwd ↔ project binding
- Entry versioning / supersedes chain (only the basic `memory_supersede` tool exists)
- Tag-intersection queries (schema supports it via the junction table; no tool yet)
- knowledge.db (separate concern)
- Auto-link-on-read philosophy (R from analysis § 3.1, deferred to Tier 3+)

## v0.3 / Cognitive OS agent practice (2026-08-09)

v0.3.0 adds eight Cognitive OS tools to the existing 27-tool memory and graph
surface. The release includes an immutable evidence ledger, scoped candidate-
policy evaluation, governing/contextual guidance lanes, a non-mutating
diagnostic surface, and the read-only `cognitive_agent_bootstrap` entry point.

The portable agent-practice contract generates Codex, Claude, Gemini, and
vendor-neutral adapters from one source and includes deterministic compliance
evaluation. Retrieval and mechanical eligibility remain distinct from
validation and authority; candidate policies are advisory, and hook-driven or
hard enforcement remains disabled.

Verification at release: 16 test files / 167 tests, TypeScript compilation,
generated-adapter freshness, focused agent-practice tests, and deterministic
frozen-harness reproduction.

See the [v0.3.0 release notes](docs/releases/v0.3.0.md) for highlights,
safety boundaries, and upgrade guidance.

## v0.2 / Tier 1 closure (2026-07-04)

Tier 1 implementation closed via `loop-eng` protocol, 6 iterations, 108 tests added. Specifically:

- **R1** — Vitest suite covering wikilinks, auto-link, activate CTE, decay matrix, supersede; in-memory DB factory via exported `SCHEMA_SQL` + `DECAY_MATRIX_SEED`.
- **R2** — `memory_tag_add` / `memory_tag_remove` quiet tools; no wikilink or auto-link re-run on tag change.
- **R5** — `memory_stale` extended with `lifecycle` + `layer` filters; explicit `never_accessed` boolean surfaces the 28-row cold set.
- **R3** — `memory_import_from_mem_sol` one-shot migration from v1 SQLite DB; idempotent on `(project_id, title)`; preserves connections (not v1 type labels).
- **R4** — `category` taxonomy documented (11 values: 9 standard + 3 first-class: `commitment`, `open_question`, `trigger`). No CHECK constraint added — agent-as-author migration is the right time to revisit.

Tool count grew from 24 → 27. Preserve-list (SQLite substrate, wikilinks-in-prose, 50-cap bm25-only pruning, 20-row decay matrix, 5-layer + 3-connection-type model) was held intact across all five iterations.

## License

MIT
