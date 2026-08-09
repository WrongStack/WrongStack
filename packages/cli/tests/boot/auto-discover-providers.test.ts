import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, ModelsDevPayload } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverAndMergeProviders } from '../../src/boot/auto-discover-providers.js';

/** Minimal registry double capturing mergeOverlay calls. */
function fakeRegistry(): {
  merged: ModelsDevPayload[];
  mergeOverlay: (p: ModelsDevPayload) => void;
} {
  const merged: ModelsDevPayload[] = [];
  return { merged, mergeOverlay: (p) => merged.push(p) };
}

function modelsResponse(ids: string[]): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        object: 'list',
        data: ids.map((id) => ({ id, capabilities: { tool_calling: true } })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never as typeof fetch;
}

function cfgWith(providers: Config['providers']): Config {
  return { providers } as unknown as Config;
}

describe('discoverAndMergeProviders', () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-discover-'));
  });
  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('discovers + merges the omniroute preset provider (baseUrl from preset)', async () => {
    const reg = fakeRegistry();
    await discoverAndMergeProviders({
      config: cfgWith({ omniroute: { type: 'omniroute', apiKey: 'sk-x' } }),
      registry: reg as never,
      cacheDir,
      fetchImpl: modelsResponse(['cc/claude-opus-4-8', 'openai/gpt-5-codex']),
    });
    expect(reg.merged).toHaveLength(1);
    const omni = reg.merged[0]?.omniroute;
    expect(omni?.npm).toBe('@ai-sdk/openai-compatible');
    expect(Object.keys(omni?.models ?? {})).toHaveLength(2);
  });

  it('is a no-op when no provider opts in', async () => {
    const reg = fakeRegistry();
    await discoverAndMergeProviders({
      config: cfgWith({ openai: { type: 'openai', apiKey: 'sk-x' } }),
      registry: reg as never,
      cacheDir,
      fetchImpl: modelsResponse(['x']),
    });
    expect(reg.merged).toHaveLength(0);
  });

  it('falls back to the cached list when the server is unreachable', async () => {
    // Seed the cache with a prior successful fetch.
    const reg1 = fakeRegistry();
    await discoverAndMergeProviders({
      config: cfgWith({ omniroute: { type: 'omniroute', apiKey: 'sk-x' } }),
      registry: reg1 as never,
      cacheDir,
      fetchImpl: modelsResponse(['cached/model']),
    });
    expect(reg1.merged).toHaveLength(1);

    // Now the server is down — discovery returns undefined, cache kicks in.
    const reg2 = fakeRegistry();
    await discoverAndMergeProviders({
      config: cfgWith({ omniroute: { type: 'omniroute', apiKey: 'sk-x' } }),
      registry: reg2 as never,
      cacheDir,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as never as typeof fetch,
    });
    expect(reg2.merged).toHaveLength(1);
    expect(Object.keys(reg2.merged[0]?.omniroute?.models ?? {})).toEqual(['cached/model']);
  });

  it('honors the explicit autoDiscoverModels flag with a custom baseUrl', async () => {
    const reg = fakeRegistry();
    const fetchSpy = vi.fn(modelsResponse(['litellm/gpt-4o'])) as never as typeof fetch;
    await discoverAndMergeProviders({
      config: cfgWith({
        mygw: {
          type: 'mygw',
          baseUrl: 'http://localhost:4000/v1',
          apiKey: 'k',
          autoDiscoverModels: true,
        },
      }),
      registry: reg as never,
      cacheDir,
      fetchImpl: fetchSpy,
    });
    expect(reg.merged).toHaveLength(1);
    expect(reg.merged[0]?.mygw).toBeDefined();
  });
});
