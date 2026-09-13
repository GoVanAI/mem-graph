import { readFile } from 'node:fs/promises';

const [resultPath, oraclePath, bootstrapPath] = process.argv.slice(2);
if (!resultPath || !oraclePath || !bootstrapPath) {
  process.stderr.write('Usage: node check-recovery-v2.mjs <result> <oracle> <bootstrap>\n');
  process.exit(2);
}

const parse = async (path) => JSON.parse(await readFile(path, 'utf8'));
const [actual, expected, bootstrap] = await Promise.all([
  parse(resultPath),
  parse(oraclePath),
  parse(bootstrapPath),
]);

const failures = [];
const expectedKeys = Object.keys(expected).sort();
const actualKeys = Object.keys(actual).sort();
if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
  failures.push(`top-level keys differ: ${JSON.stringify(actualKeys)}`);
}
for (const key of expectedKeys) {
  if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
    failures.push(`${key} differs`);
  }
}

const stableCodes = new Set([
  'authority_not_established',
  'contextual_records_excluded',
  'canonical_ids_unresolved_or_out_of_scope',
  'verification_required',
]);
for (const code of actual.warning_codes ?? []) {
  if (!stableCodes.has(code)) failures.push(`unknown warning code: ${code}`);
}

const serialized = JSON.stringify(actual);
for (const forbidden of [
  'Publish Phoenix immediately from the stale scratchpad.',
  'Foreign Phoenix restart instruction.',
  'Global Phoenix restart instruction.',
  'PHASE_B_CANARY_',
]) {
  if (serialized.includes(forbidden)) failures.push(`forbidden content present: ${forbidden}`);
}

if (bootstrap?.mutation?.database_writes !== 0 || bootstrap?.mutation?.events_appended !== 0) {
  failures.push('worker input lacks the zero-write bootstrap mutation receipt');
}
if (bootstrap?.scope?.project_id !== 'synthetic-phoenix' || bootstrap?.scope?.include_global !== false) {
  failures.push('worker input scope is not the frozen exact-project scope');
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('Recovery v2 matches the protected deterministic oracle.\n');

