import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

/** Pure, detached verification for the T1 operator-adoption contract.  This
 * module deliberately accepts bytes/values from its caller and performs no I/O. */
export const OPERATOR_ADOPTION_FAILURE_CODES = [
  'adoption_receipt_missing', 'adoption_receipt_malformed', 'adoption_contract_unsupported',
  'adoption_signature_invalid', 'adoption_signer_untrusted', 'adoption_key_revoked',
  'adoption_key_not_yet_valid', 'adoption_key_expired', 'adoption_epoch_expired',
  'adoption_receipt_revoked', 'adoption_receipt_not_yet_valid', 'adoption_receipt_expired',
  'adoption_receipt_ttl_exceeded', 'adoption_manifest_mismatch', 'adoption_scope_mismatch',
  'adoption_capability_insufficient', 'trust_registry_unavailable',
] as const;
export type AdoptionFailureCode = (typeof OPERATOR_ADOPTION_FAILURE_CODES)[number];

export interface SignedOperatorAdoptionTransportV1 { payload_b64u: string; signature_b64u: string }
export interface SignedOperatorTrustRegistryTransportV1 { payload_b64u: string; root_signature_b64u: string }
export interface OperatorReceiptRef { kind: 'operator_receipt'; receipt_id: string; project_id: string; task_id: string }
export interface OperatorTrustStartupDescriptorV1 {
  registry_id: string; deployment_audience: string; registry_root_public_key_b64u: string;
  registry_root_key_sha256: string; trust_mode: 'production' | 'fixture';
}
export interface OperatorAdoptionVerificationInput {
  receipt?: SignedOperatorAdoptionTransportV1 | null;
  registry?: SignedOperatorTrustRegistryTransportV1 | null;
  startup: OperatorTrustStartupDescriptorV1;
  manifest: unknown;
  manifest_receipt_ref: OperatorReceiptRef | null;
  request_scope: { project_id: string; task_id: string; include_global?: boolean };
  event_scope: { project_id: string; task_id: string };
  evaluated_at: string;
}
export interface AdoptionVerificationVerdictV1 {
  status: 'verified' | 'unverified'; capability: 'task_state_governing'; authority_ceiling: 'task_orientation_only';
  manifest_sha256: string; evaluated_at: string; receipt_id?: string; signer_key_id?: string;
  receipt_sha256?: string; trust_registry_sha256?: string; trust_policy_sha256?: string;
  deployment_audience?: string; failure_codes: Array<AdoptionFailureCode | 'manifest_adoption_unverified'>;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordJson = { [key: string]: Json };
const receiptDomain = 'mem-graph/operator-adoption/v1\n';
const registryDomain = 'mem-graph/operator-trust-registry/v1\n';
const b64u = /^(?:[A-Za-z0-9_-]{2,}|[A-Za-z0-9_-]{3}(?:[A-Za-z0-9_-]{4})*)$/;
const sha256Hex = /^[a-f0-9]{64}$/;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const utf8 = new TextEncoder();

function sha256(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
function record(value: Json): value is RecordJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: unknown, required: string[], optional: string[] = []): value is RecordJson {
  const candidate = value as Json;
  return record(candidate) && required.every((key) => Object.hasOwn(candidate, key))
    && Object.keys(candidate).every((key) => required.includes(key) || optional.includes(key));
}
function text(value: unknown, max = 512): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function validStartup(value: unknown): value is RecordJson {
  return exact(value, ['registry_id', 'deployment_audience', 'registry_root_public_key_b64u', 'registry_root_key_sha256', 'trust_mode'])
    && text(value.registry_id) && text(value.deployment_audience) && decodeBase64Url(value.registry_root_public_key_b64u)?.length === 32
    && typeof value.registry_root_key_sha256 === 'string' && sha256Hex.test(value.registry_root_key_sha256)
    && (value.trust_mode === 'fixture' || value.trust_mode === 'production');
}
function validRequestScope(value: unknown): value is RecordJson {
  return exact(value, ['project_id', 'task_id'], ['include_global']) && text(value.project_id) && text(value.task_id)
    && (value.include_global === undefined || typeof value.include_global === 'boolean');
}
function validEventScope(value: unknown): value is RecordJson {
  return exact(value, ['project_id', 'task_id']) && text(value.project_id) && text(value.task_id);
}
function validVerificationInput(value: unknown): value is RecordJson {
  return exact(value, ['startup', 'manifest', 'manifest_receipt_ref', 'request_scope', 'event_scope', 'evaluated_at'], ['receipt', 'registry'])
    && typeof value.evaluated_at === 'string';
}

/** Decodes only canonical, unpadded base64url. */
export function decodeBase64Url(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !b64u.test(value) || value.length % 4 === 1) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
  } catch { return null; }
}

class StrictJsonParser {
  private at = 0;
  constructor(private readonly source: string) {}
  parse(): Json { const value = this.value(); this.ws(); if (this.at !== this.source.length) throw new Error('trailing JSON'); return value; }
  private ws(): void { while (/\s/.test(this.source[this.at] ?? '')) this.at++; }
  private value(): Json {
    this.ws(); const ch = this.source[this.at];
    if (ch === '{') return this.object(); if (ch === '[') return this.array(); if (ch === '"') return this.string();
    if (ch === 't' && this.source.slice(this.at, this.at + 4) === 'true') { this.at += 4; return true; }
    if (ch === 'f' && this.source.slice(this.at, this.at + 5) === 'false') { this.at += 5; return false; }
    if (ch === 'n' && this.source.slice(this.at, this.at + 4) === 'null') { this.at += 4; return null; }
    if (ch === '-' || (ch !== undefined && /[0-9]/.test(ch))) return this.number();
    throw new Error('invalid JSON value');
  }
  private object(): RecordJson {
    const out: RecordJson = {}; const seen = new Set<string>(); this.at++; this.ws();
    if (this.source[this.at] === '}') { this.at++; return out; }
    for (;;) { this.ws(); if (this.source[this.at] !== '"') throw new Error('object key'); const key = this.string();
      if (seen.has(key)) throw new Error('duplicate key'); seen.add(key); this.ws(); if (this.source[this.at++] !== ':') throw new Error('colon');
      out[key] = this.value(); this.ws(); const sep = this.source[this.at++]; if (sep === '}') return out; if (sep !== ',') throw new Error('object separator'); }
  }
  private array(): Json[] {
    const out: Json[] = []; this.at++; this.ws(); if (this.source[this.at] === ']') { this.at++; return out; }
    for (;;) { out.push(this.value()); this.ws(); const sep = this.source[this.at++]; if (sep === ']') return out; if (sep !== ',') throw new Error('array separator'); }
  }
  private string(): string {
    const start = this.at++; let escaped = false;
    while (this.at < this.source.length) { const code = this.source.charCodeAt(this.at++); if (code < 0x20) throw new Error('control string');
      if (escaped) { if (code === 0x75) { const hex = this.source.slice(this.at, this.at + 4); if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('unicode escape'); this.at += 4; } else if (!'"\\/bfnrt'.includes(String.fromCharCode(code))) throw new Error('escape'); escaped = false; continue; }
      if (code === 0x5c) { escaped = true; continue; } if (code === 0x22) { const raw = this.source.slice(start, this.at); const parsed = JSON.parse(raw) as string; if (hasLoneSurrogate(parsed)) throw new Error('lone surrogate'); return parsed; }
    } throw new Error('unterminated string');
  }
  private number(): number { const start = this.at; const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.at)); if (!match) throw new Error('number'); this.at += match[0].length; const value = Number(match[0]); if (!Number.isFinite(value)) throw new Error('nonfinite'); return value; }
}
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code >= 0xd800 && code <= 0xdbff) { if (++i >= value.length || value.charCodeAt(i) < 0xdc00 || value.charCodeAt(i) > 0xdfff) return true; } else if (code >= 0xdc00 && code <= 0xdfff) return true; } return false;
}
/** RFC 8785 JCS for valid I-JSON values. V8's JSON number serialization is the ECMAScript serialization mandated by JCS. */
export function canonicalizeJcs(value: unknown): string {
  const stack = new Set<object>();
  const visit = (item: unknown): string => {
    if (item === null || typeof item === 'boolean') return String(item);
    if (typeof item === 'string') { if (hasLoneSurrogate(item)) throw new Error('lone surrogate'); return JSON.stringify(item); }
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error('nonfinite'); return JSON.stringify(item); }
    if (Array.isArray(item)) {
      if (stack.has(item)) throw new Error('cyclic JSON array');
      stack.add(item); const output = `[${item.map(visit).join(',')}]`; stack.delete(item); return output;
    }
    if (!record(item as Json) || stack.has(item as object)) throw new Error('invalid JSON object');
    const objectValue = item as Record<string, unknown>; stack.add(objectValue);
    const output = `{${Object.keys(objectValue).sort().map((key) => { if (hasLoneSurrogate(key)) throw new Error('lone surrogate'); return `${JSON.stringify(key)}:${visit(objectValue[key])}`; }).join(',')}}`;
    stack.delete(objectValue); return output;
  };
  return visit(value);
}
export function parseCanonicalJson(bytes: Uint8Array): Json | null {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const value = new StrictJsonParser(source).parse();
    const canonical = utf8.encode(canonicalizeJcs(value));
    return canonical.length === bytes.length && canonical.every((byte, index) => byte === bytes[index]) ? value : null;
  } catch { return null; }
}
export function canonicalJsonSha256(value: unknown): string { return sha256(utf8.encode(canonicalizeJcs(value))); }
/** Runtime structural counterparts for the two T1 JSON schemas. */
export function isOperatorAdoptionReceiptPayloadV1(value: unknown): boolean {
  if (!record(value as Json) || !validateReceipt(value as Json)) return false;
  const receipt = value as RecordJson; const issuer = receipt.issuer as RecordJson; const grant = receipt.grant as RecordJson;
  return receipt.schema_version === '1.0.0' && receipt.action === 'adopt_task_state_manifest' && issuer.algorithm === 'Ed25519'
    && includesOnly(grant.capabilities, 'task_state_governing') && grant.authority_ceiling === 'task_orientation_only';
}
export function isOperatorTrustRegistryPayloadV1(value: unknown): boolean { return record(value as Json) && validateRegistry(value as Json); }
function ed25519Key(raw: Uint8Array): ReturnType<typeof createPublicKey> | null {
  if (raw.length !== 32) return null;
  try { return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]), format: 'der', type: 'spki' }); } catch { return null; }
}
function time(value: unknown): number | null { if (typeof value !== 'string' || !timestamp.test(value)) return null; const result = Date.parse(value); return Number.isFinite(result) && new Date(result).toISOString() === value ? result : null; }
function includesOnly(value: unknown, exactValue: string): boolean { return Array.isArray(value) && value.length === 1 && value[0] === exactValue; }
function push(failures: AdoptionVerificationVerdictV1['failure_codes'], code: AdoptionFailureCode): void { if (!failures.includes(code)) failures.push(code); }
interface ManifestDigest { value: string; valid: boolean }
function manifestDigest(value: unknown): ManifestDigest {
  try { return { value: canonicalJsonSha256(value), valid: true }; } catch { return { value: sha256('invalid-manifest-input'), valid: false }; }
}
function unverified(input: OperatorAdoptionVerificationInput, failures: AdoptionVerificationVerdictV1['failure_codes'], details: Partial<AdoptionVerificationVerdictV1> = {}, digest = manifestDigest(input.manifest)): AdoptionVerificationVerdictV1 {
  if (!failures.includes('manifest_adoption_unverified')) failures.push('manifest_adoption_unverified');
  return { status: 'unverified', capability: 'task_state_governing', authority_ceiling: 'task_orientation_only', manifest_sha256: digest.value, evaluated_at: input.evaluated_at, failure_codes: failures, ...details };
}

export function verifyOperatorAdoption(input: unknown): AdoptionVerificationVerdictV1 {
  if (!validVerificationInput(input)) {
    return { status: 'unverified', capability: 'task_state_governing', authority_ceiling: 'task_orientation_only', manifest_sha256: sha256('invalid-verification-input'), evaluated_at: '', failure_codes: ['adoption_receipt_malformed', 'manifest_adoption_unverified'] };
  }
  return verifyOperatorAdoptionInput(input as unknown as OperatorAdoptionVerificationInput);
}

function verifyOperatorAdoptionInput(input: OperatorAdoptionVerificationInput): AdoptionVerificationVerdictV1 {
  const failures: AdoptionVerificationVerdictV1['failure_codes'] = [];
  const digest = manifestDigest(input.manifest); const manifest_sha256 = digest.value;
  if (!digest.valid) { push(failures, 'adoption_manifest_mismatch'); return unverified(input, failures, {}, digest); }
  if (!input.receipt) { push(failures, 'adoption_receipt_missing'); return unverified(input, failures, {}, digest); }
  if (!exact(input.receipt, ['payload_b64u', 'signature_b64u'])) { push(failures, 'adoption_receipt_malformed'); return unverified(input, failures, {}, digest); }
  const payloadBytes = decodeBase64Url(input.receipt.payload_b64u); const signature = decodeBase64Url(input.receipt.signature_b64u);
  if (!payloadBytes || !signature || signature.length !== 64) { push(failures, 'adoption_receipt_malformed'); return unverified(input, failures, {}, digest); }
  const receipt = parseCanonicalJson(payloadBytes);
  if (!receipt || !validateReceipt(receipt)) { push(failures, 'adoption_receipt_malformed'); return unverified(input, failures, {}, digest); }
  const receipt_sha256 = sha256(payloadBytes); const receiptId = receipt.receipt_id as string;
  if (!validStartup(input.startup)) { push(failures, 'trust_registry_unavailable'); return unverified(input, failures, { receipt_id: receiptId, receipt_sha256 }, digest); }
  if (!input.registry) { push(failures, 'trust_registry_unavailable'); return unverified(input, failures, { receipt_id: receiptId, receipt_sha256 }); }
  if (!exact(input.registry, ['payload_b64u', 'root_signature_b64u'])) { push(failures, 'trust_registry_unavailable'); return unverified(input, failures, { receipt_id: receiptId, receipt_sha256 }); }
  const registryBytes = decodeBase64Url(input.registry.payload_b64u); const rootSignature = decodeBase64Url(input.registry.root_signature_b64u); const rootRaw = decodeBase64Url(input.startup.registry_root_public_key_b64u);
  if (!registryBytes || !rootSignature || rootSignature.length !== 64 || !rootRaw || rootRaw.length !== 32 || !sha256Hex.test(input.startup.registry_root_key_sha256) || sha256(rootRaw) !== input.startup.registry_root_key_sha256) { push(failures, 'trust_registry_unavailable'); return unverified(input, failures, { receipt_id: receiptId, receipt_sha256 }); }
  const registry = parseCanonicalJson(registryBytes); const root = ed25519Key(rootRaw);
  if (!registry || !root || !validateRegistry(registry) || !verifySignature(null, Buffer.concat([Buffer.from(registryDomain), Buffer.from(registryBytes)]), root, rootSignature)) { push(failures, 'trust_registry_unavailable'); return unverified(input, failures, { receipt_id: receiptId, receipt_sha256 }); }
  const trust_registry_sha256 = sha256(registryBytes); const policy = registry.policy as RecordJson; const trust_policy_sha256 = canonicalJsonSha256(policy);
  const issuer = receipt.issuer as RecordJson; const grant = receipt.grant as RecordJson; const subject = receipt.subject as RecordJson;
  const details = { receipt_id: receiptId, receipt_sha256, trust_registry_sha256, trust_policy_sha256, deployment_audience: registry.deployment_audience as string };
  if (input.startup.trust_mode !== 'fixture' && input.startup.trust_mode !== 'production') { push(failures, 'trust_registry_unavailable'); return unverified(input, failures, details); }
  if (registry.registry_id !== input.startup.registry_id || registry.deployment_audience !== input.startup.deployment_audience || registry.trust_mode !== input.startup.trust_mode || issuer.registry_id !== registry.registry_id || issuer.deployment_audience !== registry.deployment_audience || issuer.trust_policy_sha256 !== trust_policy_sha256) { push(failures, 'adoption_signer_untrusted'); return unverified(input, failures, details); }
  if (receipt.schema_version !== '1.0.0' || receipt.action !== 'adopt_task_state_manifest' || issuer.algorithm !== 'Ed25519') { push(failures, 'adoption_contract_unsupported'); return unverified(input, failures, details); }
  if (!includesOnly(grant.capabilities, 'task_state_governing') || grant.authority_ceiling !== 'task_orientation_only' || !includesOnly(policy.allowed_capabilities, 'task_state_governing') || policy.maximum_authority_ceiling !== 'task_orientation_only') { push(failures, 'adoption_capability_insufficient'); return unverified(input, failures, details); }
  const evaluated = time(input.evaluated_at); const issued = time(receipt.issued_at); const notBefore = time(receipt.not_before); const expires = time(receipt.expires_at);
  if (evaluated === null || issued === null || notBefore === null || expires === null) { push(failures, 'adoption_receipt_malformed'); return unverified(input, failures, details); }
  if (!(issued <= notBefore && notBefore < expires)) { push(failures, 'adoption_receipt_malformed'); return unverified(input, failures, details); }
  if ((expires - notBefore) / 1000 > (policy.max_receipt_ttl_seconds as number)) { push(failures, 'adoption_receipt_ttl_exceeded'); return unverified(input, failures, details); }
  if (evaluated < notBefore) { push(failures, 'adoption_receipt_not_yet_valid'); return unverified(input, failures, details); }
  if (evaluated >= expires) { push(failures, 'adoption_receipt_expired'); return unverified(input, failures, details); }
  const epoch = (registry.accepted_epochs as Json[]).find((entry) => record(entry) && entry.epoch === issuer.trust_epoch) as RecordJson | undefined;
  if (!epoch) { push(failures, 'adoption_signer_untrusted'); return unverified(input, failures, details); }
  const epochEnd = epoch.valid_until === undefined ? null : time(epoch.valid_until); if (epochEnd === null && epoch.valid_until !== undefined) { push(failures, 'trust_registry_unavailable'); return unverified(input, failures, details); }
  if (epochEnd !== null && evaluated >= epochEnd) { push(failures, 'adoption_epoch_expired'); return unverified(input, failures, details); }
  const key = (epoch.keys as Json[]).find((entry) => record(entry) && entry.key_id === issuer.key_id) as RecordJson | undefined;
  if (!key) { push(failures, 'adoption_signer_untrusted'); return unverified(input, failures, details); }
  if (key.status === 'revoked') { push(failures, 'adoption_key_revoked'); return unverified(input, failures, details); }
  if ((registry.revoked_receipt_ids as Json[]).includes(receiptId)) { push(failures, 'adoption_receipt_revoked'); return unverified(input, failures, details); }
  const keyStart = time(key.valid_from); const keyEnd = key.valid_until === undefined ? null : time(key.valid_until); if (keyStart === null || (keyEnd === null && key.valid_until !== undefined)) { push(failures, 'trust_registry_unavailable'); return unverified(input, failures, details); }
  if (evaluated < keyStart || issued < keyStart) { push(failures, 'adoption_key_not_yet_valid'); return unverified(input, failures, details); }
  if ((keyEnd !== null && evaluated >= keyEnd) || (keyEnd !== null && issued >= keyEnd)) { push(failures, 'adoption_key_expired'); return unverified(input, failures, details); }
  if (!validRequestScope(input.request_scope) || !validEventScope(input.event_scope)) { push(failures, 'adoption_scope_mismatch'); return unverified(input, failures, details); }
  if (!manifestBinding(input, receipt, manifest_sha256)) { push(failures, 'adoption_manifest_mismatch'); return unverified(input, failures, details); }
  if (!scopeBinding(input, receipt)) { push(failures, 'adoption_scope_mismatch'); return unverified(input, failures, details); }
  if (input.request_scope.include_global === true && grant.include_global !== true) { push(failures, 'adoption_scope_mismatch'); return unverified(input, failures, details); }
  const signingRaw = decodeBase64Url(key.public_key_b64u); const signingKey = signingRaw ? ed25519Key(signingRaw) : null;
  if (!signingRaw || signingRaw.length !== 32 || !signingKey || !verifySignature(null, Buffer.concat([Buffer.from(receiptDomain), Buffer.from(payloadBytes)]), signingKey, signature)) { push(failures, 'adoption_signature_invalid'); return unverified(input, failures, details); }
  void subject;
  return { status: 'verified', capability: 'task_state_governing', authority_ceiling: 'task_orientation_only', manifest_sha256, evaluated_at: input.evaluated_at, signer_key_id: key.key_id as string, failure_codes: [], ...details };
}

function manifestBinding(input: OperatorAdoptionVerificationInput, receipt: RecordJson, digest: string): boolean {
  if (!record(input.manifest as Json)) return false;
  const ref = input.manifest_receipt_ref; const manifest = input.manifest as RecordJson;
  const subject = receipt.subject as RecordJson; const adoption = manifest.adoption;
  if (!exact(ref, ['kind', 'receipt_id', 'project_id', 'task_id']) || !exact(adoption, ['status', 'source'])) return false;
  const source = adoption.source;
  return adoption.status === 'operator_adopted'
    && exact(source, ['kind', 'receipt_id', 'project_id', 'task_id']) && source.kind === 'operator_receipt'
    && source.receipt_id === ref.receipt_id && source.project_id === ref.project_id && source.task_id === ref.task_id
    && ref.receipt_id === receipt.receipt_id && ref.project_id === subject.project_id && ref.task_id === subject.task_id
    && record(manifest as Json) && manifest.manifest_id === subject.manifest_id && manifest.revision === subject.manifest_revision
    && manifest.project_id === subject.project_id && manifest.task_id === subject.task_id
    && (input.request_scope.include_global !== true || manifest.include_global === true)
    && subject.manifest_sha256 === digest;
}
function scopeBinding(input: OperatorAdoptionVerificationInput, receipt: RecordJson): boolean {
  const subject = receipt.subject as RecordJson;
  return subject.project_id === input.request_scope.project_id && subject.task_id === input.request_scope.task_id
    && input.event_scope.project_id === subject.project_id && input.event_scope.task_id === subject.task_id;
}
function validateReceipt(value: Json): value is RecordJson {
  if (!exact(value, ['schema_version', 'receipt_id', 'action', 'issuer', 'subject', 'grant', 'issued_at', 'not_before', 'expires_at', 'nonce'], ['supersedes_receipt_id'])) return false;
  const v = value as RecordJson; const issuer = v.issuer; const subject = v.subject; const grant = v.grant; const nonce = decodeBase64Url(v.nonce);
  return text(v.schema_version) && uuidV4.test(v.receipt_id as string) && text(v.action) && exact(issuer, ['key_id', 'algorithm', 'registry_id', 'deployment_audience', 'trust_epoch', 'trust_policy_sha256']) && text(issuer.key_id) && text(issuer.algorithm) && text(issuer.registry_id) && text(issuer.deployment_audience) && positiveInteger(issuer.trust_epoch) && typeof issuer.trust_policy_sha256 === 'string' && sha256Hex.test(issuer.trust_policy_sha256)
    && exact(subject, ['manifest_id', 'manifest_revision', 'manifest_sha256', 'project_id', 'task_id']) && text(subject.manifest_id) && positiveInteger(subject.manifest_revision) && typeof subject.manifest_sha256 === 'string' && sha256Hex.test(subject.manifest_sha256) && text(subject.project_id) && text(subject.task_id)
    && exact(grant, ['capabilities', 'authority_ceiling', 'include_global']) && Array.isArray(grant.capabilities) && grant.capabilities.every((capability) => typeof capability === 'string') && text(grant.authority_ceiling) && typeof grant.include_global === 'boolean'
    && time(v.issued_at) !== null && time(v.not_before) !== null && time(v.expires_at) !== null && nonce !== null && nonce.length >= 16
    && (v.supersedes_receipt_id === undefined || (typeof v.supersedes_receipt_id === 'string' && uuidV4.test(v.supersedes_receipt_id)));
}
function validateRegistry(value: Json): value is RecordJson {
  if (!exact(value, ['schema_version', 'registry_id', 'deployment_audience', 'trust_mode', 'current_epoch', 'accepted_epochs', 'revoked_receipt_ids', 'policy'])) return false;
  const v = value as RecordJson; if (v.schema_version !== '1.0.0' || !text(v.registry_id) || !text(v.deployment_audience) || !positiveInteger(v.current_epoch) || !Array.isArray(v.accepted_epochs) || !Array.isArray(v.revoked_receipt_ids) || !exact(v.policy, ['allowed_capabilities', 'maximum_authority_ceiling', 'max_receipt_ttl_seconds'])) return false;
  if (v.trust_mode !== 'fixture' && v.trust_mode !== 'production') return false;
  if (!Array.isArray(v.policy.allowed_capabilities) || !v.policy.allowed_capabilities.every((capability) => typeof capability === 'string') || !text(v.policy.maximum_authority_ceiling) || !positiveInteger(v.policy.max_receipt_ttl_seconds)) return false;
  const epochs = new Set<number>(); if (v.accepted_epochs.length === 0 || !v.accepted_epochs.every((entry) => validEpoch(entry, epochs, v.current_epoch as number)) || !epochs.has(v.current_epoch)) return false;
  const revoked = new Set<string>(); return v.revoked_receipt_ids.every((id) => typeof id === 'string' && uuidV4.test(id) && !revoked.has(id) && (revoked.add(id), true));
}
function validEpoch(value: Json, seen: Set<number>, currentEpoch: number): boolean {
  if (!exact(value, ['epoch', 'keys'], ['valid_until']) || !positiveInteger(value.epoch) || value.epoch > currentEpoch || seen.has(value.epoch) || !Array.isArray(value.keys) || (value.valid_until !== undefined && time(value.valid_until) === null)) return false; seen.add(value.epoch); const keys = new Set<string>();
  return value.keys.length > 0 && value.keys.every((key) => {
    if (!exact(key, ['key_id', 'algorithm', 'public_key_b64u', 'status', 'valid_from'], ['valid_until']) || !text(key.key_id) || keys.has(key.key_id as string) || key.algorithm !== 'Ed25519' || !['active', 'revoked'].includes(key.status as string) || decodeBase64Url(key.public_key_b64u)?.length !== 32) return false;
    const start = time(key.valid_from); const end = key.valid_until === undefined ? null : time(key.valid_until);
    if (start === null || (key.valid_until !== undefined && end === null) || (end !== null && start >= end)) return false;
    keys.add(key.key_id as string); return true;
  });
}
