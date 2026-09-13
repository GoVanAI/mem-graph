import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJcs } from '../src/cognitive/operator-adoption.js';
import { createOperatorTrustRuntime, loadProtectedOperatorTrustRegistry } from '../src/cognitive/operator-trust-loader.js';

let temp = '';
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); temp = ''; });
const config = (path: string, trust_mode: 'fixture' | 'production' = 'fixture') => ({ registry_bundle_path: path, registry_id: 'registry-a', deployment_audience: 'test-audience', registry_root_public_key_b64u: Buffer.alloc(32, 7).toString('base64url'), registry_root_key_sha256: '0'.repeat(64), trust_mode });

describe('protected operator trust registry loader', () => {
  it('reads only a fixed, canonical, bounded fixture-mode snapshot', () => {
    temp = mkdtempSync(join(tmpdir(), 'operator-trust-')); const path = join(temp, 'registry.json');
    writeFileSync(path, canonicalizeJcs({ payload_b64u: 'e30', root_signature_b64u: Buffer.alloc(64).toString('base64url') }));
    const runtime = createOperatorTrustRuntime(config(path));
    expect(loadProtectedOperatorTrustRegistry(runtime)).toEqual({ payload_b64u: 'e30', root_signature_b64u: Buffer.alloc(64).toString('base64url') });
  });
  it('fails closed for missing/cwd-path/noncanonical input and unsupported production filesystem guarantees', () => {
    temp = mkdtempSync(join(tmpdir(), 'operator-trust-')); const path = join(temp, 'registry.json'); writeFileSync(path, '{ "payload_b64u":"e30","root_signature_b64u":"x" }');
    expect(loadProtectedOperatorTrustRegistry(createOperatorTrustRuntime(config(path)))).toBeUndefined();
    expect(createOperatorTrustRuntime(config(join(process.cwd(), 'registry.json')))).toBeUndefined();
    if (process.platform === 'win32') expect(loadProtectedOperatorTrustRegistry(createOperatorTrustRuntime(config(path, 'production')))).toBeUndefined();
  });

  it('captures an immutable startup descriptor and rejects transport substitution, oversized snapshots, and post-start environment input', () => {
    temp = mkdtempSync(join(tmpdir(), 'operator-trust-')); const path = join(temp, 'registry.json');
    const valid = canonicalizeJcs({ payload_b64u: 'e30', root_signature_b64u: Buffer.alloc(64).toString('base64url') }); writeFileSync(path, valid);
    const startup = config(path); const runtime = createOperatorTrustRuntime(startup)!; startup.registry_bundle_path = join(temp, 'attacker.json');
    const prior = process.env.MEM_GRAPH_OPERATOR_TRUST_STARTUP; process.env.MEM_GRAPH_OPERATOR_TRUST_STARTUP = JSON.stringify(config(join(temp, 'attacker.json')));
    try { expect(loadProtectedOperatorTrustRegistry(runtime)).toEqual({ payload_b64u: 'e30', root_signature_b64u: Buffer.alloc(64).toString('base64url') }); }
    finally { if (prior === undefined) delete process.env.MEM_GRAPH_OPERATOR_TRUST_STARTUP; else process.env.MEM_GRAPH_OPERATOR_TRUST_STARTUP = prior; }
    writeFileSync(path, canonicalizeJcs({ payload_b64u: 'e30', root_signature_b64u: Buffer.alloc(64).toString('base64url'), extra: true }));
    expect(loadProtectedOperatorTrustRegistry(runtime)).toBeUndefined();
    writeFileSync(path, 'x'.repeat(64 * 1024 + 1)); expect(loadProtectedOperatorTrustRegistry(runtime)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('POSIX-only symlink and privileged-owner production checks fail closed (Windows is asserted unsupported above)', () => {
    temp = mkdtempSync(join(tmpdir(), 'operator-trust-')); const target = join(temp, 'target.json'); const link = join(temp, 'registry.json');
    writeFileSync(target, canonicalizeJcs({ payload_b64u: 'e30', root_signature_b64u: Buffer.alloc(64).toString('base64url') })); symlinkSync(target, link);
    expect(loadProtectedOperatorTrustRegistry(createOperatorTrustRuntime(config(link)))).toBeUndefined();
    // A root process is deliberately not permitted to attest its own production registry.
    expect(loadProtectedOperatorTrustRegistry(createOperatorTrustRuntime(config(target, 'production')))).toBeUndefined();
  });

  it('rejects a deterministic TOCTOU identity change between the open and post-read snapshots', async () => {
    temp = mkdtempSync(join(tmpdir(), 'operator-trust-')); const path = join(temp, 'registry.json');
    writeFileSync(path, canonicalizeJcs({ payload_b64u: 'e30', root_signature_b64u: Buffer.alloc(64).toString('base64url') }));
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs'); let finalPathStats = 0;
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...fs,
      lstatSync: (candidate: string) => {
        const stat = fs.lstatSync(candidate);
        if (candidate !== path || ++finalPathStats !== 3) return stat;
        const changed = Object.create(stat) as typeof stat;
        Object.defineProperty(changed, 'mtimeMs', { value: stat.mtimeMs + 1 });
        return changed;
      },
    }));
    try {
      const loader = await import('../src/cognitive/operator-trust-loader.js');
      expect(loader.loadProtectedOperatorTrustRegistry(loader.createOperatorTrustRuntime(config(path)))).toBeUndefined();
    } finally { vi.doUnmock('node:fs'); vi.resetModules(); }
  });
});
