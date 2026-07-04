# mem-graph

MCP server for graph-relational memory: a v2 evolution of mem-sol that adds a graph layer (wikilinks, BM25 auto-linking, spreading activation, synaptic decay) on top of a layered memory model. Backed by better-sqlite3.

## Purpose

Solo learning build exploring graph-relational memory as an MCP substrate. Not production-aimed, not benchmarked against peer systems; the goal is hands-on understanding of layered memory, wikilinks, and spreading activation.

mem-graph is the LLM's persistent memory between opencode sessions. It builds on mem-sol v1's relational foundation and adds:

- **Layered memory model** — five discrete layers (`working`, `episodic`, `procedural`, `semantic`, `partner`) with layer-aware decay and retrieval
- **Wikilinks** — markdown-style `[[reference]]` syntax in memory content creates hard, operator-curated edges
- **BM25 auto-linking** — on every insert, soft edges are auto-created to textually-overlapping memories in the same project
- **Spreading activation** — retrieval is text-match + neighborhood traversal with weight attenuation, not pure FTS
- **Synaptic decay** — synapse weights erode over time, with separate rates per layer pair and per connection type, and access-based exemption for hot edges

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

108 tests across 9 files exercise the substrate in-memory via `:memory:` SQLite. Run takes ~500ms. See `tests/` for fixtures and `tests/helpers.ts` for the `createInMemoryDb()` factory.

## Configuration

The MCP reads:
- `MEM_GRAPH_DIR` — directory for the SQLite database. Default: `~/.local/share/mem-graph/`. The DB file is `memory.db` inside. Override by setting the env var before launch.

## Tools (27)

| Group | Tools |
|---|---|
| SQL (4) | `sql_query`, `sql_execute`, `sql_introspect`, `list_databases` |
| Orient (4) | `memory_overview`, `memory_prime`, `memory_projects`, `memory_categories` |
| Search (5) | `memory_search`, `memory_recent`, `memory_get`, `memory_changes`, `memory_stats` |
| Write (7) | `memory_add`, `memory_update`, `memory_supersede`, `memory_mark`, `memory_boost`, `memory_tag_add`, `memory_tag_remove` |
| Graph (6) | `memory_synapse_create`, `memory_synapse_traverse`, `memory_activate`, `memory_decay`, `memory_spread_stats`, `memory_stale` |
| Import (1) | `memory_import_from_mem_sol` |

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

- The MCP is project-local (this directory) but the database is user-global (`~/.config/opencode/mem-graph/memory.db` by default).
- Register in `~/.config/opencode/opencode.jsonc` under the `mem-graph` MCP name; tools will be prefixed `mem-graph_`.
- Mem-graph coexists with mem-sol v1 — they are independent servers, independent databases.

## Out of scope (explicitly deferred)

- cwd ↔ project binding
- Entry versioning / supersedes chain (only the basic `memory_supersede` tool exists)
- Tag-intersection queries (schema supports it via the junction table; no tool yet)
- knowledge.db (separate concern)
- Auto-link-on-read philosophy (R from analysis § 3.1, deferred to Tier 3+)

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
