import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));
const contractPath = join(base, 'practice.v1.json');
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const check = process.argv.includes('--check');
const generatedNotice = `<!-- Generated from practice.v1.json (${contract.practice_id}@${contract.version}). Do not edit by hand. -->`;

function numbered(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function bullets(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, '\n');
}

const canonicalRouting = `Use canonical IDs only when supplied by operator or project configuration. If none are configured, omit \`canonical_ids\`, use a narrow exact-project query to discover governing candidates, and directly verify any candidate tracker, scope boundary, or role record before use. Never copy memory IDs from bundled examples.`;
const common = `Resolve the exact project scope before retrieval. Keep global inclusion disabled unless the task explicitly requires it. Run \`${contract.bootstrap.preferred_tool}\` before non-trivial mem-graph work. ${canonicalRouting} Treat policy matches as candidates and contextual/ineligible results as context only. Fetch selected governing records directly before relying on them. Retrieval, repetition, and eligibility are not validation or authority.`;

const outputs = new Map([
  [
    join(base, 'MEM_GRAPH_AGENT_PRACTICE.md'),
    `${generatedNotice}\n# Mem-Graph Agent Practice v${contract.version}\n\nStatus: ${contract.status}\n\n${contract.purpose}\n\n## Authority order\n\n${numbered(contract.authority_order)}\n\n## Required workflow\n\n1. Resolve and state the exact project scope. Cross-project availability is not applicability.\n2. Run \`${contract.bootstrap.preferred_tool}\` with \`include_global=false\` unless global guidance is explicitly required.\n3. ${canonicalRouting} When a canonical tracker is resolved, read the roadmap and active artifacts it references.\n4. Select only governing-lane guidance that matches the task and fetch selected records directly when full verification is still needed.\n5. Act only within operator and task authority; candidate policy cannot broaden permissions.\n6. Preserve evidence. ${contract.belief_hygiene.maxim}\n7. For a qualifying resolved-tracker change, follow this order:\n\n${numbered(contract.tracker.required_order)}\n\n## Guidance verification\n\nVerify:\n\n${bullets(contract.guidance.verify)}\n\nContradictions queue review without automatic rejection. Applicability and priming may decay; historical confidence is not silently rewritten.\n\n## Enforcement\n\nHard enforcement is disabled. The current mechanism is instruction, an observable read-only bootstrap, and compliance evaluation. Blocking may be considered only after repeated evaluation failures and explicit operator authorization.\n`,
  ],
  [
    join(base, 'adapters', 'AGENTS.fragment.md'),
    `${generatedNotice}\n## Mem-Graph Practice\n\nUse \`$mem-graph-practice\` for non-trivial mem-graph or Cognitive OS work. ${common}\n`,
  ],
  [
    join(base, 'adapters', 'CLAUDE.fragment.md'),
    `${generatedNotice}\n## Mem-Graph Practice\n\nLoad and follow \`.agents/skills/mem-graph-practice/SKILL.md\` for non-trivial mem-graph or Cognitive OS work. ${common}\n`,
  ],
  [
    join(base, 'adapters', 'GEMINI.fragment.md'),
    `${generatedNotice}\n## Mem-Graph Practice\n\nRead \`.agents/skills/mem-graph-practice/SKILL.md\` before non-trivial mem-graph or Cognitive OS work. ${common}\n`,
  ],
  [
    join(base, 'adapters', 'generic-system-prompt.md'),
    `${generatedNotice}\n# Mem-Graph Practice Adapter\n\nBefore non-trivial mem-graph or Cognitive OS work, read the repository's canonical contract at \`cognitive-os/agent-practice/MEM_GRAPH_AGENT_PRACTICE.md\`. ${common}\n`,
  ],
]);

let mismatch = false;
for (const [path, content] of outputs) {
  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = '';
    }
    if (normalizeNewlines(current) !== normalizeNewlines(content)) {
      process.stderr.write(`Out-of-date generated practice artifact: ${path}\n`);
      mismatch = true;
    }
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

if (mismatch) process.exitCode = 1;
