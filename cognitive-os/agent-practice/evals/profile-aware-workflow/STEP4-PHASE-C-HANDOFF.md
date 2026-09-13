# Step 4 Phase 4C — Corrected Execution and Amendment-Review Handoff

Status: **execution complete; Gate 4C PASS**

## Scope and protected surfaces

This is a scripted, deterministic evaluation of the operator-amended Phase 4A
contract. The amendments align pd-01 and pd-05 with the verified public-runtime
orientation invariant while preserving their scope and safety assertions.
It uses real in-process MCP `Client` → `InMemoryTransport` → `McpServer`
execution and isolated `mkdtempSync` SQLite directories. It does not measure
autonomous tool selection, LLM/provider effectiveness, or provider tokens.

Unchanged protected surfaces include `cases.schema.json`, `arm-grader.mjs`,
Step 3 artifacts, Git index, commits, and live databases. The bounded correction
changes `cases.json`, its representative fixtures, the compact authority notice,
the server-owned contradiction resolver/composition path, and focused unit and
evaluation tests. No threshold was weakened and the public MCP input schema was
not widened.

## Observed evidence

- The 32-execution matrix completed through the real MCP transport. The current
  receipt records `gate_passed: true`, zero executed gaps, zero
  threshold failures, zero infrastructure failures, and 16/16 deterministic
  run-pair matches. Control passes 8/8 and candidate passes 8/8.
- The CLI still preserves its intentional nonzero gate-fail path for any future
  executed gap, threshold failure, determinism mismatch, or infrastructure
  failure; the current execution satisfies the unchanged gate.
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
- The production bootstrap composition verifies the complete cognitive-event
  chain and resolves only current `ContradictionSignal` receipts whose
  epistemic record, event, and active source memory share the allowed scope and
  whose memory is present in the governing lane. Compact projection emits
  `explicit_contradiction_present`, marks only that memory for review, and
  routes expansion to the supporting epistemic record with no access touch.
  The MCP input schema exposes neither the trusted role context nor affected
  contradiction sources, so the caller cannot manufacture this result.

## Historical-evidence preservation

The only immutable historical evidence is the original handoff pair:

- `phase-4c-receipt.pre-repair-20260912.json`
  (`9e0162c1cce9e857f20a1fe21ad31c47589b6d3f54f0aeaef215eca889429e01`)
- `phase-4c-comparison-report.pre-repair-20260912.md`
  (`c61e1d12c8488d837ca26f7d2517962e12e6a1b1b5466c8e3e2ba0da790a2333`)

Current aliases are not silently replaced: a rerun with existing aliases must
pass explicit `--replace-current`. The receipt records the fixed baseline pair
and hashes. No rolling, hash-named archive is created by repeated verification.

## Adopted bounded corrections

### pd-01 ordinary restart

The contract now expects the observed `orientation.status: partial` and
`requires_expansion: true` when no adopted task state is available.

No `verify_authority` expansion predicate was added because the public receipt
contains no such expansion. A `complete` claim without verified task state
remains a failing counterexample. The case now executes-pass.

### pd-05 wrong project

The orientation predicates now expect `partial` and `requires_expansion: true`.
All strict foreign/global exclusion and source-unavailable stub assertions are
unchanged. The case now executes-pass.

### pd-02 valid manifest

Both arms now receive the same schema-valid, deterministically signed Contract
1.1 manifest through an ephemeral fixture-only `OperatorTrustRuntime`. The
runner mechanically proves that the contract request equals the generated
signed fixture. Compact bootstrap verifies adoption and every task source in
one call; the unrelated record-103 expansion was removed. The case now
executes-pass without real secrets.

### Compact byte thresholds

The thresholds remain exactly as frozen. The compact authority notice was
reduced from 337 to 113 UTF-8 bytes while retaining rank/inclusion non-authority,
role/adoption/scope/applicability/evidence verification, and read access-effect
warnings. Small-response maximum growth and median context bytes now pass.

### pd-03 fresh contradiction

The separately authorized composition seam is now implemented. Database
presence alone is insufficient: the evidence must pass the current-revision,
scope, active-memory, governing-lane, and complete-event-chain checks described
above. The case now executes-pass without widening the public MCP schema or
allowing caller-authored contradiction authority.

## Verification and next action

Run the specified acceptance commands against this worktree and report their
exact results in the coordinating review. The current deterministic evidence
supports Gate 4C PASS; completion still requires the repository-wide checks and
operator-controlled commit boundary.

## Independent Gate 4C review

Terra completed a read-only adversarial review after the final execution. Its
first pass identified a scope fail-open for epistemic records carrying
`scope = '_global'` with an exact-project `project_id`. The resolver was then
corrected to require both epistemic scope and project scope, and a production-DB
test now proves rejection without global opt-in and acceptance with explicit
opt-in. Terra's second pass verified the correction, all six receipt-bound
source hashes, the 32-execution matrix, and unchanged verifier state, and
returned Gate 4C PASS with no remaining blockers.
