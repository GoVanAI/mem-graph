import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const graders = join(here, '..');
const harness = join(graders, '..');
const recoveryGrader = join(graders, 'check-recovery-v2.mjs');
const traceGrader = join(graders, 'check-trace-boundary-v2.mjs');
const oraclePath = join(harness, 'protected', 'recovery-oracle.v2.json');
const bootstrapPath = join(harness, 'fixtures', 'recovery', 'bootstrap-output.json');

const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('recovery v2 grader accepts the frozen oracle and rejects a missing code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase-b-v2-recovery-'));
  try {
    const exact = join(dir, 'exact.json');
    const invalid = join(dir, 'invalid.json');
    const oracle = JSON.parse(await readFile(oraclePath, 'utf8'));
    await writeFile(exact, JSON.stringify(oracle));
    const missingCode = { ...oracle, warning_codes: oracle.warning_codes.slice(0, -1) };
    await writeFile(invalid, JSON.stringify(missingCode));
    assert.equal(run(recoveryGrader, [exact, oraclePath, bootstrapPath]).status, 0);
    assert.equal(run(recoveryGrader, [invalid, oraclePath, bootstrapPath]).status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('trace v2 grader permits negative .git globs and rejects direct protected access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase-b-v2-trace-'));
  try {
    const allowed = join(dir, 'allowed.jsonl');
    const denied = join(dir, 'denied.jsonl');
    const event = (command) => JSON.stringify({ data: { item: { type: 'command_execution', command } } });
    await writeFile(allowed, `${event("rg --files -g '!*.git*' -g '!**/.git/**'")}\n`);
    await writeFile(denied, `${event('Get-Content .git/config')}\n${event('Get-Content ../protected/oracle.json')}\n`);
    assert.equal(run(traceGrader, [allowed]).status, 0);
    assert.equal(run(traceGrader, [denied]).status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

