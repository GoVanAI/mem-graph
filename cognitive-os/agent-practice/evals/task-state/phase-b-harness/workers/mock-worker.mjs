import { writeFile } from 'node:fs/promises';

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

if (!prompt.includes('answer.txt') || !prompt.includes('PASS')) {
  process.stderr.write('Unexpected smoke-test prompt\n');
  process.exitCode = 2;
} else {
  await writeFile('answer.txt', 'PASS\n', 'utf8');
  process.stdout.write('Created the requested artifact.\n');
}
