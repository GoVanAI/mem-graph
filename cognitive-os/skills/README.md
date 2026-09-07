# cognitive-os/skills/ — install-target registry

This directory hosts skill bundles that ship with the cognitive-os
framework. It is a registry, not a single source of truth — different
skills live here under different sourcing models. The rules below keep
the registry from drifting into parallel copies.

## Sourcing models

Two models are in active use. A skill in this directory is one or the
other; the model is declared in the skill's own README or top-of-file
comment.

### Canonical source (host-neutral)

The skill's full bundle lives in this directory. Adapters for each host
(Claude Code, Codex, Gemini, generic) are generated from this source via
`cognitive-os/agent-practice/generate-adapters.mjs` and the host's own
install mechanism. The skill's contract is declared in
`cognitive-os/agent-practice/reasoning-gates.v1.json` and graded by a
dedicated validator in `src/cognitive/<skill>/`.

Currently: **pre-mortem** (canonical source moved 2026-08-11 per H1;
see `pre-mortem/README.md`).

### Steward-pinned pointer

The skill's canonical source lives in the operator's steward repo. This directory contains only a pointer file —
typically a `SKILL.md` with a `Canonical source:` header — so cognitive-os
consumers can discover the skill by directory traversal but cannot fall
out of sync with the upstream body.

Pointer files do not mirror the body. Fetching the canonical source is
the supported install path. If a steward-pinned skill is later promoted
to canonical-source (because it needs to ship to other agent hosts
through the cognitive-os adapter pipeline), this directory gets a full
skill bundle and the pointer is removed.

Currently: **act**, **dream** (steward-pinned; canonical sources in
the steward repo at v1.2.2 and post-`33abd1f` respectively as of
2026-09-06).

## Why two models

The steward repo is where Claude Code's local skills evolve under
operator supervision — it is the natural authoring surface for skills
that today ship only to Claude Code sessions on this host. The
cognitive-os repo is the upstream canonical source for skills that need
to ship across host adapters.

Conflating the two creates drift sites: parallel copies of the same
SKILL.md diverge silently, and the discipline work in one surface does
not propagate to the other. The two-model rule is the cheap prevention.

## Adding or moving a skill

- **Authored in the steward repo, only consumed by Claude Code on this
  host:** create a pointer file in `cognitive-os/skills/<skill>/SKILL.md`
  referencing the steward canonical source. Add a row to the "Currently"
  list above.

- **Needs to ship across hosts (Codex, Gemini, generic), or has a
  dedicated validator / contract in `src/cognitive/`:** move the
  canonical source into this directory as a full bundle. Generate
  adapters via `npm run practice:generate`. Add a row to the "Currently"
  list above.

If unsure which model fits, default to **pointer file**. Promoting a
pointer to a full bundle is a one-way move with a clear rationale;
creating a parallel copy is the drift site we are trying to avoid.

## Drift detection

Pointer files are static; they do not auto-detect upstream changes.
Detection is operator-driven: if a steward-pinned skill's canonical
source advances by a major version (frontmatter `version:` field), the
operator should:

1. Verify the steward-pinned skill is still pointing at the right path
   (`Canonical source:` header).
2. Decide whether the cognitive-os install target still needs the
   pointer, or whether the skill has crossed the threshold to canonical
   source.

There is no automated drift detector today. Adding one is a separate
workstream if the steward repo gains enough skills to make manual
tracking untenable.

## Cross-references

- `cognitive-os/agent-practice/generate-adapters.mjs` — adapter generator
- `cognitive-os/agent-practice/reasoning-gates.v1.json` — canonical-source contract
- `cognitive-os/skills/pre-mortem/README.md` — example canonical-source skill
