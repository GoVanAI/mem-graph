#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const toolsRoot = join(repoRoot, 'src', 'tools');
const encoder = new TextEncoder();
const errors = [];

function readJson(name) {
  return JSON.parse(readFileSync(join(here, name), 'utf8'));
}

function byteLength(value) {
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

function requireCondition(condition, message) {
  if (!condition) errors.push(message);
}

function requireKeys(value, keys, label) {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of keys) requireCondition(Object.hasOwn(value, key), `${label} missing ${key}`);
}

function extractRegistrations() {
  const registrations = [];
  for (const file of readdirSync(toolsRoot).filter((name) => name.endsWith('.ts')).sort()) {
    const source = readFileSync(join(toolsRoot, file), 'utf8');
    const pattern = /server\.tool\(\s*['"]([^'"]+)['"]/g;
    const matches = [...source.matchAll(pattern)];
    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index];
      const end = matches[index + 1]?.index ?? source.length;
      registrations.push({
        name: current[1],
        source: `src/tools/${file}`,
        registration_source_bytes: byteLength(source.slice(current.index, end)),
      });
    }
  }
  return registrations;
}

const casesSchema = readJson('cases.schema.json');
const mappingSchema = readJson('tool-mapping.schema.json');
const casesDocument = readJson('cases.json');
const mapping = readJson('tool-mapping.json');
const registrations = extractRegistrations();

requireCondition(casesSchema.$schema?.includes('2020-12'), 'cases schema must declare draft 2020-12');
requireCondition(mappingSchema.$schema?.includes('2020-12'), 'mapping schema must declare draft 2020-12');
requireKeys(casesDocument, ['schema_version', 'fixture_policy', 'cases'], 'cases document');
requireCondition(casesDocument.schema_version === '1.0.0', 'cases schema_version must be 1.0.0');
requireCondition(casesDocument.fixture_policy === 'synthetic-only', 'fixtures must be synthetic-only');
requireCondition(Array.isArray(casesDocument.cases) && casesDocument.cases.length === 8, 'exactly eight baseline cases are required');

const expectedCaseIds = [
  'pd-01-ordinary-restart',
  'pd-02-valid-manifest',
  'pd-03-fresh-contradiction',
  'pd-04-long-governing-record',
  'pd-05-wrong-project',
  'pd-06-source-revised',
  'pd-07-history-heavy',
  'pd-08-degraded-input',
];
const actualCaseIds = [];
for (const [index, item] of (casesDocument.cases ?? []).entries()) {
  const label = `case[${index}]`;
  requireKeys(item, ['id', 'workflow', 'request', 'source_snapshot', 'expected', 'baseline_trace'], label);
  actualCaseIds.push(item.id);
  requireCondition(Array.isArray(item.workflow) && item.workflow.length > 0, `${label} needs workflow coverage`);
  requireKeys(item.source_snapshot, ['snapshot_id', 'project_id', 'records'], `${label}.source_snapshot`);
  requireCondition(item.source_snapshot?.project_id === item.request?.project_id, `${label} request and snapshot projects must match`);
  requireKeys(item.expected, ['outcome', 'required_signals', 'forbidden_signals'], `${label}.expected`);
  requireKeys(item.baseline_trace, ['legacy_tools', 'calls', 'measurement_status'], `${label}.baseline_trace`);
  const allowedStatuses = new Set(['contract-only-not-executed', 'executed-pass', 'executed-gap', 'executed-unavailable']);
  requireCondition(allowedStatuses.has(item.baseline_trace?.measurement_status), `${label} has invalid measurement_status`);
}
requireCondition(JSON.stringify(actualCaseIds) === JSON.stringify(expectedCaseIds), 'baseline case IDs/order differ from the frozen Step 2 list');
const fixtureText = JSON.stringify(casesDocument);
requireCondition(!/VanCh|C:\\\\Users|Documents\\\\Projects/i.test(fixtureText), 'fixtures contain a personal name or absolute workstation path');

requireKeys(mapping, ['schema_version', 'source_of_truth', 'proposed_everyday_routes', 'workflow_routes', 'tools'], 'mapping');
requireCondition(mapping.schema_version === '1.0.0', 'mapping schema_version must be 1.0.0');
requireCondition(Array.isArray(mapping.proposed_everyday_routes) && mapping.proposed_everyday_routes.length >= 8 && mapping.proposed_everyday_routes.length <= 10, 'everyday route target must contain 8-10 routes');
requireCondition(new Set(mapping.proposed_everyday_routes).size === mapping.proposed_everyday_routes.length, 'proposed everyday routes must be unique');

const workflowNames = ['orient', 'find-and-inspect', 'record-and-revise', 'review-and-learn'];
const workflowRouteSet = new Set();
for (const workflow of workflowNames) {
  const routes = mapping.workflow_routes?.[workflow];
  requireCondition(Array.isArray(routes) && routes.length > 0, `workflow ${workflow} must have routes`);
  for (const route of routes ?? []) {
    workflowRouteSet.add(route);
    requireCondition(mapping.proposed_everyday_routes.includes(route), `workflow ${workflow} names undeclared route ${route}`);
  }
}
for (const route of mapping.proposed_everyday_routes ?? []) {
  requireCondition(workflowRouteSet.has(route), `everyday route ${route} is not assigned to a workflow`);
}

const registeredNames = registrations.map((entry) => entry.name);
const mappedNames = (mapping.tools ?? []).map((entry) => entry.name);
requireCondition(new Set(registeredNames).size === registeredNames.length, 'source contains duplicate tool registrations');
requireCondition(new Set(mappedNames).size === mappedNames.length, 'mapping contains duplicate tool names');
const missing = registeredNames.filter((name) => !mappedNames.includes(name));
const extra = mappedNames.filter((name) => !registeredNames.includes(name));
requireCondition(missing.length === 0, `unmapped registered tools: ${missing.join(', ')}`);
requireCondition(extra.length === 0, `mapping entries absent from source: ${extra.join(', ')}`);

const registrationByName = new Map(registrations.map((entry) => [entry.name, entry]));
const allowedClassifications = new Set(['everyday', 'specialist', 'legacy-only']);
const allowedReturnTypes = new Set(['json', 'text-json', 'rows']);
for (const [index, entry] of (mapping.tools ?? []).entries()) {
  const label = `tool[${index}] ${entry.name ?? '<unnamed>'}`;
  requireKeys(entry, ['name', 'source', 'input_schema', 'scope', 'return_type', 'side_effects', 'classification', 'destination', 'fallback', 'practice_callers'], label);
  requireKeys(entry.input_schema, ['required', 'optional'], `${label}.input_schema`);
  requireCondition(Array.isArray(entry.input_schema?.required), `${label} required parameters must be an array`);
  requireCondition(Array.isArray(entry.input_schema?.optional), `${label} optional parameters must be an array`);
  const allParams = [...(entry.input_schema?.required ?? []), ...(entry.input_schema?.optional ?? [])];
  requireCondition(new Set(allParams).size === allParams.length, `${label} repeats an input parameter`);
  requireCondition(allowedClassifications.has(entry.classification), `${label} has invalid classification`);
  requireCondition(allowedReturnTypes.has(entry.return_type), `${label} has invalid return type`);
  requireCondition(Array.isArray(entry.side_effects), `${label} side_effects must be an array`);
  requireCondition(Array.isArray(entry.practice_callers) && entry.practice_callers.length > 0, `${label} needs practice callers`);
  requireCondition(registrationByName.get(entry.name)?.source === entry.source, `${label} source path disagrees with registration`);
}

const classifications = Object.fromEntries(
  ['everyday', 'specialist', 'legacy-only'].map((kind) => [kind, mapping.tools.filter((entry) => entry.classification === kind).length]),
);
const caseMeasurements = casesDocument.cases.map((item) => ({
  id: item.id,
  request_bytes: byteLength(item.request),
  source_snapshot_bytes: byteLength(item.source_snapshot),
  expected_contract_bytes: byteLength(item.expected),
  baseline_calls: item.baseline_trace.calls,
}));

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    status: 'step-2a-contract-validated',
    registered_tools: registrations.length,
    mapped_tools: mapping.tools.length,
    source_tool_files: new Set(registrations.map((entry) => entry.source)).size,
    proposed_everyday_routes: mapping.proposed_everyday_routes.length,
    classifications,
    registration_source_bytes: registrations.reduce((sum, entry) => sum + entry.registration_source_bytes, 0),
    mapped_input_contract_bytes: mapping.tools.reduce((sum, entry) => sum + byteLength(entry.input_schema), 0),
    artifact_bytes: {
      cases: byteLength(readFileSync(join(here, 'cases.json'), 'utf8')),
      mapping: byteLength(readFileSync(join(here, 'tool-mapping.json'), 'utf8')),
    },
    case_measurements: caseMeasurements,
    caveat: 'These are deterministic contract/source measurements, not MCP runtime, provider-token, latency, or agent-effectiveness results.',
    source_root: relative(repoRoot, toolsRoot).replaceAll('\\', '/'),
  }, null, 2));
}
