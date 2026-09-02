/**
 * Tests for the official ACP registry fetcher + entry mapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAcpRegistry, mapRegistryEntry, resolveAcpAgentCommand } from '../src/index.js';
import { currentPlatformKey } from '../src/registry/acp-registry-fetch.js';

describe('currentPlatformKey', () => {
  it('normalizes every supported OS and architecture spelling', () => {
    expect(currentPlatformKey('win32', 'x64')).toBe('windows-x86_64');
    expect(currentPlatformKey('darwin', 'arm64')).toBe('darwin-aarch64');
    expect(currentPlatformKey('linux', 'riscv64')).toBe('linux-riscv64');
    expect(currentPlatformKey()).toMatch(/^(windows|darwin|linux)-/);
  });
});

describe('mapRegistryEntry', () => {
  it('maps an npx distribution to `npx -y <pkg> <args>`', () => {
    const d = mapRegistryEntry({
      id: 'cline',
      name: 'Cline',
      distribution: { npx: { package: 'cline@3.0.31', args: ['--acp'] } },
    });
    expect(d).not.toBeNull();
    expect(d?.acp.command).toBe('npx');
    expect(d?.acp.args).toEqual(['-y', 'cline@3.0.31', '--acp']);
    expect(d?.id).toBe('cline');
  });

  it('maps a uvx distribution to `uvx <pkg> <args>`', () => {
    const d = mapRegistryEntry({
      id: 'minion-code',
      distribution: { uvx: { package: 'minion-code@0.1.44', args: ['acp'] } },
    });
    expect(d?.acp.command).toBe('uvx');
    expect(d?.acp.args).toEqual(['minion-code@0.1.44', 'acp']);
  });

  it('maps a binary distribution for the requested platform (basename of cmd)', () => {
    const d = mapRegistryEntry(
      {
        id: 'goose',
        distribution: {
          binary: {
            'darwin-aarch64': { archive: 'https://x', cmd: './goose', args: ['acp'] },
          },
        },
      },
      'darwin-aarch64',
    );
    expect(d?.acp.command).toBe('goose');
    expect(d?.acp.args).toEqual(['acp']);
  });

  it('returns null when no distribution is runnable on the target platform', () => {
    const d = mapRegistryEntry(
      {
        id: 'goose',
        distribution: { binary: { 'linux-x86_64': { cmd: './goose', args: ['acp'] } } },
      },
      'darwin-aarch64',
    );
    expect(d).toBeNull();
  });

  it('infers vendor from the entry text', () => {
    expect(
      mapRegistryEntry({
        id: 'claude-acp',
        name: 'Claude Agent',
        distribution: { npx: { package: 'x' } },
      })?.vendor,
    ).toBe('anthropic');
  });

  it.each([
    ['gemini-agent', undefined, ['Google'], 'google'],
    ['codex-agent', undefined, ['OpenAI'], 'openai'],
    ['copilot-agent', undefined, ['GitHub'], 'github'],
    ['kimi-agent', undefined, ['Moonshot'], 'moonshot'],
    ['independent', undefined, undefined, 'community'],
  ] as const)('infers the vendor for %s', (id, name, authors, vendor) => {
    expect(
      mapRegistryEntry({
        id,
        ...(name === undefined ? {} : { name }),
        ...(authors === undefined ? {} : { authors: [...authors] }),
        distribution: { npx: { package: 'agent' } },
      })?.vendor,
    ).toBe(vendor);
  });

  it('covers optional distribution metadata and fallback fields', () => {
    const uvx = mapRegistryEntry({
      id: 'uvx-minimal',
      website: 'https://example.test',
      distribution: { uvx: { package: 'agent' } },
    });
    expect(uvx?.displayName).toBe('uvx-minimal');
    expect(uvx?.acp.args).toEqual(['agent']);
    expect(uvx?.docs).toBe('https://example.test');

    const binary = mapRegistryEntry(
      {
        id: 'binary',
        distribution: {
          binary: {
            host: { cmd: String.raw`folder\agent.exe`, env: { TOKEN: 'test' } },
          },
        },
      },
      'host',
    );
    expect(binary?.acp).toEqual({
      command: 'agent.exe',
      args: [],
      env: { TOKEN: 'test' },
    });

    expect(mapRegistryEntry(null as never)).toBeNull();
    expect(mapRegistryEntry({ id: 42 } as never)).toBeNull();
    expect(mapRegistryEntry({ id: 'no-distribution' })).toBeNull();
    expect(
      mapRegistryEntry(
        { id: 'empty-command', distribution: { binary: { host: { cmd: '' } } } },
        'host',
      ),
    ).toBeNull();
  });
});

describe('fetchAcpRegistry', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it('fetches, maps, and drops unrunnable entries', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        agents: [
          {
            id: 'gemini',
            name: 'Gemini CLI',
            distribution: { npx: { package: '@google/gemini-cli@1', args: ['--acp'] } },
          },
          { id: 'binary-only', distribution: { binary: { 'other-arch': { cmd: './x' } } } },
          { id: '', distribution: { npx: { package: 'nope' } } },
        ],
      }),
    })) as never;

    const res = await fetchAcpRegistry({
      now: '2026-06-28T00:00:00Z',
      platformKey: 'darwin-aarch64',
    });
    expect(res.fetchedAt).toBe('2026-06-28T00:00:00Z');
    expect(res.agents.map((a) => a.id)).toEqual(['gemini']);
  });

  it('throws on a non-ok HTTP response', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as never;
    await expect(fetchAcpRegistry()).rejects.toThrow('HTTP 503');
  });

  it('throws when the body has no agents array', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as never;
    await expect(fetchAcpRegistry()).rejects.toThrow('no agents array');
  });

  it('aborts immediately when the caller signal is already aborted', async () => {
    const capturedSignal: { current?: AbortSignal } = {};
    globalThis.fetch = vi.fn(async (_url: string, opts: { signal: AbortSignal }) => {
      capturedSignal.current = opts.signal;
      // The signal that was passed by fetchAcpRegistry should already be aborted
      throw new DOMException('The operation was aborted', 'AbortError');
    }) as never;

    const ac = new AbortController();
    ac.abort();
    await expect(fetchAcpRegistry({ signal: ac.signal })).rejects.toThrow();
    // Verify the internal abort signal was triggered because the parent signal was already aborted
    expect(capturedSignal.current?.aborted).toBe(true);
  });

  it('listens for parent abort signal and stops the fetch', async () => {
    let capturedSignal: AbortSignal | null = null;
    globalThis.fetch = vi.fn(async (_url: string, opts: { signal: AbortSignal }) => {
      capturedSignal = opts.signal;
      return new Promise((_resolve, reject) => {
        capturedSignal!.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    }) as never;

    const ac = new AbortController();
    const fetchP = fetchAcpRegistry({ signal: ac.signal });
    // Let the fetch start
    await new Promise((r) => setImmediate(r));
    // Abort from the parent
    ac.abort();
    await expect(fetchP).rejects.toThrow('The operation was aborted');
  });

  it('accepts a top-level array and supplies default timestamp and platform', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'minimal', distribution: { npx: { package: 'minimal' } } }],
    })) as never;

    const result = await fetchAcpRegistry();
    expect(result.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(result.agents).toHaveLength(1);
  });

  it('aborts a fetch when its timeout elapses', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      async (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('timed out')));
        }),
    ) as never;

    const pending = fetchAcpRegistry({ timeoutMs: 25 });
    const rejection = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });
});

describe('resolveAcpAgentCommand with a live registry', () => {
  const live = {
    'claude-acp': { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
    gemini: { command: 'npx', args: ['-y', '@google/gemini-cli', '--acp'] },
  };

  it('resolves our stable id via the registry alias', () => {
    // 'claude-code' (our id) → 'claude-acp' (registry id) through REGISTRY_ID_ALIASES.
    const cmd = resolveAcpAgentCommand('claude-code', undefined, live);
    expect(cmd?.command).toBe('npx');
    expect(cmd?.args).toContain('@agentclientprotocol/claude-agent-acp');
    expect(cmd?.role).toBe('claude-code');
  });

  it('resolves a registry-only id directly from live', () => {
    const cmd = resolveAcpAgentCommand('gemini', undefined, live);
    expect(cmd?.args).toContain('@google/gemini-cli');
  });

  it('user override still beats the live registry', () => {
    const cmd = resolveAcpAgentCommand(
      'claude-code',
      { 'claude-code': { command: 'my-claude' } },
      live,
    );
    expect(cmd?.command).toBe('my-claude');
  });

  it('falls back to the static catalog when live lacks the id', () => {
    const cmd = resolveAcpAgentCommand('opencode', undefined, live);
    expect(cmd?.command).toBe('opencode');
  });
});
