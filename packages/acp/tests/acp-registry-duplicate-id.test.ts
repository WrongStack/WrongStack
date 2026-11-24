import { afterEach, expect, it, vi } from 'vitest';
import { fetchAcpRegistry } from '../src/registry/acp-registry-fetch.js';

afterEach(() => vi.restoreAllMocks());

it('keeps the first runnable entry for a duplicate registry ID', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      agents: [
        { id: 'same', distribution: { npx: { package: 'first' } } },
        { id: 'same', distribution: { npx: { package: 'second' } } },
      ],
    }),
  );
  const result = await fetchAcpRegistry();
  expect(result.agents).toHaveLength(1);
  expect(result.agents[0]?.acp.args?.[1]).toBe('first');
});
