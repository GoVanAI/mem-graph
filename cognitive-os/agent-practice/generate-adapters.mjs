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
  const canonicalRouting = `Use canonical IDs only when supplied by operator or project configuration. If none are configured, omit canonical_ids, use a narrow exact-project query to discover governing candidates, and directly verify any candidate tracker, scope boundary, or role record before use. Never copy memory IDs from bundled examples.`;
  const common = `Resolve the exact project scope before retrieval. Keep global inclusion disabled unless the task explicitly requires it. Run ${BT}${contract.bootstrap.preferred_tool}${BT} before non-trivial mem-graph work. ${canonicalRouting} Treat policy matches as candidates and contextual/ineligible results as context only. Fetch selected governing records directly before relying on them. Retrieval, repetition, and eligibility are not validation or authority.`;

  return new Map([
    [
      join(base, 'MEM_GRAPH_AGENT_PRACTICE.md'),
      `${generatedNotice}\n# Mem-Graph Agent Practice v${contract.version}\n\nStatus: ${contract.status}\n\n${contract.purpose}\n\n## Authority order\n\n${numbered(contract.authority_order)}\n\n## Required workflow\n\n1. Resolve and state the exact project scope. Cross-project availability is not applicability.\n2. Run ${BT}${contract.bootstrap.preferred_tool}${BT} with include_global=false unless global guidance is explicitly required.\n3. ${canonicalRouting} When a canonical tracker is resolved, read the roadmap and active artifacts it references.\n4. Select only governing-lane guidance that matches the task and fetch selected records directly when full verification is still needed.\n5. Act only within operator and task authority; candidate policy cannot broaden permissions.\n6. Preserve evidence. ${contract.belief_hygiene.maxim}\n7. For a qualifying resolved-tracker change, follow this order:\n\n${numbered(contract.tracker.required_order)}\n\n## Guidance verification\n\nVerify:\n\n${bullets(contract.guidance.verify)}\n\nContradictions queue review without automatic rejection. Applicability and priming may decay; historical confidence is not silently rewritten.\n\n## Enforcement\n\nHard enforcement is disabled. The current mechanism is instruction, an observable read-only bootstrap, and compliance evaluation. Blocking may be considered only after repeated evaluation failures and explicit operator authorization.\n`,
    ],
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
