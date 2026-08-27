import { describe, expect, it } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import {
  composeDirectorPrompt,
  composeSubagentPrompt,
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  rosterSummaryFromConfigs,
} from '../../src/coordination/director-prompts.js';
import type { MultiAgentConfig, SubagentConfig } from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

const baseConfig: MultiAgentConfig = {
  coordinatorId: 'test-director',
  doneCondition: { type: 'all_tasks_done' },
};

describe('composeDirectorPrompt', () => {
  it('uses the built-in preamble by default', () => {
    const out = composeDirectorPrompt();
    expect(out).toBe(DEFAULT_DIRECTOR_PREAMBLE.trim());
  });

  it('appends the user base prompt after the preamble', () => {
    const out = composeDirectorPrompt({ basePrompt: 'You manage refactors.' });
    expect(out.startsWith(DEFAULT_DIRECTOR_PREAMBLE.trim())).toBe(true);
    expect(out.endsWith('You manage refactors.')).toBe(true);
    expect(out).toContain('\n\nYou manage refactors.');
  });

  it('inserts a roster summary between preamble and base prompt', () => {
    const out = composeDirectorPrompt({
      basePrompt: 'BASE',
      rosterSummary: '- coder: Coder',
    });
    const preambleIdx = out.indexOf('You are the Director');
    const rosterIdx = out.indexOf('Roles you can spawn');
    const baseIdx = out.indexOf('BASE');
    expect(preambleIdx).toBeLessThan(rosterIdx);
    expect(rosterIdx).toBeLessThan(baseIdx);
    // The roster is introduced as a routing instruction, not a bare menu: a
    // leader handed 77 look-alike lines falls back to the ids it can recall.
    expect(out).toMatch(/deep and specialised/);
    expect(out).toContain('`description`');
  });

  it('honors empty preamble override (suppresses fleet protocol block)', () => {
    const out = composeDirectorPrompt({
      directorPreamble: '',
      basePrompt: 'Only this.',
    });
    expect(out).toBe('Only this.');
    expect(out).not.toContain('You are the Director');
  });

  it('honors a custom preamble', () => {
    const out = composeDirectorPrompt({
      directorPreamble: 'CUSTOM PREAMBLE',
      basePrompt: 'BASE',
    });
    expect(out).toBe('CUSTOM PREAMBLE\n\nBASE');
  });

  it('skips empty sections (no stray blank lines)', () => {
    const out = composeDirectorPrompt({
      directorPreamble: 'A',
      basePrompt: '   ',
      rosterSummary: '',
    });
    expect(out).toBe('A');
    expect(out).not.toMatch(/\n\n\n/);
  });
});

describe('composeSubagentPrompt', () => {
  it('uses the built-in baseline by default', () => {
    const out = composeSubagentPrompt();
    expect(out).toBe(DEFAULT_SUBAGENT_BASELINE.trim());
  });

  it('layers baseline → role → task → override in that order', () => {
    const out = composeSubagentPrompt({
      role: 'You are a code reviewer.',
      task: 'Review src/foo.ts',
      override: 'Respond only in JSON.',
    });
    const baselineIdx = out.indexOf('You are a subagent');
    const roleIdx = out.indexOf('Role:');
    const taskIdx = out.indexOf('Task:');
    const overrideIdx = out.indexOf('Respond only in JSON');
    expect(baselineIdx).toBeGreaterThanOrEqual(0);
    expect(baselineIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(taskIdx);
    expect(taskIdx).toBeLessThan(overrideIdx);
  });

  it('per-spawn override is the last layer (wins on conflict)', () => {
    const out = composeSubagentPrompt({
      baseline: 'BASELINE',
      role: 'ROLE',
      override: 'OVERRIDE',
    });
    expect(out.lastIndexOf('OVERRIDE')).toBeGreaterThan(out.lastIndexOf('ROLE'));
    expect(out.lastIndexOf('OVERRIDE')).toBeGreaterThan(out.lastIndexOf('BASELINE'));
  });

  it('empty baseline override suppresses the bridge-contract block', () => {
    const out = composeSubagentPrompt({
      baseline: '',
      role: 'r',
      override: 'o',
    });
    expect(out).not.toContain('Bridge contract');
    expect(out).not.toContain('You are a subagent');
  });

  it('drops empty role/task/override entirely (no header-only blocks)', () => {
    const out = composeSubagentPrompt({
      baseline: 'X',
      role: '   ',
      task: '',
    });
    expect(out).toBe('X');
    expect(out).not.toContain('Role:');
    expect(out).not.toContain('Task:');
  });

  it('does NOT leak parent system prompt or tool list (regression test)', () => {
    // The baseline forbids subagents from requesting parent context. This
    // test pins that down — a future edit that accidentally adds parent
    // prompt material to the baseline would break it.
    const out = composeSubagentPrompt();
    expect(out).toMatch(/MAY NOT request the parent's system prompt/);
    expect(out).toMatch(/tool list/);
  });

  it('inserts shared scratchpad block between task and override', () => {
    const out = composeSubagentPrompt({
      role: 'reviewer',
      task: 'review src/foo.ts',
      sharedScratchpad: '/tmp/fleet/run-1/shared',
      override: 'respond in JSON',
    });
    const taskIdx = out.indexOf('Task:');
    const sharedIdx = out.indexOf('Shared notes:');
    const overrideIdx = out.indexOf('respond in JSON');
    expect(taskIdx).toBeLessThan(sharedIdx);
    expect(sharedIdx).toBeLessThan(overrideIdx);
    expect(out).toContain('/tmp/fleet/run-1/shared');
    expect(out).toContain('list the directory and read any sibling files');
  });

  it('omits shared scratchpad block when not configured', () => {
    const out = composeSubagentPrompt({ role: 'r' });
    expect(out).not.toContain('Shared notes:');
    expect(out).not.toContain('scratchpad');
  });
});

describe('rosterSummaryFromConfigs', () => {
  it('renders one bullet per role with provider/model + capability', () => {
    const out = rosterSummaryFromConfigs({
      researcher: {
        name: 'Researcher',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        prompt: 'You research things.',
      },
      coder: {
        name: 'Coder',
        provider: 'openai',
        model: 'gpt-5',
        prompt: 'You write code.\nMore details.',
      },
    });
    // The display name is dropped when it only re-states the role id: on a
    // 77-line menu that repetition is the noise the leader has to read past.
    expect(out).toBe(
      [
        '- researcher (anthropic/claude-haiku-4-5-20251001) — You research things.',
        '- coder (openai/gpt-5) — You write code.',
      ].join('\n'),
    );
  });

  it('prefers the curated capability summary over the prompt headline', () => {
    const out = rosterSummaryFromConfigs({
      database: {
        name: 'Database',
        prompt: 'You are the Database agent. Your job is schema design, query work, and more.',
        dispatch: {
          summary: 'Schema design, query optimization, and safe reversible migrations.',
          keywords: ['schema', 'migration'],
        },
      },
    });
    // Every role prompt opens with the same "You are the X agent" boilerplate,
    // so a headline built from it spends its budget before saying anything.
    expect(out).toBe(
      '- database — Schema design, query optimization, and safe reversible migrations.',
    );
    expect(out).not.toContain('You are the');
  });

  it('keeps a display name that carries information the id does not', () => {
    const out = rosterSummaryFromConfigs({
      'shadow-agent': { name: 'Shadow Monitor', prompt: 'Watches the fleet.' },
    });
    expect(out).toBe('- shadow-agent (Shadow Monitor) — Watches the fleet.');
  });

  it('falls back to the prompt headline, without its markdown heading marker', () => {
    const out = rosterSummaryFromConfigs({
      generic: { name: 'Generic Project Agent', prompt: '# Generic Project Agent\n\nBody.' },
    });
    expect(out).toBe('- generic (Generic Project Agent) — Generic Project Agent');
  });

  it('omits provider/model tag when not configured', () => {
    const out = rosterSummaryFromConfigs({
      thing: { name: 'Thing', prompt: 'Do thing.' },
    });
    expect(out).toBe('- thing — Do thing.');
  });

  it('omits the capability when the role has neither summary nor prompt', () => {
    const out = rosterSummaryFromConfigs({
      bare: { name: 'Bare' },
    });
    expect(out).toBe('- bare');
  });

  it('truncates a long capability rather than letting one role flood the menu', () => {
    const out = rosterSummaryFromConfigs({
      r: { name: 'R', prompt: 'a'.repeat(400) },
    });
    const headlinePart = out.split(' — ')[1] as string;
    expect(headlinePart).toHaveLength(150);
    expect(headlinePart.endsWith('…')).toBe(true);
  });
});

describe('Director.leaderSystemPrompt / subagentSystemPrompt', () => {
  it('leaderSystemPrompt composes preamble + base by default', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: {
        ...baseConfig,
        leaderSystemPrompt: 'BASE LEADER PROMPT',
      },
    });
    const out = director.leaderSystemPrompt();
    expect(out).toContain('You are the Director');
    expect(out).toContain('BASE LEADER PROMPT');
  });

  it('leaderSystemPrompt accepts an explicit base override', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: { ...baseConfig, leaderSystemPrompt: 'IGNORED' },
    });
    const out = director.leaderSystemPrompt('EXPLICIT');
    expect(out).toContain('EXPLICIT');
    expect(out).not.toContain('IGNORED');
  });

  it('leaderSystemPrompt includes roster summary when roster is provided', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: baseConfig,
      roster: {
        coder: { name: 'Coder', provider: 'openai', model: 'gpt-5', prompt: 'Codes things.' },
      },
    });
    const out = director.leaderSystemPrompt();
    expect(out).toContain('Roles you can spawn');
    expect(out).toContain('- coder (openai/gpt-5) — Codes things.');
  });

  it('directorPreamble option overrides the built-in preamble', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: baseConfig,
      directorPreamble: 'MY CUSTOM PREAMBLE',
    });
    const out = director.leaderSystemPrompt('B');
    expect(out).toContain('MY CUSTOM PREAMBLE');
    expect(out).not.toContain('You are the Director');
  });

  it('subagentSystemPrompt composes baseline + role + override', () => {
    const director = new Director({ sessionId: TEST_SESSION_ID, config: baseConfig });
    const cfg: SubagentConfig = {
      name: 'reviewer',
      prompt: 'You review code.',
      systemPromptOverride: 'Respond only in JSON.',
    };
    const out = director.subagentSystemPrompt(cfg, 'Review src/foo.ts');
    expect(out).toContain('You are a subagent');
    expect(out).toContain('Role:\nYou review code.');
    expect(out).toContain('Task:\nReview src/foo.ts');
    expect(out).toContain('Respond only in JSON.');
    expect(out.lastIndexOf('Respond only in JSON')).toBeGreaterThan(out.lastIndexOf('Role:'));
  });

  it('subagentBaseline option overrides the bridge-contract baseline', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: baseConfig,
      subagentBaseline: 'CUSTOM BASELINE',
    });
    const out = director.subagentSystemPrompt({ name: 'x', prompt: 'r' });
    expect(out).toContain('CUSTOM BASELINE');
    expect(out).not.toContain('You are a subagent');
  });

  it('omitting taskBrief drops the Task section', () => {
    const director = new Director({ sessionId: TEST_SESSION_ID, config: baseConfig });
    const out = director.subagentSystemPrompt({ name: 'x', prompt: 'r' });
    expect(out).not.toContain('Task:');
    expect(out).toContain('Role:\nr');
  });

  it('director with sharedScratchpadPath injects path into every subagent prompt', () => {
    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: baseConfig,
      sharedScratchpadPath: '/tmp/fleet/shared',
    });
    const out = director.subagentSystemPrompt({ name: 'x', prompt: 'r' }, 'do thing');
    expect(out).toContain('Shared notes:');
    expect(out).toContain('/tmp/fleet/shared');
    expect(director.sharedScratchpadPath).toBe('/tmp/fleet/shared');
  });

  it('director.sharedScratchpadPath is null when not configured', () => {
    const director = new Director({ sessionId: TEST_SESSION_ID, config: baseConfig });
    expect(director.sharedScratchpadPath).toBeNull();
    const out = director.subagentSystemPrompt({ name: 'x', prompt: 'r' });
    expect(out).not.toContain('Shared notes:');
  });
});
