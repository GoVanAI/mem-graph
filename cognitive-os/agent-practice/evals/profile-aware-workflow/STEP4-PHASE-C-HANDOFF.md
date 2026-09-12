# Step 4 Phase 4C — Corrected Execution and Amendment-Review Handoff

Status: **execution complete; Gate 4C FAIL; no Phase 4A amendment adopted**

## Scope and protected surfaces

This is a scripted, deterministic evaluation of the frozen Phase 4A contract.
It uses real in-process MCP `Client` → `InMemoryTransport` → `McpServer`
execution and isolated `mkdtempSync` SQLite directories. It does not measure
autonomous tool selection, LLM/provider effectiveness, or provider tokens.

Unchanged protected surfaces: `cases.json`, `cases.schema.json`,
`arm-grader.mjs`, all `src/**`, all existing `tests/**`, Step 3 artifacts, Git
index, commits, and live databases. No Phase 4A amendment has been applied.

## Observed evidence

- The 32-execution matrix completed through the real MCP transport. The current
  receipt records `gate_passed: false`, four candidate executed gaps, two frozen
  threshold failures, zero infrastructure failures, and 16/16 deterministic
  run-pair matches.
- The gate failure is evidence, not a harness failure. The CLI's intentional
  nonzero gate-fail path is distinct from an infrastructure/harness failure.
- `clean_starting_state`, database deltas, access deltas, full Git porcelain
  state, unsupported-argument attempts, retry state, authority evidence, and
  expansion observations are derived from runtime evidence. A missing
  measurement has an explicit unavailable/not-exercised state; it is not a
  synthetic zero or pass.
- Unsupported arguments are classified only from explicit JSON-RPC invalid
  parameter/schema evidence, whether returned as `isError` or thrown. Other
  product errors remain tool-response errors.
- A structured MCP tool envelope with `ok: false` is a product/tool-response
  error even when MCP itself returned `isError: false`. Arguments remain
  accepted, transport remains healthy, and that execution cannot pass merely
  because the frozen grader lacks a response predicate.
- A retry is counted only when an observed unsupported compact bootstrap is
  immediately followed by a fallback bootstrap. Ordinary repeat bootstraps,
  including pd-06, are not retries. The frozen retry limit is evaluated against
  the maximum retries in any one workflow, not the sum across workflows.
- Governing task claims are checked against `verification.adoption_status`.
  Missing verification for a governing claim is an authority violation.
- Expansion checks compare actual non-bootstrap calls with emitted expansion
  routes: availability, active profile, route tool, typed arguments, and scope.
  Contract metadata alone is not treated as observed behavior.
- The independent test-side verifier does not import the runner. It rebuilds
  UTF-8 byte counts, normalized envelopes, semantic/composite hashes, frozen
  grader verdicts, retries, aggregates, determinism, and Gate 4C from persisted
  raw evidence.
- pd-03 now seeds a valid deterministic cognitive event, epistemic revision,
  projection, and provenance row; failed seed/audit queries throw rather than
  manufacturing zero/clean evidence. In the current receipt, both pd-03
  `epistemic_get` and `epistemic_inspect` return `ok: true` for record 104.

## Historical-evidence preservation

The only immutable historical evidence is the original handoff pair:

- `phase-4c-receipt.pre-repair-20260912.json`
  (`9e0162c1cce9e857f20a1fe21ad31c47589b6d3f54f0aeaef215eca889429e01`)
- `phase-4c-comparison-report.pre-repair-20260912.md`
  (`c61e1d12c8488d837ca26f7d2517962e12e6a1b1b5466c8e3e2ba0da790a2333`)

Current aliases are not silently replaced: a rerun with existing aliases must
pass explicit `--replace-current`. The receipt records the fixed baseline pair
and hashes. No rolling, hash-named archive is created by repeated verification.

## Formal amendment proposal — operator decision required

These are proposals only. They must not be applied or rerun until operator
adoption.

### pd-01 ordinary restart

Observed: candidate reports `orientation.status: partial` and
`requires_expansion: true` without an adopted task state. This supports
considering those two expectation changes.

Do **not** add a `verify_authority` expansion predicate: the present public
receipt contains no expansion for record 101. First establish a justified
fixture/query/canonical-id reachability path, then observe it in a fresh public
MCP run. A `complete` claim without verified task state must remain a failing
counterexample.

### pd-02 valid manifest

Recommended path: provide a schema-valid signed `TaskStateManifestV1` and a
deterministic ephemeral test `OperatorTrustRuntime` through the supported
registration option. Use deterministic test-only keys; do not use real secrets.
Do not weaken this valid-manifest case into an unverified fallback case. Invalid
signature, authority ceiling mismatch, and unverified adoption must still fail.

### pd-03 fresh contradiction

Classify the discrepancy as a public-composition seam/product gap pending
separate design review, or narrow the contract without pretending it is
reachable. The projector reads warnings from `composed.task_state.packet.warnings`
and source labeling from internal
`trustedRoleContext.affected_contradiction_sources`; public MCP registration
supplies only `bootstrap_query`. Merely seeding a database event does not
demonstrate the required review state or expansion. Production behavior is not
changed here.

### pd-05 wrong project

Observed: `partial` orientation and `requires_expansion: true` coexist with
strict foreign/global isolation. Consider changing only the orientation
expectation while retaining the foreign/global exclusion and source-unavailable
stub assertions. Any foreign hydration or silent global widening remains a
failing counterexample.

### Frozen thresholds

The current results remain failed: small-case maximum growth is 19.32% against
10%, and median total context rises by 36.5 B. The receipt/report provide each
small case's percentage and absolute delta, the median, and total aggregate
delta. Do not choose a post-observation percentage, exclude real structural
framing bytes, or replace per-case protection solely with aggregate totals. A
replacement threshold needs a pre-registered framing-cost study and an explicit
operator decision before another run.

## Verification and next action

Run the specified acceptance commands against this worktree and report their
exact results in the coordinating review. The current gate remains FAIL by
design; `execution-complete` is not `gate-passed`.

Next action: Codex performs Gate 4C re-review. The operator then decides whether
to adopt, reject, or split the amendment proposal. No commit, push, contract
change, product change, or fresh comparison belongs to this handoff.
