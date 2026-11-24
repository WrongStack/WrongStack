import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAcpRegistry, mapRegistryEntry } from '../src/registry/acp-registry-fetch.js';

describe('ACP registry metadata boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['name', 42],
    ['authors', { vendor: 'Example' }],
  ])('retains runnable entries with a malformed optional %s field', async (field, value) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        agents: [
          { id: 'bad', [field]: value, distribution: { npx: { package: 'bad' } } },
          { id: 'ok', distribution: { npx: { package: 'ok' } } },
        ],
      }),
    );
    expect((await fetchAcpRegistry()).agents.map((entry) => entry.id)).toEqual(['bad', 'ok']);
  });

  it('drops launch specs whose environment contains non-string values', () => {
    expect(
      mapRegistryEntry({
        id: 'bad',
        distribution: { npx: { package: 'bad', env: { TOKEN: 42 } } },
      } as never),
    ).toBeNull();
  });
});
