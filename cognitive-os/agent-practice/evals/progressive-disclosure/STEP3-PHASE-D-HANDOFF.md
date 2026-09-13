# Step 3 — Phase D Completion Handoff

Status: **ready for final Codex Gate D acceptance**

Date: 2026-09-07

Starting/ending HEAD: `af95264` (dirty working tree; no commit or push)

## Outcome

Phase D records **7 executed-pass / 1 executed-gap / 0 unavailable / 0
infrastructure failures** across two independent disposable runs.

- `pd-01`, `pd-02`, `pd-03`, `pd-04`, `pd-05`, `pd-07`, and `pd-08` pass.
- `pd-06` is the single honest product gap.
- Phase E has not started.

The runner exits `1` while the product gap exists. This implements the execution
plan's fail-closed predicate-failure rule. The valid receipt is written before
that exit so Gate D can inspect unaffected cases and the bounded gap.

## Final repairs

### pd-02 — verified synthetic adoption

The runner reuses the repository's fixture-mode trust pattern. It generates
ephemeral Ed25519 keys in memory, writes only a signed fixture registry inside
the disposable case directory, signs a Contract 1.1 adoption receipt, creates
the fixture trust runtime, invokes `bootstrapCognitiveAgentWithTaskState`, and
then invokes the real projector.

No key, signature transport, or disposable path is emitted in the receipt. Task
slots become governing only after real adoption verification. Source 103 is
then supplied in the declared pure-projection current-state lane.

### pd-06 — faithful three-call MCP evidence

The runner no longer substitutes a direct projector result for MCP evidence. It
retains this declared sequence for both runs:

1. `cognitive_agent_bootstrap` compact orientation at version 1;
2. `memory_get` after the controlled source transition to version 2; and
3. `cognitive_agent_bootstrap` compact re-orientation.

The final MCP envelope is the primary raw and grading envelope and `calls` is
three. It does not emit `version_mismatch` or `refresh_required`, so the case is
`executed-gap`. Both compact calls prove zero mutation; the middle read proves
only its declared access-tracking effect.

### Fail-closed validation

`validateReceipt()` now requires every byte, digest, semantic-hash, mutation,
and scope verdict to be true; exact ordered cases in both runs; matching
cross-run outcomes and semantic hashes; zero infrastructure failures; recomputed
aggregates and aggregate hashes; canonical raw wire; matching metadata; and the
exact pd-06 three-observation witness.

The runner exits nonzero for any failed verification, infrastructure failure,
`executed-gap`, or `executed-unavailable` outcome.

`validate-step3-contract.mjs` independently cross-checks both receipt runs,
measurement status, execution layer, wire/bytes, digest, semantic hash,
verification categories, determinism, and pd-06 observations.

## Receipt and statuses

Receipt:
`cognitive-os/agent-practice/evals/progressive-disclosure/phase-d-receipt.json`

It retains exact raw wire/envelopes, separate grading and normalized envelopes,
verification evidence, and all pd-06 observations for both runs. Expected totals
are 16/16 for bytes, compact digests, semantic hashes, mutation, and scope.

`cases.json` matches the receipt: `pd-06` is `executed-gap`; the other seven are
`executed-pass`.

## Product gap

The public compact MCP integration is stateless across calls and has no trusted
version-comparison input. It cannot compare orientation with later hydration and
emit `version_mismatch`/`refresh_required`. Phase D records that limitation and
does not authorize a production API change.

## Files changed by the final repair

- `run-step3-cases.mts`
- `phase-d-receipt.json`
- `cases.json`
- `validate-step3-contract.mjs`
- `STEP3-PHASE-D-HANDOFF.md`
- `README.md`

No `src/**`, `tests/**`, profiles, live database, commit, or push was changed by
this repair.

## Required verification

```powershell
python scripts/validate-progressive-disclosure-schemas.py
node cognitive-os/agent-practice/evals/progressive-disclosure/measure-step2a.mjs
node --test cognitive-os/agent-practice/evals/progressive-disclosure/structured-predicate.test.mjs cognitive-os/agent-practice/evals/progressive-disclosure/case-fixtures.test.mjs
node cognitive-os/agent-practice/evals/progressive-disclosure/validate-step3-contract.mjs
npx tsx cognitive-os/agent-practice/evals/progressive-disclosure/run-step3-cases.mts
npx tsc --noEmit
npm run practice:check
npm test
git diff --check -- cognitive-os/agent-practice/evals/progressive-disclosure docs/Update/STEP_3_GATE_D_CODEX_REVIEW.md
```

The runner is expected to exit `1` with
`status="phase-d-runner-product-gap"` and a valid 7-pass/1-gap receipt. Every
other command must exit `0`.

Stop for Gate D acceptance. Phase E remains closed until Codex records it.
