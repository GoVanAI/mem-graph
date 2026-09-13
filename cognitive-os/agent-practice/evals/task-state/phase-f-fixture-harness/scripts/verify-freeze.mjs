#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.resolve(here, '..');
const manifestPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(harness, 'freeze.manifest.v1.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function inside(root, target, label) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escapes root: ${target}`);
  return path.resolve(target);
}
async function digest(root, relative) {
  const target = inside(root, path.join(root, relative), 'frozen artifact');
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Frozen artifact must be a regular file: ${relative}`);
  return sha256(await readFile(target));
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.schema_version !== 1 || !manifest.artifacts || typeof manifest.artifacts !== 'object') throw new Error('Invalid Phase F freeze manifest');
const failures = [];
for (const [relative, expected] of Object.entries(manifest.artifacts)) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) { failures.push(`invalid digest: ${relative}`); continue; }
  try { const actual = await digest(harness, relative); if (actual !== expected) failures.push(`digest mismatch: ${relative}`); } catch (error) { failures.push(String(error)); }
}
for (const pair of manifest.equivalence ?? []) {
  try {
    const local = await digest(harness, pair.local);
    const sourceRoot = path.resolve(harness, pair.source_root);
    const expectedSourceRoot = path.resolve(harness, '../phase-b-harness');
    if (sourceRoot !== expectedSourceRoot) throw new Error(`unapproved equivalence source root: ${pair.source_root}`);
    const source = await digest(sourceRoot, pair.source);
    if (local !== source) failures.push(`copy differs from B1 source: ${pair.local}`);
  } catch (error) { failures.push(String(error)); }
}
if (failures.length) { process.stderr.write(`${failures.join('\n')}\n`); process.exit(1); }
process.stdout.write(JSON.stringify({ status: 'verified', manifest: manifestPath, artifacts: Object.keys(manifest.artifacts).length, equivalence: (manifest.equivalence ?? []).length }) + '\n');
