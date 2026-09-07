# Progressive disclosure — Step 2A baseline

Status: contract and source-surface baseline. No consolidated MCP routes or
profiles are implemented here.

This directory freezes the measurement inputs and operation mapping used before
the 41-tool surface changes. It follows the everyday mental model:

1. **Orient**
2. **Find and inspect**
3. **Record and revise**
4. **Review and learn**

The proposed everyday surface contains nine typed routes. This is a design
mapping, not authority to register them. It preserves the important boundary
between ordinary memory editing, immutable epistemic revision, epistemic
receipts, and Cognitive OS event evidence.

## Artifacts

- `cases.json` contains the eight synthetic cases specified by Step 2. No live
  or personal database material is included. Their baseline traces are frozen
  expectations and deliberately marked `contract-only-not-executed`.
- `tool-mapping.json` maps every tool currently registered in `src/tools/*.ts`
  exactly once to an everyday, specialist, or legacy-only destination. It also
  records current inputs, scope, return shape, effects, fallback, and practice
  callers.
- `cases.schema.json` and `tool-mapping.schema.json` define the portable data
  contracts.
- `measure-step2a.mjs` validates those contracts, extracts the registration set
  from source, checks exact mapping coverage, and reports deterministic byte and
  count measurements to stdout.

## Run the oracle

From the repository root:

```powershell
node cognitive-os/agent-practice/evals/progressive-disclosure/measure-step2a.mjs
```

A pass requires:

- exactly the eight frozen case IDs;
- synthetic-only fixtures with no personal path/name marker;
- every live `server.tool` registration mapped exactly once;
- no mapped tool absent from source;
- all four workflows covered by the proposed 8–10 everyday routes;
- complete mapping fields and non-overlapping destination classification.

The measurement reports serialized UTF-8 bytes for fixture inputs and mapping
contracts, source registration-segment bytes, and expected legacy call counts.
It does **not** claim runtime response size, latency, provider token use, or agent
effectiveness. Those require the later disposable-database and optional provider
execution described in the working plan.

## Draft 2020-12 validation (separate step)

The custom oracle above is structural-only — it does not run a real JSON
Schema validator against the instance documents. Before declaring the
contract valid, run Draft 2020-12 validation separately:

```powershell
python scripts/validate-progressive-disclosure-schemas.py
```

This catches `additionalProperties` rejections and other structural
failures the custom oracle misses (notably: both schemas set
`additionalProperties: false` at the root and require an explicit
`$schema` property declaration, which the instance documents include
for editor and tool discovery).

## Scope and compatibility assumptions

The mapping records the currently proposed B+C hybrid without implementing it:

- the existing full surface remains a compatibility surface;
- the eventual agent surface is exact-project first and opts into `_global`;
- `_global` inclusion never means arbitrary foreign-project access;
- intentional cross-project wikilinks remain stored and appear as reference
  stubs until a deliberate target-project hydration;
- access-tracking reads are labeled rather than described as zero-write.

Any later source change that adds, removes, or renames a registered tool makes
this oracle fail until the mapping is consciously reconciled.
