/**
 * Unit tests for the WrongProxy rewrite applied in `applyEmbeddedModelSwitch`
 * (packages/webui-server/src/server/embedded-host-adapters.ts) with the proxy
 * `active=true` vs `false`, mocking `applyProxyConfig` (delegating spy on the
 * real singleton) and the provider factory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeProviderFromConfig } from '@wrongstack/providers';
import {
  applyProxyConfig,
  __resetProxyConfigForTests,
} from '@wrongstack/core/wiring/proxy-rewrite';
import type { ProviderConfig } from '@wrongstack/core/types';

vi.mock('@wrongstack/core/wiring/proxy-rewrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/wiring/proxy-rewrite')>();
  return {
    ...actual,
    applyProxyConfig: vi.fn((next: Parameters<typeof applyProxyConfig>[0]) =>
      actual.applyProxyConfig(next),
    ),
  };
});

vi.mock('ws', () => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocket: MockWebSocket };
});

vi.mock('@wrongstack/providers', () => ({
  makeProviderFromConfig: vi.fn(
    (id: string, cfg: Record<string, unknown>) => ({ id, ...cfg, capabilities: { maxContext: 128000 } }),
  ),
}));

import {
  applyEmbeddedModelSwitch,
  type EmbeddedAgentConfigContext,
} from '../src/server/embedded-host-adapters.js';

function savedProviders(): Record<string, ProviderConfig> {
  return {
    openai: { type: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1' },
  };
}

function makeCtx(overrides: Partial<EmbeddedAgentConfigContext> = {}): {
  ctx: EmbeddedAgentConfigContext;
  agent: { ctx: Record<string, unknown> };
} {
  const agent = {
    ctx: {
      provider: { id: 'openai' },
      model: 'gpt-4o',
      session: { id: 'sess-1' },
      meta: {},
      runModelTransition: vi.fn(async (fn: () => Promise<void>) => fn()),
    },
  };
  const ctx = {
    agent,
    modeStore: undefined,
    buildSessionStart: vi.fn(async () => ({})),
    loadSavedProviders: vi.fn(async () => savedProviders()),
    modelsRegistry: undefined,
    persistPrefs: vi.fn(async () => undefined),
    send: vi.fn(),
    broadcast: vi.fn(),
    log: vi.fn(),
    ...overrides,
  } as unknown as EmbeddedAgentConfigContext;
  return { ctx, agent };
}

beforeEach(() => {
  __resetProxyConfigForTests();
  vi.mocked(applyProxyConfig).mockClear();
});

afterEach(() => __resetProxyConfigForTests());

describe('applyEmbeddedModelSwitch proxy rewrite', () => {
  it('rewrites the switched provider baseUrl through the proxy when active', async () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:8000', active: true });
    const { ctx, agent } = makeCtx();
    await applyEmbeddedModelSwitch(ctx, 'openai', 'gpt-4o');
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ baseUrl: 'http://localhost:8000/proxy/api.openai.com/v1' }),
    );
    expect((agent.ctx.provider as { baseUrl?: string }).baseUrl).toBe(
      'http://localhost:8000/proxy/api.openai.com/v1',
    );
    expect((agent.ctx as { model: string }).model).toBe('gpt-4o');
  });

  it('keeps the raw baseUrl when active=false', async () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:8000', active: false });
    const { ctx, agent } = makeCtx();
    await applyEmbeddedModelSwitch(ctx, 'openai', 'gpt-4o');
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ baseUrl: 'https://api.openai.com/v1' }),
    );
    expect((agent.ctx.provider as { baseUrl?: string }).baseUrl).toBe('https://api.openai.com/v1');
  });

  it('keeps the raw baseUrl when the singleton is never enabled', async () => {
    const { ctx, agent } = makeCtx();
    await applyEmbeddedModelSwitch(ctx, 'openai', 'gpt-4o');
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ baseUrl: 'https://api.openai.com/v1' }),
    );
    expect((agent.ctx.provider as { baseUrl?: string }).baseUrl).toBe('https://api.openai.com/v1');
  });

  it('persists the switched provider/model', async () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:8000', active: true });
    const { ctx } = makeCtx();
    await applyEmbeddedModelSwitch(ctx, 'openai', 'gpt-4o');
    expect(ctx.persistPrefs).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4o' });
  });
});