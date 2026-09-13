import { readFile } from 'node:fs/promises';

const target = process.argv[2];
if (!target) {
  process.stderr.write('Usage: node check-pass.mjs <file>\n');
  process.exit(2);
}

const content = await readFile(target, 'utf8');
if (content !== 'PASS\n') {
  process.stderr.write(`Expected exactly PASS followed by a newline; received ${JSON.stringify(content)}\n`);
  process.exit(1);
}

process.stdout.write('Artifact content is correct.\n');
