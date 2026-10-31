import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveEndpoint = vi.fn();
const refreshCache = vi.fn();
const readCache = vi.fn();
const readQuota = vi.fn(async (_opts: unknown) => true);
vi.mock('@wrongstack/fleet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/fleet')>()),
  reportWrongForgeQuota: (opts: unknown) => readQuota(opts),
  WRONGFORGE_AGENT_ID: 'wrongforge',
  resolveWrongForgeEndpoint: () => resolveEndpoint(),
  readCachedWrongForgeInfo: () => readCache(),
  refreshWrongForgeInfoCache: (ep: unknown) => refreshCache(ep),
}));

const { wrongForgeLeaderPickable } = await import(
  '../../src/wrongforge-leader/wrongforge-leader-picker.js'
);

const endpoint = { url: 'http://127.0.0.1:8787', apiKey: 'k'.repeat(32) };

beforeEach(() => {
  resolveEndpoint.mockReset();
  refreshCache.mockReset();
  readCache.mockReset();
  readQuota.mockClear();
});

describe('wrongForgeLeaderPickable', () => {
  it('offers the server-advertised effort controls for each model', () => {
    resolveEndpoint.mockReturnValue(endpoint);
    readCache.mockReturnValue({
      models: ['a', 'b'],
      features: [],
      modelDetails: [
        { id: 'a', description: 'Reasoning', effortLevels: ['low', 'high'] },
        { id: 'b', description: 'Plain', effortLevels: [] },
      ],
    });
    expect(wrongForgeLeaderPickable()[0]?.models).toMatchObject([
      { id: 'a', reasoningEffortLevels: ['low', 'high'], effortSupported: true },
      { id: 'b', reasoningEffortLevels: [], effortSupported: false },
    ]);
  });
  it('offers nothing when no WrongForge is set up on this machine', () => {
    resolveEndpoint.mockReturnValue(undefined);
    expect(wrongForgeLeaderPickable()).toEqual([]);
    expect(refreshCache).not.toHaveBeenCalled();
    expect(readCache).not.toHaveBeenCalled();
  });

  it('offers nothing while the model list is unknown, but refreshes it for next time', () => {
    resolveEndpoint.mockReturnValue(endpoint);
    readCache.mockReturnValue(undefined);
    expect(wrongForgeLeaderPickable()).toEqual([]);
    expect(refreshCache).toHaveBeenCalledWith(endpoint);
  });

  it('lists the cached models and marks the default one', () => {
    resolveEndpoint.mockReturnValue(endpoint);
    readCache.mockReturnValue({
      models: ['sonnet', 'opus'],
      defaultModel: 'opus',
      features: [],
    });

    const [entry, ...rest] = wrongForgeLeaderPickable();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ id: 'wrongforge', type: 'wrongforge' });
    expect(entry?.models).toEqual([
      { id: 'sonnet', name: 'sonnet', description: 'WrongForge leading the session' },
      {
        id: 'opus',
        name: 'opus (WrongForge default)',
        description: 'WrongForge leading the session',
      },
    ]);
    expect(refreshCache).toHaveBeenCalledWith(endpoint);
  });
});
