#!/usr/bin/env node

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const receiptDomain = Buffer.from('mem-graph/operator-adoption/v1\n');
const registryDomain = Buffer.from('mem-graph/operator-trust-registry/v1\n');

function canonicalize(value, stack = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new Error('cyclic JSON');
    stack.add(value);
    const result = `[${value.map((item) => canonicalize(item, stack)).join(',')}]`;
    stack.delete(value);
    return result;
  }
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype || stack.has(value)) throw new Error('invalid JSON');
  stack.add(value);
  const result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], stack)}`).join(',')}}`;
  stack.delete(value);
  return result;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const b64u = (value) => Buffer.from(value).toString('base64url');
const rawPublic = (key) => key.export({ format: 'der', type: 'spki' }).subarray(-32);
const canonicalBytes = (value) => Buffer.from(canonicalize(value), 'utf8');
const iso = (milliseconds) => new Date(milliseconds).toISOString();

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('T4 signing requires a directly attended interactive terminal. Piped or redirected approval is refused.');
}

const outputArgument = process.argv[2];
if (!outputArgument || !isAbsolute(outputArgument)) throw new Error('Pass one absolute output path for the public signed bundle.');
const outputPath = resolve(outputArgument);
if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing output: ${outputPath}`);

const now = Date.now();
const receiptId = randomUUID();
const ceremonyId = randomUUID();
const taskId = 'trusted-operator-adoption-t4-disposable';
const source = { kind: 'memory', id: 1, project_id: 'cognitive-os' };
const receiptRef = { kind: 'operator_receipt', receipt_id: receiptId, project_id: 'cognitive-os', task_id: taskId };
const manifest = {
  schema_version: '1.1.0',
  manifest_id: `t4-disposable-${ceremonyId}`,
  revision: 1,
  project_id: 'cognitive-os',
  task_id: taskId,
  include_global: false,
  adoption: { status: 'operator_adopted', source: receiptRef },
  task: {
    objective: { statement: 'Verify one disposable live operator-adoption receipt through the frozen T4 oracle.', required: true, sources: [source] },
    definition_of_done: { statement: 'The exact manifest governs only while its receipt is fresh, correctly scoped, and not revoked; private key material remains outside mem-graph.', required: true, sources: [source] },
    constraints: [
      { statement: 'Do not authorize T5 or Phase F.', required: true, sources: [source] },
      { statement: 'Do not persist or expose either disposable private key.', required: true, sources: [source] },
    ],
    expected_next_action: { statement: 'Stop after reporting the T4 result.', required: true, sources: [source] },
  },
  lane_requirements: { governing: 'required', current_state: 'optional', open_state: 'optional', evidence: 'optional', context_only: 'optional', warnings: 'optional' },
  governing_sources: [source],
  event_scope: { project_id: 'cognitive-os', task_id: taskId, allow_legacy_v1_context: false },
  limits: { max_items_per_lane: 10, max_preview_characters: 300 },
};

const manifestSha256 = sha256(canonicalBytes(manifest));
const notBefore = iso(now);
const expiresAt = iso(now + 30 * 60 * 1000);
const registryId = `t4-disposable-${ceremonyId}`;
const audience = 'mem-graph-t4-live-oracle';
const policy = { allowed_capabilities: ['task_state_governing'], maximum_authority_ceiling: 'task_orientation_only', max_receipt_ttl_seconds: 1800 };

process.stdout.write(`\nT4 DISPOSABLE OPERATOR-ADOPTION CEREMONY\n\n`);
process.stdout.write(`Project: cognitive-os\nTask: ${taskId}\nManifest revision: 1\n`);
process.stdout.write(`Objective: ${manifest.task.objective.statement}\n`);
process.stdout.write(`Done: ${manifest.task.definition_of_done.statement}\n`);
for (const constraint of manifest.task.constraints) process.stdout.write(`Constraint: ${constraint.statement}\n`);
process.stdout.write(`Capability: task_state_governing\nAuthority ceiling: task_orientation_only\nInclude global: false\n`);
process.stdout.write(`Expires: ${expiresAt}\nManifest SHA-256: ${manifestSha256}\n\n`);
process.stdout.write('No private key will be written to disk or included in the public output.\n');

const challenge = `ADOPT ${manifestSha256}`;
const prompt = createInterface({ input: process.stdin, output: process.stdout });
const response = await prompt.question(`Type the complete confirmation below, or close the terminal to refuse:\n${challenge}\n> `);
prompt.close();
if (response !== challenge) throw new Error('Operator confirmation did not match; nothing was signed or written.');

const root = generateKeyPairSync('ed25519');
const signer = generateKeyPairSync('ed25519');
const signerPublic = rawPublic(signer.publicKey);
const rootPublic = rawPublic(root.publicKey);
const registryBase = {
  schema_version: '1.0.0', registry_id: registryId, deployment_audience: audience, trust_mode: 'production', current_epoch: 1,
  accepted_epochs: [{ epoch: 1, keys: [{ key_id: 't4-disposable-operator', algorithm: 'Ed25519', public_key_b64u: b64u(signerPublic), status: 'active', valid_from: iso(now - 60_000), valid_until: expiresAt }] }],
  revoked_receipt_ids: [], policy,
};
const receipt = {
  schema_version: '1.0.0', receipt_id: receiptId, action: 'adopt_task_state_manifest',
  issuer: { key_id: 't4-disposable-operator', algorithm: 'Ed25519', registry_id: registryId, deployment_audience: audience, trust_epoch: 1, trust_policy_sha256: sha256(canonicalBytes(policy)) },
  subject: { manifest_id: manifest.manifest_id, manifest_revision: 1, manifest_sha256: manifestSha256, project_id: 'cognitive-os', task_id: taskId },
  grant: { capabilities: ['task_state_governing'], authority_ceiling: 'task_orientation_only', include_global: false },
  issued_at: notBefore, not_before: notBefore, expires_at: expiresAt, nonce: b64u(randomBytes(16)),
};

function registryTransport(payload) {
  const bytes = canonicalBytes(payload);
  return { payload_b64u: b64u(bytes), root_signature_b64u: b64u(sign(null, Buffer.concat([registryDomain, bytes]), root.privateKey)) };
}
const receiptBytes = canonicalBytes(receipt);
const publicBundle = {
  bundle_version: '1.0.0', ceremony_id: ceremonyId, confirmed_at: iso(Date.now()), expires_at: expiresAt,
  operator_confirmation: { mode: 'direct_interactive_terminal', challenge_sha256: sha256(Buffer.from(challenge, 'utf8')) },
  manifest,
  adoption_receipt: { payload_b64u: b64u(receiptBytes), signature_b64u: b64u(sign(null, Buffer.concat([receiptDomain, receiptBytes]), signer.privateKey)) },
  active_registry_transport: registryTransport(registryBase),
  revoked_registry_transport: registryTransport({ ...registryBase, revoked_receipt_ids: [receiptId] }),
  startup_public: { registry_id: registryId, deployment_audience: audience, registry_root_public_key_b64u: b64u(rootPublic), registry_root_key_sha256: sha256(rootPublic), trust_mode: 'production' },
};

writeFileSync(outputPath, `${JSON.stringify(publicBundle, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
process.stdout.write(`\nPublic signed bundle written to: ${outputPath}\n`);
process.stdout.write(`Bundle SHA-256: ${sha256(Buffer.from(JSON.stringify(publicBundle, null, 2) + '\n', 'utf8'))}\n`);
process.stdout.write('The disposable private keys were never exported and will disappear when this process exits.\n');
