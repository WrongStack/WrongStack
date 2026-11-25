import { describe, expect, it, vi } from 'vitest';
import {
  defaultBridgeAgentIds,
  resolveAcpClientProfile,
} from '../src/registry/acp-client-profiles.js';
import { fetchAcpRegistry, mapRegistryEntry } from '../src/registry/acp-registry-fetch.js';

describe('ACP registry fallback behavior', () => {
  it('falls back from the GitHub release to the CDN and retains release metadata', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          agents: [
            { id: 'demo', version: '2.4.1', distribution: { npx: { package: 'demo@2.4.1' } } },
          ],
        }),
      );
    try {
      const result = await fetchAcpRegistry();
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        'https://github.com/agentclientprotocol/registry/releases/latest/download/registry.json',
        'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
      ]);
      expect(result.agents[0]).toMatchObject({ registry: { version: '2.4.1' } });
    } finally {
      fetch.mockRestore();
    }
  });

  it('uses the generic profile for unknown identifiers inherited by object maps', () => {
    expect(resolveAcpClientProfile('constructor')).toMatchObject({
      id: 'constructor',
      mcpInjection: 'acp-session-new',
      bridgeByDefault: true,
    });
  });

  it('rejects a Windows binary path ending in a directory separator', () => {
    const platform = 'windows-x86_64';
    expect(
      mapRegistryEntry(
        { id: 'demo', distribution: { binary: { [platform]: { cmd: 'folder\\agent\\' } } } },
        platform,
      ),
    ).toBeNull();
  });

  it('keeps runnable registry entries when another entry has malformed launch arguments', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        agents: [
          { id: 'bad', distribution: { npx: { package: 'bad', args: {} } } },
          { id: 'ok', distribution: { npx: { package: 'ok', args: ['--acp'] } } },
        ],
      }),
    );
    try {
      const result = await fetchAcpRegistry();
      expect(result.agents.map((entry) => entry.id)).toEqual(['ok']);
    } finally {
      fetch.mockRestore();
    }
  });

  it('normalizes live bridge IDs before dropping blanks and duplicates', () => {
    const result = defaultBridgeAgentIds([' COPILOT ', '   ', 'Future-Agent', 'future-agent']);
    expect(result.filter((id) => id === 'copilot')).toHaveLength(1);
    expect(result.filter((id) => id === 'future-agent')).toHaveLength(1);
    expect(result.every((id) => id === id.trim().toLowerCase())).toBe(true);
  });
});
