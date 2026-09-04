import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { parseCanonicalJson, type OperatorTrustStartupDescriptorV1, type SignedOperatorTrustRegistryTransportV1 } from './operator-adoption.js';

export interface OperatorTrustDeploymentConfig extends OperatorTrustStartupDescriptorV1 { registry_bundle_path: string }
export interface OperatorTrustRuntime { readonly startup: OperatorTrustStartupDescriptorV1; readonly registry_bundle_path: string }
const maxRegistryBytes = 64 * 1024;
const sameIdentity = (a: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, b: typeof a) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Freezes a descriptor at host startup. It never reads request/environment data. */
export function createOperatorTrustRuntime(config: unknown): OperatorTrustRuntime | undefined {
  if (!plain(config) || Object.keys(config).sort().join(',') !== 'deployment_audience,registry_bundle_path,registry_id,registry_root_key_sha256,registry_root_public_key_b64u,trust_mode') return undefined;
  if (typeof config.registry_bundle_path !== 'string' || !isAbsolute(config.registry_bundle_path) || resolve(config.registry_bundle_path) !== config.registry_bundle_path || typeof config.registry_id !== 'string' || typeof config.deployment_audience !== 'string' || typeof config.registry_root_public_key_b64u !== 'string' || typeof config.registry_root_key_sha256 !== 'string' || !['fixture', 'production'].includes(config.trust_mode as string)) return undefined;
  // A registry inside the repository/current working tree is agent-writable by definition.
  const cwdRelative = relative(process.cwd(), config.registry_bundle_path);
  if (cwdRelative === '' || (!cwdRelative.startsWith(`..${sep}`) && cwdRelative !== '..' && !isAbsolute(cwdRelative))) return undefined;
  return Object.freeze({ startup: Object.freeze({ registry_id: config.registry_id, deployment_audience: config.deployment_audience, registry_root_public_key_b64u: config.registry_root_public_key_b64u, registry_root_key_sha256: config.registry_root_key_sha256, trust_mode: config.trust_mode as 'fixture' | 'production' }), registry_bundle_path: config.registry_bundle_path });
}

function safePath(path: string, production: boolean): boolean {
  const parsed = parse(path); let current = parsed.root;
  for (const part of path.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)) {
    current = `${current}${current.endsWith(sep) ? '' : sep}${part}`;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current !== path && !stat.isDirectory())) return false;
    if (production && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) return false;
  }
  return true;
}

/** Reads one bounded immutable snapshot; every error is intentionally indistinguishable to callers. */
export function loadProtectedOperatorTrustRegistry(runtime: OperatorTrustRuntime | undefined): SignedOperatorTrustRegistryTransportV1 | undefined {
  if (!runtime) return undefined;
  const production = runtime.startup.trust_mode === 'production';
  // Node cannot prove Windows ACL/reparse-point safety for a production bundle.
  if (production && (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() === 0)) return undefined;
  let fd: number | undefined;
  try {
    if (!safePath(runtime.registry_bundle_path, production)) return undefined;
    const before = lstatSync(runtime.registry_bundle_path); if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxRegistryBytes || (production && (before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) !== 0))) return undefined;
    fd = openSync(runtime.registry_bundle_path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd); if (!opened.isFile() || !sameIdentity(before, opened) || opened.size > maxRegistryBytes) return undefined;
    const bytes = Buffer.alloc(opened.size); if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return undefined;
    const after = lstatSync(runtime.registry_bundle_path); const finished = fstatSync(fd); if (!sameIdentity(before, after) || !sameIdentity(opened, finished)) return undefined;
    const parsed = parseCanonicalJson(bytes); if (!plain(parsed) || Object.keys(parsed).sort().join(',') !== 'payload_b64u,root_signature_b64u' || typeof parsed.payload_b64u !== 'string' || typeof parsed.root_signature_b64u !== 'string') return undefined;
    return { payload_b64u: parsed.payload_b64u, root_signature_b64u: parsed.root_signature_b64u };
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
