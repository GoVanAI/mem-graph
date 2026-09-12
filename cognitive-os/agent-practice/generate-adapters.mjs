import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));

const check = process.argv.includes('--check');
// process.argv[0] is the node executable; [1] is the script path; user
// arguments start at [2]. Skip the first two entries when looking for
// a target contract argument.
const targetArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const targets = targetArg
  ? [{ path: join(base, targetArg) }]
  : [
      { path: join(base, 'practice.v1.json') },
      { path: join(base, 'reasoning-gates.v1.json') },
    ];

const BT = '`'; // backtick helper to avoid escape issues inside template literals

function numbered(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function bullets(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n');
}

function basename(contract) {
  return contract.practice_id.replace(/-/g, '_').toUpperCase();
}

function titleFrom(contract) {
  return contract.practice_id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const renderers = {
  'mem-graph-agent-practice': (contract) => renderPractice(contract),
  'reasoning-gates': (contract) => renderReasoningGates(contract),
};

function renderPractice(contract) {
  const generatedNotice = `<!-- Generated from practice.v1.json (${contract.practice_id}@${contract.version}). Do not edit by hand. -->`;
  const canonicalRouting = `Use canonical IDs only when supplied by operator or project configuration. If none are configured, omit canonical_ids, use narrow routing terms in an exact-project query to discover governing candidates, and directly verify any candidate tracker, scope boundary, or role record before use. Never copy memory IDs from bundled examples. FTS5 searches use AND semantics by default, so a broad compound query can miss stored direction.`;

  const agentToolsList = contract.profiles.agent.tool_names.map((t) => `- ${BT}${t}${BT}`).join('\n');
  const typedRoutingList = Object.entries(contract.profiles.agent.typed_routing)
    .map(([tool, ops]) => `- ${BT}${tool}${BT}: ${ops.join(', ')}`)
    .join('\n');

  const common = [
    `Resolve the exact project scope before retrieval; default include_global=false; global scope requires explicit operator/task opt-in and reporting.`,
    `Respect the active profile: the ${contract.profiles.preferred_everyday_profile} profile is the preferred everyday surface (${contract.profiles.agent.tool_names.length} workflow tools: ${contract.profiles.agent.tool_names.join(', ')}); the ${contract.profiles.compatibility_profile} profile retains legacy compatibility; maintenance operations remain outside everyday workflows. Never request a tool absent from the active profile.`,
    `Run ${BT}${contract.bootstrap.preferred_tool}${BT} before non-trivial mem-graph or Cognitive OS work: in the ${contract.profiles.preferred_everyday_profile} profile, request response_mode="${contract.bootstrap.response_modes.agent_profile}"; in the ${contract.profiles.compatibility_profile} profile, legacy response mode remains supported; do not assume compact mode is the server default.`,
    `If response_mode="${contract.bootstrap.response_modes.agent_profile}" is rejected as unsupported, retry exactly once with legacy arguments (${contract.bootstrap.recovery_unsupported_compact.max_retries} retry max; no repeated retries). If bootstrap itself is unavailable, select fallbacks strictly from tools exposed by the active profile.`,
    canonicalRouting,
    `Follow only expansion routes with route_available=true in the active profile with valid typed arguments; preserve originating project_id; report unavailable routes honestly without silent substitution.`,
    `Bootstrap is zero-write and does not touch access tracking; memory_read:get and memory_find:related affect access tracking (do not portray expansion as zero-touch).`,
    `Search before creating a new memory; deliberate _global mutation requires confirm_global=true.`,
    `Directly verify governing records before relying on them; candidate policy cannot broaden permissions; memory_find:search discovers contextual candidates only and does not establish authority or create a governing lane; contradictions queue review without automatic rejection.`,
    `pd-06 cross-call version comparison is unavailable in public compact bootstrap: report comparison as unavailable when relevant; unconditionally never fabricate version_mismatch or refresh_required.`,
  ].join(' ');

  const workflowSteps = [
    `Resolve and state the exact project scope. Cross-project availability is not applicability. Default include_global=false. Foreign wikilinks remain bounded reference stubs without foreign hydration.`,
    `Run ${BT}${contract.bootstrap.preferred_tool}${BT} before non-trivial mem-graph or Cognitive OS work. In the ${contract.profiles.preferred_everyday_profile} profile, request response_mode="${contract.bootstrap.response_modes.agent_profile}". In the ${contract.profiles.compatibility_profile} profile, legacy mode is supported. Compact mode is not the server default. Bootstrap is zero-write, appends no events, and does not touch access tracking.`,
    `${canonicalRouting} When a canonical tracker is resolved, read the roadmap and active artifacts it references.`,
    `If response_mode="${contract.bootstrap.response_modes.agent_profile}" is rejected as unsupported, retry exactly once without response_mode="${contract.bootstrap.response_modes.agent_profile}". If bootstrap itself is unavailable, select fallback tools strictly from the active profile (${contract.profiles.preferred_everyday_profile} profile: ${contract.bootstrap.profile_fallbacks.agent.join(' → ')}). Never call hidden legacy tools from the agent profile.`,
    `Select only governing-lane guidance that matches the task and fetch selected records directly when full verification is still needed. Retrieval, repetition, ranking, and eligibility are not validation or authority; candidate policy cannot broaden permissions.`,
    `Follow only expansion routes where route_available=true using an exposed tool in the active profile with valid typed arguments. Preserve originating project_id and global scope decisions. Never silently substitute another tool when a route is unavailable; report unresolved sources or unavailable routes honestly.`,
    `Expansion effects: ${BT}memory_read:get${BT} updates record access counters; ${BT}memory_find:related${BT} touches returned memories and synapses. Do not describe expansion as zero-touch.`,
    `pd-06 product gap: Public compact bootstrap has no trusted cross-call comparison input. Cross-call version comparison is unavailable in public compact bootstrap: report comparison as unavailable when that fact matters; unconditionally never fabricate ${BT}version_mismatch${BT} or ${BT}refresh_required${BT}.`,
    `Mutation boundaries: Search before creating a new memory (${BT}memory_write:add${BT}). Deliberate _global mutation requires confirm_global=true. Epistemic admission (${BT}epistemic_admit${BT}) and receipts (${BT}epistemic_append_receipt${BT}) remain separate boundaries. Cognitive event append (${BT}cognitive_event_append${BT}) and read (${BT}cognitive_event_read${BT}) remain separate routes.`,
    `Preserve evidence. ${contract.belief_hygiene.maxim}`,
    `For a qualifying resolved-tracker change, follow this order:\n\n${numbered(contract.tracker.required_order)}`,
  ];

  const fullDoc = [
    generatedNotice,
    `# Mem-Graph Agent Practice v${contract.version}`,
    '',
    `Status: ${contract.status}`,
    '',
    contract.purpose,
    '',
    '## Authority order',
    '',
    numbered(contract.authority_order),
    '',
    '## Profile discovery and tool routing',
    '',
    contract.profiles.discovery_rule,
    '',
    `### Agent profile (${contract.profiles.agent.tool_names.length} workflow tools)`,
    '',
    agentToolsList,
    '',
    '**Typed routing operations:**',
    '',
    typedRoutingList,
    '',
    `### Full compatibility profile (${contract.profiles.full.tool_count} legacy tools)`,
    '',
    `The ${contract.profiles.compatibility_profile} profile retains all ${contract.profiles.full.tool_count} legacy tools for backward compatibility with existing hosts. Default bootstrap response mode is legacy.`,
    '',
    `### Maintenance profile (${contract.profiles.maintenance.tool_count} specialist tools)`,
    '',
    `Specialist database administration, SQL execution, raw policy evaluation, and maintenance diagnostics belong to the ${contract.profiles.maintenance_profile} profile and are excluded from the everyday agent workflow.`,
    '',
    '## Required workflow',
    '',
    numbered(workflowSteps),
    '',
    '## Guidance verification',
    '',
    'Verify:',
    '',
    bullets(contract.guidance.verify),
    '',
    'memory_find:search discovers scoped contextual candidates; it does not create a governing lane or establish authority. Directly fetch candidates with memory_read:get and verify authority from an operator-adopted artifact, canonical role, or explicit delegation. If authority cannot be established, report current guidance unresolved.',
    '',
    'Contradictions queue review without automatic rejection or silent adoption. Applicability and priming may decay; historical confidence is not silently rewritten.',
    '',
    '## Known product gaps',
    '',
    `- **pd-06 cross-call version comparison**: ${contract.known_gaps.pd_06_cross_call_version_comparison.description} Rules:`,
    contract.known_gaps.pd_06_cross_call_version_comparison.rules.map((r) => `  - ${r}`).join('\n'),
    '',
    '## Enforcement',
    '',
    'Hard enforcement is disabled. The current mechanism is instruction, an observable read-only bootstrap, and compliance evaluation. Blocking may be considered only after repeated evaluation failures and explicit operator authorization.',
    '',
  ].join('\n');

  return new Map([
    [join(base, 'MEM_GRAPH_AGENT_PRACTICE.md'), fullDoc],
    [
      join(base, 'adapters', 'AGENTS.fragment.md'),
      `${generatedNotice}\n## Mem-Graph Practice\n\nUse $mem-graph-practice for non-trivial mem-graph or Cognitive OS work. ${common}\n`,
    ],
    [
      join(base, 'adapters', 'CLAUDE.fragment.md'),
      `${generatedNotice}\n## Mem-Graph Practice\n\nLoad and follow .agents/skills/mem-graph-practice/SKILL.md for non-trivial mem-graph or Cognitive OS work. ${common}\n`,
    ],
    [
      join(base, 'adapters', 'GEMINI.fragment.md'),
      `${generatedNotice}\n## Mem-Graph Practice\n\nRead .agents/skills/mem-graph-practice/SKILL.md before non-trivial mem-graph or Cognitive OS work. ${common}\n`,
    ],
    [
      join(base, 'adapters', 'generic-system-prompt.md'),
      `${generatedNotice}\n# Mem-Graph Practice Adapter\n\nBefore non-trivial mem-graph or Cognitive OS work, read the repository's canonical contract at cognitive-os/agent-practice/MEM_GRAPH_AGENT_PRACTICE.md. ${common}\n`,
    ],
  ]);
}

function renderReasoningGates(contract) {
  const baseName = basename(contract);
  const title = titleFrom(contract);
  const generatedNotice = `<!-- Generated from reasoning-gates.v1.json (${contract.practice_id}@${contract.version}). Do not edit by hand. -->`;
  const gate = contract.gates.pre_mortem;
  const common = `Reasoning gates produce advisory artifacts only; they do not authorize execution. A passed gate proves coverage; execution authority remains with the operator and turn-shape. Run turn-shape Risk Trigger delegation before an irreversible action, implementation commitment, or persistent-state change. Pre-mortem is the first gate; completion-audit is a deferred sibling for post-execution missed-risk review. Treat gate results as candidates; fetch selected records directly when full verification is still needed.`;

  const scopeEntries = Object.entries(contract.scope)
    .filter(([k]) => k !== 'rule')
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  const enforcementEntries = Object.entries(contract.enforcement)
    .filter(([k]) => k !== 'enable_blocking_only_after')
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const longDoc = [
    generatedNotice,
    `# ${title} v${contract.version}`,
    '',
    `Status: ${contract.status}`,
    '',
    contract.purpose,
    '',
    `Principle: ${contract.principle}`,
    '',
    '## Authority order',
    '',
    numbered(contract.authority_order),
    '',
    '## Scope',
    '',
    scopeEntries,
    '',
    contract.scope.rule,
    '',
    '## Gates',
    '',
    `### pre-mortem (${gate.mode})`,
    '',
    '**Applies to:**',
    '',
    bullets(gate.applies_to),
    '',
    '**Trigger words:**',
    '',
    bullets(gate.trigger_words),
    '',
    '**Required coverage:**',
    '',
    `- Categories: ${gate.coverage.category_coverage_required.join(', ')}`,
    `- Causal independence: ${gate.coverage.causal_independence_required}`,
    `- Mechanism specificity: ${gate.coverage.rejection}`,
    '',
    '**Required fields:**',
    '',
    bullets(gate.required_fields),
    '',
    `**Warning check status:** ${gate.warning_check_status_enum.join(', ')}. Evidence required when status is verified or refused.`,
    '',
    '**Rollback required when** commitment_boundary is irreversible_action or persistent_state_change.',
    '',
    '**Statuses:**',
    '',
    `- Skill emits: ${gate.statuses.skill_emitted.join(', ')}`,
    `- Authorized actor emits: ${gate.statuses.actor_emitted.join(', ')}`,
    `- Forbidden: ${gate.statuses.forbidden.join(', ')}`,
    '',
    `**Accepted-risk authority:** ${gate.accepted_risk_authority.join(', ')}`,
    '',
    '**Waiver required fields:**',
    '',
    bullets(gate.waiver_required_fields),
    '',
    '**Must occur before:**',
    '',
    bullets(gate.must_occur_before),
    '',
    `**Artifact storage:** ${gate.artifact_storage.type} at ${BT}${gate.artifact_storage.location_pattern}${BT}, referenced from ${gate.artifact_storage.referenced_from}.`,
    '',
    `**Sibling:** ${gate.completion_audit_sibling} (deferred; ${gate.completion_audit_note})`,
    '',
    '## Evaluation',
    '',
    `- Dedicated validator: ${BT}${contract.evaluation.dedicated_validator}${BT}`,
    `- Deterministic-first: ${contract.evaluation.deterministic_first}`,
    `- Scope discipline: ${contract.evaluation.scope_discipline}`,
    `- Deterministic script: ${BT}${contract.evaluation.deterministic_script}${BT}`,
    '',
    '## Enforcement',
    '',
    enforcementEntries,
    '',
    contract.enforcement.enable_blocking_only_after,
    '',
  ].join('\n');

  return new Map([
    [join(base, `${baseName}.md`), longDoc],
    [
      join(base, 'adapters', `${baseName}.AGENTS.fragment.md`),
      `${generatedNotice}\n## ${title}\n\nUse reasoning gates for non-trivial pre-commit analysis. ${common}\n`,
    ],
    [
      join(base, 'adapters', `${baseName}.CLAUDE.fragment.md`),
      `${generatedNotice}\n## ${title}\n\nLoad and follow .claude/skills/pre-mortem/SKILL.md for pre-commit failure analysis. ${common}\n`,
    ],
    [
      join(base, 'adapters', `${baseName}.GEMINI.fragment.md`),
      `${generatedNotice}\n## ${title}\n\nRead .agents/skills/pre-mortem/SKILL.md before pre-commit failure analysis. ${common}\n`,
    ],
    [
      join(base, 'adapters', `${baseName}.generic-system-prompt.md`),
      `${generatedNotice}\n# ${title} Adapter\n\nBefore pre-commit failure analysis, read the canonical contract at cognitive-os/agent-practice/${baseName}.md. ${common}\n`,
    ],
  ]);
}

let totalMismatch = false;
for (const target of targets) {
  let contract;
  try {
    contract = JSON.parse(readFileSync(target.path, 'utf8'));
  } catch (e) {
    process.stderr.write(`Skipping ${target.path}: ${e.message}\n`);
    continue;
  }

  const renderer = renderers[contract.practice_id];
  if (!renderer) {
    process.stderr.write(`No renderer registered for ${contract.practice_id} (${target.path}); skipping\n`);
    continue;
  }

  const outputs = renderer(contract);
  for (const [path, content] of outputs) {
    if (check) {
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        current = '';
      }
      if (normalizeNewlines(current) !== normalizeNewlines(content)) {
        process.stderr.write(`Out-of-date generated artifact: ${path}\n`);
        totalMismatch = true;
      }
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    process.stdout.write(`Wrote ${path}\n`);
  }
}

if (totalMismatch) process.exitCode = 1;
