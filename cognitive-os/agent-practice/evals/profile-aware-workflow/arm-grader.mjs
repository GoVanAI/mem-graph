// Single grader for the Step 4 Phase 4A profile-aware workflow contract.
// Takes (caseDoc, arm, transcript) and returns a structured grade with one
// check per contract field. The same grader evaluates representative
// fixtures (must pass) and counterexample fixtures (must fail with the
// fixture's expected_failure_code).
//
// Checks performed for every arm:
//   - tool names in the transcript belong to the arm's allowed_tool_names
//   - excluded_tools do NOT appear anywhere in the transcript
//   - transcript length is within allowed_call_cardinality { min, max }
//   - required_ordering_relationships hold between tool calls
//   - every required_tool_calls.calls entry appears in the transcript
//     and matches the per-call args_predicates + response_predicates
//   - scope preservation: every expansion call's args.project_id (or
//     equivalent scope field) equals expected_scope.project_id
//   - expansion_route metadata is consistent (route_available, tool_in_active_profile,
//     args_validate_structurally, preserve_scope)
//   - access effects: an expansion call declared as touches_access_counters
//     must NOT have response_envelope.access_tracking === 'none'
//   - bootstrap call must satisfy expected_bootstrap_mutation_or_access_behavior
//   - candidate-only: response_mode MUST equal 'compact' on the bootstrap
//     request and the bootstrap envelope MUST have response_mode === 'compact'
//   - control-only: response_mode MUST be absent OR equal 'legacy' on the
//     bootstrap request
//   - bootstrap envelope MUST NOT fabricate version_mismatch in the pd-06
//     candidate arm because the public MCP has no comparison seam
//
// Pure module: no I/O, no clock, no Math.random. Reuses Step 3
// structured-predicate.mjs for RFC 6901 pointer resolution.

import {
  evaluatePredicate,
  validatePredicate,
} from '../progressive-disclosure/structured-predicate.mjs';
import {
  FULL_PROFILE_TOOL_NAMES,
  AGENT_PROFILE_TOOL_NAMES,
  MAINTENANCE_PROFILE_TOOL_NAMES,
} from './tool-profiles-mirror.mjs';
export { FULL_PROFILE_TOOL_NAMES, AGENT_PROFILE_TOOL_NAMES, MAINTENANCE_PROFILE_TOOL_NAMES };

export const STABLE_FAILURE_CODES = {
  TOOL_NOT_IN_PROFILE: 'tool_not_in_profile',
  EXCLUDED_TOOL_PRESENT: 'excluded_tool_present',
  PROHIBITED_FAMILY_PRESENT: 'prohibited_family_present',
  CARDINALITY_OUT_OF_RANGE: 'cardinality_out_of_range',
  ORDERING_VIOLATION: 'ordering_violation',
  REQUIRED_CALL_MISSING: 'required_call_missing',
  REQUIRED_CALL_ARG_MISMATCH: 'required_call_arg_mismatch',
  REQUIRED_CALL_RESPONSE_MISMATCH: 'required_call_response_mismatch',
  EXPANSION_ROUTE_UNAVAILABLE_CALLED: 'expansion_route_unavailable_called',
  REQUIRED_EXPANSION_NOT_CALLED: 'required_expansion_not_called',
  OPTIONAL_EXPANSION_NOT_ALLOWED: 'optional_expansion_not_allowed',
  SCOPE_NOT_PRESERVED: 'scope_not_preserved',
  SCOPE_MISSING_PROJECT_ID: 'scope_missing_project_id',
  SEARCH_BEFORE_CREATE_VIOLATION: 'search_before_create_violation',
  RETRY_COUNT_EXCEEDED: 'retry_count_exceeded',
  ACCESS_TRACKING_LIE: 'access_tracking_lie',
  BOOTSTRAP_MUTATION_VIOLATION: 'bootstrap_mutation_violation',
  COMPACT_RESPONSE_MODE_MISSING: 'compact_response_mode_missing',
  LEGACY_RESPONSE_MODE_UNEXPECTED: 'legacy_response_mode_unexpected',
  PD06_VERSION_MISMATCH_FABRICATION: 'pd06_version_mismatch_fabrication',
  ORIENTATION_INVARIANT_VIOLATION: 'orientation_invariant_violation',
  RESPONSE_PREDICATE_FAILED: 'response_predicate_failed',
  REQUIRED_ARGUMENT_PREDICATE_FAILED: 'required_argument_predicate_failed',
  PREDICATE_INVALID: 'predicate_invalid',
};

function makeCheck(id, passed, detail, code) {
  return { id, passed, detail, code };
}

function checkToolMembership(transcript, armDoc) {
  const allowed = new Set(armDoc.allowed_tool_names ?? []);
  const violations = [];
  for (const [index, call] of (transcript ?? []).entries()) {
    if (!allowed.has(call.tool)) {
      violations.push({ index, tool: call.tool, label: `call[${index}].tool=${call.tool}` });
    }
  }
  return violations;
}

function checkExcludedTools(transcript, armDoc) {
  const excluded = new Set(armDoc.required_tool_calls?.excluded_tools ?? []);
  const violations = [];
  for (const [index, call] of (transcript ?? []).entries()) {
    if (excluded.has(call.tool)) {
      violations.push({ index, tool: call.tool, label: `call[${index}].tool=${call.tool}` });
    }
  }
  return violations;
}

function rewritePointerToTranscript(pointer, basePrefix) {
  if (!pointer || pointer === '' || pointer === '/') return `${basePrefix}`;
  if (pointer.startsWith('/transcript/')) return pointer;
  return `${basePrefix}${pointer}`;
}

function checkCardinality(transcript, armDoc) {
  const { min, max } = armDoc.allowed_call_cardinality ?? { min: 1, max: 1 };
  const n = (transcript ?? []).length;
  if (n < min) return { kind: 'below_min', observed: n, minimum: min };
  if (n > max) return { kind: 'above_max', observed: n, maximum: max };
  return null;
}

function checkOrdering(transcript, relationships) {
  const indices = new Map();
  for (const [index, call] of (transcript ?? []).entries()) {
    if (!indices.has(call.tool)) indices.set(call.tool, []);
    indices.get(call.tool).push(index);
  }
  const violations = [];
  for (const rel of relationships ?? []) {
    const pred = indices.get(rel.predecessor) ?? [];
    const succ = indices.get(rel.successor) ?? [];
    if (rel.type === 'must_precede') {
      if (pred.length === 0 || succ.length === 0) {
        violations.push({ rel, reason: 'missing_endpoint' });
        continue;
      }
      // There must exist a predecessor occurrence that is strictly before
      // some successor occurrence.
      const ok = pred.some((pi) => succ.some((si) => pi < si));
      if (!ok) violations.push({ rel, reason: 'predecessor_not_before_successor' });
    } else if (rel.type === 'must_follow') {
      if (pred.length === 0 || succ.length === 0) {
        violations.push({ rel, reason: 'missing_endpoint' });
        continue;
      }
      const ok = succ.some((si) => pred.some((pi) => pi > si));
      if (!ok) violations.push({ rel, reason: 'successor_not_before_predecessor' });
    } else if (rel.type === 'consecutive') {
      // The two tools must appear adjacently in either order; here we
      // require predecessor immediately followed by successor.
      const predLast = Math.max(...pred);
      const succFirst = Math.min(...succ);
      if (succFirst !== predLast + 1) {
        violations.push({ rel, reason: 'not_consecutive' });
      }
    } else if (rel.type === 'bootstrap_before_mutation') {
      const MUTATION_TOOLS = new Set([
        'memory_add', 'memory_update', 'memory_supersede', 'memory_mark',
        'memory_boost', 'memory_tag_add', 'memory_tag_remove',
        'memory_synapse_create', 'memory_decay', 'memory_import_from_mem_sol',
        'cognitive_event_append', 'cognitive_policy_create',
        'cognitive_policy_evaluate', 'epistemic_admit', 'epistemic_append_receipt',
        'sql_execute', 'memory_write',
      ]);
      const bootstrapIndices = indices.get('cognitive_agent_bootstrap') ?? [];
      const mutationIndices = [];
      for (const [index, call] of (transcript ?? []).entries()) {
        if (MUTATION_TOOLS.has(call.tool)) mutationIndices.push(index);
      }
      for (const mi of mutationIndices) {
        const lastBootstrap = Math.max(...bootstrapIndices, -1);
        if (mi <= lastBootstrap) {
          violations.push({ rel, reason: 'mutation_before_or_concurrent_with_bootstrap', mutation_index: mi });
        }
      }
    }
  }
  return violations;
}

function findCall(transcript, toolName, occurrence = 0) {
  let seen = 0;
  for (const [index, call] of (transcript ?? []).entries()) {
    if (call.tool === toolName) {
      if (seen === occurrence) return index;
      seen += 1;
    }
  }
  return -1;
}

function checkRequiredCalls(transcript, armDoc) {
  const calls = armDoc.required_tool_calls?.calls ?? [];
  const failures = [];
  const bootstrapEnv = transcript[0]?.response_envelope ?? {};
  const bootstrapExpansions = Array.isArray(bootstrapEnv.expansions) ? bootstrapEnv.expansions : [];
  for (const [index, call] of (transcript ?? []).entries()) {
    if (index === 0) continue;
    if (call.tool === 'cognitive_agent_bootstrap') continue;
    const sourceId = call?.args?.id ?? call?.args?.record_id;
    const matchingExpansion = bootstrapExpansions.find((entry) => entry?.source?.id === sourceId);
    if (matchingExpansion && matchingExpansion.route_available === false) {
      failures.push({ kind: STABLE_FAILURE_CODES.EXPANSION_ROUTE_UNAVAILABLE_CALLED, transcriptIndex: index, sourceId, tool: call.tool });
    }
    const expectedAccessTracking =
      call.tool === 'memory_get' || (call.tool === 'memory_read' && call?.args?.operation === 'get')
        ? 'touches_access_counters'
        : (call.tool === 'memory_find' && call?.args?.operation === 'related')
          ? 'touches_access_counters'
          : null;
    if (matchingExpansion && expectedAccessTracking && matchingExpansion.access_tracking !== expectedAccessTracking) {
      failures.push({ kind: STABLE_FAILURE_CODES.ACCESS_TRACKING_LIE, transcriptIndex: index, sourceId, observed: matchingExpansion.access_tracking, expected: expectedAccessTracking });
    }
  }
  for (const [reqIndex, required] of calls.entries()) {
    const occurrence = required.occurrence ?? 0;
    const callIndex = findCall(transcript, required.tool, occurrence);
    if (callIndex < 0) {
      failures.push({ kind: STABLE_FAILURE_CODES.REQUIRED_CALL_MISSING, requiredIndex: reqIndex, tool: required.tool, label: 'required call ' + required.tool + ' not in transcript' });
      continue;
    }
    const call = transcript[callIndex];
    const routeContract = required.expansion_route;
    if (routeContract) {
      for (const field of ['route_available', 'tool_in_active_profile', 'args_validate_structurally', 'preserve_scope']) {
        if (routeContract[field] !== true) {
          failures.push({ kind: STABLE_FAILURE_CODES.REQUIRED_CALL_ARG_MISMATCH, requiredIndex: reqIndex, reason: `required expansion metadata ${field} must be true`, observed: routeContract[field] });
        }
      }
    }
    if (routeContract?.args_validate_structurally === true) {
      const matchingRoute = bootstrapExpansions.find((entry) => {
        const id = call?.args?.id ?? call?.args?.record_id;
        return entry?.source?.id === id || entry?.source?.record_id === id;
      })?.route;
      // Legacy responses and explicitly documented fallback calls do not expose
      // compact expansion routes. When a route is present, however, it must
      // agree with the actual call and validate against the public schema.
      if (matchingRoute) {
        if (matchingRoute.tool !== call.tool) {
          failures.push({ kind: STABLE_FAILURE_CODES.REQUIRED_CALL_ARG_MISMATCH, requiredIndex: reqIndex, reason: 'bootstrap expansion route names a different tool' });
        }
        const routeArgsFailures = checkToolFamilyArgs([{ tool: matchingRoute.tool, args: matchingRoute.arguments ?? {} }]);
        for (const violation of routeArgsFailures) {
          failures.push({ kind: STABLE_FAILURE_CODES.REQUIRED_CALL_ARG_MISMATCH, requiredIndex: reqIndex, reason: 'bootstrap expansion route arguments do not validate', violation });
        }
      }
    }
    const argsEnveloped = { transcript: [{ tool: call.tool, args: call.args ?? {}, response_envelope: call.response_envelope ?? {} }] };
    const argsPredicates = Array.isArray(required.args_predicates) ? required.args_predicates : [];
    for (const predicate of argsPredicates) {
      if (predicate === undefined || predicate === null) continue;
      const rewrittenPointer = rewritePointerToTranscript(predicate.pointer, '/transcript/0/args');
      const rewritten = { ...predicate, pointer: rewrittenPointer };
      const v = validatePredicate(rewritten);
      if (!v.ok) {
        failures.push({ kind: STABLE_FAILURE_CODES.PREDICATE_INVALID, requiredIndex: reqIndex, pointer: predicate.pointer, reason: v.reason });
        continue;
      }
      const r = evaluatePredicate(argsEnveloped, rewritten);
      if (!r.ok) {
        failures.push({ kind: STABLE_FAILURE_CODES.REQUIRED_CALL_ARG_MISMATCH, requiredIndex: reqIndex, pointer: predicate.pointer, reason: r.reason });
        continue;
      }
      if (!r.passed) {
        failures.push({ kind: STABLE_FAILURE_CODES.REQUIRED_CALL_ARG_MISMATCH, requiredIndex: reqIndex, pointer: predicate.pointer, observed: r.observed });
      }
    }
    const responseEnveloped = argsEnveloped;
    const responsePredicates = Array.isArray(required.response_predicates) ? required.response_predicates : [];
    for (const predicate of responsePredicates) {
      if (predicate === undefined) continue;
      const rewrittenPointer = rewritePointerToTranscript(predicate.pointer, '/transcript/0/response_envelope');
      const rewritten = { ...predicate, pointer: rewrittenPointer };
      const v = validatePredicate(rewritten);
      if (!v.ok) {
        failures.push({ kind: STABLE_FAILURE_CODES.PREDICATE_INVALID, requiredIndex: reqIndex, pointer: predicate.pointer, reason: v.reason });
        continue;
      }
      const r = evaluatePredicate(responseEnveloped, rewritten);
      if (!r.ok) {
        failures.push({ kind: STABLE_FAILURE_CODES.REQUIRED_CALL_RESPONSE_MISMATCH, requiredIndex: reqIndex, pointer: predicate.pointer, reason: r.reason });
        continue;
      }
      if (!r.passed) {
        failures.push({ kind: STABLE_FAILURE_CODES.REQUIRED_CALL_RESPONSE_MISMATCH, requiredIndex: reqIndex, pointer: predicate.pointer, observed: r.observed });
      }
    }
  }
  return failures;
}

function checkScopePreservation(transcript, armDoc) {
  const expectedProjectId = armDoc.expected_scope?.project_id;
  if (!expectedProjectId) return [];
  const violations = [];
  // Legacy tools that do not carry project_id in their production schema.
  const SCOPE_OPTIONAL_FULL = new Set([
    'memory_get', // legacy accepts {id, include_synapses} only
    'memory_search', // accepts {query, project_id?}; if omitted, behavior is documented as database-wide
    'memory_changes', // accepts {since, project_id?}
    'memory_activate', // accepts {query, project_id?}
    'memory_synapse_traverse', // accepts {id}
    'cognitive_event_trace',
    'cognitive_policy_create',
    'cognitive_policy_lookup',
    'cognitive_policy_evaluate',
    'cognitive_current_guidance_search',
    'cognitive_current_guidance_diagnose',
    'memory_prime',
    'memory_boost',
    'memory_decay',
    'memory_stats',
    'memory_synapse_create',
    'memory_overview',
    'memory_projects',
    'memory_categories',
    'memory_stale',
    'memory_spread_stats',
    'memory_import_from_mem_sol',
    'memory_tag_add',
    'memory_tag_remove',
    'epistemic_integrity_check',
    'list_databases',
    'sql_query',
    'sql_execute',
    'sql_introspect',
  ]);
  for (const [index, call] of (transcript ?? []).entries()) {
    if (index === 0) continue;
    const args = call?.args ?? {};
    // Agent wrappers (memory_read, memory_find, memory_write, epistemic_inspect)
    // MUST carry project_id per Pattern 1. Legacy tools above are exempt.
    if (args.project_id === undefined) {
      if (armDoc.profile === 'full' && SCOPE_OPTIONAL_FULL.has(call.tool)) {
        if (call.tool === 'memory_get') {
          const returnedProjectId = call?.response_envelope?.project_id;
          if (returnedProjectId !== expectedProjectId) {
            violations.push({ index, kind: 'response_scope_mismatch', observed: returnedProjectId, expected: expectedProjectId, tool: call.tool });
          }
        }
        continue;
      }
      violations.push({ index, kind: 'missing', expected: expectedProjectId, tool: call.tool });
      continue;
    }
    if (args.project_id !== expectedProjectId) {
      violations.push({ index, kind: 'mismatch', observed: args.project_id, expected: expectedProjectId });
    }
  }
  return violations;
}

// Operation-specific tool family argument requirements.
// Source of truth: src/tools/*.ts server.tool( registrations.
// Legacy memory_get accepts only id + include_synapses (no project_id).
// Agent wrappers accept operation + project_id + operation-specific args.
const TOOL_FAMILY_ARGS = {
  cognitive_agent_bootstrap: {
    required: ['query', 'project_id'],
    optional: ['limit', 'include_global', 'category', 'layer', 'canonical_ids', 'include_canonical_content', 'include_excluded_details', 'task_state', 'response_mode'],
  },
  // Legacy full-profile tools
  memory_get: { required: ['id'], optional: ['include_synapses'] },
  memory_search: { required: ['query'], optional: ['project_id', 'category', 'layer', 'status', 'limit'] },
  memory_recent: { required: [], optional: ['project_id', 'category', 'layer', 'lifecycle', 'limit'] },
  memory_changes: { required: ['since'], optional: ['project_id', 'limit'] },
  memory_activate: { required: ['query'], optional: ['project_id', 'max_hop_depth', 'min_synapse_weight', 'land_on_layers', 'pass_through_layers', 'limit_cap'] },
  memory_synapse_traverse: { required: ['id'], optional: ['direction', 'connection_type', 'min_weight', 'limit'] },
  epistemic_get: { required: ['record_id', 'project_id'], optional: ['include_global', 'as_of'] },
  epistemic_query: { required: ['project_id'], optional: ['include_global', 'scope', 'epistemic_status', 'limit'] },
  epistemic_concept_diff: { required: ['record_id', 'project_id', 'from_as_of', 'to_as_of'], optional: ['include_global', 'include_unchanged', 'include_retracted'] },
  cognitive_current_guidance_search: { required: ['query', 'project_id'], optional: ['limit', 'include_global', 'category', 'layer'] },
  cognitive_current_guidance_diagnose: { required: ['query', 'project_id'], optional: ['limit', 'include_global', 'category', 'layer'] },
  // Agent wrappers (require project_id per Pattern 1)
  memory_read: {
    allowed_operations: ['get', 'links'],
    required: () => ['project_id', 'operation', 'id'],
    optional: (args) => args?.operation === 'links'
      ? ['include_global', 'direction', 'connection_type', 'min_weight', 'limit']
      : ['include_global'],
  },
  memory_find: {
    allowed_operations: ['search', 'recent', 'changes', 'related'],
    required: (args) => {
      const base = ['project_id', 'operation'];
      if (args?.operation === 'search' || args?.operation === 'related') return [...base, 'query'];
      if (args?.operation === 'changes') return [...base, 'since'];
      return base;
    },
    optional: (args) => {
      if (args?.operation === 'search') return ['include_global', 'status', 'category', 'layer', 'limit'];
      if (args?.operation === 'recent') return ['include_global', 'category', 'layer', 'lifecycle', 'limit'];
      if (args?.operation === 'changes') return ['include_global', 'limit'];
      if (args?.operation === 'related') return ['include_global', 'max_hop_depth', 'min_synapse_weight', 'land_on_layers', 'pass_through_layers', 'limit'];
      return [];
    },
  },
  memory_write: {
    allowed_operations: ['add', 'update', 'mark', 'supersede', 'tag_add', 'tag_remove'],
    required: (args) => {
      const op = args?.operation;
      const base = ['project_id', 'operation'];
      if (op === 'add') return [...base, 'category', 'title', 'content'];
      if (op === 'update') return [...base, 'id'];
      if (op === 'mark') return [...base, 'id', 'status'];
      if (op === 'supersede') return [...base, 'old_id', 'new_id'];
      if (op === 'tag_add' || op === 'tag_remove') return [...base, 'id', 'tag'];
      return base;
    },
    optional: (args) => {
      if (args?.operation === 'add') return ['confirm_global', 'layer', 'summary', 'tags', 'lifecycle', 'confidence', 'importance_score', 'session_id', 'source'];
      if (args?.operation === 'update') return ['confirm_global', 'title', 'content', 'summary', 'tags', 'category', 'layer', 'lifecycle', 'confidence', 'importance_score'];
      if (args?.operation === 'mark') return ['confirm_global', 'reason'];
      if (args?.operation === 'supersede') return ['confirm_global', 'reason'];
      if (args?.operation === 'tag_add' || args?.operation === 'tag_remove') return ['confirm_global'];
      return [];
    },
  },
  epistemic_inspect: {
    allowed_operations: ['get', 'query', 'diff'],
    required: (args) => {
      if (args?.operation === 'get') return ['project_id', 'operation', 'record_id'];
      if (args?.operation === 'query') return ['project_id', 'operation'];
      if (args?.operation === 'diff') return ['project_id', 'operation', 'record_id', 'from_as_of', 'to_as_of'];
      return ['project_id', 'operation'];
    },
    optional: (args) => {
      if (args?.operation === 'get') return ['include_global', 'as_of'];
      if (args?.operation === 'query') return ['include_global', 'scope', 'epistemic_status', 'limit'];
      if (args?.operation === 'diff') return ['include_global', 'include_unchanged', 'include_retracted'];
      return [];
    },
  },
  epistemic_admit: { required: ['idempotency_key', 'project_id', 'scope', 'statement', 'epistemic_status', 'verification_level', 'source_quality', 'confidence', 'valid_from', 'task_id'], optional: ['record_id', 'expected_revision', 'previous_revision_id', 'valid_until', 'source_memory_id', 'supersedes_record_id', 'superseded_by_record_id', 'provenance', 'session_id', 'observed_at'] },
  epistemic_append_receipt: { required: ['idempotency_key', 'record_id', 'revision_id', 'receipt_type', 'receipt_payload', 'observed_at', 'task_id', 'project_id'], optional: ['independence_key', 'session_id'] },
  cognitive_event_append: { required: ['event_type', 'task_id', 'project_id', 'payload'], optional: ['session_id', 'correlation_id', 'causation_id', 'idempotency_key', 'observed_at'] },
  cognitive_event_read: { required: ['project_id'], optional: ['event_type', 'task_id', 'session_id', 'correlation_id', 'causation_id', 'after_sequence', 'before_sequence', 'limit'] },
  memory_prime: { required: ['project_id'], optional: ['include_global', 'max_tokens', 'include_archived'] },
};

function checkToolFamilyArgs(transcript) {
  // Operation-specific family-schema argument requirements. Failure
  // is honest — missing required args is rejected by production.
  const violations = [];
  for (const [index, call] of (transcript ?? []).entries()) {
    const spec = TOOL_FAMILY_ARGS[call.tool];
    if (!spec) continue;
    const args = call?.args ?? {};
    if (spec.allowed_operations && !spec.allowed_operations.includes(args.operation)) {
      violations.push({ index, tool: call.tool, invalid_operation: args.operation, allowed_operations: spec.allowed_operations });
    }
    const required = typeof spec.required === 'function' ? spec.required(args) : spec.required;
    const optional = typeof spec.optional === 'function' ? spec.optional(args) : spec.optional;
    const allowed = new Set([...required, ...(optional ?? [])]);
    for (const key of required) {
      if (args[key] === undefined) {
        violations.push({ index, tool: call.tool, missing: key, operation: args.operation });
      }
    }
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) {
        violations.push({ index, tool: call.tool, unexpected: key, operation: args.operation });
      }
    }
  }
  return violations;
}

function checkOrientationInvariant(transcript) {
  // Phase B invariant: status='partial' iff requires_expansion=true.
  // status='complete' iff requires_expansion=false.
  // status='unavailable' implies requires_expansion=true (the orientation
  // is degraded; the agent must recover via expansion or fallback).
  const violations = [];
  for (const [index, call] of (transcript ?? []).entries()) {
    if (call.tool !== 'cognitive_agent_bootstrap') continue;
    const orientation = call?.response_envelope?.orientation;
    if (!orientation) continue;
    const status = orientation.status;
    const re = orientation.requires_expansion;
    if (status === 'partial' && re === false) {
      violations.push({ index, observed: { status, requires_expansion: re } });
    } else if (status === 'complete' && re === true) {
      violations.push({ index, observed: { status, requires_expansion: re } });
    } else if (status === 'unavailable' && re === false) {
      violations.push({ index, observed: { status, requires_expansion: re } });
    }
  }
  return violations;
}

function checkSearchBeforeCreate(transcript) {
  // If the transcript contains memory_write.add, a memory_find with
  // operation='search' must precede it. memory_find.recent/.changes
  // and memory_search do not satisfy this rule.
  // Legacy full-profile memory_add requires a preceding memory_search.
  const violations = [];
  const indices = (tool, opMatch) => transcript
    .map((c, i) => (c.tool === tool && (opMatch === undefined || c.args?.operation === opMatch)) ? i : -1)
    .filter((i) => i >= 0);
  const candidateSearch = indices('memory_find', 'search');
  const legacySearch = indices('memory_search');
  const allSearch = [...candidateSearch, ...legacySearch];
  for (const writeI of [
    ...indices('memory_write', 'add'),
    ...indices('memory_add'),
  ]) {
    const hasPredecessor = allSearch.some((s) => s < writeI);
    if (!hasPredecessor) {
      violations.push({ mutationIndex: writeI, reason: 'no search before mutation' });
    }
  }
  return violations;
}

function checkArmLevelPredicates(transcript, armDoc) {
  // Arm-level required_argument_predicates and response_predicates target
  // the transcript envelope as a whole (e.g., /transcript/0/args/...
  // or /transcript/0/response_envelope/...).
  const wrapped = { transcript: transcript ?? [] };
  const failures = [];
  for (const predicate of armDoc.required_argument_predicates ?? []) {
    const r = evaluatePredicate(wrapped, predicate);
    if (!r.ok) {
      failures.push({ kind: STABLE_FAILURE_CODES.REQUIRED_ARGUMENT_PREDICATE_FAILED, pointer: predicate.pointer, reason: r.reason });
      continue;
    }
    if (!r.passed) {
      failures.push({ kind: STABLE_FAILURE_CODES.REQUIRED_ARGUMENT_PREDICATE_FAILED, pointer: predicate.pointer, observed: r.observed });
    }
  }
  for (const predicate of armDoc.response_predicates ?? []) {
    const r = evaluatePredicate(wrapped, predicate);
    if (!r.ok) {
      failures.push({ kind: STABLE_FAILURE_CODES.RESPONSE_PREDICATE_FAILED, pointer: predicate.pointer, reason: r.reason });
      continue;
    }
    if (!r.passed) {
      failures.push({ kind: STABLE_FAILURE_CODES.RESPONSE_PREDICATE_FAILED, pointer: predicate.pointer, observed: r.observed });
    }
  }
  return failures;
}

function checkRetryCount(transcript, armDoc) {
  // Only an unsupported compact response opens the retry budget. Ordinary
  // re-bootstrap calls (for example pd-06 verification) are not retries.
  if (armDoc.bootstrap_response_mode !== 'compact') return [];
  let unsupportedIndex = -1;
  for (const [index, call] of (transcript ?? []).entries()) {
    if (call.tool !== 'cognitive_agent_bootstrap') continue;
    const responseText = JSON.stringify(call.response_envelope ?? '').toLowerCase();
    if (call.args?.response_mode === 'compact' && responseText.includes('response_mode') && responseText.includes('not supported')) {
      unsupportedIndex = index;
      break;
    }
  }
  if (unsupportedIndex < 0) return [];
  const retryIndices = [];
  for (let index = unsupportedIndex + 1; index < (transcript ?? []).length; index += 1) {
    if (transcript[index]?.tool === 'cognitive_agent_bootstrap') retryIndices.push(index);
  }
  if (retryIndices.length > 1) {
    return [{ observed: retryIndices.length, allowed: 1, unsupportedIndex, retryIndices }];
  }
  return [];
}

function checkProhibitedFamilies(transcript, armDoc) {
  // Arm-level prohibited_tool_names_or_families: no transcript call may
  // name a tool that matches.
  const prohibited = armDoc.prohibited_tool_names_or_families ?? [];
  if (prohibited.length === 0) return [];
  const violations = [];
  for (const [index, call] of (transcript ?? []).entries()) {
    for (const banned of prohibited) {
      if (call.tool === banned) {
        violations.push({ index, tool: call.tool, banned });
        continue;
      }
      if (banned && typeof banned === 'string' && call.tool && call.tool.startsWith(banned + '_')) {
        violations.push({ index, tool: call.tool, banned });
      }
    }
  }
  return violations;
}

function checkExpectedExpansionBehavior(transcript, armDoc) {
  const behavior = armDoc.expected_expansion_behavior;
  if (!behavior) return [];
  const violations = [];
  const requiredCalls = armDoc.required_tool_calls?.calls ?? [];
  if (behavior.must_call_required_expansions === true) {
    const requiredExpansionTool = requiredCalls.find((call) => call?.expansion_route?.route_available);
    if (requiredExpansionTool) {
      const occurrence = requiredExpansionTool.occurrence ?? 0;
      if (findCall(transcript, requiredExpansionTool.tool, occurrence) < 0) {
        violations.push({ kind: STABLE_FAILURE_CODES.REQUIRED_EXPANSION_NOT_CALLED, reason: 'must_call_required_expansions=true but required expansion call is absent' });
      }
    }
  }
  if (behavior.may_call_optional_expansions === false) {
    const requiredKeys = new Set(requiredCalls.map((call) => `${call.tool}:${call.occurrence ?? 0}`));
    const seen = new Map();
    const bootstrapExpansions = transcript?.[0]?.response_envelope?.expansions ?? [];
    for (const [index, call] of (transcript ?? []).entries()) {
      const occurrence = seen.get(call.tool) ?? 0;
      seen.set(call.tool, occurrence + 1);
      if (requiredKeys.has(`${call.tool}:${occurrence}`)) continue;
      if (call.tool === 'cognitive_agent_bootstrap') continue;
      const sourceId = call?.args?.id ?? call?.args?.record_id;
      const unavailable = Array.isArray(bootstrapExpansions)
        && bootstrapExpansions.some((entry) => entry?.source?.id === sourceId && entry?.route_available === false);
      if (!unavailable) {
        violations.push({ kind: STABLE_FAILURE_CODES.OPTIONAL_EXPANSION_NOT_ALLOWED, index, tool: call.tool, occurrence });
      }
    }
  }
  return violations;
}

function checkBootstrapBehavior(transcript, armDoc) {
  const expected = armDoc.expected_bootstrap_mutation_or_access_behavior ?? {};
  const bootstrapCall = transcript?.[0];
  if (!bootstrapCall) return [];
  const failures = [];
  const env = bootstrapCall.response_envelope ?? {};
  // Fail-closed: absence of the `mutation` object is a violation.
  const mutation = env.mutation;
  if (!mutation || typeof mutation !== 'object') {
    failures.push({ observed: 'absent', label: 'bootstrap response envelope missing mutation block' });
    return failures;
  }
  if (expected.writes_database === false) {
    if (mutation.database_writes === undefined) {
      failures.push({ observed: 'absent', label: 'bootstrap.mutation.database_writes absent (fail-closed)' });
    } else if (mutation.database_writes !== 0) {
      failures.push({ observed: mutation.database_writes, label: 'bootstrap wrote to database' });
    }
  }
  if (expected.touches_access_tracking === false) {
    if (mutation.access_tracking === undefined) {
      failures.push({ observed: 'absent', label: 'bootstrap.mutation.access_tracking absent (fail-closed)' });
    } else if (mutation.access_tracking !== 'not_touched') {
      failures.push({ observed: mutation.access_tracking, label: 'bootstrap touched access tracking' });
    }
  }
  if (expected.writes_database === false) {
    if (mutation.events_appended === undefined) {
      failures.push({ observed: 'absent', label: 'bootstrap.mutation.events_appended absent (fail-closed)' });
    } else if (mutation.events_appended !== 0) {
      failures.push({ observed: mutation.events_appended, label: 'bootstrap appended events' });
    }
    if (mutation.receipt_persistence === undefined) {
      failures.push({ observed: 'absent', label: 'bootstrap.mutation.receipt_persistence absent (fail-closed)' });
    } else if (mutation.receipt_persistence !== 'none') {
      failures.push({ observed: mutation.receipt_persistence, label: 'bootstrap persisted receipts' });
    }
  }
  return failures;
}

function checkResponseMode(transcript, armDoc) {
  const expected = armDoc.bootstrap_response_mode;
  const bootstrapCall = transcript?.[0];
  if (!bootstrapCall) return [];
  const failures = [];
  const requestMode = bootstrapCall?.args?.response_mode;
  if (expected === 'compact' && requestMode !== 'compact') {
    failures.push({ kind: STABLE_FAILURE_CODES.COMPACT_RESPONSE_MODE_MISSING, observed: requestMode, expected: 'compact' });
  }
  if (expected === 'legacy' && requestMode !== undefined && requestMode !== 'legacy') {
    failures.push({ kind: STABLE_FAILURE_CODES.LEGACY_RESPONSE_MODE_UNEXPECTED, observed: requestMode, expected: 'legacy or absent' });
  }
  return failures;
}

function checkPd06HonestRefresh(transcript, armDoc, caseDoc) {
  if (caseDoc.id !== 'pd-06-source-revised') return [];
  if (armDoc.profile !== 'agent') return [];
  const failures = [];
  // The public MCP has no caller-controlled version-comparison seam. Any
  // version_mismatch expansion in this Phase 4 contract is therefore fabricated.
  for (const [index, call] of (transcript ?? []).entries()) {
    if (call.tool !== 'cognitive_agent_bootstrap') continue;
    const expansions = Array.isArray(call?.response_envelope?.expansions) ? call.response_envelope.expansions : [];
    if (expansions.some((entry) => entry?.reason === 'version_mismatch')) {
      failures.push({ kind: STABLE_FAILURE_CODES.PD06_VERSION_MISMATCH_FABRICATION, index, observed: 'public bootstrap fabricated version_mismatch without a comparison seam' });
    }
  }
  return failures;
}

export function gradeTranscriptAgainstArm(transcript, caseDoc, arm) {
  const armDoc = caseDoc.arms?.[arm];
  if (!armDoc) {
    return {
      passed: false,
      checks: [makeCheck('arm_present', false, `arm ${arm} missing in case ${caseDoc.id}`, STABLE_FAILURE_CODES.PREDICATE_INVALID)],
      failures: [{ kind: STABLE_FAILURE_CODES.PREDICATE_INVALID, reason: `arm ${arm} missing` }],
      failure_codes: [STABLE_FAILURE_CODES.PREDICATE_INVALID],
    };
  }

  const checks = [];

  // 1. tool membership
  const toolViolations = checkToolMembership(transcript, armDoc);
  checks.push(makeCheck(
    'tool_membership',
    toolViolations.length === 0,
    toolViolations.length === 0 ? 'every call uses an allowed_tool_names entry' : `violations: ${JSON.stringify(toolViolations)}`,
    STABLE_FAILURE_CODES.TOOL_NOT_IN_PROFILE,
  ));

  // 2. excluded tools
  const excludedViolations = checkExcludedTools(transcript, armDoc);
  checks.push(makeCheck(
    'excluded_tools',
    excludedViolations.length === 0,
    excludedViolations.length === 0 ? 'no excluded tool called' : `violations: ${JSON.stringify(excludedViolations)}`,
    STABLE_FAILURE_CODES.EXCLUDED_TOOL_PRESENT,
  ));

  // 3. cardinality
  const cardinalityViolation = checkCardinality(transcript, armDoc);
  checks.push(makeCheck(
    'call_cardinality',
    cardinalityViolation === null,
    cardinalityViolation === null ? 'transcript length within allowed_call_cardinality' : JSON.stringify(cardinalityViolation),
    STABLE_FAILURE_CODES.CARDINALITY_OUT_OF_RANGE,
  ));

  // 4. ordering
  const orderingViolations = checkOrdering(transcript, armDoc.required_ordering_relationships ?? []);
  checks.push(makeCheck(
    'ordering_relationships',
    orderingViolations.length === 0,
    orderingViolations.length === 0 ? 'ordering relationships satisfied' : `violations: ${JSON.stringify(orderingViolations)}`,
    STABLE_FAILURE_CODES.ORDERING_VIOLATION,
  ));

  // 5. required calls + per-call predicates + access tracking honesty + expansion_route availability
  const requiredFailures = checkRequiredCalls(transcript, armDoc);
  const requiredFailuresNoInvalid = requiredFailures.filter((f) => f.kind !== STABLE_FAILURE_CODES.PREDICATE_INVALID);
  // Determine the dominant failure code from the specific failures so the
  // counterexample grader can attribute the violation precisely.
  const requiredFailureCodes = [];
  for (const f of requiredFailuresNoInvalid) {
    if (!requiredFailureCodes.includes(f.kind)) requiredFailureCodes.push(f.kind);
  }
  const requiredCode = requiredFailureCodes[0] ?? STABLE_FAILURE_CODES.REQUIRED_CALL_MISSING;
  checks.push(makeCheck(
    'required_calls',
    requiredFailuresNoInvalid.length === 0,
    requiredFailuresNoInvalid.length === 0 ? 'every required call matched its predicates' : `failures: ${JSON.stringify(requiredFailuresNoInvalid)}`,
    requiredCode,
  ));

  // 6. scope preservation
  const scopeViolations = checkScopePreservation(transcript, armDoc);
  checks.push(makeCheck(
    'scope_preservation',
    scopeViolations.length === 0,
    scopeViolations.length === 0 ? 'every expansion preserves expected_scope.project_id' : `violations: ${JSON.stringify(scopeViolations)}`,
    STABLE_FAILURE_CODES.SCOPE_NOT_PRESERVED,
  ));

  // 7. bootstrap behavior
  const bootstrapFailures = checkBootstrapBehavior(transcript, armDoc);
  checks.push(makeCheck(
    'bootstrap_behavior',
    bootstrapFailures.length === 0,
    bootstrapFailures.length === 0 ? 'bootstrap satisfies expected_bootstrap_mutation_or_access_behavior' : JSON.stringify(bootstrapFailures),
    STABLE_FAILURE_CODES.BOOTSTRAP_MUTATION_VIOLATION,
  ));

  // 8. response_mode
  const responseModeFailures = checkResponseMode(transcript, armDoc);
  checks.push(makeCheck(
    'response_mode',
    responseModeFailures.length === 0,
    responseModeFailures.length === 0 ? 'bootstrap request matches declared response_mode' : JSON.stringify(responseModeFailures),
    STABLE_FAILURE_CODES.COMPACT_RESPONSE_MODE_MISSING,
  ));

  // 9. pd-06 honest refresh
  const pd06Failures = checkPd06HonestRefresh(transcript, armDoc, caseDoc);
  checks.push(makeCheck(
    'pd06_honest_refresh',
    pd06Failures.length === 0,
    pd06Failures.length === 0 ? 'pd-06 candidate arm does not fabricate version_mismatch without cross-call evidence' : JSON.stringify(pd06Failures),
    STABLE_FAILURE_CODES.PD06_VERSION_MISMATCH_FABRICATION,
  ));

  // 10. arm-level required_argument_predicates and response_predicates
  //     (predicates targeting the bootstrap transcript directly).
  const armPredicatesFailures = checkArmLevelPredicates(transcript, armDoc);
  checks.push(makeCheck(
    'arm_level_predicates',
    armPredicatesFailures.length === 0,
    armPredicatesFailures.length === 0 ? 'arm-level required_argument_predicates and response_predicates satisfied' : `failures: ${JSON.stringify(armPredicatesFailures)}`,
    armPredicatesFailures[0]?.kind ?? STABLE_FAILURE_CODES.RESPONSE_PREDICATE_FAILED,
  ));

  // 11. prohibited families at arm level.
  const prohibitedViolations = checkProhibitedFamilies(transcript, armDoc);
  checks.push(makeCheck(
    'prohibited_families',
    prohibitedViolations.length === 0,
    prohibitedViolations.length === 0 ? 'no prohibited family called' : `violations: ${JSON.stringify(prohibitedViolations)}`,
    STABLE_FAILURE_CODES.PROHIBITED_FAMILY_PRESENT,
  ));

  // 12. expected_expansion_behavior.must_call_required_expansions.
  const expansionBehaviorViolations = checkExpectedExpansionBehavior(transcript, armDoc);
  checks.push(makeCheck(
    'expected_expansion_behavior',
    expansionBehaviorViolations.length === 0,
    expansionBehaviorViolations.length === 0 ? 'must_call_required_expansions satisfied' : JSON.stringify(expansionBehaviorViolations),
    expansionBehaviorViolations[0]?.kind ?? STABLE_FAILURE_CODES.REQUIRED_EXPANSION_NOT_CALLED,
  ));

  // 13. tool family-schema argument requirements (F2 scope fail-closed).
  const toolFamilyViolations = checkToolFamilyArgs(transcript);
  checks.push(makeCheck(
    'tool_family_args',
    toolFamilyViolations.length === 0,
    toolFamilyViolations.length === 0 ? 'every tool call has its required family args' : `violations: ${JSON.stringify(toolFamilyViolations)}`,
    STABLE_FAILURE_CODES.SCOPE_MISSING_PROJECT_ID,
  ));

  // 14. orientation invariant: partial iff requires_expansion.
  const orientationViolations = checkOrientationInvariant(transcript);
  checks.push(makeCheck(
    'orientation_invariant',
    orientationViolations.length === 0,
    orientationViolations.length === 0 ? 'orientation.status and requires_expansion are coupled' : JSON.stringify(orientationViolations),
    STABLE_FAILURE_CODES.ORIENTATION_INVARIANT_VIOLATION,
  ));

  // 15. search-before-create guard.
  const searchBeforeViolations = checkSearchBeforeCreate(transcript);
  checks.push(makeCheck(
    'search_before_create',
    searchBeforeViolations.length === 0,
    searchBeforeViolations.length === 0 ? 'memory_write.add preceded by a search' : JSON.stringify(searchBeforeViolations),
    STABLE_FAILURE_CODES.SEARCH_BEFORE_CREATE_VIOLATION,
  ));

  // 16. retry count: compact bootstrap calls exceeding frozen threshold.
  const retryViolations = checkRetryCount(transcript, armDoc);
  checks.push(makeCheck(
    'retry_count',
    retryViolations.length === 0,
    retryViolations.length === 0 ? 'compact retry count within frozen threshold' : JSON.stringify(retryViolations),
    STABLE_FAILURE_CODES.RETRY_COUNT_EXCEEDED,
  ));

  // Collect failure codes (deduped, in stable order).
  const failure_codes = [];
  const seen = new Set();
  for (const check of checks) {
    if (!check.passed && !seen.has(check.code)) {
      seen.add(check.code);
      failure_codes.push(check.code);
    }
  }
  // Promote the specific required_call failure codes into the top-level
  // failure_codes list so counterexample attribution is precise.
  for (const code of requiredFailureCodes) {
    if (!seen.has(code)) {
      seen.add(code);
      failure_codes.push(code);
    }
  }
  // Promote arm-level predicate failure codes.
  for (const f of armPredicatesFailures) {
    if (f.kind && !seen.has(f.kind)) {
      seen.add(f.kind);
      failure_codes.push(f.kind);
    }
  }

  const passed = checks.every((check) => check.passed);

  // Aggregate failures for top-level summary (in stable order).
  const failures = [];
  if (toolViolations.length > 0) failures.push({ kind: STABLE_FAILURE_CODES.TOOL_NOT_IN_PROFILE, details: toolViolations });
  if (excludedViolations.length > 0) failures.push({ kind: STABLE_FAILURE_CODES.EXCLUDED_TOOL_PRESENT, details: excludedViolations });
  if (prohibitedViolations.length > 0) failures.push({ kind: STABLE_FAILURE_CODES.PROHIBITED_FAMILY_PRESENT, details: prohibitedViolations });
  if (cardinalityViolation !== null) failures.push({ kind: STABLE_FAILURE_CODES.CARDINALITY_OUT_OF_RANGE, details: cardinalityViolation });
  if (orderingViolations.length > 0) failures.push({ kind: STABLE_FAILURE_CODES.ORDERING_VIOLATION, details: orderingViolations });
  failures.push(...requiredFailures);
  failures.push(...armPredicatesFailures);
  if (scopeViolations.length > 0) failures.push({ kind: STABLE_FAILURE_CODES.SCOPE_NOT_PRESERVED, details: scopeViolations });
  if (toolFamilyViolations.length > 0) failures.push({ kind: STABLE_FAILURE_CODES.SCOPE_MISSING_PROJECT_ID, details: toolFamilyViolations });
  if (orientationViolations.length > 0) failures.push({ kind: STABLE_FAILURE_CODES.ORIENTATION_INVARIANT_VIOLATION, details: orientationViolations });
  if (searchBeforeViolations.length > 0) failures.push({ kind: STABLE_FAILURE_CODES.SEARCH_BEFORE_CREATE_VIOLATION, details: searchBeforeViolations });
  for (const violation of expansionBehaviorViolations) {
    failures.push({ kind: violation.kind ?? STABLE_FAILURE_CODES.REQUIRED_EXPANSION_NOT_CALLED, details: violation });
  }
  if (bootstrapFailures.length > 0) failures.push({ kind: STABLE_FAILURE_CODES.BOOTSTRAP_MUTATION_VIOLATION, details: bootstrapFailures });
  if (responseModeFailures.length > 0) failures.push(...responseModeFailures);
  if (pd06Failures.length > 0) failures.push(...pd06Failures);
  if (retryViolations.length > 0) failures.push({ kind: STABLE_FAILURE_CODES.RETRY_COUNT_EXCEEDED, details: retryViolations });

  return {
    passed,
    checks,
    failures,
    failure_codes,
  };
}
