# pre-mortem — host-neutral canonical source

This directory is the **canonical source** for the pre-mortem skill bundle. It is **not** a host-specific install target — Claude, Codex, Gemini, and generic-host adapters are generated from this source via `cognitive-os/agent-practice/generate-adapters.mjs` and the host's own install mechanism.

## Layout

```
pre-mortem/
├── .claude-plugin/
│   └── plugin.json          # Manifest (per plugin-structure convention)
├── README.md                 # This file
├── SKILL.md                  # Skill body — frontmatter + procedure (filled by #115)
├── references/               # Reference docs loaded on demand
├── scripts/                  # Deterministic validators (filled by #116)
├── examples/                 # Worked pre-mortem examples (filled by M4)
└── artifacts/                # Runtime pre-mortem artifacts (referenced from task ledger)
```

## Install targets

This canonical source gets installed to:

- **Claude Code**: `~/.claude/skills/pre-mortem/` (symlink or generated copy)
- **Codex**: `<codex config>/skills/pre-mortem/`
- **Gemini**: `<gemini config>/skills/pre-mortem/`
- **Generic host**: any path the host's loader accepts

Adapters are generated via `npm run practice:generate` (from `cognitive-os/agent-practice/generate-adapters.mjs`) and follow the contract in `reasoning-gates.v1.json`.

## Contract

The skill's behavior is governed by **`cognitive-os/agent-practice/reasoning-gates.v1.json`**, not by this README. Per the Sol review corrections record (Sol H2), the pre-mortem contract is intentionally separate from `practice.v1.json` (which governs mem-graph usage, not general reasoning gates).

Key contract clauses:
- Skill may emit only `passed` | `flagged` | `approval_required`
- Authorized actors (operator / system) emit `accepted_risk` via the memory-admission gate
- `waived` is forbidden as a status
- `passed` proves coverage only; grants no task authority

See `cognitive-os/agent-practice/REASONING_GATES.md` for the full generated contract document.

## Validator

The skill's inputs are graded by the dedicated validator at **`src/cognitive/pre-mortem/pre-mortem-eval.ts`**. Per Sol H4, this is separate from `agent-practice-eval.ts` to avoid breaking its 100-point mem-graph compliance rubric.

13 critical checks enforce:
- category coverage + causal independence
- warning_check_status validity + evidence requirement
- rollback recovery for irreversible commitments
- accepted_risk authority_reference + `no_additional_authority: true`
- waiver completeness

## Status

| Status | Lifecycle |
|---|---|
| Scaffold | ✅ 2026-08-11 — directory + manifest + this README |
| Validator (H4) | ✅ 2026-08-11 — `src/cognitive/pre-mortem/pre-mortem-eval.ts` |
| Reasoning-gates contract (H2) | ✅ 2026-08-11 — `cognitive-os/agent-practice/reasoning-gates.v1.json` |
| Persistence prerequisites (H8-1, H8-2, H8-3, H5) | ✅ 2026-08-11 |
| Canonical source moved to repo (H1) | ✅ 2026-08-11 — `cognitive-os/skills/pre-mortem/` |
| Worked examples redacted (M4) | ✅ 2026-08-11 — `examples/2026-08-02-process-miss-redacted.md` and `examples/2026-08-09-missed-acceptance-gate-redacted.md` |
| SKILL.md body (item 6 #115) | ⏳ pending |
| Failure-mode catalog (item 6) | ⏳ pending |
| Validator script (item 6 #116) | ⏳ pending |

## Cross-references

- the Sol review corrections record — Sol review corrections
- the Sol review task ledger — Sol review task ledger (closed)
- the prior codex handoff, the prior codex handoff — prior codex handoffs
- `cognitive-os/agent-practice/reasoning-gates.v1.json` — governing contract
- `cognitive-os/agent-practice/REASONING_GATES.md` — generated contract document
- `src/cognitive/pre-mortem/pre-mortem-eval.ts` — dedicated validator
- `src/cognitive/pre-mortem/types.ts` — validator types
