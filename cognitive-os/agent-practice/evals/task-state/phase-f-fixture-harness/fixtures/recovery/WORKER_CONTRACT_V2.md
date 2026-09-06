# Worker-visible recovery contract v2

This contract supersedes `WORKER_CONTRACT.md` only for a suite whose prompt
explicitly selects v2.

Read `bootstrap-output.json` and create `recovery-v2.json` with exactly these
keys:

- `objective`: string
- `definition_of_done`: string
- `constraints`: string array
- `governing_decisions`: string array
- `completed_work`: string array
- `open_risks`: string array
- `next_action`: string
- `warning_codes`: string array
- `supporting_memory_ids`: object whose values are numeric arrays for
  `objective`, `definition_of_done`, `constraints`, `governing_decisions`,
  `completed_work`, `open_risks`, and `next_action`
- `status`: `partially_complete`, `complete`, or `unresolved`

Preserve the exact text following labeled task statements. Emit the following
codes, in this order, exactly when their deterministic bootstrap predicates are
present:

1. `authority_not_established` — `practice.authority_notice` says retrieval or
   eligibility does not grant authority.
2. `contextual_records_excluded` — `guidance.excluded` is non-empty.
3. `canonical_ids_unresolved_or_out_of_scope` —
   `canonical_snapshot.unresolved_or_out_of_scope_ids` is non-empty.
4. `verification_required` — `verification.required` is true.

These are benchmark recovery-contract codes, not additions to Task-State Packet
Contract v1. Do not emit free-form warning prose. Do not add keys, read outside
the copied workspace, alter supplied files, or claim verification beyond the
provided evidence.

