/**
 * Choosing `wrongforge/<model>` (or an ACP agent) in a WebUI/desktop
 * conversation must keep the leader's own capabilities. The catalog has no
 * entry for an agent leader, so the overlay would replace them with the
 * unsupported-family defaults (`streaming: false`), and the loop would call
 * `complete()` for every leader turn: WrongForge's one-step, tool-less side
 * path ("Use no tools."), where it can never call a tool.
 *
 * Runs the real `withCatalogCapabilities` and the real leader provider.
 */
import { createAcpLeaderProviderFactory } from '@wrongstack/runtime/acp-leader';
import { createWrongForgeLeaderProviderFactory } from '@wrongstack/runtime/wrongforge-leader';
import { describe, expect, it, vi } from 'vitest';
import { applyEmbeddedModelSwitch } from '../src/server/embedded-host-adapters.js';

function catalogWithoutLeader(): any {
  return {
    refresh: vi.fn(async () => undefined),
    getProvider: vi.fn(async () => undefined),
    getModel: vi.fn(async () => undefined),
    listProviders: vi.fn(async () => []),
  };
}

function mockAgent(): any {
  return {
    ctx: {
      projectRoot: '/tmp/proj',
      provider: { id: 'openai', capabilities: { maxContext: 128000, streaming: true } },
      model: 'gpt-4o',
      session: { id: 'sess-1' },
      meta: {},
      tools: [],
      runModelTransition: async (fn: () => Promise<void>) => fn(),
    },
  };
}

function buildLeader(id: string): any {
  const opts = { bootConfig: {} as never, buildProvider: () => undefined };
  if (id === 'wrongforge') {
    return createWrongForgeLeaderProviderFactory(opts).create({ type: id } as never);
  }
  if (id === 'acp') {
    // The ACP leader reads the leading agent from the config's model.
    return createAcpLeaderProviderFactory({
      ...opts,
      bootConfig: { model: 'claude-code' } as never,
    }).create({ type: id } as never);
  }
  return undefined;
}

async function switchTo(providerId: string, modelId: string): Promise<any> {
  const agent = mockAgent();
  await applyEmbeddedModelSwitch(
    {
      agent,
      modeStore: undefined,
      buildSessionStart: vi.fn(async () => ({})),
      loadSavedProviders: vi.fn(async () => ({})),
      modelsRegistry: catalogWithoutLeader(),
      buildProvider: buildLeader,
      send: vi.fn(),
      broadcast: vi.fn(),
      log: vi.fn(),
    },
    providerId,
    modelId,
  );
  return agent;
}

describe('applyEmbeddedModelSwitch to an agent leader', () => {
  it('keeps WrongForge streaming and tool-capable when the catalog has no entry for it', async () => {
    const agent = await switchTo('wrongforge', 'claude-opus-5-5');
    expect(agent.ctx.provider.id).toBe('wrongforge');
    expect(agent.ctx.model).toBe('claude-opus-5-5');
    expect(agent.ctx.provider.capabilities.streaming).toBe(true);
    expect(agent.ctx.provider.capabilities.tools).toBe(true);
  });

  // Without the guard an ACP leader's turns go to `complete()`, which throws
  // "Set acp.leader.sideModel …" when no side model is configured.
  it('keeps the ACP leader streaming when the catalog has no entry for it', async () => {
    const agent = await switchTo('acp', 'claude-code');
    expect(agent.ctx.provider.id).toBe('acp');
    expect(agent.ctx.provider.capabilities.streaming).toBe(true);
  });
});
