import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const grader = join(here, '..', 'check-trace-boundary-v3.mjs');
const run = (args) => spawnSync(process.execPath, [grader, ...args], { encoding: 'utf8' });
const event = (command) => JSON.stringify({ data: { item: { type: 'command_execution', command } } });

test('v3 permits a protected-named workspace and negative .git globs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase-b-v3-allowed-'));
  try {
    const workspace = 'C:\\evals\\restart-recovery-v3-protected__1\\workspace';
    const trace = join(dir, 'trace.jsonl');
    await writeFile(trace, [
      event(`Get-Content '${workspace}\\WORKER_CONTRACT_V2.md'`),
      event("rg --files -g '!*.git*' -g '!**/.git/**'"),
    ].join('\n'));
    assert.equal(run([trace, workspace]).status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('v3 rejects host skill and protected-oracle reads outside the workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase-b-v3-denied-'));
  try {
    const workspace = 'C:\\evals\\restart-recovery-v3-protected__1\\workspace';
    const trace = join(dir, 'trace.jsonl');
    await writeFile(trace, [
      event("Get-Content 'C:\\Users\\tester\\.codex\\skills\\turn-shape\\references\\acceptance-oracle.md'"),
      event("Get-Content '..\\..\\protected\\recovery-oracle.v2.json'"),
    ].join('\n'));
    assert.equal(run([trace, workspace]).status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

