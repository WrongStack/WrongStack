import { afterEach, expect, it, vi } from 'vitest';
import { fetchAcpRegistry } from '../src/registry/acp-registry-fetch.js';

afterEach(() => vi.restoreAllMocks());

it('drops registry identifiers containing control characters', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      agents: [{ id: 'bad\nid', distribution: { npx: { package: 'demo' } } }],
    }),
  );
  expect((await fetchAcpRegistry()).agents).toEqual([]);
});
