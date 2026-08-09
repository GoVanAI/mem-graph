import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gradeAgentPractice } from '../../../src/cognitive/agent-practice-eval.js';
import type { AgentPracticeTranscript } from '../../../src/cognitive/types.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const transcriptPath = argument('--transcript');
const execute = process.argv.includes('--execute');
const configuredModel = argument('--model') ?? process.env.MEM_GRAPH_EVAL_MODEL;
if (!transcriptPath) {
  throw new Error(
    'Usage: npx tsx review-with-minimax.ts --transcript <path> [--model <model-id>] [--execute]',
  );
}
if (execute && !configuredModel) {
  throw new Error('--execute requires --model or MEM_GRAPH_EVAL_MODEL');
}
if (configuredModel && !/^[A-Za-z0-9._:-]+$/.test(configuredModel)) {
  throw new Error('Model ID contains unsupported characters');
}

const raw = readFileSync(resolve(transcriptPath), 'utf8');
if (
  /-----BEGIN [^-]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{16,}|\b(?:sk|api)[-_][A-Za-z0-9_-]{20,}/i.test(
    raw,
  )
) {
  throw new Error('Transcript appears to contain a secret; redact it before external review');
}

const transcript = JSON.parse(raw) as AgentPracticeTranscript;
const deterministic = gradeAgentPractice(transcript);
const messages = [
  {
    role: 'system',
    content:
      'You are an independent mem-graph practice auditor. Deterministic trace checks are immutable facts: do not rescore or override them. Assess only scope reasoning, uncertainty calibration, retrieval-versus-validation distinction, authority boundaries, contradiction preservation, and evidence-claim clarity. Return JSON only with keys qualitative_pass, dimensions, concerns, and recommendation.',
  },
  {
    role: 'user',
    content: JSON.stringify({ deterministic, transcript }),
  },
];
const model = configuredModel ?? '<set-with---model-or-MEM_GRAPH_EVAL_MODEL>';
const mmxArgs = [
  'text',
  'chat',
  '--model',
  model,
  '--messages-file',
  '<temporary-redacted-messages.json>',
  '--non-interactive',
  '--quiet',
  '--output',
  'json',
];

if (!execute) {
  process.stdout.write(
    `${JSON.stringify({ mode: 'dry_run', provider: 'minimax', model, mmx_args: mmxArgs, deterministic, messages }, null, 2)}\n`,
  );
  process.exit(0);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'mem-graph-eval-'));
const messagesPath = join(temporaryDirectory, 'messages.json');
try {
  writeFileSync(messagesPath, JSON.stringify(messages), { encoding: 'utf8', mode: 0o600 });
  const command = process.platform === 'win32' ? 'mmx.cmd' : 'mmx';
  const result = spawnSync(
    command,
    mmxArgs.map((value) =>
      value === '<temporary-redacted-messages.json>' ? messagesPath : value,
    ),
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `mmx exited with status ${result.status}`);
  }
  process.stdout.write(result.stdout);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
