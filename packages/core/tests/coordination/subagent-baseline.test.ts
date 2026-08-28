import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import { DEFAULT_SUBAGENT_BASELINE } from '../../src/coordination/director-prompts.js';
import { renderInstructionLayer } from '../../src/core/instruction-template.js';
import type { MultiAgentConfig } from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

const BASELINE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'instructions',
    'coordination',
    'subagent-baseline.md',
  ),
  'utf8',
);

function render(tools: string[]): string {
  return renderInstructionLayer(BASELINE, {
    toolNames: new Set(tools),
    tier: 'off',
    subagent: true,
    strictToolReferences: true,
  });
}

describe('subagent baseline — tool-gated discovery', () => {
  it('is the same source the director composers load', () => {
    expect(DEFAULT_SUBAGENT_BASELINE.trim()).toBe(BASELINE.trim());
  });

  it('hides every index tool name when none are registered', () => {
    const out = render(['read', 'grep', 'glob', 'tree']);
    expect(out).toContain('No index tools are registered');
    expect(out).not.toContain('codebase-search');
    expect(out).not.toContain('codebase-stats');
    expect(out).not.toContain('codebase-incoming-calls');
    expect(out).not.toContain('codebase-impact-analysis');
    expect(out).not.toContain('codebase-ast-replace');
    expect(out).not.toContain('codebase-targeted-test');
    expect(out).toContain('`grep`');
  });

  it('teaches index-first search when only search/stats are live', () => {
    const out = render(['read', 'grep', 'glob', 'tree', 'codebase-search', 'codebase-stats']);
    expect(out).toContain('## Codebase discovery');
    expect(out).toContain('`codebase-search`');
    expect(out).toContain('`codebase-stats`');
    expect(out).toContain('before broad `grep`/`glob`/`tree`');
    expect(out).not.toContain('No index tools are registered');
    expect(out).not.toContain('`codebase-impact-analysis`');
    expect(out).not.toContain('`codebase-ast-replace`');
  });

  it('includes the full inspect-and-mutate playbook when those tools are live', () => {
    const out = render([
      'read',
      'grep',
      'edit',
      'codebase-search',
      'codebase-repo-map',
      'codebase-skeleton',
      'codebase-incoming-calls',
      'codebase-outgoing-calls',
      'codebase-impact-analysis',
      'codebase-ast-replace',
      'codebase-invariant-check',
      'codebase-targeted-test',
    ]);
    expect(out).toContain('`codebase-repo-map`');
    expect(out).toContain('`codebase-skeleton`');
    expect(out).toContain('`codebase-incoming-calls`');
    expect(out).toContain('`codebase-impact-analysis`');
    expect(out).toContain('## Mutation and verification');
    expect(out).toContain('`codebase-ast-replace`');
    expect(out).toContain('`codebase-invariant-check`');
    expect(out).toContain('`codebase-targeted-test`');
  });

  it('omits mailbox protocol when no mail tools are registered', () => {
    expect(render(['read', 'grep'])).not.toContain('## Mailbox protocol');
    expect(render(['read', 'mailbox'])).toContain('## Mailbox protocol');
  });

  it('teaches session_note as the same-session leader channel when registered', () => {
    expect(render(['read', 'grep'])).not.toContain('## Same-session notes');
    const out = render(['read', 'session_note']);
    expect(out).toContain('## Same-session notes');
    expect(out).toContain('`session_note to="leader"`');
    expect(out).not.toContain('## Mailbox protocol');
  });

  it('director render uses the live subagent tool slice', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: {
        coordinatorId: 'test-director',
        doneCondition: { type: 'all_tasks_done' },
      } satisfies MultiAgentConfig,
    });
    const browserish = director.subagentSystemPrompt({
      id: 'browser',
      name: 'Browser',
      role: 'browser',
      prompt: 'You are the Browser agent.',
      tools: ['read', 'grep', 'glob', 'tree', 'fetch'],
    });
    expect(browserish).toContain('No index tools are registered');
    expect(browserish).not.toContain('codebase-search');

    const explorer = director.subagentSystemPrompt({
      id: 'explore',
      name: 'Explore',
      role: 'explore',
      prompt: 'You are the Explore agent.',
      tools: [
        'read',
        'grep',
        'glob',
        'tree',
        'codebase-search',
        'codebase-repo-map',
        'codebase-skeleton',
      ],
    });
    expect(explorer).toContain('`codebase-search`');
    expect(explorer).toContain('`codebase-repo-map`');
    expect(explorer).not.toContain('No index tools are registered');
  });
});
