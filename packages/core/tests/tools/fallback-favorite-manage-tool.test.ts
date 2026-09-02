/**
 * Tests for createFavoriteManageTool — favorite model list management.
 * Covers: list/add/remove actions, duplicate detection, index/ref removal,
 * error branches, and config mutation via updateConfig.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFavoriteManageTool } from '../../src/tools/fallback-favorite-manage-tool.js';
import type { FallbackManageToolOptions } from '../../src/tools/fallback-manage-tool-options.js';

function makeOpts(overrides: Record<string, unknown> = {}): FallbackManageToolOptions {
  const config: Record<string, unknown> = {
    provider: 'test-provider',
    model: 'test-model',
    favoriteModels: ['test-provider/test-model', 'test-provider/other-model'],
    ...overrides,
  };
  return {
    getConfig: () => config as never,
    updateConfig: vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      mutate(config);
    }),
  };
}

describe('favorite_manage — list', () => {
  it('lists all favorites with indices', async () => {
    const tool = createFavoriteManageTool(makeOpts());
    const result = await tool.execute({ action: 'list' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('ok');
    expect(result.favorites).toEqual(['test-provider/test-model', 'test-provider/other-model']);
    expect(result.message).toContain('1. test-provider/test-model');
    expect(result.message).toContain('2. test-provider/other-model');
  });

  it('shows a helpful message when no favorites exist', async () => {
    const tool = createFavoriteManageTool(makeOpts({ favoriteModels: [] }));
    const result = await tool.execute({ action: 'list' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('ok');
    expect(result.favorites).toEqual([]);
    expect(result.message).toContain('No favorites set');
  });
});

describe('favorite_manage — add', () => {
  it('adds a new favorite', async () => {
    const opts = makeOpts();
    const tool = createFavoriteManageTool(opts);
    const result = await tool.execute({ action: 'add', model: 'openai/gpt-4o' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Added favorite');
    expect(result.favorites).toContain('openai/gpt-4o');
    expect(opts.updateConfig).toHaveBeenCalledTimes(1);
  });

  it('rejects adding without a model', async () => {
    const tool = createFavoriteManageTool(makeOpts());
    const result = await tool.execute({ action: 'add' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('Provide "model"');
  });

  it('rejects adding a duplicate favorite', async () => {
    const tool = createFavoriteManageTool(makeOpts());
    const result = await tool.execute(
      { action: 'add', model: 'test-provider/test-model' },
      {} as never,
      { signal: new AbortController().signal },
    );
    expect(result.status).toBe('error');
    expect(result.message).toContain('already a favorite');
  });
});

describe('favorite_manage — remove', () => {
  it('removes by 1-based index', async () => {
    const opts = makeOpts();
    const tool = createFavoriteManageTool(opts);
    const result = await tool.execute({ action: 'remove', index: 1 }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Removed favorite: test-provider/test-model');
    expect(result.favorites).toEqual(['test-provider/other-model']);
  });

  it('rejects out-of-range index', async () => {
    const tool = createFavoriteManageTool(makeOpts());
    const result = await tool.execute({ action: 'remove', index: 99 }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('out of range');
  });

  it('rejects index 0', async () => {
    const tool = createFavoriteManageTool(makeOpts());
    const result = await tool.execute({ action: 'remove', index: 0 }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('out of range');
  });

  it('removes by model ref', async () => {
    const opts = makeOpts();
    const tool = createFavoriteManageTool(opts);
    const result = await tool.execute(
      { action: 'remove', model: 'test-provider/other-model' },
      {} as never,
      { signal: new AbortController().signal },
    );
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Removed favorite: test-provider/other-model');
    expect(result.favorites).toEqual(['test-provider/test-model']);
  });

  it('rejects removing a model not in favorites', async () => {
    const tool = createFavoriteManageTool(makeOpts());
    const result = await tool.execute(
      { action: 'remove', model: 'openai/nonexistent' },
      {} as never,
      { signal: new AbortController().signal },
    );
    expect(result.status).toBe('error');
    expect(result.message).toContain('not found');
  });

  it('rejects remove without model or index', async () => {
    const tool = createFavoriteManageTool(makeOpts());
    const result = await tool.execute({ action: 'remove' }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('Provide either');
  });
});

describe('favorite_manage — unknown action', () => {
  it('returns an error for unrecognized actions', async () => {
    const tool = createFavoriteManageTool(makeOpts());
    const result = await tool.execute({ action: 'destroy' as never }, {} as never, {
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('Unknown action');
  });
});
