import { describe, expect, it, vi, beforeEach } from 'vitest';
import gitAutocommitPlugin from '../src/git-autocommit';

const mockApi = {
  tools: {
    register: vi.fn(),
  },
  config: { extensions: {} },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
  events: {
    on: vi.fn(),
  },
};

describe('git-autocommit plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers only git_autocommit (git_stage and git_status_summary removed)', () => {
    gitAutocommitPlugin.setup(mockApi as any);
    const tools = mockApi.tools.register.mock.calls.map(([t]: any[]) => t.name);

    expect(tools).toContain('git_autocommit');
    expect(tools).not.toContain('git_stage');
    expect(tools).not.toContain('git_status_summary');
  });

  it('git_autocommit tool schema is correct', () => {
    gitAutocommitPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'git_autocommit',
    )?.[0];

    expect(tool).toBeDefined();
    expect(tool?.name).toBe('git_autocommit');
    expect(tool?.description).toContain('AI-generated');
    expect(tool?.permission).toBe('confirm');
    expect(tool?.mutating).toBe(true);
    expect(tool?.inputSchema.type).toBe('object');
    expect(tool?.inputSchema.properties?.type?.enum).toEqual([
      'feat',
      'fix',
      'docs',
      'style',
      'refactor',
      'test',
      'chore',
      'perf',
      'ci',
      'build',
      'revert',
    ]);
  });
});
