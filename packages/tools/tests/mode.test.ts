import { describe, expect, it, vi } from 'vitest';
import { createModeTool } from '../src/mode.js';

const makeOpts = () => ({ signal: new AbortController().signal });

const mockModeStore = (modes: any[] = [], active: string | null = null) => ({
  getActiveMode: vi.fn().mockResolvedValue(modes.find((m) => m.id === active) ?? null),
  listModes: vi.fn().mockResolvedValue(modes),
  getMode: vi
    .fn()
    .mockImplementation((id: string) => Promise.resolve(modes.find((m) => m.id === id) ?? null)),
  setActiveMode: vi.fn().mockResolvedValue(undefined),
});

describe('createModeTool', () => {
  it('has correct metadata', () => {
    const store = mockModeStore();
    const tool = createModeTool(store);
    expect(tool.name).toBe('mode');
    expect(tool.permission).toBe('confirm');
    expect(tool.mutating).toBe(true);
  });

  it('get action returns current mode', async () => {
    const store = mockModeStore(
      [{ id: 'dev', name: 'Dev', description: 'Development mode' }],
      'dev',
    );
    const tool = createModeTool(store);
    const result = await tool.execute({ action: 'get' }, {} as any, makeOpts());
    expect(result.action).toBe('get');
    expect(result.currentMode).toBe('dev');
    expect(result.success).toBe(true);
  });

  it('get action returns null when no mode set', async () => {
    const store = mockModeStore([{ id: 'dev', name: 'Dev', description: '' }], null);
    const tool = createModeTool(store);
    const result = await tool.execute({ action: 'get' }, {} as any, makeOpts());
    expect(result.currentMode).toBeUndefined();
  });

  it('list action returns all modes with family and tags metadata', async () => {
    const modes = [
      { id: 'default', name: 'Default', description: 'Balanced', tags: ['balanced'] },
      { id: 'review-lite', name: 'Review Lite', description: 'Narrow review', tags: ['lite', 'review'] },
      { id: 'code-reviewer', name: 'Review Deep', description: 'Full review', tags: ['deep', 'review'] },
    ];
    const store = mockModeStore(modes, null);
    const tool = createModeTool(store);
    const result = await tool.execute({ action: 'list' }, {} as any, makeOpts());

    expect(result.modes).toEqual([
      {
        id: 'default',
        name: 'Default',
        description: 'Balanced',
        family: 'balanced',
        tags: ['balanced'],
      },
      {
        id: 'review-lite',
        name: 'Review Lite',
        description: 'Narrow review',
        family: 'lite',
        tags: ['lite', 'review'],
      },
      {
        id: 'code-reviewer',
        name: 'Review Deep',
        description: 'Full review',
        family: 'deep',
        tags: ['deep', 'review'],
      },
    ]);
    expect(result.action).toBe('list');
    expect(result.message).toMatch(/default\s+\[balanced\]/);
    expect(result.message).toMatch(/review-lite\s+\[lite\]/);
    expect(result.message).toMatch(/code-reviewer\s+\[deep\]/);
  });

  it('set action requires mode', async () => {
    const store = mockModeStore();
    const tool = createModeTool(store);
    const result = await tool.execute({ action: 'set' }, {} as any, makeOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain('mode is required');
  });

  it('set action fails for unknown mode', async () => {
    const store = mockModeStore([{ id: 'dev', name: 'Dev', description: '' }]);
    const tool = createModeTool(store);
    const result = await tool.execute({ action: 'set', mode: 'unknown' }, {} as any, makeOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('set action succeeds for valid mode', async () => {
    const modes = [{ id: 'dev', name: 'Dev', description: 'Development mode' }];
    const store = mockModeStore(modes, null);
    const tool = createModeTool(store);
    const result = await tool.execute({ action: 'set', mode: 'dev' }, {} as any, makeOpts());
    expect(result.success).toBe(true);
    expect(store.setActiveMode).toHaveBeenCalledWith('dev');
  });

  it('clear action resets mode', async () => {
    const store = mockModeStore([], 'dev');
    const tool = createModeTool(store);
    const result = await tool.execute({ action: 'clear' }, {} as any, makeOpts());
    expect(result.success).toBe(true);
    expect(store.setActiveMode).toHaveBeenCalledWith(null);
  });

  it('returns error for unknown action', async () => {
    const store = mockModeStore();
    const tool = createModeTool(store);
    const result = await tool.execute({ action: 'unknown' } as any, {} as any, makeOpts());
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown action');
  });
});
