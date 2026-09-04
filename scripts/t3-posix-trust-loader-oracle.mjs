#!/usr/bin/env node
/**
 * Prepared T3 POSIX oracle. Run with the repository's existing tsx loader:
 *   node_modules/.bin/tsx scripts/t3-posix-trust-loader-oracle.mjs
 *
 * This intentionally fails on every unmet precondition; it never skips a
 * Linux security check. The generated path is deliberately under /opt rather
 * than /tmp, whose world-writable parent the production loader must reject.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'linux') throw new Error('T3 POSIX oracle requires Linux');
if (typeof process.getuid !== 'function' || process.getuid() === 0) throw new Error('T3 POSIX oracle requires a non-root runner');
if (typeof process.getgid !== 'function') throw new Error('T3 POSIX oracle requires POSIX getgid');

const runRoot = (args, input) => execFileSync('sudo', ['-n', ...args], { input, stdio: ['pipe', 'ignore', 'pipe'] });
try { runRoot(['true']); } catch { throw new Error('T3 POSIX oracle requires passwordless sudo (`sudo -n true`)'); }

const { canonicalizeJcs } = await import('../src/cognitive/operator-adoption.ts');
const { createOperatorTrustRuntime, loadProtectedOperatorTrustRegistry } = await import('../src/cognitive/operator-trust-loader.ts');
const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const oracleDir = `/opt/mem-graph-t3-${nonce}`;
const uid = process.getuid(); const gid = process.getgid();
const rootPublicKey = Buffer.alloc(32, 7); const rootSignature = Buffer.alloc(64, 9).toString('base64url');
const transport = { payload_b64u: 'e30', root_signature_b64u: rootSignature };
const canonicalTransport = canonicalizeJcs(transport);

function writeRootFile(path, mode) {
  runRoot(['tee', path], canonicalTransport);
  runRoot(['chown', 'root:root', path]); runRoot(['chmod', mode, path]);
}
function runtime(path) {
  const value = createOperatorTrustRuntime({
    registry_bundle_path: path, registry_id: 't3-registry', deployment_audience: 't3-posix-oracle',
    registry_root_public_key_b64u: rootPublicKey.toString('base64url'),
    registry_root_key_sha256: createHash('sha256').update(rootPublicKey).digest('hex'), trust_mode: 'production',
  });
  assert.ok(value, `runtime must accept ${path}`); return value;
}
function expectRejected(name, path) {
  assert.equal(loadProtectedOperatorTrustRegistry(runtime(path)), undefined, `${name} must fail closed`);
}

let created = false;
try {
  runRoot(['install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', oracleDir]); created = true;
  const secure = `${oracleDir}/registry.json`; writeRootFile(secure, '0644');
  assert.deepEqual(loadProtectedOperatorTrustRegistry(runtime(secure)), transport, 'root-owned protected transport must load');

  const sameUid = `${oracleDir}/same-uid.json`; writeRootFile(sameUid, '0644'); runRoot(['chown', `${uid}:${gid}`, sameUid]);
  expectRejected('same-UID-owned final file', sameUid);

  const writableFile = `${oracleDir}/group-writable.json`; writeRootFile(writableFile, '0664');
  expectRejected('group/world-writable final file', writableFile);

  const writableDirectory = `${oracleDir}/group-writable-dir`; runRoot(['install', '-d', '-o', 'root', '-g', 'root', '-m', '0775', writableDirectory]);
  const nested = `${writableDirectory}/registry.json`; writeRootFile(nested, '0644');
  expectRejected('group/world-writable path component', nested);

  const symbolic = `${oracleDir}/registry-symlink.json`; runRoot(['ln', '-s', secure, symbolic]);
  expectRejected('symlink final file', symbolic);

  const hardlink = `${oracleDir}/registry-hardlink.json`; runRoot(['ln', secure, hardlink]);
  expectRejected('hardlink final file', hardlink);
  process.stdout.write('T3 POSIX trust-loader oracle passed\n');
} finally {
  if (created) {
    if (!oracleDir.startsWith('/opt/mem-graph-t3-')) throw new Error('refusing unsafe cleanup target');
    runRoot(['rm', '-rf', '--', oracleDir]);
    if (existsSync(oracleDir)) throw new Error(`oracle cleanup failed: ${oracleDir}`);
    process.stdout.write('T3 POSIX trust-loader oracle cleanup complete\n');
  }
}
