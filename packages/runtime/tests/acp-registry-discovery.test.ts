import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WstackPaths } from '@wrongstack/core/utils';
import { expect, it, vi } from 'vitest';
import { discoverAcpRegistry } from '../src/portable-commands/acp-registry-cache.js';

it('refreshes an absent registry once, reuses it, and keeps it after a failed refresh', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'wrongstack-acp-discovery-'));
  const paths = { cacheDir } as WstackPaths;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({
      agents: [
        { id: 'sample', version: '1.2.3', distribution: { npx: { package: 'sample@1.2.3' } } },
      ],
    }),
  );
  const now = vi.spyOn(Date, 'now');
  try {
    const snapshots = await Promise.all([discoverAcpRegistry(paths), discoverAcpRegistry(paths)]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(snapshots[0]?.byId['sample']?.args).toEqual(['-y', 'sample@1.2.3']);
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(await discoverAcpRegistry(paths)).toEqual(snapshots[0]);
    expect(fetch).toHaveBeenCalledTimes(2);

    now.mockReturnValue(Date.parse(snapshots[0]!.fetchedAt) + 3_600_000);
    fetch.mockImplementation(async () => new Response(null, { status: 503 }));
    expect(await discoverAcpRegistry(paths)).toEqual(snapshots[0]);
    expect(fetch).toHaveBeenCalledTimes(5);
  } finally {
    fetch.mockRestore();
    now.mockRestore();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

it('retains upstream quarantine status when opening the persisted registry', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'wrongstack-acp-quarantine-'));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).endsWith('/quarantine.json')) return Response.json({ sample: 'Missing build' });
    return Response.json({
      agents: [{ id: 'sample', distribution: { npx: { package: 'sample@1.2.3' } } }],
    });
  });
  try {
    const cached = await discoverAcpRegistry({ cacheDir } as WstackPaths);
    expect(cached?.agents[0]?.registry?.quarantineReason).toBe('Missing build');
    expect(cached?.byId['sample']?.quarantineReason).toBe('Missing build');
  } finally {
    fetch.mockRestore();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
