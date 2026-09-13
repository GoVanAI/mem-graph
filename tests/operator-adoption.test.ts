import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalizeJcs, canonicalJsonSha256, decodeBase64Url, isOperatorAdoptionReceiptPayloadV1, isOperatorTrustRegistryPayloadV1, parseCanonicalJson, verifyOperatorAdoption } from '../src/cognitive/operator-adoption.js';

const at = '2026-09-02T12:00:00.000Z';
const uuid = 'b1b2b3b4-c5c6-4d47-8e89-a1b2c3d4e5f6';
const b64u = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const rawPublic = (key: KeyObject) => key.export({ format: 'der', type: 'spki' }).subarray(-32);
type Parts = { receipt: any; registry: any; manifest: any; ref: any; request: any; event: any; startup: any; root: ReturnType<typeof generateKeyPairSync>; signer: ReturnType<typeof generateKeyPairSync>; at: string; bomReceipt?: boolean; bomRegistry?: boolean };

function fixture(mutate?: (parts: Parts) => void): any {
  const root = generateKeyPairSync('ed25519'); const signer = generateKeyPairSync('ed25519');
  const ref = { kind: 'operator_receipt', receipt_id: uuid, project_id: 'cognitive-os', task_id: 't1' };
  const manifest = { manifest_id: 'm3-t1', revision: 1, project_id: 'cognitive-os', task_id: 't1', include_global: false, adoption: { status: 'operator_adopted', source: ref }, text: 'é' };
  const policy = { allowed_capabilities: ['task_state_governing'], maximum_authority_ceiling: 'task_orientation_only', max_receipt_ttl_seconds: 600 };
  const registry = { schema_version: '1.0.0', registry_id: 'registry-a', deployment_audience: 'test-audience', trust_mode: 'fixture', current_epoch: 7, accepted_epochs: [{ epoch: 7, keys: [{ key_id: 'operator-1', algorithm: 'Ed25519', public_key_b64u: b64u(rawPublic(signer.publicKey)), status: 'active', valid_from: '2026-09-02T11:00:00.000Z', valid_until: '2026-09-02T13:00:00.000Z' }] }], revoked_receipt_ids: [], policy };
  const receipt = { schema_version: '1.0.0', receipt_id: uuid, action: 'adopt_task_state_manifest', issuer: { key_id: 'operator-1', algorithm: 'Ed25519', registry_id: 'registry-a', deployment_audience: 'test-audience', trust_epoch: 7, trust_policy_sha256: canonicalJsonSha256(policy) }, subject: { manifest_id: manifest.manifest_id, manifest_revision: manifest.revision, manifest_sha256: canonicalJsonSha256(manifest), project_id: 'cognitive-os', task_id: 't1' }, grant: { capabilities: ['task_state_governing'], authority_ceiling: 'task_orientation_only', include_global: false }, issued_at: '2026-09-02T11:59:00.000Z', not_before: at, expires_at: '2026-09-02T12:05:00.000Z', nonce: b64u(Buffer.alloc(16, 9)) };
  const startup = { registry_id: 'registry-a', deployment_audience: 'test-audience', registry_root_public_key_b64u: b64u(rawPublic(root.publicKey)), registry_root_key_sha256: hash(rawPublic(root.publicKey)), trust_mode: 'fixture' as const };
  const parts: Parts = { receipt, registry, manifest, ref, request: { project_id: 'cognitive-os', task_id: 't1', include_global: false }, event: { project_id: 'cognitive-os', task_id: 't1' }, startup, root, signer, at };
  mutate?.(parts);
  const registryPayload = Buffer.concat([parts.bomRegistry ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(canonicalizeJcs(parts.registry))]); const receiptPayload = Buffer.concat([parts.bomReceipt ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(canonicalizeJcs(parts.receipt))]);
  return { receipt: { payload_b64u: b64u(receiptPayload), signature_b64u: b64u(sign(null, Buffer.concat([Buffer.from('mem-graph/operator-adoption/v1\n'), receiptPayload]), signer.privateKey)) }, registry: { payload_b64u: b64u(registryPayload), root_signature_b64u: b64u(sign(null, Buffer.concat([Buffer.from('mem-graph/operator-trust-registry/v1\n'), registryPayload]), root.privateKey)) }, startup, manifest: parts.manifest, manifest_receipt_ref: parts.ref, request_scope: parts.request, event_scope: parts.event, evaluated_at: parts.at };
}
const code = (mutate: (parts: Parts) => void, expected: string) => expect(verifyOperatorAdoption(fixture(mutate)).failure_codes).toContain(expected);

describe('operator-adoption pure verifier', () => {
  it('verifies and deterministically replays an exact detached receipt with generated fixture keys', () => {
    const input = fixture(); const first = verifyOperatorAdoption(input); const second = verifyOperatorAdoption(input);
    expect(first).toMatchObject({ status: 'verified', receipt_id: uuid, signer_key_id: 'operator-1', failure_codes: [] }); expect(second).toEqual(first);
  });

  it('uses strict JCS for escaping, numeric boundaries, Unicode ordering, and noncanonical raw JSON rejection', () => {
    expect(canonicalizeJcs({ '\ud83d\ude00': 'é', a: 1e-7, z: -0 })).toBe('{"a":1e-7,"z":0,"😀":"é"}');
    expect(canonicalizeJcs({ s: '\b\t\n\f\r"\\\u0000' })).toBe('{"s":"\\b\\t\\n\\f\\r\\"\\\\\\u0000"}');
    expect(canonicalizeJcs({ m: 1e-7, d: 0.000001, n: 9007199254740991 })).toBe('{"d":0.000001,"m":1e-7,"n":9007199254740991}');
    expect(canonicalizeJcs({ '😀': 3, '€': 2, a: 1 })).toBe('{"a":1,"€":2,"😀":3}');
    expect(parseCanonicalJson(Buffer.from('{"a":1e-7,"z":0,"😀":"é"}'))).toEqual({ a: 1e-7, z: 0, '😀': 'é' });
    expect(parseCanonicalJson(Buffer.from('{"a":-0}'))).toBeNull(); expect(parseCanonicalJson(Buffer.from('{"a":1,"\\u0061":1}'))).toBeNull(); expect(parseCanonicalJson(Buffer.from('{ "a":1}'))).toBeNull();
    const cycle: unknown[] = []; cycle.push(cycle); expect(() => canonicalizeJcs(cycle)).toThrow(); expect(() => canonicalizeJcs(new Date())).toThrow(); expect(() => canonicalizeJcs('\ud800')).toThrow();
  });

  it('fails malformed/missing receipt inputs and every signature/trust authentication boundary', () => {
    const missing = fixture(); missing.receipt = null; expect(verifyOperatorAdoption(missing).failure_codes).toContain('adoption_receipt_missing');
    const malformed = fixture(); malformed.receipt.payload_b64u = 'AQ=='; expect(verifyOperatorAdoption(malformed).failure_codes).toContain('adoption_receipt_malformed');
    const badReceipt = fixture(); badReceipt.receipt.signature_b64u = b64u(Buffer.alloc(64)); expect(verifyOperatorAdoption(badReceipt).failure_codes).toContain('adoption_signature_invalid');
    const badRoot = fixture(); badRoot.registry.root_signature_b64u = b64u(Buffer.alloc(64)); expect(verifyOperatorAdoption(badRoot).failure_codes).toContain('trust_registry_unavailable');
    code((p) => { p.startup.registry_root_key_sha256 = '0'.repeat(64); }, 'trust_registry_unavailable');
    code((p) => { p.registry.accepted_epochs[0].keys[0].public_key_b64u = b64u(Buffer.alloc(31)); }, 'trust_registry_unavailable');
  });

  it('rejects signed BOM-prefixed receipt and registry payloads byte-for-byte', () => {
    expect(verifyOperatorAdoption(fixture((p) => { p.bomReceipt = true; })).failure_codes).toContain('adoption_receipt_malformed');
    expect(verifyOperatorAdoption(fixture((p) => { p.bomRegistry = true; })).failure_codes).toContain('trust_registry_unavailable');
  });

  it('binds root-signed trust mode and permits the positive three-way global grant only', () => {
    const modeFlip = fixture(); modeFlip.startup.trust_mode = 'production'; expect(verifyOperatorAdoption(modeFlip).failure_codes).toContain('adoption_signer_untrusted');
    const global = fixture((p) => { p.request.include_global = true; p.manifest.include_global = true; p.receipt.grant.include_global = true; p.receipt.subject.manifest_sha256 = canonicalJsonSha256(p.manifest); });
    expect(verifyOperatorAdoption(global)).toMatchObject({ status: 'verified', failure_codes: [] });
  });

  it('covers contract, signer, policy/capability, and registry identity failures', () => {
    code((p) => { p.receipt.schema_version = '9.0.0'; }, 'adoption_contract_unsupported');
    code((p) => { p.receipt.issuer.registry_id = 'wrong'; }, 'adoption_signer_untrusted');
    code((p) => { p.registry.deployment_audience = 'wrong'; }, 'adoption_signer_untrusted');
    code((p) => { p.receipt.grant.capabilities = ['other']; }, 'adoption_capability_insufficient');
    code((p) => { p.registry.policy.allowed_capabilities = ['other']; p.receipt.issuer.trust_policy_sha256 = canonicalJsonSha256(p.registry.policy); }, 'adoption_capability_insufficient');
    code((p) => { p.receipt.issuer.trust_epoch = 6; }, 'adoption_signer_untrusted');
  });

  it('covers receipt, epoch, key, TTL, and revocation time boundaries', () => {
    code((p) => { p.at = '2026-09-02T11:59:59.999Z'; }, 'adoption_receipt_not_yet_valid');
    code((p) => { p.at = '2026-09-02T12:05:00.000Z'; }, 'adoption_receipt_expired');
    code((p) => { p.receipt.expires_at = '2026-09-02T12:10:00.001Z'; }, 'adoption_receipt_ttl_exceeded');
    code((p) => { p.registry.accepted_epochs[0].valid_until = at; }, 'adoption_epoch_expired');
    code((p) => { p.registry.accepted_epochs[0].keys[0].valid_from = '2026-09-02T12:00:00.001Z'; }, 'adoption_key_not_yet_valid');
    code((p) => { p.registry.accepted_epochs[0].keys[0].valid_until = at; }, 'adoption_key_expired');
    code((p) => { p.receipt.issued_at = '2026-09-02T10:00:00.000Z'; }, 'adoption_key_not_yet_valid');
    code((p) => { p.registry.accepted_epochs[0].keys[0].status = 'revoked'; }, 'adoption_key_revoked');
    code((p) => { p.registry.revoked_receipt_ids = [uuid]; }, 'adoption_receipt_revoked');
  });

  it('proves exact identity, TTL, and key-start boundary pairs with a fixed clock', () => {
    const exactTtl = fixture((p) => { p.receipt.expires_at = '2026-09-02T12:10:00.000Z'; });
    expect(verifyOperatorAdoption(exactTtl)).toMatchObject({ status: 'verified', failure_codes: [] });
    code((p) => { p.receipt.expires_at = '2026-09-02T12:10:00.001Z'; }, 'adoption_receipt_ttl_exceeded');

    const keyStartExact = fixture((p) => { p.registry.accepted_epochs[0].keys[0].valid_from = p.receipt.issued_at; });
    expect(verifyOperatorAdoption(keyStartExact)).toMatchObject({ status: 'verified', failure_codes: [] });
    code((p) => { p.receipt.issued_at = '2026-09-02T11:58:59.999Z'; p.registry.accepted_epochs[0].keys[0].valid_from = '2026-09-02T11:59:00.000Z'; }, 'adoption_key_not_yet_valid');

    const singleRevocation = fixture((p) => { p.registry.revoked_receipt_ids = [uuid]; });
    expect(verifyOperatorAdoption(singleRevocation).failure_codes).toContain('adoption_receipt_revoked');
    code((p) => { p.registry.revoked_receipt_ids = [uuid, uuid]; }, 'trust_registry_unavailable');

    const lowerCanonical = fixture(); expect(verifyOperatorAdoption(lowerCanonical)).toMatchObject({ status: 'verified' });
    code((p) => { p.receipt.receipt_id = uuid.toUpperCase(); }, 'adoption_receipt_malformed');
    code((p) => { p.receipt.receipt_id = 'b1b2b3b4-c5c6-1d47-8e89-a1b2c3d4e5f6'; }, 'adoption_receipt_malformed');
  });

  it('rejects malformed identity/registry invariants and exact manifest/scope/global substitution', () => {
    code((p) => { p.receipt.receipt_id = 'BAD'; }, 'adoption_receipt_malformed');
    code((p) => { p.receipt.nonce = b64u(Buffer.alloc(15)); }, 'adoption_receipt_malformed');
    code((p) => { p.registry.accepted_epochs.push({ ...p.registry.accepted_epochs[0] }); }, 'trust_registry_unavailable');
    code((p) => { p.registry.accepted_epochs[0].epoch = 8; }, 'trust_registry_unavailable');
    code((p) => { p.registry.accepted_epochs[0].keys.push({ ...p.registry.accepted_epochs[0].keys[0] }); }, 'trust_registry_unavailable');
    code((p) => { p.manifest.text = 'one byte changed'; }, 'adoption_manifest_mismatch');
    code((p) => { p.manifest.project_id = 'other'; }, 'adoption_manifest_mismatch');
    code((p) => { p.event.project_id = 'other'; }, 'adoption_scope_mismatch');
    code((p) => { p.request.include_global = true; }, 'adoption_manifest_mismatch');
    code((p) => { p.request.include_global = true; p.manifest.include_global = true; p.receipt.subject.manifest_sha256 = canonicalJsonSha256(p.manifest); }, 'adoption_scope_mismatch');
  });

  it('fails uncanonicalizable manifests before a signed digest could authorize them', () => {
    const input = fixture(); const cyclic: any = { ...input.manifest }; cyclic.self = cyclic; input.manifest = cyclic;
    expect(verifyOperatorAdoption(input)).toMatchObject({ status: 'unverified', failure_codes: ['adoption_manifest_mismatch', 'manifest_adoption_unverified'] });
  });

  it('never throws on malformed JavaScript runtime shapes and fails closed deterministically', () => {
    for (const manifest of [null, 'manifest', 1, []]) {
      const input = fixture(); input.manifest = manifest;
      expect(() => verifyOperatorAdoption(input)).not.toThrow(); expect(verifyOperatorAdoption(input).failure_codes).toContain('adoption_manifest_mismatch');
    }
    const badStartup = fixture(); badStartup.startup = null; expect(() => verifyOperatorAdoption(badStartup)).not.toThrow(); expect(verifyOperatorAdoption(badStartup).failure_codes).toContain('trust_registry_unavailable');
    for (const key of ['request_scope', 'event_scope'] as const) {
      const input = fixture(); input[key] = null; expect(() => verifyOperatorAdoption(input)).not.toThrow(); expect(verifyOperatorAdoption(input).failure_codes).toContain('adoption_scope_mismatch');
    }
  });

  it('fails closed for null, undefined, and primitive whole inputs', () => {
    for (const input of [null, undefined, 'input', 1, []]) {
      expect(() => verifyOperatorAdoption(input)).not.toThrow(); expect(verifyOperatorAdoption(input)).toMatchObject({ status: 'unverified', failure_codes: ['adoption_receipt_malformed', 'manifest_adoption_unverified'] });
    }
  });

  it('keeps both supplied schema artifacts parseable JSON', () => {
    const receiptSchema = JSON.parse(readFileSync(new URL('../cognitive-os/agent-practice/operator-adoption-receipt.v1.schema.json', import.meta.url), 'utf8'));
    const registrySchema = JSON.parse(readFileSync(new URL('../cognitive-os/agent-practice/operator-trust-registry.v1.schema.json', import.meta.url), 'utf8'));
    expect(receiptSchema.$id).toBe('mem-graph/operator-adoption-receipt/v1'); expect(registrySchema.$id).toBe('mem-graph/operator-trust-registry/v1');
  });

  it('keeps the protected verifier pure: no filesystem, database, or environment dependency crosses T1', () => {
    const source = readFileSync(new URL('../src/cognitive/operator-adoption.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:fs|better-sqlite3|from '\.\.\/db|process\.(?:env|cwd)|readFile|openSync/);
  });

  it('keeps exported runtime structural validators aligned with representative schema shapes', () => {
    const input = fixture(); const receipt = JSON.parse(Buffer.from(input.receipt.payload_b64u, 'base64url').toString('utf8')); const registry = JSON.parse(Buffer.from(input.registry.payload_b64u, 'base64url').toString('utf8'));
    expect(isOperatorAdoptionReceiptPayloadV1(receipt)).toBe(true); expect(isOperatorTrustRegistryPayloadV1(registry)).toBe(true);
    expect(isOperatorAdoptionReceiptPayloadV1({ ...receipt, unexpected: true })).toBe(false); expect(isOperatorAdoptionReceiptPayloadV1({ ...receipt, nonce: 'short' })).toBe(false); expect(isOperatorAdoptionReceiptPayloadV1({ ...receipt, schema_version: '9.0.0' })).toBe(false);
    expect(isOperatorTrustRegistryPayloadV1({ ...registry, trust_mode: 'other' })).toBe(false); expect(isOperatorTrustRegistryPayloadV1({ ...registry, accepted_epochs: [] })).toBe(false);
  });

  it('rejects strict base64url padding and invalid signature lengths', () => {
    expect(decodeBase64Url('AQ==')).toBeNull(); expect(decodeBase64Url('A')).toBeNull(); const input = fixture(); input.receipt.signature_b64u = b64u(Buffer.alloc(63)); expect(verifyOperatorAdoption(input).failure_codes).toContain('adoption_receipt_malformed');
  });
});
