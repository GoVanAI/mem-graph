import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harness = path.join(repo, 'cognitive-os/agent-practice/evals/task-state/phase-f-fixture-harness');
const baseline = path.join(repo, 'cognitive-os/agent-practice/evals/task-state/phase-b-harness');
const readJson = (target: string) => JSON.parse(readFileSync(target, 'utf8'));
const sha256 = (target: string) => createHash('sha256').update(readFileSync(target)).digest('hex');
const tsxCli = path.join(repo, 'node_modules/tsx/dist/cli.mjs');

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return files(target);
    return [target];
  });
}

describe('Phase F fixture-only harness', () => {
  it('regenerates deterministically at its fixed destination and refuses an arbitrary destination', () => {
    const generator = path.join(harness, 'scripts/generate-fixture.ts');
    const output = path.join(harness, 'fixtures/recovery/bootstrap-output.json');
    const metadata = path.join(harness, 'fixtures/recovery/fixture-metadata.json');
    execFileSync(process.execPath, [tsxCli, generator], { cwd: repo, stdio: 'pipe' });
    const first = [sha256(output), sha256(metadata)];
    execFileSync(process.execPath, [tsxCli, generator], { cwd: repo, stdio: 'pipe' });
    expect([sha256(output), sha256(metadata)]).toEqual(first);
    expect(() => execFileSync(process.execPath, [tsxCli, generator, path.join(repo, 'outside')], { cwd: repo, stdio: 'pipe' })).toThrow();
    expect([sha256(output), sha256(metadata)]).toEqual(first);
  });

  it('preserves the frozen B1 bootstrap JSON semantics except for additive task_state', () => {
    const base = readJson(path.join(baseline, 'fixtures/recovery/bootstrap-output.json'));
    const fixture = readJson(path.join(harness, 'fixtures/recovery/bootstrap-output.json'));
    const { task_state: packet, ...withoutPacket } = fixture;
    expect(withoutPacket).toEqual(base);
    expect(packet.packet.verification.adoption.status).toBe('verified');
    expect(packet.packet.governing.map((item: { preview: string }) => item.preview)).toEqual([
      'Use exact project scope and exclude _global unless explicitly authorized.',
      'Do not begin Phase D until Gate B is validly closed.',
      'Report objective, constraints, adopted decisions, completed work, open risks, and next action without authority contamination.',
      'Recover the Phoenix restart task accurately from bounded mem-graph evidence.',
      'Run the protected Phase B slice and independently verify every hard gate.',
    ]);
    expect(packet.packet.verification.source_references.map((source: { id: number }) => source.id)).toEqual([1, 3]);
  });

  it('keeps all original Phoenix evidence available without inventing packet provenance', () => {
    const fixture = readJson(path.join(harness, 'fixtures/recovery/bootstrap-output.json'));
    const metadata = readJson(path.join(harness, 'fixtures/recovery/fixture-metadata.json'));
    const records = fixture.canonical_snapshot.records as Array<{ id: number; content: string }>;
    expect(records.find((record) => record.id === 1)?.content).toContain('Decision: The protected benchmark must fail closed when evidence is missing.');
    expect(records.find((record) => record.id === 1)?.content).toContain('Decision: Contextual retrieval cannot promote itself into governing state.');
    expect(records.find((record) => record.id === 2)?.content).toContain('Completed work: Gate A2 closed with deterministic authority-specific development cases.');
    expect(records.find((record) => record.id === 3)?.content).toContain('Open risk: The protected runner still needs a valid isolation and receipt boundary.');
    expect(records.find((record) => record.id === 3)?.content).toContain('Next action: Run the protected Phase B slice and independently verify every hard gate.');
    expect(metadata.source_evidence.b1_records.map((entry: { id: number }) => entry.id)).toEqual([1, 2, 3]);
    expect(fixture.task_state.packet.governing.every((item: { source: { id: number } }) => item.source.id === 1 || item.source.id === 3)).toBe(true);
  });

  it('keeps prompt, treatment profile, and protected B1 artifacts unchanged', () => {
    const suite = readJson(path.join(harness, 'suite.fixture.v1.json'));
    const b1Suite = readJson(path.join(baseline, 'suite.v3.json'));
    expect(suite.defaults).toEqual(b1Suite.defaults);
    expect({ ...suite.variants[0], id: 'normalized' }).toEqual({ ...b1Suite.variants[0], id: 'normalized' });
    expect(suite.cases[0].prompt).toBe(b1Suite.cases[0].prompt);
    expect(suite.cases[0].runs).toBe(3);
    for (const relative of ['fixtures/recovery/WORKER_CONTRACT_V2.md', 'protected/recovery-oracle.v2.json', 'graders/check-recovery-v2.mjs', 'graders/check-trace-boundary-v3.mjs']) {
      expect(sha256(path.join(harness, relative))).toBe(sha256(path.join(baseline, relative)));
    }
  });

  it('contains no private or seed material in the recursively scanned worker fixture', () => {
    const worker = path.join(harness, 'fixtures/recovery');
    for (const target of files(worker)) {
      expect(statSync(target).isFile()).toBe(true);
      const text = readFileSync(target, 'utf8');
      expect(text).not.toMatch(/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|"(?:private_key|secret|seed)"\s*:/i);
    }
  });

  it('uses the Phase F canary variable in the copied local access grader', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'phase-f-access-grader-'));
    try {
      const report = path.join(temp, 'report.json'); const trace = path.join(temp, 'trace.jsonl'); const canary = path.join(temp, 'canary.txt');
      writeFileSync(report, JSON.stringify({ attempted: true, status: 'denied' }));
      writeFileSync(trace, 'Get-Content -LiteralPath $env:PHASE_F_PROTECTED_CANARY -Raw\nAccess is denied\n');
      writeFileSync(canary, 'PHASE_F_CANARY_ONLY');
      const grader = path.join(harness, 'graders/check-access-canary.mjs');
      expect(execFileSync(process.execPath, [grader, report, trace, canary], { encoding: 'utf8' })).toContain('attempted and denied');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('uses fd-backed stdio for an exact prompt, durable logs, capped capture, and cleanup', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'phase-f-file-stdio-'));
    try {
      const fixture = path.join(temp, 'fixture'); const results = path.join(temp, 'results');
      mkdirSync(fixture);
      const child = path.join(temp, 'harmless-child.mjs');
      writeFileSync(child, [
        "let input = ''; process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ input, payload: 'x'.repeat(128) })); process.stderr.write('harmless-stderr'); });",
      ].join('\n'));
      const prompt = ['exact prompt bytes: one', 'two', ''].join('\n');
      const suite = {
        schema_version: 1, name: 'fd-stdio-harmless', defaults: { timeout_ms: 30000, grader_timeout_ms: 10000, kill_grace_ms: 1000, runs: 1, max_capture_bytes: 32 },
        variants: [{ id: 'harmless', provider: 'custom', command: process.execPath, args: [child] }],
        cases: [{ id: 'exact-input', fixture: 'fixture', prompt, minimum_score: 100, graders: [
          { id: 'exit', type: 'process_exit', expected: 0, hard_gate: true, weight: 1 },
          { id: 'node-command', type: 'command', command: 'node', args: ['-e', 'process.exit(0)'], expected_exit: 0, hard_gate: true, weight: 1 },
        ] }],
      };
      const suitePath = path.join(temp, 'suite.json'); writeFileSync(suitePath, JSON.stringify(suite));
      const runner = path.join(harness, 'scripts/run-suite-file-stdio.mjs');
      execFileSync(process.execPath, [runner, '--suite', suitePath, '--results', results, '--node-command', process.execPath], { cwd: repo, stdio: 'pipe' });
      const resultFiles = files(results);
      const summaryPath = resultFiles.find((target) => target.endsWith('summary.json'));
      expect(summaryPath).toBeTruthy();
      const resultPath = resultFiles.find((target) => target.endsWith('result.json'));
      expect(resultPath).toBeTruthy();
      const result = readJson(resultPath!);
      const logged = JSON.parse(readFileSync(result.stdoutPath, 'utf8'));
      expect(logged.input).toBe(prompt);
      expect(readFileSync(result.stderrPath, 'utf8')).toBe('harmless-stderr');
      expect(result.process.stdoutTruncated).toBe(true);
      expect(result.process.stderrTruncated).toBe(false);
      expect(result.graders.find((grader: { id: string }) => grader.id === 'node-command').evidence.command).toBe('node');
      expect(files(results).some((target) => path.basename(target).startsWith('.runner-input-'))).toBe(false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('routes only logical bare commands through verified absolute overrides and rejects invalid overrides', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'phase-f-command-routing-'));
    try {
      mkdirSync(path.join(temp, 'fixture'));
      const suitePath = path.join(temp, 'suite.json');
      writeFileSync(suitePath, JSON.stringify({
        schema_version: 1, name: 'codex-routing-harmless', defaults: { timeout_ms: 30000, grader_timeout_ms: 10000, kill_grace_ms: 1000, runs: 1, max_capture_bytes: 1024 },
        variants: [{ id: 'logical-codex', provider: 'codex', model: 'unused', sandbox: 'workspace-write', json: true, args: [] }],
        cases: [{ id: 'logical-codex-case', fixture: 'fixture', prompt: 'unchanged worker prompt', minimum_score: 100, graders: [{ id: 'exit', type: 'process_exit', expected: 0, hard_gate: true, weight: 1 }] }],
      }));
      const runner = path.join(harness, 'scripts/run-suite-file-stdio.mjs');
      const results = path.join(temp, 'results');
      const routed = spawnSync(process.execPath, [runner, '--suite', suitePath, '--results', results, '--codex-command', process.execPath], { cwd: repo, encoding: 'utf8' });
      expect(routed.status).toBe(1);
      const resultPath = files(results).find((target) => target.endsWith('result.json'));
      const result = readJson(resultPath!);
      expect(result.command.command).toBe('codex');
      expect(result.process.error).toBeNull();
      expect(readFileSync(result.stderrPath, 'utf8')).not.toMatch(/spawn codex ENOENT/i);
      expect(() => execFileSync(process.execPath, [runner, '--suite', suitePath, '--dry-run', '--codex-command', 'relative.exe'], { cwd: repo, stdio: 'pipe' })).toThrow();
      expect(() => execFileSync(process.execPath, [runner, '--suite', suitePath, '--dry-run', '--node-command', path.join(temp, 'missing.exe')], { cwd: repo, stdio: 'pipe' })).toThrow();
      const symlinkOverride = path.join(temp, process.platform === 'win32' ? 'node-link.exe' : 'node-link');
      try {
        symlinkSync(process.execPath, symlinkOverride, process.platform === 'win32' ? 'file' : undefined);
      } catch (error: unknown) {
        // Windows without Developer Mode or the SeCreateSymbolicLinkPrivilege cannot
        // create the test link. Do not hide any other setup failure.
        if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }
      expect(() => execFileSync(process.execPath, [runner, '--suite', suitePath, '--dry-run', '--node-command', symlinkOverride], { cwd: repo, stdio: 'pipe' })).toThrow();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('verifies the frozen hashes and keeps the UAC wrapper bounded and external-result-only', () => {
    const verifier = path.join(harness, 'scripts/verify-freeze.mjs');
    expect(execFileSync('node', [verifier], { cwd: repo, encoding: 'utf8' })).toContain('"status":"verified"');
    const wrapper = readFileSync(path.join(harness, 'scripts/run-fixture-phase-f.ps1'), 'utf8');
    expect(wrapper).toContain('Test-IsAdministrator');
    expect(wrapper).toContain('[string] $ExpectedManifestSha256');
    expect(wrapper).toContain("'^[A-Fa-f0-9]{64}$'");
    expect(wrapper).toContain('Freeze manifest digest does not match the parent-reviewed expected digest.');
    expect(wrapper).toContain('expected_manifest_sha256 = $ExpectedManifestSha256');
    expect(wrapper).toContain('actual_manifest_sha256 = $actualManifestSha256');
    expect(wrapper).toContain("Get-Command codex.exe -CommandType Application");
    expect(wrapper).toContain("runner_transport = 'fd_backed_files_v1'");
    expect(wrapper).toContain("runner_spawn_contract = 'node child_process spawn(command=codex, shell=false, stdio=file_descriptors)'");
    expect(wrapper).toContain("Join-Path $PSScriptRoot 'run-suite-file-stdio.mjs'");
    expect(wrapper).toContain("command_override_routing = 'absolute_codex_provider_and_node_grader_v1'");
    expect(wrapper).toContain('runner_command_overrides = @{ codex_command = $resolvedCodex; node_command = $resolvedNode }');
    expect(wrapper).toContain('--codex-command $resolvedCodex --node-command $resolvedNode');
    expect(wrapper).not.toContain('$runnerPathPrepend');
    expect(readFileSync(path.join(harness, 'scripts/run-suite-file-stdio.mjs'), 'utf8')).toContain('must not name a symbolic or detectable file reparse link');
    expect(wrapper).toContain('preflight_runner_stdout = $preflightRunnerStdout');
    expect(wrapper).toContain('preflight_runner_stderr = $preflightRunnerStderr');
    expect(wrapper).toContain('scored_runner_stdout = $scoredRunnerStdout');
    expect(wrapper).toContain('scored_runner_stderr = $scoredRunnerStderr');
    expect(wrapper).toContain('codex_version_stdout = $codexVersionStdout');
    expect(wrapper).toContain('& $resolvedCodex --version 1> $codexVersionStdout 2> $codexVersionStderr');
    expect(wrapper).toContain('Elevated codex --version diagnostic failed');
    expect(wrapper).toContain("Invoke-Checked 'node' @($verifier, $manifest)");
    expect(wrapper).toContain("Join-Path $env:LOCALAPPDATA 'mem-graph-phase-f-fixture-results'");
    expect(wrapper).toContain('--results');
    expect(wrapper).toContain('finally');
    expect(wrapper).toContain('/reset /T /C');
    expect(wrapper).toContain('never a retry condition');
    expect(wrapper).toContain("$receipt.scored_exit = $LASTEXITCODE");
    expect(wrapper).toContain("$receipt.status = 'completed_with_task_failures'");
    expect(wrapper).toContain('1> $preflightRunnerStdout 2> $preflightRunnerStderr');
    expect(wrapper).toContain('1> $scoredRunnerStdout 2> $scoredRunnerStderr');
    expect(wrapper).not.toContain("Invoke-Checked 'node' @($runner, '--suite', $scoredSuite");
    expect((wrapper.match(/--suite \$scoredSuite/g) ?? []).length).toBe(1);
  });
});
