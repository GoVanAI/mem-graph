import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gradeAgentPractice } from '../../../src/cognitive/agent-practice-eval.js';
import type { AgentPracticeTranscript } from '../../../src/cognitive/types.js';

const path = process.argv[2];
if (!path) {
  throw new Error('Usage: npx tsx grade-transcript.ts <transcript.json>');
}

const transcript = JSON.parse(readFileSync(resolve(path), 'utf8')) as AgentPracticeTranscript;
process.stdout.write(`${JSON.stringify(gradeAgentPractice(transcript), null, 2)}\n`);
