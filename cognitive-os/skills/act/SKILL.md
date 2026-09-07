---
name: act
description: 'Steward-pinned pointer. Canonical source lives in the operator's steward repo (path is host-specific). This file is a discovery aid for cognitive-os consumers; do not edit the body here.'
user-invocable: false
---

# act — steward-pinned pointer

This directory exists so cognitive-os consumers can discover the `act`
skill by directory traversal. The skill body is **not mirrored here**;
fetching the canonical source is the supported install path.

## What this pointer is

A `SKILL.md` with `user-invocable: false` so it does not register as a
real skill in any host's skill registry. The host that needs the skill
reads the canonical source, not this file. This file's only job is to
be visible under `ls cognitive-os/skills/`.

## What this pointer is not

- Not a backup. The steward repo's git history is the source of truth.
- Not a sync target. There is no automated mirror from steward to this
  directory. If the canonical source advances, this pointer's "Version
  at last review" line is informational only — fetch the source to know
  the current version.
- Not a fork. Edits to this file's body would be lost (the host reads
  the canonical source).

## When to promote this pointer to a full bundle

If `act` needs to ship across host adapters (Codex, Gemini, generic),
the canonical source moves into this directory as a full bundle, with
its own validator and contract entry in
`cognitive-os/agent-practice/reasoning-gates.v1.json`. Until then, the
steward repo is the canonical source and this pointer is sufficient.

See `cognitive-os/skills/README.md` for the sourcing-model rules.

## Cross-references

- Sourcing rules: `cognitive-os/skills/README.md`
- Pre-mortem (canonical-source example): `cognitive-os/skills/pre-mortem/`
