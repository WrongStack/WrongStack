/**
 * `enable_*_tools` on `spawn_subagent` only ever add.
 *
 * They used to seed `allowedCapabilities` with `['fs.read']` when the worker
 * had no grant of its own. An explicit list replaces the host's wide default,
 * so `enable_write_tools: true` left a build worker with read + write and no
 * shell — it could edit but not run a single test.
 */

import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';
import { describe, expect, it } from 'vitest';
import type * as Host from '../../src/coordination/director-host-contracts.js';
import { makeSpawnTool } from '../../src/coordination/director-spawn-tool.js';

const ROSTER: Record<string, SubagentConfig> = {
  executor: { name: 'executor', role: 'executor' },
  'read-only': { name: 'read-only', role: 'read-only', allowedCapabilities: ['fs.read'] },
};

async function spawnWith(input: Record<string, unknown>): Promise<SubagentConfig> {
  let spawned: SubagentConfig | undefined;
  const director = {
    spawn: async (cfg: SubagentConfig) => {
      spawned = cfg;
      return 'sub-1';
    },
  } as unknown as Host.DirectorAdmissionPort;
  await makeSpawnTool(director, ROSTER).execute(
    input as never,
    { meta: {} } as never,
    { signal: new AbortController().signal } as never,
  );
  if (!spawned) throw new Error('spawn was not called');
  return spawned;
}

describe('spawn_subagent capability toggles', () => {
  it('leaves a worker on the wide default when it has no grant of its own', async () => {
    const cfg = await spawnWith({
      role: 'executor',
      enable_write_tools: true,
      enable_network_tools: true,
      enable_mcp_tools: true,
    });
    expect(cfg.allowedCapabilities).toBeUndefined();

    const adHoc = await spawnWith({ name: 'helper', enable_write_tools: true });
    expect(adHoc.allowedCapabilities).toBeUndefined();
  });

  it('carries leader-requested skills, trimmed, deduped and capped', async () => {
    const cfg = await spawnWith({
      role: 'executor',
      skills: [' testing ', 'testing', '', 3, 'a', 'b', 'c', 'd'],
    });
    expect(cfg.requestedSkills).toEqual(['testing', 'a', 'b', 'c']);
    expect((await spawnWith({ role: 'executor' })).requestedSkills).toBeUndefined();
  });

  it('widens a narrowed role grant by exactly the requested capabilities', async () => {
    const cfg = await spawnWith({
      role: 'read-only',
      enable_write_tools: true,
      enable_network_tools: true,
    });
    expect(cfg.allowedCapabilities).toEqual(['fs.read', 'fs.write', 'net.outbound']);
    // The roster entry itself is not mutated.
    expect(ROSTER['read-only']?.allowedCapabilities).toEqual(['fs.read']);
  });
});
