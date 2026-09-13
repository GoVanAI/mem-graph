import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalizeJcs, canonicalJsonSha256, verifyOperatorAdoption } from '../src/cognitive/operator-adoption.js';

const receiptDomain = Buffer.from('mem-graph/operator-adoption/v1\n');
const registryDomain = Buffer.from('mem-graph/operator-trust-registry/v1\n');
const at = '2026-09-05T12:00:00.000Z';
const b64u = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const rawPublic = (key: KeyObject) => key.export({ format: 'der', type: 'spki' }).subarray(-32);
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

function coherentBundle(label: string) {
  const root = generateKeyPairSync('ed25519');
  const signer = generateKeyPairSync('ed25519');
  const receiptId = 'b1b2b3b4-c5c6-4d47-8e89-a1b2c3d4e5f6';
  const receiptRef = { kind: 'operator_receipt' as const, receipt_id: receiptId, project_id: 'cognitive-os', task_id: 't4-anchor-regression' };
  const manifest = {
    manifest_id: `t4-${label}`, revision: 1, project_id: 'cognitive-os', task_id: 't4-anchor-regression', include_global: false,
    adoption: { status: 'operator_adopted', source: receiptRef },
  };
  const policy = { allowed_capabilities: ['task_state_governing'], maximum_authority_ceiling: 'task_orientation_only', max_receipt_ttl_seconds: 600 };
  const registry = {
    schema_version: '1.0.0', registry_id: 't4-anchor-registry', deployment_audience: 't4-anchor-oracle', trust_mode: 'fixture', current_epoch: 1,
    accepted_epochs: [{ epoch: 1, keys: [{ key_id: `signer-${label}`, algorithm: 'Ed25519', public_key_b64u: b64u(rawPublic(signer.publicKey)), status: 'active', valid_from: '2026-09-05T11:00:00.000Z', valid_until: '2026-09-05T13:00:00.000Z' }] }],
    revoked_receipt_ids: [], policy,
  };
  const receipt = {
    schema_version: '1.0.0', receipt_id: receiptId, action: 'adopt_task_state_manifest',
    issuer: { key_id: `signer-${label}`, algorithm: 'Ed25519', registry_id: registry.registry_id, deployment_audience: registry.deployment_audience, trust_epoch: 1, trust_policy_sha256: canonicalJsonSha256(policy) },
    subject: { manifest_id: manifest.manifest_id, manifest_revision: manifest.revision, manifest_sha256: canonicalJsonSha256(manifest), project_id: manifest.project_id, task_id: manifest.task_id },
    grant: { capabilities: ['task_state_governing'], authority_ceiling: 'task_orientation_only', include_global: false },
    issued_at: '2026-09-05T11:59:00.000Z', not_before: at, expires_at: '2026-09-05T12:05:00.000Z', nonce: b64u(Buffer.alloc(16, 7)),
  };
  const registryBytes = Buffer.from(canonicalizeJcs(registry));
  const receiptBytes = Buffer.from(canonicalizeJcs(receipt));
  const rootRaw = rawPublic(root.publicKey);
  return {
    receipt: { payload_b64u: b64u(receiptBytes), signature_b64u: b64u(sign(null, Buffer.concat([receiptDomain, receiptBytes]), signer.privateKey)) },
    registry: { payload_b64u: b64u(registryBytes), root_signature_b64u: b64u(sign(null, Buffer.concat([registryDomain, registryBytes]), root.privateKey)) },
    startup: { registry_id: registry.registry_id, deployment_audience: registry.deployment_audience, registry_root_public_key_b64u: b64u(rootRaw), registry_root_key_sha256: digest(rootRaw), trust_mode: 'fixture' as const },
    manifest, manifest_receipt_ref: receiptRef, request_scope: { project_id: manifest.project_id, task_id: manifest.task_id, include_global: false }, event_scope: { project_id: manifest.project_id, task_id: manifest.task_id }, evaluated_at: at,
  };
}

describe('T4 trust-anchor regression', () => {
  it('accepts a coherent bundle only under its independently selected root and rejects a coherent foreign root', () => {
    const trusted = coherentBundle('trusted');
    const foreign = coherentBundle('foreign');
    expect(verifyOperatorAdoption(trusted)).toMatchObject({ status: 'verified', failure_codes: [] });
    expect(verifyOperatorAdoption(foreign)).toMatchObject({ status: 'verified', failure_codes: [] });
    expect(verifyOperatorAdoption({ ...foreign, startup: trusted.startup })).toMatchObject({
      status: 'unverified', failure_codes: expect.arrayContaining(['trust_registry_unavailable']),
    });
  });

  it('keeps the T4 oracle descriptor separate from candidate-bundle metadata', () => {
    const source = readFileSync(new URL('../scripts/t4-live-operator-oracle.mjs', import.meta.url), 'utf8');
    expect(source).toContain('startupDescriptorArgument');
    expect(source).toContain('...startupDescriptor, registry_bundle_path');
    expect(source).not.toContain('...bundle.startup_public, registry_bundle_path');
  });
});
