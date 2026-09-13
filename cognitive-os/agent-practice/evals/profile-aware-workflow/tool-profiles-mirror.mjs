// Derives the canonical profile membership from the committed source-of-truth.
// This module is the ONLY source of profile truth inside the profile-aware
// workflow contract. cases.json, transcript-fixtures.mjs, and
// validate-step4-contract.mjs must import FULL_PROFILE_TOOL_NAMES,
// AGENT_PROFILE_TOOL_NAMES, and MAINTENANCE_PROFILE_TOOL_NAMES from here.
//
// The full profile = every `server.tool( '<name>'` registration found in
// src/tools/*.ts. The agent and maintenance profile lists are mirrored from
// the typed constants exported in src/tool-profiles.ts.
//
// Pure module: no I/O beyond a one-shot read of src/tools/*.ts at module
// load. No clock, no Math.random, no global state.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const TOOLS_DIR = join(REPO_ROOT, 'src', 'tools');
const TOOL_PROFILES_PATH = join(REPO_ROOT, 'src', 'tool-profiles.ts');

function extractServerToolNamesFromSource(source) {
  // Match the multi-line `server.tool(\n  '<name>',\n  ...` form. The
  // name is the first single- or double-quoted string literal after
  // server.tool(. We tolerate indentation and a trailing comma.
  const names = new Set();
  const re = /server\.tool\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    names.add(match[1]);
  }
  return names;
}

function listTsFiles(dir) {
  return readdirSync(dir).filter((entry) => entry.endsWith('.ts')).sort();
}

function extractAgentAndMaintenanceNamesFromProfiles(source) {
  // Parse the typed const arrays in src/tool-profiles.ts without
  // importing the TypeScript module.
  const agentMatch = /export const AGENT_TOOL_NAMES\s*=\s*\[([^\]]*)\]/m.exec(source);
  const maintMatch = /export const MAINTENANCE_TOOL_NAMES\s*=\s*\[([^\]]*)\]/m.exec(source);
  if (!agentMatch) throw new Error('AGENT_TOOL_NAMES not found in src/tool-profiles.ts');
  if (!maintMatch) throw new Error('MAINTENANCE_TOOL_NAMES not found in src/tool-profiles.ts');
  const extractNames = (body) => Array.from(body.matchAll(/['"]([^'"]+)['"]/g)).map((m) => m[1]);
  return {
    agent: extractNames(agentMatch[1]),
    maintenance: extractNames(maintMatch[1]),
  };
}

const fullRegistration = new Set();
for (const file of listTsFiles(TOOLS_DIR)) {
  const source = readFileSync(join(TOOLS_DIR, file), 'utf8');
  for (const name of extractServerToolNamesFromSource(source)) {
    fullRegistration.add(name);
  }
}

const profilesSource = readFileSync(TOOL_PROFILES_PATH, 'utf8');
const { agent: agentList, maintenance: maintenanceList } = extractAgentAndMaintenanceNamesFromProfiles(profilesSource);

// FULL = every registration in src/tools/*.ts. Cross-check against the
// agent and maintenance mirrors: full must contain all 10 agent names that
// are also in src/tools (cognitive_agent_bootstrap, memory_prime,
// epistemic_admit, epistemic_append_receipt, cognitive_event_append), and
// must contain all 18 maintenance names.
export const FULL_PROFILE_TOOL_NAMES = Array.from(fullRegistration).sort();
export const AGENT_PROFILE_TOOL_NAMES = Array.from(new Set(agentList)).sort();
export const MAINTENANCE_PROFILE_TOOL_NAMES = Array.from(new Set(maintenanceList)).sort();

// Stable identifiers for cross-file checks.
export const REPO_ROOT_PATH = REPO_ROOT;
export const TOOL_PROFILES_SOURCE_PATH = TOOL_PROFILES_PATH;
export const TOOLS_SOURCE_DIR = TOOLS_DIR;

// Wrapper names exposed only by the agent profile (consolidated families
// not present as separate server.tool registrations in src/tools/*.ts).
export const AGENT_WRAPPER_ONLY_NAMES = AGENT_PROFILE_TOOL_NAMES.filter(
  (name) => !fullRegistration.has(name),
);

// Cross-validation: every mirror must be non-empty and well-formed.
if (FULL_PROFILE_TOOL_NAMES.length < 30) {
  throw new Error(`FULL_PROFILE_TOOL_NAMES unexpectedly short: ${FULL_PROFILE_TOOL_NAMES.length}`);
}
if (AGENT_PROFILE_TOOL_NAMES.length !== 10) {
  throw new Error(`AGENT_PROFILE_TOOL_NAMES must be exactly 10 names; got ${AGENT_PROFILE_TOOL_NAMES.length}`);
}
if (MAINTENANCE_PROFILE_TOOL_NAMES.length !== 18) {
  throw new Error(`MAINTENANCE_PROFILE_TOOL_NAMES must be exactly 18 names; got ${MAINTENANCE_PROFILE_TOOL_NAMES.length}`);
}
