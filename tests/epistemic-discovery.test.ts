import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as epistemic from '../src/epistemic/index.js';

function readRepositoryFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
}

describe('epistemic kernel public discovery', () => {
  it('documents stable repository-relative entry points', () => {
    const readme = readRepositoryFile('README.md');
    const roadmap = readRepositoryFile('cognitive-os/ROADMAP.md');

    expect(readme).toContain('### Epistemic Memory Phase 0 kernel');
    expect(readme).toContain('src/epistemic/index.ts');
    expect(readme).toContain('docs/EPISTEMIC_MEMORY_PHASE0_IMPLEMENTATION_REPORT.md');
    expect(roadmap).toContain('## Phase A: Pure Epistemic Kernel Recovery and Publication');
    expect(roadmap).toContain('../docs/EPISTEMIC_MEMORY_PHASE0_IMPLEMENTATION_REPORT.md');
  });

  it('exports the complete pure-kernel surface from one barrel', () => {
    expect(epistemic.EpistemicRecordSchema).toBeDefined();
    expect(epistemic.validateEpistemicRecord).toBeTypeOf('function');
    expect(epistemic.compileCompactPrime).toBeTypeOf('function');
    expect(epistemic.synthesizeAssessments).toBeTypeOf('function');
    expect(epistemic.projectBeliefMaintenance).toBeTypeOf('function');
    expect(epistemic.buildBeliefReviewQueue).toBeTypeOf('function');
  });

  it('keeps public epistemic documents free of deployment-local paths and memory IDs', () => {
    const documents = [
      'docs/EPISTEMIC_MEMORY_BASE_LAYER_PROPOSAL.md',
      'docs/EPISTEMIC_MEMORY_PHASE0_IMPLEMENTATION_REPORT.md',
      'docs/EPISTEMIC_MEMORY_V0_3_IMPLEMENTATION_HANDOFF.md',
      'docs/EPISTEMIC_MEMORY_V0_4_STALE_BELIEF_CONTROL.md',
    ].map(readRepositoryFile).join('\n');

    expect(documents).not.toMatch(/[A-Za-z]:\\Users\\/);
    expect(documents).not.toMatch(/Memory\s+`?\d{2,}`?/);
    expect(documents).not.toMatch(/\[\[\d+\]\]/);
  });

  it('does not register the pure kernel with the database or MCP runtime', () => {
    const runtime = [
      readRepositoryFile('src/index.ts'),
      readRepositoryFile('src/db.ts'),
      readRepositoryFile('src/tools/cognitive.ts'),
    ].join('\n');

    expect(runtime).not.toMatch(/from ['"][^'"]*epistemic/);
  });
});
