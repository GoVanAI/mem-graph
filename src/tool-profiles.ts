import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDatabase } from './db.js';
import { errorResult, jsonResult } from './util.js';
import { runActivate } from './activate.js';
import { runMemoryAdd, runMemoryUpdate, runSupersede, runMemoryMark } from './tools/memory-write.js';
import { runTagAdd, runTagRemove } from './tools/memory-tags.js';
import { MemoryReadError, readMemoryEntry, readMemoryLinks } from './memory-read.js';
import { registerSqlTools } from './tools/sql.js';
import { registerMemoryOrientTools } from './tools/memory-orient.js';
import { registerMemorySearchTools } from './tools/memory-search.js';
import { registerMemoryWriteTools } from './tools/memory-write.js';
import { registerMemoryTagTools } from './tools/memory-tags.js';
import { registerMemoryGraphTools } from './tools/memory-graph.js';
import { registerMemoryImportTools } from './tools/memory-import.js';
import { registerCognitiveTools } from './tools/cognitive.js';
import { registerEpistemicTools } from './tools/epistemic.js';
import { appendCognitiveEvent, listCognitiveEvents, verifyCognitiveEventChain } from './cognitive/events.js';
import { COGNITIVE_EVENT_TYPES } from './cognitive/types.js';
import { diffEpistemicRecord, formatEpistemicError, queryEpistemicRecords, readEpistemicRecord } from './tools/epistemic.js';
import { runMemoryPrime } from './memory-prime.js';
import { runMemoryChanges, runMemoryRecent, runMemorySearch } from './tools/memory-search.js';
import type { OperatorTrustRuntime } from './cognitive/operator-trust-loader.js';

export const MCP_PROFILES = ['full', 'agent', 'maintenance'] as const;
export type McpProfile = (typeof MCP_PROFILES)[number];

/** Parse before opening SQLite so an invalid deployment cannot create a DB. */
export function parseMcpProfile(value = process.env.MCP_PROFILE): McpProfile {
  if (value === undefined || value === '') return 'full';
  if ((MCP_PROFILES as readonly string[]).includes(value)) return value as McpProfile;
  throw new Error(`Invalid MCP_PROFILE ${JSON.stringify(value)}; expected full, agent, or maintenance.`);
}

export const MAINTENANCE_TOOL_NAMES = [
  'cognitive_policy_create', 'cognitive_policy_evaluate', 'cognitive_policy_lookup',
  'epistemic_integrity_check', 'list_databases', 'memory_boost', 'memory_categories',
  'memory_decay', 'memory_import_from_mem_sol', 'memory_overview', 'memory_projects',
  'memory_spread_stats', 'memory_stale', 'memory_stats', 'memory_synapse_create',
  'sql_execute', 'sql_introspect', 'sql_query',
] as const;
export const AGENT_TOOL_NAMES = [
  'cognitive_agent_bootstrap', 'memory_prime', 'memory_find', 'memory_read',
  'memory_write', 'epistemic_inspect', 'epistemic_admit', 'epistemic_append_receipt',
  'cognitive_event_append', 'cognitive_event_read',
] as const;

type Registerable = McpServer & { tool: (...args: any[]) => unknown; registerTool: (...args: any[]) => unknown };

/* Existing tools are deliberately registered through their original adapters.
 * The filter only changes exposure; it neither wraps handlers nor changes schemas. */
function onlyTools(server: McpServer, names: readonly string[]): McpServer {
  const allowed = new Set<string>(names);
  const target = server as Registerable;
  return new Proxy(target, {
    get(obj, property, receiver) {
      if (property === 'tool') return (name: string, ...rest: any[]) => allowed.has(name) ? obj.tool(name, ...rest) : undefined;
      if (property === 'registerTool') return (name: string, ...rest: any[]) => allowed.has(name) ? obj.registerTool(name, ...rest) : undefined;
      const value = Reflect.get(obj, property, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  }) as unknown as McpServer;
}

function registerLegacy(server: McpServer, options: { operatorTrustRuntime?: OperatorTrustRuntime } = {}): void {
  registerSqlTools(server);
  registerMemoryOrientTools(server);
  registerMemorySearchTools(server);
  registerMemoryWriteTools(server);
  registerMemoryTagTools(server);
  registerMemoryGraphTools(server);
  registerMemoryImportTools(server);
  registerCognitiveTools(server, { ...options, profile: 'full' });
  registerEpistemicTools(server);
}

function inScope(row: { project_id: string }, projectId: string, includeGlobal: boolean): boolean {
  return row.project_id === projectId || (includeGlobal && row.project_id === '_global');
}

function globalWriteAllowed(projectId: string, confirmGlobal?: true): boolean {
  return projectId !== '_global' || confirmGlobal === true;
}

const layer = z.enum(['working', 'episodic', 'procedural', 'semantic', 'partner']);
const lifecycle = z.enum(['permanent', 'milestone', 'ephemeral']);
const status = z.enum(['active', 'superseded', 'archived', 'invalid']);
const eventFilters = {
  event_type: z.enum(COGNITIVE_EVENT_TYPES).optional(), task_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(), correlation_id: z.string().min(1).optional(),
  causation_id: z.string().min(1).optional(), after_sequence: z.number().int().nonnegative().optional(),
  before_sequence: z.number().int().positive().optional(), limit: z.number().int().positive().max(200).optional(),
} as const;

function register(server: McpServer, name: string, description: string, inputSchema: z.ZodTypeAny, handler: (input: any) => Promise<unknown> | unknown): void {
  // `registerTool` is the current SDK surface and supports discriminated-union
  // schemas. The fallback is limited to small test doubles used by legacy tests.
  const candidate = server as unknown as { registerTool?: Function; tool: Function };
  if (typeof candidate.registerTool === 'function') candidate.registerTool(name, { description, inputSchema }, handler);
  else candidate.tool(name, description, inputSchema, handler);
}

function memoryRow(db: ReturnType<typeof getDatabase>, id: number): Record<string, any> | undefined {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, any> | undefined;
}

function scopedMemory(db: ReturnType<typeof getDatabase>, id: number, projectId: string, includeGlobal: boolean): Record<string, any> | undefined {
  const row = memoryRow(db, id);
  return row && inScope(row as { project_id: string }, projectId, includeGlobal) ? row : undefined;
}

function agentError(code: string, message: string) { return jsonResult({ ok: false, code, message }); }

function findMemories(input: any) {
  const db = getDatabase('memory');
  const includeGlobal = input.include_global ?? false;
  const limit = input.limit ?? 20;
  try {
    if (input.operation === 'search') {
      const rows = runMemorySearch(db, { ...input, include_global: includeGlobal, limit });
      return jsonResult({ ok: true, operation: input.operation, results: rows, access_tracking: 'none' });
    }
    if (input.operation === 'recent') {
      const rows = runMemoryRecent(db, { ...input, include_global: includeGlobal, limit });
      return jsonResult({ ok: true, operation: input.operation, results: rows, access_tracking: 'none' });
    }
    if (input.operation === 'changes') {
      const rows = runMemoryChanges(db, { ...input, include_global: includeGlobal, limit });
      return jsonResult({ ok: true, operation: input.operation, results: rows, access_tracking: 'none' });
    }
    const rows = runActivate(db, { query: input.query, project_id: input.project_id, include_global: includeGlobal, max_hop_depth: input.max_hop_depth, min_synapse_weight: input.min_synapse_weight, limit_cap: limit, land_on_layers: input.land_on_layers, pass_through_layers: input.pass_through_layers, strict_scope: true });
    return jsonResult({ ok: true, operation: input.operation, results: rows, access_tracking: 'touched_returned_memories_and_synapses' });
  } catch (error) { return agentError('MEMORY_FIND_ERROR', error instanceof Error ? error.message : String(error)); }
}

function readMemory(input: any) {
  const db = getDatabase('memory');
  const scope = { project_id: input.project_id, include_global: input.include_global ?? false };
  try {
    if (input.operation === 'get') {
      const result = readMemoryEntry(db, input.id, scope);
      return jsonResult({ ok: true, operation: 'get', touched: true, memory: result.memory });
    }
    const result = readMemoryLinks(db, {
      id: input.id, direction: input.direction, connection_type: input.connection_type,
      min_weight: input.min_weight, limit: input.limit,
    }, scope);
    const links: Array<Record<string, unknown>> = [];
    for (const row of result.rows) {
      if (inScope({ project_id: row.other_project_id }, input.project_id, scope.include_global)) {
        links.push({ source_id: row.source_id, target_id: row.target_id, connection_type: row.connection_type, weight: row.weight, access_count: row.access_count, created_at: row.created_at, updated_at: row.updated_at, id: row.other_id, project_id: row.other_project_id, layer: row.other_layer, title: row.other_title, summary: row.other_summary, status: row.other_status, foreign_stub: false });
        continue;
      }
      // A foreign explicit wikilink establishes topology but never hydrates content.
      if (row.connection_type === 'wikilink') links.push({ source_id: row.source_id, target_id: row.target_id, connection_type: row.connection_type, weight: row.weight, foreign_stub: true, target: { id: row.other_id, project_id: row.other_project_id, title: row.other_title, type: row.other_layer } });
    }
    return jsonResult({ ok: true, operation: 'links', touched: false, memory: { id: result.memory.id, project_id: result.memory.project_id, title: result.memory.title, tags: result.tags }, links });
  } catch (error) {
    if (error instanceof MemoryReadError) return agentError('OUT_OF_SCOPE', `memory ${input.id} is unavailable in project ${input.project_id}`);
    return agentError('MEMORY_READ_ERROR', error instanceof Error ? error.message : String(error));
  }
}

function writeMemory(input: any) {
  const db = getDatabase('memory');
  if (!globalWriteAllowed(input.project_id, input.confirm_global)) return agentError('GLOBAL_CONFIRMATION_REQUIRED', 'set confirm_global=true for deliberate _global mutation');
  try {
    if (input.operation === 'add') {
      const result = runMemoryAdd(db, input);
      return jsonResult({ ok: true, operation: 'add', result: { id: result.id, project_id: result.project_id, wikilinks_resolved: result.wikilinks_resolved, broken_wikilinks: result.broken_wikilinks, auto_links: result.auto_links } });
    }
    if (input.operation === 'supersede') {
      if (!scopedMemory(db, input.old_id, input.project_id, false) || !scopedMemory(db, input.new_id, input.project_id, false)) return agentError('OUT_OF_SCOPE', 'both supersession endpoints must be in the explicit project');
      return jsonResult({ ok: true, operation: 'supersede', result: runSupersede(db, input.old_id, input.new_id, input.reason) });
    }
    const existing = scopedMemory(db, input.id, input.project_id, false);
    if (!existing) return agentError('OUT_OF_SCOPE', `memory ${input.id} is unavailable in project ${input.project_id}`);
    if (input.operation === 'tag_add') return jsonResult({ ok: true, operation: input.operation, result: runTagAdd(db, input.id, input.tag) });
    if (input.operation === 'tag_remove') return jsonResult({ ok: true, operation: input.operation, result: runTagRemove(db, input.id, input.tag) });
    if (input.operation === 'mark') { if (!runMemoryMark(db, input.id, input.status)) return agentError('NOT_FOUND', `memory ${input.id} does not exist`); return jsonResult({ ok: true, operation: 'mark', id: input.id, status: input.status, reason: input.reason ?? null }); }
    runMemoryUpdate(db, { id: input.id, title: input.title, content: input.content, summary: input.summary, tags: input.tags, category: input.category, layer: input.layer, lifecycle: input.lifecycle, confidence: input.confidence, importance_score: input.importance_score }, { allowTagsOnly: true });
    return jsonResult({ ok: true, operation: 'update', id: input.id });
  } catch (error) { return agentError('MEMORY_WRITE_ERROR', error instanceof Error ? error.message : String(error)); }
}

function inspectEpistemic(input: any) {
  const db = getDatabase('memory'); const includeGlobal = input.include_global ?? false;
  try {
    if (input.operation === 'get') return jsonResult({ ok: true, operation: 'get', ...readEpistemicRecord(db, input) });
    if (input.operation === 'query') return jsonResult({ ok: true, operation: 'query', ...queryEpistemicRecords(db, input) });
    return jsonResult({ ok: true, operation: 'diff', ...diffEpistemicRecord(db, input) });
  } catch (error) { return jsonResult({ ok: false, ...formatEpistemicError(error) }); }
}

const findSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('search'), project_id: z.string().min(1), include_global: z.boolean().optional(), query: z.string().min(1), status: status.optional(), category: z.string().optional(), layer: layer.optional(), limit: z.number().int().positive().max(100).optional() }).strict(),
  z.object({ operation: z.literal('recent'), project_id: z.string().min(1), include_global: z.boolean().optional(), category: z.string().optional(), layer: layer.optional(), lifecycle: lifecycle.optional(), limit: z.number().int().positive().max(100).optional() }).strict(),
  z.object({ operation: z.literal('changes'), project_id: z.string().min(1), include_global: z.boolean().optional(), since: z.string().min(1), limit: z.number().int().positive().max(200).optional() }).strict(),
  z.object({ operation: z.literal('related'), project_id: z.string().min(1), include_global: z.boolean().optional(), query: z.string().min(1), max_hop_depth: z.number().int().min(1).max(5).optional(), min_synapse_weight: z.number().min(0).max(5).optional(), land_on_layers: z.array(layer).optional(), pass_through_layers: z.array(layer).optional(), limit: z.number().int().positive().max(100).optional() }).strict(),
]);
const readSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('get'), id: z.number().int().positive(), project_id: z.string().min(1), include_global: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal('links'), id: z.number().int().positive(), project_id: z.string().min(1), include_global: z.boolean().optional(), direction: z.enum(['outgoing', 'incoming', 'both']).optional(), connection_type: z.enum(['wikilink', 'bm25_auto', 'parent_child']).optional(), min_weight: z.number().min(0).max(5).optional(), limit: z.number().int().positive().max(200).optional() }).strict(),
]);
const writeSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('add'), project_id: z.string().min(1), confirm_global: z.literal(true).optional(), category: z.string().min(1), title: z.string().min(1), content: z.string(), layer: layer.optional(), summary: z.string().optional(), tags: z.array(z.string()).optional(), lifecycle: lifecycle.optional(), confidence: z.number().min(0).max(1).optional(), importance_score: z.number().min(0).max(1).optional(), session_id: z.string().optional(), source: z.enum(['session', 'import', 'manual', 'derived']).optional() }).strict(),
  z.object({ operation: z.literal('update'), project_id: z.string().min(1), confirm_global: z.literal(true).optional(), id: z.number().int().positive(), title: z.string().optional(), content: z.string().optional(), summary: z.string().optional(), tags: z.array(z.string()).optional(), category: z.string().optional(), layer: layer.optional(), lifecycle: lifecycle.optional(), confidence: z.number().min(0).max(1).optional(), importance_score: z.number().min(0).max(1).optional() }).strict(),
  z.object({ operation: z.literal('mark'), project_id: z.string().min(1), confirm_global: z.literal(true).optional(), id: z.number().int().positive(), status, reason: z.string().optional() }).strict(),
  z.object({ operation: z.literal('supersede'), project_id: z.string().min(1), confirm_global: z.literal(true).optional(), old_id: z.number().int().positive(), new_id: z.number().int().positive(), reason: z.string().optional() }).strict(),
  z.object({ operation: z.literal('tag_add'), project_id: z.string().min(1), confirm_global: z.literal(true).optional(), id: z.number().int().positive(), tag: z.string().min(1) }).strict(),
  z.object({ operation: z.literal('tag_remove'), project_id: z.string().min(1), confirm_global: z.literal(true).optional(), id: z.number().int().positive(), tag: z.string().min(1) }).strict(),
]);
const inspectSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('get'), record_id: z.number().int().positive(), project_id: z.string().min(1), include_global: z.boolean().optional(), as_of: z.string().optional() }).strict(),
  z.object({ operation: z.literal('query'), project_id: z.string().min(1), include_global: z.boolean().optional(), scope: z.enum(['exact-project', '_global']).optional(), epistemic_status: z.enum(['verified','corroborated','inferred','reported','assumed','contested','stale','retracted']).optional(), limit: z.number().int().positive().max(500).optional() }).strict(),
  z.object({ operation: z.literal('diff'), record_id: z.number().int().positive(), project_id: z.string().min(1), include_global: z.boolean().optional(), from_as_of: z.string().min(1), to_as_of: z.string().min(1), include_unchanged: z.boolean().optional(), include_retracted: z.boolean().optional() }).strict(),
]);

// MCP's JSON-schema conversion does not advertise a root discriminated union
// reliably. These object schemas are the public discovery contract; strict
// operation-specific schemas above remain the authority at execution time.
const findInputSchema = z.object({ operation: z.enum(['search', 'recent', 'changes', 'related']), project_id: z.string().min(1), include_global: z.boolean().optional(), query: z.string().optional(), since: z.string().optional(), status: status.optional(), category: z.string().optional(), layer: layer.optional(), lifecycle: lifecycle.optional(), limit: z.number().optional(), max_hop_depth: z.number().optional(), min_synapse_weight: z.number().optional(), land_on_layers: z.array(layer).optional(), pass_through_layers: z.array(layer).optional() }).passthrough();
const readInputSchema = z.object({ operation: z.enum(['get', 'links']), id: z.number().int().positive(), project_id: z.string().min(1), include_global: z.boolean().optional(), direction: z.enum(['outgoing', 'incoming', 'both']).optional(), connection_type: z.enum(['wikilink', 'bm25_auto', 'parent_child']).optional(), min_weight: z.number().optional(), limit: z.number().optional() }).passthrough();
const writeInputSchema = z.object({ operation: z.enum(['add', 'update', 'mark', 'supersede', 'tag_add', 'tag_remove']), project_id: z.string().min(1), confirm_global: z.literal(true).optional(), id: z.number().optional(), old_id: z.number().optional(), new_id: z.number().optional(), category: z.string().optional(), title: z.string().optional(), content: z.string().optional(), layer: layer.optional(), summary: z.string().optional(), tags: z.array(z.string()).optional(), lifecycle: lifecycle.optional(), confidence: z.number().optional(), importance_score: z.number().optional(), session_id: z.string().optional(), source: z.enum(['session', 'import', 'manual', 'derived']).optional(), status: status.optional(), reason: z.string().optional(), tag: z.string().optional() }).passthrough();
const inspectInputSchema = z.object({ operation: z.enum(['get', 'query', 'diff']), record_id: z.number().optional(), project_id: z.string().min(1), include_global: z.boolean().optional(), as_of: z.string().optional(), scope: z.enum(['exact-project', '_global']).optional(), epistemic_status: z.enum(['verified','corroborated','inferred','reported','assumed','contested','stale','retracted']).optional(), limit: z.number().optional(), from_as_of: z.string().optional(), to_as_of: z.string().optional(), include_unchanged: z.boolean().optional(), include_retracted: z.boolean().optional() }).passthrough();

function strictFamily<T extends z.ZodTypeAny>(schema: T, handler: (input: z.infer<T>) => unknown) {
  return (input: unknown) => {
    const parsed = schema.safeParse(input);
    return parsed.success ? handler(parsed.data) : errorResult(`Invalid family operation: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  };
}

function registerAgentTools(server: McpServer, options: { operatorTrustRuntime?: OperatorTrustRuntime }): void {
  // These four retain their original domain handlers and schemas; no handler is called from another handler.
  const existing = onlyTools(server, ['cognitive_agent_bootstrap', 'cognitive_event_append', 'epistemic_admit', 'epistemic_append_receipt']);
  registerCognitiveTools(existing, { ...options, profile: 'agent' }); registerEpistemicTools(existing);
  register(server, 'memory_find', 'Scoped agent retrieval: search, recent, changes, or related.', findInputSchema, strictFamily(findSchema, findMemories));
  register(server, 'memory_read', 'Scoped agent memory read: get or links.', readInputSchema, strictFamily(readSchema, readMemory));
  register(server, 'memory_write', 'Scoped agent mutation: add, update, mark, supersede, tag_add, or tag_remove.', writeInputSchema, strictFamily(writeSchema, writeMemory));
  register(server, 'epistemic_inspect', 'Scoped read-only epistemic inspection: get, query, or diff.', inspectInputSchema, strictFamily(inspectSchema, inspectEpistemic));
  register(server, 'cognitive_event_read', 'Read bounded Cognitive OS events for the required project only.', z.object({ project_id: z.string().min(1), ...eventFilters }).strict(), (input) => jsonResult({ ok: true, integrity: verifyCognitiveEventChain(getDatabase('memory')), events: listCognitiveEvents(getDatabase('memory'), input) }));
  // The agent prime is intentionally a separate adapter. It is scope-explicit,
  // but uses the same persisted fields and zero-write selection rules as legacy prime.
  register(server, 'memory_prime', 'Scope-explicit, zero-write agent session primer.', z.object({ project_id: z.string().min(1), include_global: z.boolean().optional(), max_tokens: z.number().int().positive().max(16384).optional(), include_archived: z.boolean().optional() }).strict(), (input) => agentPrime(input));
}

function agentPrime(input: { project_id: string; include_global?: boolean; max_tokens?: number; include_archived?: boolean }) {
  const result = runMemoryPrime(getDatabase('memory'), { ...input, include_global: input.include_global ?? false });
  return jsonResult({ ...result, scope: { project_id: input.project_id, include_global: input.include_global ?? false }, access_tracking: 'none' });
}

export function registerToolsForProfile(server: McpServer, profile: McpProfile, options: { operatorTrustRuntime?: OperatorTrustRuntime } = {}): void {
  if (profile === 'full') { registerLegacy(server, options); return; }
  if (profile === 'maintenance') { registerLegacy(onlyTools(server, MAINTENANCE_TOOL_NAMES), options); return; }
  // Preserve the startup snapshot even in agent profile: it belongs to the
  // bootstrap handler. Re-registering only that handler requires the supplied runtime.
  // The original registration above accepts runtime only for cognitive tools.
  registerAgentTools(server, options);
}
