# mem-graph

mem-graph is a local-first MCP server that gives agents durable, inspectable, graph-relational memory. It stores memories with relationships (wikilinks, BM25 auto-links, parent-child edges) and retrieves them via FTS5 plus spreading activation with synaptic decay.

## Features

- **Layered storage** — five memory layers (`working`, `episodic`, `procedural`, `semantic`, `partner`) with layer-aware decay and retrieval.
- **Wikilinks** — `[[reference]]` markdown syntax creates hard, operator-curated graph edges.
- **BM25 auto-linking** — soft edges auto-created to textually-overlapping memories on every insert.
- **Spreading activation** — retrieval is text-match plus neighborhood traversal with weight attenuation, not pure FTS.
- **Synaptic decay** — synapse weights erode over time, with separate rates per layer pair and per connection type, and access-based exemption for hot edges.
- **Epistemic Memory kernel** — strict v0.3/v0.4 records, bounded prime compilation, neutral synthesis, and stale-belief maintenance with deliberate challenge, belief-use, linked-outcome, contradiction, freshness, influence, and review-queue projections.

## Install

```bash
git clone https://github.com/GoVanAI/mem-graph
cd mem-graph
npm install
```

Register as an MCP server (e.g., `~/.config/opencode/opencode.jsonc` or Claude Code's MCP config):

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

The server reads `MEM_GRAPH_DIR` literally — `~` is not expanded at runtime. Default (without `MEM_GRAPH_DIR`) is `~/.local/share/mem-graph/memory.db`.

## Run

```bash
npm start
```

## Tests

```bash
npm test           # run once, exits 0 on success
npm run test:watch # watch mode
```

The Vitest suite runs the substrate, cognitive layer, and Epistemic Memory kernel against an in-memory SQLite (`tests/helpers.ts`, `createInMemoryDb()`). See `tests/` for fixtures.

## Tool surface

| Group | Tools | Count |
|---|---|---|
| SQL | `sql_query`, `sql_execute`, `sql_introspect`, `list_databases` | 4 |
| Orient | `memory_overview`, `memory_prime`, `memory_projects`, `memory_categories` | 4 |
| Search | `memory_search`, `memory_recent`, `memory_get`, `memory_changes`, `memory_stats` | 5 |
| Write | `memory_add`, `memory_update`, `memory_supersede`, `memory_mark`, `memory_boost`, `memory_tag_add`, `memory_tag_remove` | 7 |
| Graph | `memory_synapse_create`, `memory_synapse_traverse`, `memory_activate`, `memory_decay`, `memory_spread_stats`, `memory_stale` | 6 |
| Cognitive layer | `cognitive_agent_bootstrap`, `cognitive_event_append`, `cognitive_event_trace`, `cognitive_policy_create`, `cognitive_policy_lookup`, `cognitive_policy_evaluate`, `cognitive_current_guidance_search`, `cognitive_current_guidance_diagnose`, `cognitive_concept_diff`, `cognitive_task_state_*` | ~12 |
| Epistemic | `epistemic_admit`, `epistemic_inspect`, `epistemic_append_receipt`, `epistemic_event_*` | ~6 |
| Workflow profiles | `agent_profile`, `maintenance_profile` (via `src/tool-profiles.ts`) | — |

The cognitive and epistemic layers are part of mem-graph's substrate; they are not a separate framework.

## Source layout

```
src/
├── access.ts                # SQLite access layer
├── activate.ts              # spreading activation retrieval
├── auto-link.ts             # BM25 auto-linking on insert
├── bootstrap.ts             # substrate bootstrap
├── cognitive/               # cognitive layer
│   ├── agent-bootstrap.ts
│   ├── agent-practice-eval.ts
│   ├── bootstrap-disclosure.ts
│   ├── concept-diff/
│   ├── event-contracts.ts
│   ├── events.ts
│   ├── operator-adoption.ts
│   ├── policy.ts
│   ├── pre-mortem/
│   ├── retrieval.ts
│   ├── schema.ts
│   ├── task-state-manifest.ts
│   ├── task-state-server.ts
│   ├── task-state.ts
│   └── types.ts
├── db.ts                    # SQLite schema DDL
├── decay.ts                 # synaptic decay matrix
├── epistemic/               # Epistemic Memory kernel
│   ├── dream-bridge.ts
│   ├── index.ts             # public import surface
│   ├── maintenance.ts
│   ├── maintenance-runtime.ts
│   ├── persistence.ts
│   ├── prime.ts
│   ├── projections.ts
│   ├── schema.ts
│   ├── self-correct-bridge.ts
│   ├── synthesize.ts
│   ├── task-ledger.ts
│   ├── types.ts
│   └── validate.ts
├── import-memsol.ts         # one-shot migration from mem-sol v1
├── index.ts                 # MCP server entry point
├── memory-prime.ts          # priming helpers
├── memory-read.ts           # read helpers
├── migrations/              # DB migration system
│   ├── baseline.ts
│   ├── index.ts
│   └── registry.ts
├── tool-profiles.ts         # workflow-oriented MCP profiles
├── tools/                   # MCP tool implementations
│   ├── cognitive.ts
│   ├── epistemic.ts
│   ├── memory-graph.ts
│   ├── memory-import.ts
│   ├── memory-orient.ts
│   ├── memory-search.ts
│   ├── memory-tags.ts
│   ├── memory-write.ts
│   └── sql.ts
├── util.ts
└── wikilink.ts              # wikilink extraction and resolution
```

## Schema

See `src/db.ts` for the canonical DDL.

- **`memories`** — relational layer; columns: `id`, `layer`, `title`, `slug`, `content`, `project_id`, `category`, `lifecycle`, `status`, `confidence`, `boost`, `summary`, `session_id`, `source`, `created_at`, `updated_at`, `accessed_at`, `access_count`, `importance_score`, `expires_at`, `refresh_strategy`
- **`memory_tag`** — junction table, `(memory_id, tag)` PK with `ON DELETE CASCADE`
- **`synapses`** — graph edges; `source_id`, `target_id`, `connection_type` (`wikilink` / `bm25_auto` / `parent_child`), `weight` (0.0–5.0), `access_count`
- **`memories_fts`** — FTS5 mirror (porter stemmer + 2/3-char prefix), kept in sync by triggers
- **`decay_matrix`** — `(source_layer, target_layer, connection_type) → decay_rate`; wildcard `*` for target_layer

### Five layers

| Layer | Purpose | Decay (vs same layer) |
|---|---|---|
| `working` | In-progress, in-flight | Aggressive (0.70 wikilink, 0.40 bm25) |
| `episodic` | Session events, time-anchored | Moderate (0.95 wikilink, 0.88 bm25) |
| `semantic` | Connective tissue, conceptual | Stable (0.99 wikilink, 0.93 bm25) |
| `procedural` | How-to, never-fade rules | Highly stable (0.995 wikilink, 0.98 bm25) |
| `partner` | User model, prefs | Most stable (0.999 wikilink, 0.97 bm25) |

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Tag storage | Junction table `memory_tag` |
| D2 | Wikilink direction | Author = source |
| D3 | Cycle prevention | `NOT EXISTS` subquery |
| D4 | Decay frequency | Tool exposed, runs via cron |
| D5 | Synapse cap | 50 in + 50 out per memory, enforced on insert |
| D6 | Wikilink rendering | Auto-render to title in tool output |
| D7 | `access_count` on synapses | Both memories and synapses |
| D8 | ID format | Integer, autoincrement |

## License

MIT
