# Epistemic Memory Phase 0 Implementation Report

**Date:** 2026-08-08  
**Repository base:** `7760781c2a0e5f00de32534670db180e0f79c262`  
**Status:** Implemented and verified as a dormant, side-effect-free kernel; recovered into the Phase A worktree on 2026-08-09  
**Runtime boundary:** Phase A authorizes recovery and public discovery only; no
epistemic MCP, persistence, event type, database schema, retrieval path,
scheduler, hook, or production alias is added

## Delivered surface

- strict v0.3 types and Zod schemas;
- semantic, closed-bundle, compact-prime, assessment, and synthesis validation;
- bounded deterministic compact-prime compilation with lifecycle, exact-scope,
  contradiction, question, action, relevance, recency, and externally verified
  authority components;
- deterministic assembly of explicitly supplied neutral synthesis semantics;
- clean-room fixtures for task resume, supersession, topic and project scope,
  and disputed hypotheses;
- v0.4 pure stale-belief projection with review deadlines, deliberate challenge
  receipts, explicit belief-use and linked outcome receipts, contradiction
  pressure, freshness/applicability decay, influence, review priority, and a
  deterministic worldview-review queue; and
- documentation and a pure barrel export at `src/epistemic/index.ts`.

## Safety properties verified

- Missing scope is unspecified rather than universal.
- Every compact-prime lane and synthesis citation is scope checked.
- Future record state and provenance fail closed.
- Compilation uses a closed relation catalog and rejects duplicate IDs.
- Authority fields are non-binding unless the caller supplies independently
  verified authority IDs.
- Review policies bind to one belief and its exact named scope.
- Retrieval and access counts never count as challenge or outcome evidence.
- Attributable outcomes must cite a matching same-belief, same-decision use
  receipt with the same decisive/supporting role.
- A decision cannot claim use ownership in multiple projects.
- Influence is derived only from explicit meaningful use/project breadth;
  risk and volatility contribute to a separate review-priority score.
- Contradiction and missed outcomes queue review without rewriting status,
  authority, or historical confidence.
- All projection and compilation inputs remain unmodified.

## Original Phase 0 verification evidence

- Focused epistemic suite: 5 files, 63 tests passed.
- Full repository suite: 20 files, 225 tests passed.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed; only repository line-ending notices were emitted.
- Frozen MVP-001 controlled harness: deterministic baseline and treatment,
  unchanged expected classifications. Baseline remains 31 pass, 3 coverage
  fail, 1 rank/contamination fail; treatment remains 32 pass and 3
  rank/contamination fail. The historical row-4 lexical ordering remains
  unchanged; no frozen fixture or matrix was modified.
- Read-only Terra adversarial review found no accidental MCP, SQLite, event,
  retrieval, policy-runtime, MVP-002, or MVP-003 integration. Its High findings
  were fixed and covered by regression tests before final verification.

## Phase A recovery verification

Current-main verification on 2026-08-09 established:

- all 13 recovered source, test, and fixture files match the Git blobs at source
  commit `0d52aaf` exactly;
- focused kernel and discovery suite: 6 files, 67 tests passed;
- full repository suite: 22 files, 236 tests passed;
- `npx tsc --noEmit`: passed;
- generated agent-practice adapter check: passed;
- frozen MVP-001 controlled harness: deterministic and unchanged at 31 pass,
  3 coverage fail, and 1 rank/contamination fail for baseline; 32 pass and 3
  rank/contamination fail for treatment;
- runtime-isolation audit: `src/index.ts`, `src/db.ts`, and `src/tools/` do not
  import the epistemic kernel;
- public-artifact portability audit: no personal absolute path, deployment-local
  numeric memory label, or numeric wikilink remains in the epistemic documents;
  and
- tracked-file `git diff --check`: passed, with only line-ending notices.

This evidence covers the Phase A worktree. It does not claim that the changes
have been committed, published, or integrated into the running MCP server.

## Recovery-source artifact hashes

```text
08b6d5fae153004fe510ccfeee5c904df5e4dc2f45586fab5b10cf34bc7038ef  src/epistemic/types.ts
5ccb955b5ce35ba072c8f9e93372b2e5449d5bb01ae59ec20e3157fc93a38637  src/epistemic/schema.ts
403fb2d5c845ca0e1785fd8a493f9d930e54c731ea975676557fd6176bb476ea  src/epistemic/validate.ts
9545a2870bad7aa0e013d90eb9346089de57b8acbe8eb507cfbc7231bb444ef7  src/epistemic/prime.ts
1d43538b69d2d9b0b5cb7dc77f682afcb4422a5a049afae7473dadc178734d59  src/epistemic/synthesize.ts
4e6ba66ccff099e6beac155abc576f0b859c72716637f41544f1a8d1db495a71  src/epistemic/maintenance.ts
78983358ca45cdb32dff22c11d06f889894cc941470aecc31c2c1865e22c1db6  src/epistemic/index.ts
bd9191ada2213d921ee1e8964422e2578f21c007fec352ee0e7e7d3158006384  tests/fixtures/epistemic/scenarios.json
```

These hashes identify the recovered code and synthetic fixture at source commit
`0d52aaf`. Public documentation was intentionally reconciled during Phase A to
remove deployment-local paths and IDs and to mark former milestone gates as
historical.

## Deliberately deferred

The kernel cannot establish that caller-supplied provenance, independence
keys, timestamps, or verified-authority sets are true in the outside world; it
can only validate their shape and internal consistency. Cross-project
`applies_to` authority, durable receipt admission, rebuildable projections,
automatic review scheduling, epistemic MCP tools, and production integration
require separate operator-adopted contracts.

Restarting the MCP server will load the separately implemented
`cognitive_current_guidance_diagnose` and policy correlation/causation support
already present in this worktree. The epistemic kernel intentionally has no
MCP registration yet, so restart does not turn the dormant Phase 0 code into a
runtime authority surface.
