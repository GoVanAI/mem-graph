# Task-State Packet Phase B protected slice

This suite separates the worker-visible recovery fixture from protected graders
and oracles. The raw runner results must be written outside the suite and remain
uncommitted.

Sequence:

1. Generate and verify the frozen B1 bootstrap fixture with
   `npx tsx scripts/generate-fixture.ts`.
2. Dry-run and execute `smoke-suite.json` with the skill-owned runner.
3. Dry-run and execute `preflight-suite.json` against Luna. Stop if the
   protected-path canary does not fail closed.
4. Dry-run and execute `suite.json` against Luna using an external results
   directory.
5. Independently inspect every result and hard gate before making a Gate B
   claim.

Passing the mock smoke proves runner wiring only. Passing the access preflight
proves only the tested workspace-write sandbox configuration denied the named
external canary. Passing the recovery matrix proves only the frozen synthetic
restart-recovery slice.

On Windows, use an Administrator PowerShell parent so the reviewer-only oracle
surface can be protected from the unelevated worker token:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-protected-phase-b.ps1
```

The wrapper verifies an inherited starting ACL, restricts `protected/` to
`SYSTEM` and `Administrators`, runs the negative-access suite, runs the protected
pilot only on preflight success, and restores the original inherited ACL in a
`finally` block. It writes an ignored elevated receipt under `results/`.
