import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDatabase } from '../db.js';
import { errorResult, jsonResult } from '../util.js';
import {
  appendCognitiveEvent,
  listCognitiveEvents,
  verifyCognitiveEventChain,
} from '../cognitive/events.js';
import {
  createPolicyCandidate,
  evaluatePolicyCandidate,
  findPolicyCandidates,
} from '../cognitive/policy.js';
import { diagnoseCurrentGuidance, searchGoverningGuidance } from '../cognitive/retrieval.js';
import { bootstrapCognitiveAgent } from '../cognitive/agent-bootstrap.js';
import { COGNITIVE_EVENT_TYPES } from '../cognitive/types.js';

const jsonObject = z.record(z.string(), z.unknown());
const metricValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function registerCognitiveTools(server: McpServer): void {
  server.tool(
    'cognitive_agent_bootstrap',
    'Run the adopted mem-graph agent-practice bootstrap as one strictly read-only operation. Resolves exact project scope, snapshots explicitly requested canonical records without touching access counters, looks up candidate policy guidance, and separates governing from contextual lexical candidates. It appends no event, persists no receipt, grants no authority, and keeps global scope disabled unless explicitly requested.',
    {
      query: z.string().min(1),
      project_id: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
      include_global: z.boolean().optional(),
      category: z.string().optional(),
      layer: z.enum(['working', 'episodic', 'procedural', 'semantic', 'partner']).optional(),
      canonical_ids: z.array(z.number().int().positive()).max(20).optional(),
      include_canonical_content: z.boolean().optional(),
    },
    async (input) => {
      try {
        return jsonResult(bootstrapCognitiveAgent(getDatabase('memory'), input));
      } catch (error) {
        return errorResult(`Cognitive agent bootstrap error: ${(error as Error).message}`);
      }
    },
  );

  server.tool(
    'cognitive_event_append',
    'Append an immutable, hash-linked Cognitive OS event. Idempotency keys are strongly recommended for retryable calls.',
    {
      event_type: z.enum(COGNITIVE_EVENT_TYPES),
      task_id: z.string().min(1),
      project_id: z.string().min(1),
      payload: jsonObject,
      session_id: z.string().min(1).optional(),
      correlation_id: z.string().min(1).optional(),
      causation_id: z.string().min(1).optional(),
      idempotency_key: z.string().min(1).optional(),
      observed_at: z.string().min(1).optional(),
    },
    async (input) => {
      try {
        return jsonResult(appendCognitiveEvent(getDatabase('memory'), input));
      } catch (error) {
        return errorResult(`Cognitive event append error: ${(error as Error).message}`);
      }
    },
  );

  server.tool(
    'cognitive_event_trace',
    'Read Cognitive OS events in ledger order and verify the complete hash chain.',
    {
      event_type: z.enum(COGNITIVE_EVENT_TYPES).optional(),
      task_id: z.string().min(1).optional(),
      project_id: z.string().min(1).optional(),
      session_id: z.string().min(1).optional(),
      correlation_id: z.string().min(1).optional(),
      causation_id: z.string().min(1).optional(),
      after_sequence: z.number().int().nonnegative().optional(),
      before_sequence: z.number().int().positive().optional(),
      limit: z.number().int().nonnegative().max(1000).optional(),
    },
    async (filters) => {
      const db = getDatabase('memory');
      try {
        return jsonResult({
          integrity: verifyCognitiveEventChain(db),
          events: listCognitiveEvents(db, filters),
        });
      } catch (error) {
        return errorResult(`Cognitive event trace error: ${(error as Error).message}`);
      }
    },
  );

  server.tool(
    'cognitive_policy_create',
    'Create a scoped candidate policy and its immutable source event. This does not grant authoritative status.',
    {
      project_id: z.string().min(1),
      title: z.string().min(1),
      statement: z.string().min(1),
      trigger_type: z.string().min(1),
      trigger_value: z.string().min(1),
      action: jsonObject,
      exclusions: z.array(z.string()),
      verifier: jsonObject,
      task_id: z.string().min(1),
      session_id: z.string().min(1).optional(),
      idempotency_key: z.string().min(1).optional(),
    },
    async (input) => {
      try {
        return jsonResult(createPolicyCandidate(getDatabase('memory'), input));
      } catch (error) {
        return errorResult(`Cognitive policy create error: ${(error as Error).message}`);
      }
    },
  );

  server.tool(
    'cognitive_policy_lookup',
    'Find non-rejected candidate policies by exact trigger, preferring the current project before _global.',
    {
      project_id: z.string().min(1),
      trigger_type: z.string().min(1),
      trigger_value: z.string().min(1),
      limit: z.number().int().positive().max(500).optional(),
    },
    async (input) => {
      try {
        return jsonResult(findPolicyCandidates(getDatabase('memory'), input));
      } catch (error) {
        return errorResult(`Cognitive policy lookup error: ${(error as Error).message}`);
      }
    },
  );

  server.tool(
    'cognitive_policy_evaluate',
    'Record policy outcome evidence and guardrail metrics without automatically promoting policy authority.',
    {
      policy_id: z.string().min(1),
      task_id: z.string().min(1),
      project_id: z.string().min(1),
      outcome: z.enum(['succeeded', 'failed', 'inconclusive']),
      metrics: z.record(z.string(), metricValue),
      guardrail_regression: z.boolean(),
      session_id: z.string().min(1).optional(),
      correlation_id: z.string().min(1).optional(),
      causation_id: z.string().min(1).optional(),
      idempotency_key: z.string().min(1).optional(),
    },
    async (input) => {
      try {
        return jsonResult(evaluatePolicyCandidate(getDatabase('memory'), input));
      } catch (error) {
        return errorResult(`Cognitive policy evaluation error: ${(error as Error).message}`);
      }
    },
  );

  server.tool(
    'cognitive_current_guidance_search',
    'Search active, governing-eligible current guidance only: exact project by default, excluding working/ephemeral and non-governing categories. Results include category and eligibility, which does not itself grant authority; fetch selected memories directly to verify canonical role, adoption, scope, and applicability before use. User and system instructions remain higher priority. Graph expansion is deliberately excluded.',
    {
      query: z.string(),
      project_id: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
      include_global: z.boolean().optional(),
      category: z.string().optional(),
      layer: z.enum(['working', 'episodic', 'procedural', 'semantic', 'partner']).optional(),
    },
    async (input) => {
      try {
        return jsonResult(searchGoverningGuidance(getDatabase('memory'), input));
      } catch (error) {
        return errorResult(`Current-guidance search error: ${(error as Error).message}`);
      }
    },
  );

  server.tool(
    'cognitive_current_guidance_diagnose',
    'Inspect the bounded active lexical candidate set for current guidance without changing access tracking. Returns governing and contextual/ineligible lanes with stable exclusion reasons; exact project only by default and graph expansion is excluded.',
    {
      query: z.string(),
      project_id: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
      include_global: z.boolean().optional(),
      category: z.string().optional(),
      layer: z.enum(['working', 'episodic', 'procedural', 'semantic', 'partner']).optional(),
    },
    async (input) => {
      try {
        return jsonResult(diagnoseCurrentGuidance(getDatabase('memory'), input));
      } catch (error) {
        return errorResult(`Current-guidance diagnostic error: ${(error as Error).message}`);
      }
    },
  );
}
