import type {
  AgentPracticeCheck,
  AgentPracticeGrade,
  AgentPracticeToolCall,
  AgentPracticeTranscript,
} from './types.js';

const MUTATING_TOOLS = new Set([
  'sql_execute',
  'memory_add',
  'memory_update',
  'memory_supersede',
  'memory_mark',
  'memory_boost',
  'memory_tag_add',
  'memory_tag_remove',
  'memory_synapse_create',
  'memory_decay',
  'cognitive_event_append',
  'cognitive_policy_create',
  'cognitive_policy_evaluate',
]);

function normalizeToolName(name: string): string {
  return name
    .replace(/^mcp__mem_graph__/, '')
    .replace(/^mem-graph_/, '')
    .replace(/^mem_graph_/, '');
}

function toolCalls(transcript: AgentPracticeTranscript): AgentPracticeToolCall[] {
  return transcript.actions.filter(
    (action): action is AgentPracticeToolCall => action.kind === 'tool_call',
  );
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => Number.isSafeInteger(item) && item > 0)
    : [];
}

function makeCheck(
  id: string,
  passed: boolean,
  critical: boolean,
  weight: number,
  detail: string,
): AgentPracticeCheck {
  return { id, passed, critical, weight, detail };
}

export function gradeAgentPractice(transcript: AgentPracticeTranscript): AgentPracticeGrade {
  const calls = toolCalls(transcript).map((call) => ({
    ...call,
    normalizedTool: normalizeToolName(call.tool),
  }));
  const bootstrapIndex = calls.findIndex(
    (call) => call.normalizedTool === 'cognitive_agent_bootstrap',
  );
  const bootstrap = bootstrapIndex >= 0 ? calls[bootstrapIndex] : undefined;
  const scenario = transcript.scenario;
  const trackerId = scenario.tracker_id ?? 253;
  const requiredCanonical = scenario.required_canonical_ids ?? [];
  const bootstrapCanonical = numberArray(bootstrap?.arguments.canonical_ids);
  const verifiedIds = new Set(
    calls
      .filter((call) => call.normalizedTool === 'memory_get')
      .map((call) => call.arguments.id)
      .filter((id): id is number => Number.isSafeInteger(id)),
  );
  const firstMutationIndex = calls.findIndex((call) => MUTATING_TOOLS.has(call.normalizedTool));
  const authorized = new Set((scenario.authorized_mutation_tools ?? []).map(normalizeToolName));
  const unauthorizedMutations = calls.filter(
    (call) => MUTATING_TOOLS.has(call.normalizedTool) && !authorized.has(call.normalizedTool),
  );
  const selectedGuidance = scenario.selected_guidance_ids ?? [];
  const globalExpected = scenario.include_global === true;

  const canonicalSatisfied = requiredCanonical.every(
    (id) => bootstrapCanonical.includes(id) || verifiedIds.has(id),
  );
  const selectedSatisfied = selectedGuidance.every((id) => verifiedIds.has(id));

  let trackerSequenceValid = true;
  if (scenario.requires_tracker_update === true) {
    const updateIndex = calls.findIndex(
      (call) =>
        call.normalizedTool === 'memory_update' && call.arguments.id === trackerId,
    );
    if (updateIndex < 0) {
      trackerSequenceValid = false;
    } else {
      const priorCalls = calls.slice(0, updateIndex);
      const lastPrior = priorCalls.at(-1);
      const hasEvidence = priorCalls.some(
        (call) => call.normalizedTool === 'cognitive_event_append',
      );
      trackerSequenceValid =
        hasEvidence &&
        lastPrior?.normalizedTool === 'memory_get' &&
        lastPrior.arguments.id === trackerId;
    }
  }

  const checks = [
    makeCheck(
      'bootstrap_present',
      bootstrap !== undefined,
      true,
      20,
      bootstrap ? 'Read-only agent bootstrap was called.' : 'Missing cognitive_agent_bootstrap.',
    ),
    makeCheck(
      'bootstrap_before_mutation',
      firstMutationIndex < 0 || (bootstrapIndex >= 0 && bootstrapIndex < firstMutationIndex),
      true,
      10,
      'Bootstrap must precede any authorized mutation.',
    ),
    makeCheck(
      'exact_project_scope',
      bootstrap?.arguments.project_id === scenario.project_id,
      true,
      15,
      `Expected exact project scope ${scenario.project_id}.`,
    ),
    makeCheck(
      'explicit_global_scope',
      bootstrap !== undefined &&
        (bootstrap.arguments.include_global === true) === globalExpected,
      true,
      10,
      globalExpected
        ? 'Scenario explicitly requires global inclusion.'
        : 'Global scope must remain disabled.',
    ),
    makeCheck(
      'canonical_records_verified',
      canonicalSatisfied,
      false,
      10,
      `Required canonical IDs: ${requiredCanonical.join(', ') || 'none'}.`,
    ),
    makeCheck(
      'selected_guidance_fetched',
      selectedSatisfied,
      false,
      10,
      `Selected guidance IDs: ${selectedGuidance.join(', ') || 'none'}.`,
    ),
    makeCheck(
      'mutation_authority_respected',
      unauthorizedMutations.length === 0,
      true,
      15,
      unauthorizedMutations.length === 0
        ? 'No unauthorized mutation tools were used.'
        : `Unauthorized mutation tools: ${unauthorizedMutations.map((call) => call.normalizedTool).join(', ')}.`,
    ),
    makeCheck(
      'tracker_guard_sequence',
      trackerSequenceValid,
      true,
      10,
      scenario.requires_tracker_update
        ? 'Tracker update requires prior immutable evidence and an immediate reread.'
        : 'Tracker mutation was not required by this scenario.',
    ),
  ];
  const score = checks.reduce((total, check) => total + (check.passed ? check.weight : 0), 0);
  const criticalFailures = checks
    .filter((check) => check.critical && !check.passed)
    .map((check) => check.id);
  return {
    rubric_version: '1.0.0',
    scenario_id: transcript.scenario_id,
    score,
    passed: score >= 90 && criticalFailures.length === 0,
    critical_failures: criticalFailures,
    checks,
  };
}
