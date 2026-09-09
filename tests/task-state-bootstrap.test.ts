import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendCognitiveEvent } from '../src/cognitive/events.js';
import { bootstrapCognitiveAgent, bootstrapCognitiveAgentWithTaskState } from '../src/cognitive/agent-bootstrap.js';
import * as agentBootstrapModule from '../src/cognitive/agent-bootstrap.js';
import { initDatabase, closeAllDatabases, getDatabase } from '../src/db.js';
import { admitEpistemicRecord } from '../src/epistemic/persistence.js';
import { registerCognitiveTools } from '../src/tools/cognitive.js';
import { canonicalJson } from '../src/cognitive/bootstrap-disclosure.js';
import * as bootstrapDisclosureModule from '../src/cognitive/bootstrap-disclosure.js';
import { registerSqlTools } from '../src/tools/sql.js';
import { registerMemoryOrientTools } from '../src/tools/memory-orient.js';
import { registerMemorySearchTools } from '../src/tools/memory-search.js';
import { registerMemoryWriteTools } from '../src/tools/memory-write.js';
import { registerMemoryTagTools } from '../src/tools/memory-tags.js';
import { registerMemoryGraphTools } from '../src/tools/memory-graph.js';
import { registerMemoryImportTools } from '../src/tools/memory-import.js';
import { registerEpistemicTools } from '../src/tools/epistemic.js';
import { canonicalizeJcs, canonicalJsonSha256 } from '../src/cognitive/operator-adoption.js';
import { createOperatorTrustRuntime } from '../src/cognitive/operator-trust-loader.js';
import { validateTaskStateManifest } from '../src/cognitive/task-state-manifest.js';
import { seedMemory } from './helpers.js';

type ToolEntry = { cb: (input: unknown) => Promise<{ content: Array<{ text: string }> }> };

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ref = { kind: 'memory', id: 1, project_id: 'project-a' };
  return {
    schema_version: '1.0.0', manifest_id: 'task-manifest-a', revision: 1,
    project_id: 'project-a', task_id: 'task-a',
    adoption: { status: 'operator_adopted', source: ref },
    task: {
      objective: { statement: 'Return a bounded packet.', required: true, sources: [ref] },
      definition_of_done: { statement: 'Packet is source-backed.', required: true, sources: [ref] },
      constraints: [],
    },
    lane_requirements: { governing: 'optional', current_state: 'optional', open_state: 'optional', evidence: 'optional', context_only: 'optional', warnings: 'optional' },
    event_scope: { project_id: 'project-a', task_id: 'task-a', allow_legacy_v1_context: false },
    limits: { max_items_per_lane: 10, max_preview_characters: 200 },
    ...overrides,
  };
}

function snapshot(db: ReturnType<typeof getDatabase>): Record<string, string[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name, (db.prepare(`SELECT * FROM \"${name.replaceAll('\"', '\"\"')}\"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort()]));
}

function fakeServer(): { tools: Map<string, ToolEntry>; server: McpServer } {
  const tools = new Map<string, ToolEntry>();
  const server = { tool: (name: string, _description: string, _schema: unknown, cb: ToolEntry['cb']) => tools.set(name, { cb }) } as unknown as McpServer;
  return { tools, server };
}

function signedFixture(options: { name: string; manifest_global?: boolean; signed_global?: boolean; global_source?: boolean; malformed_receipt?: boolean }): { runtime: NonNullable<ReturnType<typeof createOperatorTrustRuntime>>; request: NonNullable<Parameters<typeof bootstrapCognitiveAgentWithTaskState>[2]> } {
  const root = generateKeyPairSync('ed25519'); const signer = generateKeyPairSync('ed25519');
  const raw = (key: typeof root.publicKey) => key.export({ format: 'der', type: 'spki' }).subarray(-32); const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
  const receiptRef = { kind: 'operator_receipt' as const, receipt_id: 'b1b2b3b4-c5c6-4d47-8e89-a1b2c3d4e5f6', project_id: 'project-a', task_id: 'task-a' };
  const base = manifest(); const globalRef = { kind: 'memory' as const, id: 2, project_id: '_global' };
  const signedManifest = manifest({ schema_version: '1.1.0', include_global: options.manifest_global === true, adoption: { status: 'operator_adopted', source: receiptRef }, ...(options.global_source ? { task: { ...(base.task as object), objective: { statement: 'Global source.', required: true, sources: [globalRef] } } } : {}) });
  const policy = { allowed_capabilities: ['task_state_governing'], maximum_authority_ceiling: 'task_orientation_only', max_receipt_ttl_seconds: 3_000_000_000 };
  const registry = { schema_version: '1.0.0', registry_id: 'registry-a', deployment_audience: 'fixture-audience', trust_mode: 'fixture', current_epoch: 1, accepted_epochs: [{ epoch: 1, keys: [{ key_id: 'operator', algorithm: 'Ed25519', public_key_b64u: b64u(raw(signer.publicKey)), status: 'active', valid_from: '2020-01-01T00:00:00.000Z' }] }], revoked_receipt_ids: [], policy };
  const receipt = { schema_version: '1.0.0', receipt_id: receiptRef.receipt_id, action: 'adopt_task_state_manifest', issuer: { key_id: 'operator', algorithm: 'Ed25519', registry_id: 'registry-a', deployment_audience: 'fixture-audience', trust_epoch: 1, trust_policy_sha256: canonicalJsonSha256(policy) }, subject: { manifest_id: signedManifest.manifest_id, manifest_revision: signedManifest.revision, manifest_sha256: canonicalJsonSha256(signedManifest), project_id: 'project-a', task_id: 'task-a' }, grant: { capabilities: ['task_state_governing'], authority_ceiling: 'task_orientation_only', include_global: options.signed_global === true }, issued_at: '2020-01-01T00:00:00.000Z', not_before: '2020-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', nonce: b64u(Buffer.alloc(16, 1)) };
  const registryPayload = Buffer.from(canonicalizeJcs(registry)); const receiptPayload = Buffer.from(canonicalizeJcs(receipt));
  const transport = { payload_b64u: b64u(registryPayload), root_signature_b64u: b64u(sign(null, Buffer.concat([Buffer.from('mem-graph/operator-trust-registry/v1\n'), registryPayload]), root.privateKey)) };
  const path = join(tempDir, `fixture-registry-${options.name}.json`); writeFileSync(path, canonicalizeJcs(transport)); const rootRaw = raw(root.publicKey);
  const runtime = createOperatorTrustRuntime({ registry_bundle_path: path, registry_id: 'registry-a', deployment_audience: 'fixture-audience', registry_root_public_key_b64u: b64u(rootRaw), registry_root_key_sha256: createHash('sha256').update(rootRaw).digest('hex'), trust_mode: 'fixture' });
  const signedReceipt = { payload_b64u: b64u(receiptPayload), signature_b64u: b64u(sign(null, Buffer.concat([Buffer.from('mem-graph/operator-adoption/v1\n'), receiptPayload]), signer.privateKey)) };
  return { runtime: runtime!, request: { project_id: 'project-a', task_id: 'task-a', manifest: signedManifest, adoption_receipt: options.malformed_receipt ? { ...signedReceipt, payload_b64u: 'AQ==' } : signedReceipt } as unknown as NonNullable<Parameters<typeof bootstrapCognitiveAgentWithTaskState>[2]> };
}

let tempDir = '';
let priorDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'task-state-bootstrap-'));
  priorDir = process.env.MEM_GRAPH_DIR;
  process.env.MEM_GRAPH_DIR = tempDir;
  initDatabase('memory');
  seedMemory(getDatabase('memory'), { title: 'Adoption candidate', content: 'Operator-looking text is not trusted.', project_id: 'project-a', category: 'decision', layer: 'semantic' });
});

afterEach(() => {
  closeAllDatabases();
  rmSync(tempDir, { recursive: true, force: true });
  if (priorDir === undefined) delete process.env.MEM_GRAPH_DIR;
  else process.env.MEM_GRAPH_DIR = priorDir;
});

describe('Option 1 task-state bootstrap integration', () => {
  it('preserves the exact legacy result and digest when task state is absent', () => {
    const db = getDatabase('memory');
    const input = { project_id: 'project-a', query: 'packet' };
    const before = bootstrapCognitiveAgent(db, input);
    const after = bootstrapCognitiveAgent(db, input);
    expect(after).toEqual(before);
    expect('task_state' in after).toBe(false);
    expect(after.bootstrap_digest).toBe(before.bootstrap_digest);
  });

  it('preserves the exact legacy result through the public handler when task state is absent', async () => {
    const { tools, server } = fakeServer();
    registerCognitiveTools(server);
    const input = { project_id: 'project-a', query: 'packet' };
    const result = JSON.parse((await tools.get('cognitive_agent_bootstrap')!.cb(input)).content[0].text);
    expect(result).toEqual(bootstrapCognitiveAgent(getDatabase('memory'), input));
    expect('task_state' in result).toBe(false);
  });

  it('keeps omitted and explicit legacy responses byte-identical to the direct composer', async () => {
    const { tools, server } = fakeServer();
    registerCognitiveTools(server);
    const input = { project_id: 'project-a', query: 'packet' };
    const omitted = await tools.get('cognitive_agent_bootstrap')!.cb(input);
    const explicit = await tools.get('cognitive_agent_bootstrap')!.cb({ ...input, response_mode: 'legacy' });
    const direct = bootstrapCognitiveAgent(getDatabase('memory'), input);
    expect(JSON.parse(omitted.content[0].text)).toEqual(direct);
    expect(JSON.parse(explicit.content[0].text)).toEqual(direct);
    expect(explicit.content[0].text).toBe(omitted.content[0].text);
    expect(JSON.parse(explicit.content[0].text).bootstrap_digest).toBe(direct.bootstrap_digest);
  });

  it('composes once, projects once, and returns the canonical compact wire without writes', async () => {
    const { tools, server } = fakeServer();
    registerCognitiveTools(server);
    const db = getDatabase('memory');
    const before = snapshot(db);
    const composeSpy = vi.spyOn(agentBootstrapModule, 'bootstrapCognitiveAgent');
    const projectorSpy = vi.spyOn(bootstrapDisclosureModule, 'projectCompactBootstrap');
    try {
      const response = await tools.get('cognitive_agent_bootstrap')!.cb({
        project_id: 'project-a', query: 'packet', response_mode: 'compact',
      });
      const text = response.content[0].text;
      const envelope = JSON.parse(text) as { response_mode: string; profile: string; orientation: { task_state: string }; budget: { serialized_bytes: number }; mutation: { access_tracking: string } };
      expect(composeSpy).toHaveBeenCalledTimes(1);
      expect(projectorSpy).toHaveBeenCalledTimes(1);
      expect(envelope.response_mode).toBe('compact');
      expect(envelope.profile).toBe('full');
      expect(envelope.orientation.task_state).toBe('not_requested');
      expect(envelope.budget.serialized_bytes).toBe(Buffer.byteLength(text, 'utf8'));
      expect(text).toBe(canonicalJson(envelope));
      expect(envelope.mutation.access_tracking).toBe('not_touched');
      expect(snapshot(db)).toEqual(before);
    } finally {
      composeSpy.mockRestore();
      projectorSpy.mockRestore();
    }
  });

  it('keeps base orientation while honestly marking malformed task state partial in compact mode', async () => {
    const { tools, server } = fakeServer();
    registerCognitiveTools(server);
    const result = JSON.parse((await tools.get('cognitive_agent_bootstrap')!.cb({
      project_id: 'project-a', query: 'packet', response_mode: 'compact',
      task_state: { task_id: 'task-a', manifest: { malformed: true } },
    })).content[0].text) as { orientation: { status: string; task_state: string }; scope: { project_id: string } };
    expect(result.scope.project_id).toBe('project-a');
    expect(result.orientation).toEqual(expect.objectContaining({ status: 'partial', task_state: 'unavailable' }));
  });

  it('uses a separate fail-closed packet envelope and ignores caller authority flags', () => {
    const db = getDatabase('memory');
    const result = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, {
      project_id: 'project-a', task_id: 'task-a', manifest: manifest(),
      // Deliberately not part of the accepted request shape.
      sources: { memories: [{ operator_adoption_verified: true, external_to_manifest: true }] },
    } as unknown as Parameters<typeof bootstrapCognitiveAgentWithTaskState>[2]);
    expect(result.task_state.status).toBe('assembled');
    expect(result.task_state.packet?.unresolved).toContain('manifest_adoption_unverified');
    expect(result.task_state.packet?.governing).toEqual([]);
    expect(result.task_state.envelope_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bootstrap_digest).toBe(bootstrapCognitiveAgent(db, { project_id: 'project-a', query: 'packet' }).bootstrap_digest);
  });

  it('keeps Contract 1.1 operator-receipt manifests non-governing when protected trust configuration is absent', () => {
    const receipt = { kind: 'operator_receipt', receipt_id: 'b1b2b3b4-c5c6-4d47-8e89-a1b2c3d4e5f6', project_id: 'project-a', task_id: 'task-a' };
    const result = bootstrapCognitiveAgentWithTaskState(getDatabase('memory'), { project_id: 'project-a', query: 'packet' }, { project_id: 'project-a', task_id: 'task-a', manifest: manifest({ schema_version: '1.1.0', adoption: { status: 'operator_adopted', source: receipt } }) });
    expect(result.task_state.packet).toMatchObject({ contract_version: '1.1.0', governing: [] });
    expect(result.task_state.packet?.unresolved).toContain('adoption_receipt_missing');
  });

  it('validates representative Contract 1.1 corpus with Draft 2020-12 schema and runtime parity', () => {
    const schema = JSON.parse(readFileSync(new URL('../cognitive-os/agent-practice/task-state-manifest.v1.1.schema.json', import.meta.url), 'utf8'));
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    const receipt = { kind: 'operator_receipt', receipt_id: 'b1b2b3b4-c5c6-4d47-8e89-a1b2c3d4e5f6', project_id: 'project-a', task_id: 'task-a' };
    const positive = manifest({ schema_version: '1.1.0', adoption: { status: 'operator_adopted', source: receipt }, governing_sources: [{ kind: 'memory', id: 1, project_id: 'project-a' }], review_policy: { validation_sources: [{ kind: 'memory', id: 1, project_id: 'project-a' }] } });
    const negative = { ...positive, adoption: { ...positive.adoption as object, source: { kind: 'memory', id: 1, project_id: 'project-a' } } };
    expect(validate(positive)).toBe(true); expect(validateTaskStateManifest(positive).ok).toBe(true);
    expect(validate(negative)).toBe(false); expect(validateTaskStateManifest(negative).ok).toBe(false);
  });

  it('composes a valid fixture-mode signed receipt into exact Contract 1.1 governing membership', () => {
    const root = generateKeyPairSync('ed25519'); const signer = generateKeyPairSync('ed25519'); const raw = (key: typeof root.publicKey) => key.export({ format: 'der', type: 'spki' }).subarray(-32); const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    const receiptRef = { kind: 'operator_receipt' as const, receipt_id: 'b1b2b3b4-c5c6-4d47-8e89-a1b2c3d4e5f6', project_id: 'project-a', task_id: 'task-a' };
    const signedManifest = manifest({ schema_version: '1.1.0', adoption: { status: 'operator_adopted', source: receiptRef } }); const policy = { allowed_capabilities: ['task_state_governing'], maximum_authority_ceiling: 'task_orientation_only', max_receipt_ttl_seconds: 3_000_000_000 };
    const registry = { schema_version: '1.0.0', registry_id: 'registry-a', deployment_audience: 'fixture-audience', trust_mode: 'fixture', current_epoch: 1, accepted_epochs: [{ epoch: 1, keys: [{ key_id: 'operator', algorithm: 'Ed25519', public_key_b64u: b64u(raw(signer.publicKey)), status: 'active', valid_from: '2020-01-01T00:00:00.000Z' }] }], revoked_receipt_ids: [], policy };
    const receipt = { schema_version: '1.0.0', receipt_id: receiptRef.receipt_id, action: 'adopt_task_state_manifest', issuer: { key_id: 'operator', algorithm: 'Ed25519', registry_id: 'registry-a', deployment_audience: 'fixture-audience', trust_epoch: 1, trust_policy_sha256: canonicalJsonSha256(policy) }, subject: { manifest_id: signedManifest.manifest_id, manifest_revision: signedManifest.revision, manifest_sha256: canonicalJsonSha256(signedManifest), project_id: 'project-a', task_id: 'task-a' }, grant: { capabilities: ['task_state_governing'], authority_ceiling: 'task_orientation_only', include_global: false }, issued_at: '2020-01-01T00:00:00.000Z', not_before: '2020-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', nonce: b64u(Buffer.alloc(16, 1)) };
    const registryPayload = Buffer.from(canonicalizeJcs(registry)); const receiptPayload = Buffer.from(canonicalizeJcs(receipt)); const transport = { payload_b64u: b64u(registryPayload), root_signature_b64u: b64u(sign(null, Buffer.concat([Buffer.from('mem-graph/operator-trust-registry/v1\n'), registryPayload]), root.privateKey)) };
    const path = join(tempDir, 'fixture-registry.json'); writeFileSync(path, canonicalizeJcs(transport)); const rootRaw = raw(root.publicKey); const runtime = createOperatorTrustRuntime({ registry_bundle_path: path, registry_id: 'registry-a', deployment_audience: 'fixture-audience', registry_root_public_key_b64u: b64u(rootRaw), registry_root_key_sha256: createHash('sha256').update(rootRaw).digest('hex'), trust_mode: 'fixture' });
    const request = { project_id: 'project-a', task_id: 'task-a', manifest: signedManifest, adoption_receipt: { payload_b64u: b64u(receiptPayload), signature_b64u: b64u(sign(null, Buffer.concat([Buffer.from('mem-graph/operator-adoption/v1\n'), receiptPayload]), signer.privateKey)) } };
    const db = getDatabase('memory'); const before = snapshot(db); const base = bootstrapCognitiveAgent(db, { project_id: 'project-a', query: 'packet' });
    vi.useFakeTimers();
    try {
      vi.setSystemTime('2026-09-02T00:00:01.000Z'); const response = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, request, runtime);
      vi.setSystemTime('2026-09-02T00:00:02.000Z'); const replay = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, request, runtime);
      expect(response.task_state.packet).toMatchObject({ contract_version: '1.1.0', verification: { adoption: { status: 'verified', failure_codes: [] } } }); expect(response.task_state.packet?.governing).toHaveLength(2);
      const { task_state: _taskState, ...unchangedBootstrap } = response;
      expect(unchangedBootstrap).toEqual(base); expect(response.bootstrap_digest).toBe(base.bootstrap_digest); expect(snapshot(db)).toEqual(before);
      expect(replay.task_state.packet?.verification.adoption?.evaluated_at).not.toBe(response.task_state.packet?.verification.adoption?.evaluated_at); expect(replay.task_state.packet?.packet_digest).toBe(response.task_state.packet?.packet_digest); expect(replay.task_state.envelope_digest).toBe(response.task_state.envelope_digest);
      const deniedGlobal = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet', include_global: true }, request, runtime);
      expect(deniedGlobal.task_state.packet).toMatchObject({ scope: { include_global: false, global_inclusion: 'disabled' }, verification: { adoption: { status: 'unverified' } } });
      expect(deniedGlobal.task_state.packet?.verification.adoption?.failure_codes).toContain('adoption_manifest_mismatch');
    } finally { vi.useRealTimers(); }
  });

  it('keeps a malformed detached receipt soft-failed with a valid fixture runtime and no database effect', () => {
    const fixture = signedFixture({ name: 'malformed', malformed_receipt: true }); const db = getDatabase('memory');
    const outer = { project_id: 'project-a', query: 'packet' }; const base = bootstrapCognitiveAgent(db, outer); const before = snapshot(db);
    const result = bootstrapCognitiveAgentWithTaskState(db, outer, fixture.request, fixture.runtime);
    expect(result.task_state).toMatchObject({ status: 'assembled', packet: { governing: [], verification: { adoption: { status: 'unverified' } } } });
    expect(result.task_state.packet?.verification.adoption?.failure_codes).toContain('adoption_receipt_malformed');
    const { task_state: _taskState, ...unchangedBootstrap } = result;
    expect(unchangedBootstrap).toEqual(base); expect(result.bootstrap_digest).toBe(base.bootstrap_digest); expect(snapshot(db)).toEqual(before);
  });

  it('permits an actual global source only for the end-to-end three-grant matrix', () => {
    const db = getDatabase('memory'); seedMemory(db, { title: 'Signed global source', content: 'global', project_id: '_global' });
    vi.useFakeTimers();
    try {
      vi.setSystemTime('2026-09-02T00:00:00.000Z');
      const positive = signedFixture({ name: 'global-positive', manifest_global: true, signed_global: true, global_source: true });
      const allowed = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet', include_global: true }, positive.request, positive.runtime);
      expect(allowed.task_state.packet).toMatchObject({ scope: { include_global: true, global_inclusion: 'explicit' }, verification: { adoption: { status: 'verified' } } });
      expect(allowed.task_state.packet?.governing.some((item) => item.source.project_id === '_global')).toBe(true);

      const noOuter = signedFixture({ name: 'global-no-outer', manifest_global: true, signed_global: true, global_source: true });
      const outerDenied = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, noOuter.request, noOuter.runtime);
      expect(outerDenied.task_state.packet).toMatchObject({ scope: { include_global: false }, verification: { adoption: { status: 'verified' } } });
      expect(outerDenied.task_state.packet?.governing.some((item) => item.source.project_id === '_global')).toBe(false);
      expect(outerDenied.task_state.packet?.warnings).toContain('global_source_not_authorized');

      const noManifest = signedFixture({ name: 'global-no-manifest', manifest_global: false, signed_global: true, global_source: true });
      const manifestDenied = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet', include_global: true }, noManifest.request, noManifest.runtime);
      expect(manifestDenied.task_state.packet).toMatchObject({ scope: { include_global: false }, governing: [], verification: { adoption: { status: 'unverified' } } });
      expect(manifestDenied.task_state.packet?.verification.adoption?.failure_codes).toContain('adoption_manifest_mismatch');

      const noGrant = signedFixture({ name: 'global-no-grant', manifest_global: true, signed_global: false, global_source: true });
      const grantDenied = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet', include_global: true }, noGrant.request, noGrant.runtime);
      expect(grantDenied.task_state.packet).toMatchObject({ scope: { include_global: false }, governing: [], verification: { adoption: { status: 'unverified' } } });
      expect(grantDenied.task_state.packet?.verification.adoption?.failure_codes).toContain('adoption_scope_mismatch');
    } finally { vi.useRealTimers(); }
  });

  it('returns base bootstrap plus unavailable task state for malformed optional input', async () => {
    const { tools, server } = fakeServer();
    registerCognitiveTools(server);
    expect(tools.size).toBe(8);
    const result = JSON.parse((await tools.get('cognitive_agent_bootstrap')!.cb({ project_id: 'project-a', query: 'packet', task_state: { task_id: 'task-a', manifest: { malformed: true } } })).content[0].text) as { bootstrap_digest: string; task_state: { status: string; reason: string } };
    expect(result.task_state).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'manifest_invalid' }));
    expect(result.bootstrap_digest).toBe(bootstrapCognitiveAgent(getDatabase('memory'), { project_id: 'project-a', query: 'packet' }).bootstrap_digest);
  });

  it('retains the public surface while task-state adoption remains additive', () => {
    const { tools, server } = fakeServer();
    registerSqlTools(server); registerMemoryOrientTools(server); registerMemorySearchTools(server); registerMemoryWriteTools(server);
    registerMemoryTagTools(server); registerMemoryGraphTools(server); registerMemoryImportTools(server); registerCognitiveTools(server); registerEpistemicTools(server);
    // 41 = 40 baseline (post-Phase-B Slice 1) + epistemic_concept_diff (Item 9 Goal 8)
    expect(tools.size).toBe(41);
    expect(tools.has('cognitive_agent_bootstrap')).toBe(true);
    expect(tools.has('epistemic_concept_diff')).toBe(true);
  });

  it('binds task-state scope to the outer bootstrap project rather than nested input', async () => {
    const { tools, server } = fakeServer();
    registerCognitiveTools(server);
    const result = JSON.parse((await tools.get('cognitive_agent_bootstrap')!.cb({ project_id: 'project-a', query: 'packet', task_state: { project_id: 'other-project', task_id: 'task-a', manifest: manifest() } })).content[0].text) as { task_state: { packet: { scope: { project_id: string } } } };
    expect(result.task_state.packet.scope.project_id).toBe('project-a');
  });

  it('keeps global inclusion dual-explicit and rejects cross-project references', () => {
    const db = getDatabase('memory');
    seedMemory(db, { title: 'Global source', content: 'global', project_id: '_global' });
    const globalRef = { kind: 'memory', id: 2, project_id: '_global' };
    const denied = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet', include_global: true }, { project_id: 'project-a', task_id: 'task-a', include_global: true, manifest: manifest({ task: { ...manifest().task as object, objective: { statement: 'Global.', required: true, sources: [globalRef] } } }) });
    expect(denied.task_state.packet?.warnings).toContain('global_source_not_authorized');
    const cross = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, { project_id: 'project-a', task_id: 'task-a', manifest: manifest({ task: { ...manifest().task as object, objective: { statement: 'Cross.', required: true, sources: [{ kind: 'memory', id: 2, project_id: 'other-project' }] } } }) });
    expect(cross.task_state.packet?.warnings).toContain('cross_project_source');
  });

  it('preserves source-version, event-integrity, and event-bound failures', () => {
    const db = getDatabase('memory');
    const mismatch = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, { project_id: 'project-a', task_id: 'task-a', manifest: manifest({ task: { ...manifest().task as object, objective: { statement: 'Drift.', required: true, sources: [{ kind: 'memory', id: 1, project_id: 'project-a', expected_updated_at: '2020-01-01T00:00:00.000Z' }] } } }) });
    expect(mismatch.task_state.packet?.warnings).toContain('source_version_mismatch');
    const event = appendCognitiveEvent(db, { event_type: 'EvidenceObserved', project_id: 'project-a', task_id: 'task-a', payload: { source_memory_id: 1 }, schema_version: 2 });
    const bounded = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, { project_id: 'project-a', task_id: 'task-a', manifest: manifest({ event_scope: { project_id: 'project-a', task_id: 'task-a', after_sequence: event.sequence, allow_legacy_v1_context: false }, task: { ...manifest().task as object, objective: { statement: 'Bound.', required: true, sources: [{ kind: 'cognitive_event', event_id: event.event_id, project_id: 'project-a', task_id: 'task-a' }] } } }) });
    expect(bounded.task_state.packet?.unresolved).toContain('source_out_of_scope');
    db.exec('DROP TRIGGER cognitive_events_reject_update');
    db.prepare("UPDATE cognitive_events SET event_hash = 'tampered' WHERE event_id = ?").run(event.event_id);
    const broken = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, { project_id: 'project-a', task_id: 'task-a', manifest: manifest() });
    expect(broken.task_state.packet?.warnings).toContain('event_chain_invalid');
    expect(broken.task_state.packet?.evidence).toEqual([]);
  });

  it('surfaces valid task-state envelopes as unsupported context without promoting them', () => {
    const db = getDatabase('memory');
    appendCognitiveEvent(db, {
      event_type: 'DecisionMade', project_id: 'project-a', task_id: 'task-a', schema_version: 2,
      payload: {
        title: 'Open state observation', statement: 'Await operator approval.',
        task_state: { version: '1.0.0', state_id: 'open-1', role: 'open_state', status: 'open', statement: 'Await operator approval.' },
      },
    });
    const result = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, { project_id: 'project-a', task_id: 'task-a', manifest: manifest() });
    expect(result.task_state.packet?.unresolved).toContain('event_projection_unsupported');
    expect(result.task_state.packet?.open_state).toEqual([]);
    expect(result.task_state.packet?.context_only.some((item) => item.exclusion_reasons?.includes('event_projection_unsupported'))).toBe(true);
  });

  it('rejects non-RFC3339 dates and duplicate source references at the normative manifest boundary', async () => {
    const { tools, server } = fakeServer();
    registerCognitiveTools(server);
    const invalidDate = manifest({ event_scope: { project_id: 'project-a', task_id: 'task-a', observed_after: '2026-02-30T00:00:00Z', allow_legacy_v1_context: false } });
    const duplicate = manifest({ task: { ...manifest().task as object, objective: { statement: 'Duplicate.', required: true, sources: [{ kind: 'memory', id: 1, project_id: 'project-a' }, { project_id: 'project-a', id: 1, kind: 'memory' }] } } });
    for (const candidate of [invalidDate, duplicate]) {
      const result = JSON.parse((await tools.get('cognitive_agent_bootstrap')!.cb({ project_id: 'project-a', query: 'packet', task_state: { task_id: 'task-a', manifest: candidate } })).content[0].text);
      expect(result.task_state).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'manifest_invalid' }));
      expect(result.bootstrap_digest).toBe(bootstrapCognitiveAgent(getDatabase('memory'), { project_id: 'project-a', query: 'packet' }).bootstrap_digest);
    }
  });

  it('normalizes epistemic numeric storage IDs to Contract-v1 strings and remains zero-write', () => {
    const db = getDatabase('memory');
    const admitted = admitEpistemicRecord(db, { idempotency_key: 'epistemic-task-state', project_id: 'project-a', scope: 'exact-project', statement: 'Context only.', epistemic_status: 'inferred', verification_level: 'direct', source_quality: 'observed', confidence: 0.5, valid_from: '2026-01-01T00:00:00.000Z', task_id: 'task-a' });
    const before = snapshot(db);
    const result = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, { project_id: 'project-a', task_id: 'task-a', manifest: manifest({ task: { ...manifest().task as object, objective: { statement: 'Epistemic.', required: true, sources: [{ kind: 'epistemic_record', record_id: String(admitted.record_id), project_id: 'project-a', expected_revision: admitted.revision_number }] } } }) });
    expect(result.task_state.status).toBe('assembled');
    expect(result.task_state.packet?.verification.source_references).toContainEqual(expect.objectContaining({ kind: 'epistemic_record', record_id: String(admitted.record_id) }));
    expect(snapshot(db)).toEqual(before);
  });

  it('replays deterministically and leaves every logical table unchanged', () => {
    const db = getDatabase('memory');
    const before = snapshot(db);
    const request = { project_id: 'project-a', task_id: 'task-a', manifest: manifest() };
    const one = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, request);
    const two = bootstrapCognitiveAgentWithTaskState(db, { project_id: 'project-a', query: 'packet' }, request);
    expect(two.task_state).toEqual(one.task_state);
    expect(snapshot(db)).toEqual(before);
  });
});
