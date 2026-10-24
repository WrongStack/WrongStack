/**
 * Providers the host serves itself (the CLI's ACP leader, `acp`) are offered
 * by the WebUI pickers beside the saved ones: they ride `providers.saved`
 * with their models, and `provider.models` answers from the host's list
 * without the catalog. A saved record of the same id is never shadowed.
 */
import type { ProviderConfig } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createProviderOperations } from '../src/server/provider-handlers.js';

const ACP = {
  id: 'acp',
  type: 'acp',
  models: [{ id: 'claude-code', name: 'Claude Code', contextWindow: 1_000_000 }],
};

function operations(saved: Record<string, ProviderConfig>) {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const broadcast = vi.fn();
  const ops = createProviderOperations({
    providerStore: { load: async () => saved, save: async () => {} },
    broadcast,
    send: (_ws, message) => sent.push(message as never),
    hostProviders: () => [ACP],
  });
  return { ops, sent, broadcast };
}

const WS = {} as WebSocket;

describe('host providers in the WebUI pickers', () => {
  it('lists acp with its agents after the saved providers', async () => {
    const { ops, sent } = operations({ zai: { type: 'zai', models: ['glm-5'] } as ProviderConfig });
    await ops.handleProvidersSaved(WS);
    const payload = sent[0]?.payload as { providers: Array<Record<string, unknown>> } | undefined;
    const providers = payload?.providers ?? [];
    expect(providers.map((p) => p.id)).toEqual(['zai', 'acp']);
    expect(providers[1]).toMatchObject({
      type: 'acp',
      models: ['claude-code'],
      pickedModelId: 'claude-code',
      apiKeys: [],
    });
  });

  it("answers acp's models from the host, with no models registry at all", async () => {
    const { ops, sent } = operations({});
    await ops.handleProviderModels(WS, 'acp');
    expect(sent[0]).toEqual({
      type: 'provider.models',
      payload: {
        provider: 'acp',
        models: [
          {
            id: 'claude-code',
            name: 'Claude Code',
            contextWindow: 1_000_000,
            outputModalities: ['text'],
          },
        ],
      },
    });
  });

  it('never shadows a saved acp record when provider.models is asked for it', async () => {
    // The user's own provider happens to use the id "acp". `providers.saved`
    // already drops the host entry for that id, so `provider.models` must agree
    // — otherwise the two frames describe the same id with two different
    // providers and the picker offers ACP agents under a non-ACP row.
    const { ops, sent } = operations({
      acp: { type: 'openai', models: ['mine'] } as ProviderConfig,
    });
    await ops.handleProviderModels(WS, 'acp');
    const frame = sent[0] as { type: string; payload?: { models?: Array<{ id: string }> } };
    const ids = frame.payload?.models?.map((model) => model.id) ?? [];
    expect(ids).not.toContain('claude-code');
    // No models registry is supplied here, so the saved record falls through to
    // the registry guard instead of being answered from the host list.
    expect(frame.type).toBe('key.operation_result');
  });

  it('keeps acp in the list a broadcast sends, and never shadows a saved acp record', () => {
    const { ops, broadcast } = operations({});
    ops.broadcastSaved({ acp: { type: 'openai', models: ['x'] } as ProviderConfig });
    const message = broadcast.mock.calls[0]?.[0] as
      | { payload: { providers: Array<{ id: string; type: string }> } }
      | undefined;
    const providers = message?.payload.providers;
    expect(providers).toEqual([expect.objectContaining({ id: 'acp', type: 'openai' })]);
  });
});
