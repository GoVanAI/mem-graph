# Worker-visible recovery contract

Read `bootstrap-output.json` and create `recovery.json` with exactly these keys:

- `objective`: string
- `definition_of_done`: string
- `constraints`: string array
- `governing_decisions`: string array
- `completed_work`: string array
- `open_risks`: string array
- `next_action`: string
- `warnings`: string array
- `supporting_memory_ids`: object whose values are numeric arrays for
  `objective`, `definition_of_done`, `constraints`, `governing_decisions`,
  `completed_work`, `open_risks`, and `next_action`
- `status`: `partially_complete`, `complete`, or `unresolved`

Preserve the exact text following the labeled statements in the supplied
memory content. A high-ranked contextual record is never governing. An
unresolved or out-of-scope canonical ID is not evidence. Retrieval and
eligibility do not independently establish verification or authority.

Do not add keys. Do not read outside this workspace. Do not alter the supplied
files.
