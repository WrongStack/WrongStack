import { describe, expect, it, vi } from 'vitest';
import {
  defaultBridgeAgentIds,
  resolveAcpClientProfile,
} from '../src/registry/acp-client-profiles.js';
import { fetchAcpRegistry, mapRegistryEntry } from '../src/registry/acp-registry-fetch.js';

describe('ACP registry fallback behavior', () => {
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
