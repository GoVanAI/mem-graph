import { describe, expect, it } from 'vitest';
import { runActivate } from '../src/activate.js';
import {
  appendCognitiveEvent,
  listCognitiveEvents,
  verifyCognitiveEventChain,
} from '../src/cognitive/events.js';
import {
  createPolicyCandidate,
  evaluatePolicyCandidate,
  findPolicyCandidates,
} from '../src/cognitive/policy.js';
import { searchCurrentGuidance } from '../src/cognitive/retrieval.js';
import { createInMemoryDb, seedMemory, seedSynapse } from './helpers.js';

describe('Cognitive OS MVP-001 proof sequence', () => {
  it('learns a scoped retrieval policy and removes broad-activation contamination on a fresh task', () => {
    const db = createInMemoryDb();
    const canonical = seedMemory(db, {
      title: 'Current canonical retrieval guidance',
      content: 'Strict retrieval uses active exact project guidance first.',
      project_id: 'cognitive-os',
      category: 'decision',
      layer: 'procedural',
      status: 'active',
    });
    const superseded = seedMemory(db, {
      title: 'Superseded retrieval guidance',
      content: 'Always expand the graph before checking lifecycle.',
      project_id: 'cognitive-os',
      category: 'decision',
      layer: 'procedural',
      status: 'superseded',
    });
    const otherProject = seedMemory(db, {
      title: 'Other project retrieval guidance',
      content: 'Context belonging to a different project.',
      project_id: 'other-project',
      category: 'decision',
      layer: 'procedural',
      status: 'active',
    });
    seedSynapse(db, canonical, superseded, 'wikilink', 1);
    seedSynapse(db, canonical, otherProject, 'wikilink', 1);

    const baselineTask = 'mvp-001-baseline';
    const broad = runActivate(db, {
      query: 'strict retrieval guidance',
      project_id: 'cognitive-os',
    });
    expect(broad.map((row) => row.id)).toEqual(
      expect.arrayContaining([canonical, superseded, otherProject]),
    );

    appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: baselineTask,
      project_id: 'cognitive-os',
      payload: { retrieval: 'memory_activate', intent: 'current_canonical_guidance' },
    });
    appendCognitiveEvent(db, {
      event_type: 'ExecutionObserved',
      task_id: baselineTask,
      project_id: 'cognitive-os',
      payload: { result_ids: broad.map((row) => row.id) },
    });
    appendCognitiveEvent(db, {
      event_type: 'EvidenceObserved',
      task_id: baselineTask,
      project_id: 'cognitive-os',
      payload: { inactive_results: 1, unintended_cross_project_results: 1 },
    });
    appendCognitiveEvent(db, {
      event_type: 'BeliefRevised',
      task_id: baselineTask,
      project_id: 'cognitive-os',
      payload: { belief: 'activation_is_contextual_not_canonical_retrieval' },
    });
    appendCognitiveEvent(db, {
      event_type: 'ReflectionProposed',
      task_id: baselineTask,
      project_id: 'cognitive-os',
      payload: { proposal: 'active_exact_project_search_before_graph_expansion' },
    });

    const policy = createPolicyCandidate(db, {
      project_id: 'cognitive-os',
      title: 'Current-guidance retrieval policy',
      statement: 'Search active exact-project guidance before graph expansion.',
      trigger_type: 'request_type',
      trigger_value: 'current_canonical_guidance',
      action: { retrieval: 'cognitive_current_guidance_search' },
      exclusions: ['historical audit', 'cross-project analogy', 'provenance reconstruction'],
      verifier: {
        inactive_results: 0,
        unintended_cross_project_results: 0,
        canonical_present: true,
      },
      task_id: baselineTask,
      idempotency_key: 'mvp-001:policy:create',
    });

    const freshTask = 'mvp-001-fresh-analogue';
    const retrievedPolicies = findPolicyCandidates(db, {
      project_id: 'cognitive-os',
      trigger_type: 'request_type',
      trigger_value: 'current_canonical_guidance',
    });
    expect(retrievedPolicies[0].policy_id).toBe(policy.policy_id);
    appendCognitiveEvent(db, {
      event_type: 'PolicyRetrieved',
      task_id: freshTask,
      project_id: 'cognitive-os',
      payload: { policy_id: policy.policy_id, changed_tool_choice: true },
    });

    const strict = searchCurrentGuidance(db, {
      query: 'strict retrieval guidance',
      project_id: 'cognitive-os',
      category: 'decision',
    });
    expect(strict.map((row) => row.id)).toEqual([canonical]);
    appendCognitiveEvent(db, {
      event_type: 'DecisionMade',
      task_id: freshTask,
      project_id: 'cognitive-os',
      payload: { retrieval: 'cognitive_current_guidance_search', selected_id: canonical },
    });

    const evaluated = evaluatePolicyCandidate(db, {
      policy_id: policy.policy_id,
      task_id: freshTask,
      project_id: 'cognitive-os',
      outcome: 'succeeded',
      metrics: {
        baseline_contaminated_results: 2,
        inactive_results: 0,
        unintended_cross_project_results: 0,
        canonical_present: true,
      },
      guardrail_regression: false,
      idempotency_key: 'mvp-001:policy:evaluate:fresh',
    });
    expect(evaluated).toMatchObject({
      status: 'candidate',
      evaluation_count: 1,
      success_count: 1,
    });

    const eventTypes = new Set(listCognitiveEvents(db).map((event) => event.event_type));
    expect(eventTypes).toEqual(
      new Set([
        'DecisionMade',
        'ExecutionObserved',
        'EvidenceObserved',
        'BeliefRevised',
        'ReflectionProposed',
        'PolicyCandidateCreated',
        'PolicyRetrieved',
        'PolicyEvaluated',
      ]),
    );
    expect(verifyCognitiveEventChain(db)).toMatchObject({ valid: true });
  });
});
