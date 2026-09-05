#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { bootstrapCognitiveAgentWithTaskState } from '../src/cognitive/agent-bootstrap.js';
import { createOperatorTrustRuntime } from '../src/cognitive/operator-trust-loader.js';
import { createInMemoryDb, seedMemory } from '../tests/helpers.js';

const [bundleArgument, activeRegistryPath, revokedRegistryPath] = process.argv.slice(2);
if (!bundleArgument || !activeRegistryPath || !revokedRegistryPath) throw new Error('usage: t4-live-operator-oracle.mjs <public-bundle> <protected-active-registry> <protected-revoked-registry>');
if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0) throw new Error('T4 production oracle requires a non-root Linux process.');

const bundleText = readFileSync(resolve(bundleArgument), 'utf8');
if (bundleText.length > 256 * 1024) throw new Error('public bundle exceeds bound');
const bundle = JSON.parse(bundleText);
assert.equal(bundle.bundle_version, '1.0.0');
assert.ok(Date.parse(bundle.expires_at) > Date.now(), 'operator receipt expired before the oracle began');

const forbiddenKey = /^(?:private[_-]?key|private[_-]?key[_-]?b64u|secret|seed)$/i;
const privateMarker = /-----BEGIN (?:ED25519 |EC |RSA |OPENSSH )?PRIVATE KEY-----/;
function assertPublicOnly(value, path = 'bundle') {
  if (typeof value === 'string') assert.equal(privateMarker.test(value), false, `private-key marker at ${path}`);
  else if (Array.isArray(value)) value.forEach((item, index) => assertPublicOnly(item, `${path}[${index}]`));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    assert.equal(forbiddenKey.test(key), false, `private-key field at ${path}.${key}`);
    assertPublicOnly(child, `${path}.${key}`);
  }
}
assertPublicOnly(bundle);
for (const value of Object.values(process.env)) if (typeof value === 'string') assert.equal(privateMarker.test(value), false, 'private key present in verifier environment');

const activeOnDisk = JSON.parse(readFileSync(resolve(activeRegistryPath), 'utf8'));
const revokedOnDisk = JSON.parse(readFileSync(resolve(revokedRegistryPath), 'utf8'));
assert.deepEqual(activeOnDisk, bundle.active_registry_transport);
assert.deepEqual(revokedOnDisk, bundle.revoked_registry_transport);

const activeRuntime = createOperatorTrustRuntime({ ...bundle.startup_public, registry_bundle_path: resolve(activeRegistryPath) });
const revokedRuntime = createOperatorTrustRuntime({ ...bundle.startup_public, registry_bundle_path: resolve(revokedRegistryPath) });
assert.ok(activeRuntime && revokedRuntime, 'production runtime did not initialize');

const db = createInMemoryDb();
const sourceId = seedMemory(db, { title: 'T4 disposable operator-presence source', content: 'The operator authorized execution of the frozen T4 oracle and no later phase.', project_id: 'cognitive-os', category: 'decision', layer: 'semantic' });
assert.equal(sourceId, 1);
const baseInput = { project_id: 'cognitive-os', query: 'T4 disposable operator presence', include_global: false };
const request = { project_id: 'cognitive-os', task_id: bundle.manifest.task_id, manifest: bundle.manifest, adoption_receipt: bundle.adoption_receipt };

function run(input = baseInput, taskState = request, runtime = activeRuntime) {
  return bootstrapCognitiveAgentWithTaskState(db, input, taskState, runtime).task_state;
}
function assertDenied(result, label, expectedCode) {
  assert.equal(result.status, 'assembled', `${label}: envelope status`);
  assert.deepEqual(result.packet?.governing, [], `${label}: governing must be empty`);
  assert.equal(result.packet?.verification.adoption?.status, 'unverified', `${label}: adoption status`);
  if (expectedCode) assert.ok(result.packet?.verification.adoption?.failure_codes.includes(expectedCode), `${label}: missing ${expectedCode}`);
}

const positive = run();
assert.equal(positive.status, 'assembled');
assert.equal(positive.packet?.verification.adoption?.status, 'verified');
assert.ok((positive.packet?.governing.length ?? 0) >= 4, 'exact manifest did not produce expected governing statements');
assert.ok(positive.packet?.governing.every((item) => item.source.kind === 'memory' && item.source.id === 1));

const mutatedManifest = structuredClone(bundle.manifest);
mutatedManifest.task.objective.statement += '!';
assertDenied(run(baseInput, { ...request, manifest: mutatedManifest }), 'one-byte manifest mutation', 'adoption_manifest_mismatch');
assertDenied(run({ ...baseInput, project_id: 'cognitive-os-substituted' }), 'project substitution', 'adoption_scope_mismatch');
assertDenied(run(baseInput, { ...request, task_id: `${request.task_id}-substituted` }), 'task substitution', 'adoption_scope_mismatch');

const RealDate = Date;
class ExpiredDate extends RealDate {
  constructor(...args) { super(...(args.length === 0 ? [bundle.expires_at] : args)); }
  static now() { return RealDate.parse(bundle.expires_at); }
}
globalThis.Date = ExpiredDate;
try { assertDenied(run(), 'receipt expiry', 'adoption_receipt_expired'); }
finally { globalThis.Date = RealDate; }

assertDenied(run(baseInput, request, revokedRuntime), 'receipt revocation', 'adoption_receipt_revoked');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
for (const { name } of tables) {
  const quoted = String(name).replaceAll('"', '""');
  const serialized = JSON.stringify(db.prepare(`SELECT * FROM "${quoted}"`).all());
  assert.equal(privateMarker.test(serialized), false, `private-key marker in disposable database table ${name}`);
}
db.close();

const scanRoots = ['src', 'tests', 'cognitive-os', 'docs', 'scripts'];
const textExtensions = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.yml', '.yaml']);
function scanRepository(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && ['node_modules', '.git', 'coverage', 'dist'].includes(entry.name)) continue;
    const target = join(path, entry.name);
    if (entry.isDirectory()) scanRepository(target);
    else if (textExtensions.has(extname(entry.name))) assert.equal(privateMarker.test(readFileSync(target, 'utf8')), false, `private-key marker in repository file ${target}`);
  }
}
for (const root of scanRoots) scanRepository(root);

process.stdout.write(`${JSON.stringify({
  gate: 'T4', status: 'passed', ceremony_id: bundle.ceremony_id,
  manifest_sha256: positive.packet.verification.adoption.manifest_sha256,
  positive_governing_count: positive.packet.governing.length,
  negatives: ['one-byte-manifest-mutation', 'project-substitution', 'task-substitution', 'expiry', 'revocation'],
  private_key_absence: ['public-bundle', 'verifier-environment', 'request', 'repository', 'fixtures', 'disposable-database'],
}, null, 2)}\n`);
