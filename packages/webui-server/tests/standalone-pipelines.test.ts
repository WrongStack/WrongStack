/**
 * The standalone server's agent pipelines.
 *
 * They used to be built bare: a reasoning effort or cache TTL chosen in its
 * settings was saved and never reached a request, and a plugin middleware's
 * crash failed the whole turn. Its tabs can run different models, so the
 * reasoning profile comes from the model each request goes to, and a setting
 * changed at runtime applies to the next one.
 */
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, ModelsRegistry, Provider, Request } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
// The binding is core-internal; tests resolve core from source, so this is
// the same module the middleware reads.
import { bindRequestProvider } from '../../core/src/core/request-provider-binding.js';
import {
  createStandaloneAgentPipelines,
  projectModelRuntimePrefs,
} from '../src/server/standalone-pipelines.js';

const REASONING = {
  default: 'enabled',
  disableSupported: true,
  effortSupported: true,
  effortLevels: ['low', 'medium', 'high'],
} as const;

const provider = (id: string): Provider =>
  ({ id, capabilities: { reasoning: true, maxContext: 100_000 } }) as unknown as Provider;

/** A catalog that knows a reasoning profile only for `reasoner/thinker`. */
const modelsRegistry = {
  getModel: async (providerId: string, modelId: string) =>
    providerId === 'reasoner' && modelId === 'thinker'
      ? { providerId, modelId, capabilities: { maxContext: 100_000, reasoningConfig: REASONING } }
      : undefined,
  getProvider: async () => undefined,
} as unknown as ModelsRegistry;

function setup(modelRuntime: Config['modelRuntime']) {
  let config = { modelRuntime } as Config;
  const events = new EventBus();
  const errors: string[] = [];
  events.on('error', (ev) => errors.push(ev.phase ?? ''));
  const pipelines = createStandaloneAgentPipelines({
    getConfig: () => config,
    getProvider: () => provider('plain'),
    modelsRegistry,
    events,
    logger: { warn: () => {}, error: () => {} },
  });
  const send = (providerId: string, model: string): Promise<Request> => {
    const req: Request = { model, messages: [] };
    bindRequestProvider(req, provider(providerId));
    return pipelines.request.run(req);
  };
  return {
    pipelines,
    errors,
    send,
    savePrefs: (payload: Record<string, unknown>) => {
      const next = projectModelRuntimePrefs(config.modelRuntime, payload);
      if (next) config = { ...config, modelRuntime: next as Config['modelRuntime'] };
    },
  };
}

describe('standalone model-runtime middleware', () => {
  it("applies the reasoning effort by the profile of the request's own model", async () => {
    const { send } = setup({ reasoning: { mode: 'on', effort: 'high' } });

    expect((await send('reasoner', 'thinker')).reasoning?.effort).toBe('high');
    // A tab on a model with no known profile gets no reasoning field at all.
    expect((await send('plain', 'thinker')).reasoning).toBeUndefined();
  });

  it('applies the cache TTL and a setting saved while running', async () => {
    const { send, savePrefs } = setup(undefined);
    expect((await send('reasoner', 'thinker')).cache).toBeUndefined();

    savePrefs({ cacheTtl: '1h', reasoningEffort: 'low', reasoningMode: 'on' });
    const out = await send('reasoner', 'thinker');
    expect(out.cache).toEqual({ ttl: '1h' });
    expect(out.reasoning?.effort).toBe('low');
  });

  it("survives a plugin middleware's crash and still fails on a core one", async () => {
    const { pipelines, errors, send } = setup(undefined);
    const crash = (owner: string) => ({
      name: `crash-${owner}`,
      owner,
      handler: async () => {
        throw new Error('boom');
      },
    });
    pipelines.request.use(crash('some-plugin'));
    await expect(send('plain', 'm')).resolves.toMatchObject({ model: 'm' });
    expect(errors).toEqual(['pipeline:crash-some-plugin']);

    pipelines.request.remove('crash-some-plugin');
    pipelines.request.use(crash('core'));
    await expect(send('plain', 'm')).rejects.toThrow('boom');
  });
});
