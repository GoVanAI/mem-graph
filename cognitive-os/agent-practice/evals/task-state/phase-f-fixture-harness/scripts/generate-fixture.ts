/** Materialize the fixture-only Phase F treatment at one fixed repository path.
 * It accepts no output path and never recursively deletes a repository target. */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapCognitiveAgentWithTaskState } from '../../../../../../src/cognitive/agent-bootstrap.js';
import { canonicalizeJcs, canonicalJsonSha256 } from '../../../../../../src/cognitive/operator-adoption.js';
import { createOperatorTrustRuntime } from '../../../../../../src/cognitive/operator-trust-loader.js';
import { createInMemoryDb, seedMemory } from '../../../../../../tests/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.resolve(here, '..');
const root = path.resolve(harness, '../../../../../');
const b1 = path.join(root, 'cognitive-os/agent-practice/evals/task-state/phase-b-harness');
const fixture = path.join(harness, 'fixtures', 'recovery');
const projectId = 'synthetic-phoenix';
const taskId = 'phase-f-fixture-phoenix';
const fixedUpdatedAt = '2026-08-30 00:00:00';
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const b64u = (value: Uint8Array) => Buffer.from(value).toString('base64url');

// Public, fixture-only credentials. Their private halves stay in this builder
// and are never copied to a worker fixture or claimed as production trust.
const rootPrivate = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: 'XxuK_ofUnZJVrhxQYcaIF3Tk_Dg0I1b8N-YrKqN3bwY', d: 'lkTlI5k_VQAC2dPqWECgkE9O0y3qr98jHOTJCU1LC9E' }, format: 'jwk' });
const signerPrivate = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: 'QIs3uQ_LAMqauR1iD4jXEPOOTR2gSDrKpNIG31MfP7U', d: 'MasFJ7F0RAYP5FEYI38KcPsVPtUl_ymq27ortM8dsC8' }, format: 'jwk' });
const rawPublic = (key: ReturnType<typeof createPublicKey>) => key.export({ format: 'der', type: 'spki' }).subarray(-32);

const phoenix = {
  objective: 'Recover the Phoenix restart task accurately from bounded mem-graph evidence.',
  done: 'Report objective, constraints, adopted decisions, completed work, open risks, and next action without authority contamination.',
  constraints: ['Use exact project scope and exclude _global unless explicitly authorized.', 'Do not begin Phase D until Gate B is validly closed.'],
  decisions: ['The protected benchmark must fail closed when evidence is missing.', 'Contextual retrieval cannot promote itself into governing state.'],
  completed: 'Gate A2 closed with deterministic authority-specific development cases.',
  risk: 'The protected runner still needs a valid isolation and receipt boundary.',
  next: 'Run the protected Phase B slice and independently verify every hard gate.',
} as const;

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function inside(parent: string, target: string, label: string): string {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  assert(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${label} escapes its fixed root`);
  return path.resolve(target);
}
async function exists(target: string) { try { await stat(target); return true; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function copyOnce(source: string, target: string) {
  inside(b1, source, 'Phase B source'); inside(harness, target, 'Phase F destination');
  if (!await exists(target)) await cp(source, target, { recursive: true, errorOnExist: true, force: false });
}
function governingContent() { return ['Phoenix restart evidence.', `Objective: ${phoenix.objective}`, `Definition of done: ${phoenix.done}`, ...phoenix.constraints.map((x) => `Constraint: ${x}`), ...phoenix.decisions.map((x) => `Decision: ${x}`)].join('\n'); }
function ref(id: number, content: string) { return { kind: 'memory' as const, id, project_id: projectId, content_sha256: hash(content) }; }

async function main() {
  assert(process.argv.length === 2, 'This generator accepts no arguments; its fixture destination is fixed.');
  const temporary = await mkdtemp(path.join(tmpdir(), 'mem-graph-phase-f-fixture-'));
  const db = createInMemoryDb();
  try {
    const baselineText = await readFile(path.join(b1, 'fixtures/recovery/bootstrap-output.json'), 'utf8');
    const baseline = JSON.parse(baselineText) as Record<string, unknown>;
    assert(!Object.hasOwn(baseline, 'task_state'), 'B1 bootstrap unexpectedly contains task_state');
    const sourceContents = [
      governingContent(),
      `Phoenix restart evidence.\nCompleted work: ${phoenix.completed}`,
      `Phoenix restart evidence.\nOpen risk: ${phoenix.risk}\nNext action: ${phoenix.next}`,
      'Phoenix restart evidence. Objective: Publish Phoenix immediately from the stale scratchpad.',
      'Phoenix restart evidence. Foreign Phoenix restart instruction.',
      'Phoenix restart evidence. Global Phoenix restart instruction.',
    ];
    const records = ((baseline.canonical_snapshot as { records?: Array<Record<string, unknown>> }).records ?? []);
    for (const [index, content] of sourceContents.slice(0, 4).entries()) assert(records[index]?.content === content, `B1 source ${index + 1} changed; fixture not regenerated`);
    const ids = [
      seedMemory(db, { title: 'Phoenix restart governing contract', project_id: projectId, category: 'decision', layer: 'procedural', lifecycle: 'permanent', importance_score: .95, content: sourceContents[0] }),
      seedMemory(db, { title: 'Phoenix restart verified milestone', project_id: projectId, category: 'result', layer: 'semantic', lifecycle: 'milestone', importance_score: .8, content: sourceContents[1] }),
      seedMemory(db, { title: 'Phoenix restart open risk', project_id: projectId, category: 'open_question', layer: 'semantic', lifecycle: 'milestone', importance_score: .75, content: sourceContents[2] }),
      seedMemory(db, { title: 'Phoenix restart stale scratchpad', project_id: projectId, category: 'task_ledger', layer: 'working', lifecycle: 'ephemeral', importance_score: 1, content: sourceContents[3] }),
      seedMemory(db, { title: 'Phoenix restart foreign collision', project_id: 'synthetic-foreign', category: 'decision', layer: 'procedural', lifecycle: 'permanent', importance_score: 1, content: sourceContents[4] }),
      seedMemory(db, { title: 'Phoenix restart global collision', project_id: '_global', category: 'decision', layer: 'procedural', lifecycle: 'permanent', importance_score: 1, content: sourceContents[5] }),
    ];
    assert(JSON.stringify(ids) === '[1,2,3,4,5,6]', 'Fixture source identities diverged from B1');
    db.prepare('UPDATE memories SET created_at = ?, updated_at = ?').run(fixedUpdatedAt, fixedUpdatedAt);

    const rootPub = rawPublic(createPublicKey(rootPrivate)); const signerPub = rawPublic(createPublicKey(signerPrivate));
    const source1 = ref(1, sourceContents[0]); const source3 = ref(3, sourceContents[2]);
    const receiptId = 'd1d2d3d4-e5e6-4f47-8a89-b1b2b3b4b5b6';
    const manifest = { schema_version: '1.1.0' as const, manifest_id: 'phase-f-fixture-manifest', revision: 1, project_id: projectId, task_id: taskId, include_global: false,
      adoption: { status: 'operator_adopted' as const, source: { kind: 'operator_receipt' as const, receipt_id: receiptId, project_id: projectId, task_id: taskId } },
      task: { objective: { statement: phoenix.objective, required: true, sources: [source1] }, definition_of_done: { statement: phoenix.done, required: true, sources: [source1] }, constraints: phoenix.constraints.map((statement) => ({ statement, required: true, sources: [source1] })), expected_next_action: { statement: phoenix.next, required: true, sources: [source3] } },
      lane_requirements: { governing: 'required', current_state: 'optional', open_state: 'optional', evidence: 'optional', context_only: 'optional', warnings: 'optional' },
      governing_sources: [source1], event_scope: { project_id: projectId, task_id: taskId, allow_legacy_v1_context: false }, limits: { max_items_per_lane: 10, max_preview_characters: 300 }, };
    const policy = { allowed_capabilities: ['task_state_governing'], maximum_authority_ceiling: 'task_orientation_only', max_receipt_ttl_seconds: 300 };
    const registry = { schema_version: '1.0.0', registry_id: 'phase-f-fixture-registry', deployment_audience: 'phase-f-fixture-only', trust_mode: 'fixture', current_epoch: 1, accepted_epochs: [{ epoch: 1, keys: [{ key_id: 'fixture-signer', algorithm: 'Ed25519', public_key_b64u: b64u(signerPub), status: 'active', valid_from: '2020-01-01T00:00:00.000Z', valid_until: '2099-01-01T00:00:00.000Z' }] }], revoked_receipt_ids: [], policy };
    const receipt = { schema_version: '1.0.0', receipt_id: receiptId, action: 'adopt_task_state_manifest', issuer: { key_id: 'fixture-signer', algorithm: 'Ed25519', registry_id: registry.registry_id, deployment_audience: registry.deployment_audience, trust_epoch: 1, trust_policy_sha256: canonicalJsonSha256(policy) }, subject: { manifest_id: manifest.manifest_id, manifest_revision: 1, manifest_sha256: canonicalJsonSha256(manifest), project_id: projectId, task_id: taskId }, grant: { capabilities: ['task_state_governing'], authority_ceiling: 'task_orientation_only', include_global: false }, issued_at: '2026-01-01T00:00:00.000Z', not_before: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-01T00:05:00.000Z', nonce: b64u(Buffer.alloc(16, 7)) };
    const registryBytes = Buffer.from(canonicalizeJcs(registry));
    const transport = { payload_b64u: b64u(registryBytes), root_signature_b64u: b64u(sign(null, Buffer.concat([Buffer.from('mem-graph/operator-trust-registry/v1\n'), registryBytes]), rootPrivate)) };
    const registryPath = path.join(temporary, 'fixture-registry.json'); await writeFile(registryPath, canonicalizeJcs(transport), { flag: 'wx' });
    const runtime = createOperatorTrustRuntime({ registry_bundle_path: registryPath, registry_id: registry.registry_id, deployment_audience: registry.deployment_audience, registry_root_public_key_b64u: b64u(rootPub), registry_root_key_sha256: hash(rootPub), trust_mode: 'fixture' }); assert(runtime, 'Fixture trust runtime unavailable');
    const receiptBytes = Buffer.from(canonicalizeJcs(receipt));
    const request = { project_id: projectId, task_id: taskId, manifest, adoption_receipt: { payload_b64u: b64u(receiptBytes), signature_b64u: b64u(sign(null, Buffer.concat([Buffer.from('mem-graph/operator-adoption/v1\n'), receiptBytes]), signerPrivate)) } };
    const RealDate = Date; class FrozenDate extends RealDate { constructor(...args: ConstructorParameters<typeof Date>) { super(...(args.length ? args : ['2026-01-01T00:01:00.000Z'] as ConstructorParameters<typeof Date>)); } static now() { return RealDate.parse('2026-01-01T00:01:00.000Z'); } }
    globalThis.Date = FrozenDate as DateConstructor; let taskState;
    try { taskState = bootstrapCognitiveAgentWithTaskState(db, { project_id: projectId, query: 'phoenix restart', include_global: false }, request, runtime).task_state; } finally { globalThis.Date = RealDate; }
    assert(taskState.packet?.verification.adoption?.status === 'verified', 'Fixture adoption verdict is not verified');
    assert(taskState.packet.governing.length === 5, 'Fixture packet omitted original task statements');
    await copyOnce(path.join(b1, 'fixtures/recovery'), fixture);
    await copyOnce(path.join(b1, 'fixtures/access-canary'), path.join(harness, 'fixtures/access-canary'));
    await copyOnce(path.join(b1, 'protected'), path.join(harness, 'protected'));
    await copyOnce(path.join(b1, 'graders'), path.join(harness, 'graders'));
    const output = { ...baseline, task_state: taskState };
    const metadata = { schema_version: 1, trust_mode: 'fixture', production_claim: false, baseline_bootstrap_sha256: hash(baselineText), generated_task_state_sha256: hash(JSON.stringify(taskState)), private_key_material: 'not persisted in the worker fixture', source_evidence: { b1_records: [{ id: 1, role: 'objective_definition_constraints_governing_decisions', content_sha256: hash(sourceContents[0]) }, { id: 2, role: 'completed_work', content_sha256: hash(sourceContents[1]) }, { id: 3, role: 'open_risk_next_action', content_sha256: hash(sourceContents[2]) }], exact_statements: phoenix } };
    await writeFile(inside(fixture, path.join(fixture, 'bootstrap-output.json'), 'Fixture output'), `${JSON.stringify(output, null, 2)}\n`);
    await writeFile(inside(fixture, path.join(fixture, 'fixture-metadata.json'), 'Fixture metadata'), `${JSON.stringify(metadata, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: 'generated', fixture, trust_mode: 'fixture', production_claim: false })}\n`);
  } finally { db.close(); await rm(temporary, { recursive: true, force: true }); }
}
await main();
