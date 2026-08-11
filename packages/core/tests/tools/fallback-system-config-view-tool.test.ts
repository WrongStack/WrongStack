/**
 * Tests for createSystemConfigViewTool — comprehensive config viewer.
 * Covers: all section values (providers, models, fallbacks, matrix, agents,
 * refiner, doctor), the doctor health checks, and edge cases.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FallbackManageToolOptions } from '../../src/tools/fallback-manage-tool-options.js';
import { createSystemConfigViewTool } from '../../src/tools/fallback-system-config-view-tool.js';

function makeOpts(overrides: Record<string, unknown> = {}): FallbackManageToolOptions {
  const config: Record<string, unknown> = {
    provider: 'test-provider',
    model: 'test-model',
    providers: {
      'test-provider': { type: 'openai', apiKey: 'sk-test', models: ['test-model', 'other-model'] },
      'backup-provider': { type: 'anthropic', models: ['claude-3'] },
    },
    favoriteModels: ['test-provider/test-model'],
    fallbackModels: ['test-provider/other-model'],
    fallbackProfiles: { fast: ['test-provider/test-model'] },
    modelMatrix: {},
    fallbackAuto: true,
    favoriteModelsOnly: false,
    ...overrides,
  };
  return {
    getConfig: () => config as never,
    updateConfig: vi.fn(),
  };
}

describe('system_config_view — providers section', () => {
  it('lists configured providers with key status', async () => {
    const tool = createSystemConfigViewTool(makeOpts());
    const result = await tool.execute({ section: 'providers' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('test-provider');
    expect(result.message).toContain('backup-provider');
    expect(result.message).toContain('key:✓');
  });

  it('shows (none configured) when no providers exist', async () => {
    const tool = createSystemConfigViewTool(makeOpts({ providers: {} }));
    const result = await tool.execute({ section: 'providers' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('(none configured)');
  });

  it('marks the leader provider with a star', async () => {
    const tool = createSystemConfigViewTool(makeOpts());
    const result = await tool.execute({ section: 'providers' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('★ test-provider');
  });

  it('shows baseUrl and family when present', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        providers: {
          custom: {
            type: 'openai-compatible',
            baseUrl: 'http://localhost:8080',
            family: 'openai',
            apiKey: 'k',
          },
        },
      }),
    );
    const result = await tool.execute({ section: 'providers' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('url:http://localhost:8080');
    expect(result.message).toContain('family:openai');
  });
});

describe('system_config_view — models section', () => {
  it('lists favorites and settings', async () => {
    const tool = createSystemConfigViewTool(makeOpts());
    const result = await tool.execute({ section: 'models' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('test-provider/test-model');
    expect(result.message).toContain('fallbackAuto: on');
    expect(result.message).toContain('favoriteModelsOnly: off');
  });

  it('shows empty favorites message', async () => {
    const tool = createSystemConfigViewTool(makeOpts({ favoriteModels: [] }));
    const result = await tool.execute({ section: 'models' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('none');
  });
});

describe('system_config_view — fallbacks section', () => {
  it('shows chain and profiles', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({ fallbackBridge: 'test-provider/other-model' }),
    );
    const result = await tool.execute({ section: 'fallbacks' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('test-provider/other-model');
    expect(result.message).toContain('Continuity Bridge');
    expect(result.message).toContain('fast');
  });

  it('shows empty chain message', async () => {
    const tool = createSystemConfigViewTool(makeOpts({ fallbackModels: [], fallbackProfiles: {} }));
    const result = await tool.execute({ section: 'fallbacks' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('empty');
    expect(result.message).toContain('(none)');
  });
});

describe('system_config_view — matrix section', () => {
  it('shows role assignments', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        modelMatrix: { 'bug-hunter': { provider: 'test-provider', model: 'test-model' } },
      }),
    );
    const result = await tool.execute({ section: 'matrix' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('bug-hunter');
  });

  it('shows empty matrix message', async () => {
    const tool = createSystemConfigViewTool(makeOpts({ modelMatrix: {} }));
    const result = await tool.execute({ section: 'matrix' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('empty');
  });
});

describe('system_config_view — agents section', () => {
  it('lists catalog agents with resolved models', async () => {
    const tool = createSystemConfigViewTool(makeOpts());
    const result = await tool.execute({ section: 'agents' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('ROLE');
    expect(result.message).toContain('PHASE');
  });
});

describe('system_config_view — fleet section', () => {
  it('shows configured budget ceilings and override hints', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        maxConcurrent: 8,
        fleet: { budget: { maxSpawns: 256, maxTokens: 1_000_000, maxCostUsd: 12.5 } },
      }),
    );
    const result = await tool.execute({ section: 'fleet' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('Fleet Budgets');
    expect(result.message).toContain('maxConcurrent: 8');
    expect(result.message).toContain('maxSpawns: 256');
    expect(result.message).toContain('maxTokens: 1000000');
    expect(result.message).toContain('maxCostUsd: 12.5');
    expect(result.message).toContain('WRONGSTACK_MAX_SPAWNS');
    expect(result.message).toContain('/fleet status');
  });

  it('doctor validates fleet.budget numeric fields', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        fleet: { budget: { maxSpawns: -1 } },
      }),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('fleet.budget.maxSpawns');
  });
});

describe('system_config_view — refiner section', () => {
  it('shows refiner config defaults', async () => {
    const tool = createSystemConfigViewTool(makeOpts());
    const result = await tool.execute({ section: 'refiner' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('refinerProvider');
    expect(result.message).toContain('(same as leader)');
  });

  it('shows explicit refiner config', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        autonomy: {
          refinerProvider: 'openai',
          refinerModel: 'gpt-4o',
          refinerFallbackProfile: 'fast',
        },
      }),
    );
    const result = await tool.execute({ section: 'refiner' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('openai');
    expect(result.message).toContain('gpt-4o');
    expect(result.message).toContain('fast');
  });
});

describe('system_config_view — doctor section', () => {
  it('reports healthy config', async () => {
    const tool = createSystemConfigViewTool(makeOpts());
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('checks passed');
    expect(result.message).toContain('0 issues');
  });

  it('warns about favorite referencing unknown provider', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        favoriteModels: ['unknown-provider/some-model'],
      }),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('unknown provider');
  });

  it('reports a bare-model continuity bridge as invalid', async () => {
    const tool = createSystemConfigViewTool(makeOpts({ fallbackBridge: 'other-model' }));
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('must be a full provider/model reference');
  });

  it('warns about favorite model not in provider model list', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        favoriteModels: ['test-provider/nonexistent-model'],
      }),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('not in');
    expect(result.message).toContain('model list');
  });

  it('reports issue for chain entry with unknown provider', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        fallbackModels: ['ghost-provider/model'],
      }),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('issues');
  });

  it('reports issue for matrix referencing unknown provider', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        modelMatrix: { reviewer: { provider: 'ghost-provider', model: 'x' } },
      }),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('unknown provider');
  });

  it('reports issue for matrix referencing unknown fallback profile', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        modelMatrix: {
          reviewer: {
            provider: 'test-provider',
            model: 'test-model',
            fallbackProfile: 'nonexistent',
          },
        },
      }),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('unknown fallback profile');
  });

  it('warns about empty profile', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        fallbackProfiles: { empty: [] },
      }),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('empty');
  });

  it('warns when leader provider has no config entry', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({
        provider: 'unconfigured-provider',
        providers: { other: { type: 'openai', apiKey: 'k' } },
      }),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('no explicit config entry');
  });

  describe('empty-model reference detection', () => {
    it('reports an issue for a favorite entry with no model', async () => {
      const tool = createSystemConfigViewTool(
        makeOpts({
          favoriteModels: ['test-provider/'],
        }),
      );
      const result = await tool.execute({ section: 'doctor' }, {} as never, {
        signal: new AbortController().signal,
      });
      expect(result.message).toContain('Favorite');
      expect(result.message).toContain('has no model');
      expect(result.message).toContain('1 issue');
    });

    it('reports an issue for a chain entry with no model', async () => {
      const tool = createSystemConfigViewTool(
        makeOpts({
          fallbackModels: ['test-provider/'],
        }),
      );
      const result = await tool.execute({ section: 'doctor' }, {} as never, {
        signal: new AbortController().signal,
      });
      expect(result.message).toContain('Chain entry');
      expect(result.message).toContain('has no model');
    });

    it('reports an issue for a profile entry with no model', async () => {
      const tool = createSystemConfigViewTool(
        makeOpts({
          fallbackProfiles: { broken: ['test-provider/'] },
        }),
      );
      const result = await tool.execute({ section: 'doctor' }, {} as never, {
        signal: new AbortController().signal,
      });
      expect(result.message).toContain('Profile "broken"');
      expect(result.message).toContain('has no model');
    });

    it('reports an issue for a whitespace-only ref', async () => {
      const tool = createSystemConfigViewTool(
        makeOpts({
          favoriteModels: ['   '],
        }),
      );
      const result = await tool.execute({ section: 'doctor' }, {} as never, {
        signal: new AbortController().signal,
      });
      expect(result.message).toContain('has no model');
    });
  });

  it('warns when fallbackMaxLastResortCandidates is negative', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({ fallbackMaxLastResortCandidates: -5 } as never),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('fallbackMaxLastResortCandidates');
    expect(result.message).toContain('negative');
  });

  it('warns when fallbackMaxLastResortCandidates is non-finite', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({ fallbackMaxLastResortCandidates: Number.NaN } as never),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('fallbackMaxLastResortCandidates');
    expect(result.message).toContain('non-negative');
    expect(result.message).toContain('NaN');
  });

  it('passes silently when fallbackMaxLastResortCandidates is a valid number', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({ fallbackMaxLastResortCandidates: 20 } as never),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('0 issues');
  });

  it('warns when fallbackMaxLastResortCandidates is a fraction that floors to 0', async () => {
    const tool = createSystemConfigViewTool(
      makeOpts({ fallbackMaxLastResortCandidates: 0.5 } as never),
    );
    const result = await tool.execute({ section: 'doctor' }, {} as never, {
      signal: new AbortController().signal,
    });
    // 0.5 floors to 0 at runtime — the doctor must surface this so the user
    // is not surprised by a silently disabled last-resort append.
    expect(result.message).toContain('disabled');
  });
});

describe('system_config_view — all section', () => {
  it('includes all sections', async () => {
    const tool = createSystemConfigViewTool(makeOpts());
    const result = await tool.execute({ section: 'all' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.message).toContain('Leader');
    expect(result.message).toContain('Providers');
    expect(result.message).toContain('Favorites');
    expect(result.message).toContain('Fallback Chain');
    expect(result.message).toContain('Model Matrix');
    expect(result.message).toContain('Agent Models');
    expect(result.message).toContain('Configuration Doctor');
    expect(result.message).toContain('Goal Refinement');
  });

  it('defaults to all when section is omitted', async () => {
    const tool = createSystemConfigViewTool(makeOpts());
    const result = await tool.execute({}, {} as never, { signal: new AbortController().signal });
    expect(result.message).toContain('Leader');
    expect(result.message).toContain('Providers');
  });
});
