import { describe, expect, it, vi } from 'vitest';
import type {
  Config,
  ModelsRegistry,
  Provider,
  ResolvedProvider,
  Response,
} from '@wrongstack/core/types';
import {
  buildModelSmokeTargets,
  parseModelSmokeOptions,
  runModelSmokeTests,
} from '../src/subcommands/handlers/model-smoke-test.js';

function provider(
  id: string,
  models: Array<string | { id: string; output: string[] }>,
): ResolvedProvider {
  return {
    id,
    name: id,
    family: 'openai-compatible',
    envVars: [],
    models: models.map((model) =>
      typeof model === 'string'
        ? { id: model, name: model }
        : {
            id: model.id,
            name: model.id,
            modalities: { input: ['text'], output: model.output },
          },
    ),
  };
}

function registry(entries: ResolvedProvider[]): ModelsRegistry {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    load: vi.fn(),
    refresh: vi.fn(),
    listProviders: vi.fn(async () => entries),
    getProvider: vi.fn(async (id: string) => byId.get(id)),
    getModel: vi.fn(),
    suggestModel: vi.fn(async (id: string) => byId.get(id)?.models.at(-1)?.id),
    ageSeconds: vi.fn(),
  } as ModelsRegistry;
}

function config(): Config {
  return {
    provider: 'alpha',
    model: 'active-model',
    providers: {
      alpha: { type: 'alpha', family: 'openai-compatible', models: ['explicit'] },
      alias: {
        type: 'base',
        family: 'openai-compatible',
        customModels: { custom: {} },
      },
    },
  } as unknown as Config;
}

describe('model smoke test options', () => {
  it('combines top-level flags with direct handler args', () => {
    expect(
      parseModelSmokeOptions(['--models=m1,m2'], {
        'all-models': true,
        providers: 'alpha,alias',
        timeout: '1234',
        'max-tokens': '9',
      }),
    ).toMatchObject({
      allModels: true,
      providerFilter: ['alpha', 'alias'],
      modelFilter: ['m1', 'm2'],
      timeoutMs: 1234,
      maxTokens: 9,
    });
  });

  it('rejects invalid numeric limits', () => {
    expect(() => parseModelSmokeOptions([], { timeout: '0' })).toThrow(
      '--timeout must be a positive integer',
    );
  });
});

describe('model smoke targets', () => {
  it('selects one representative per configured provider by default', async () => {
    const targets = await buildModelSmokeTargets(
      config(),
      registry([provider('alpha', ['catalog-a']), provider('base', ['base-a', 'base-b'])]),
      { allModels: false },
    );

    expect(targets).toEqual([
      { providerId: 'alpha', modelId: 'active-model' },
      { providerId: 'alias', modelId: 'custom' },
    ]);
  });

  it('expands explicit, custom, catalog, and active models without duplicates', async () => {
    const targets = await buildModelSmokeTargets(
      config(),
      registry([
        provider('alpha', ['explicit', 'catalog-a']),
        provider('base', ['base-a', 'base-b']),
      ]),
      { allModels: true },
    );

    expect(targets).toEqual([
      { providerId: 'alpha', modelId: 'explicit' },
      { providerId: 'alpha', modelId: 'catalog-a' },
      { providerId: 'alpha', modelId: 'active-model' },
      { providerId: 'alias', modelId: 'custom' },
      { providerId: 'alias', modelId: 'base-a' },
      { providerId: 'alias', modelId: 'base-b' },
    ]);
  });

  it('excludes catalog models that explicitly cannot emit text', async () => {
    const targets = await buildModelSmokeTargets(
      {
        provider: 'media',
        model: 'chat',
        providers: {
          media: {
            type: 'media',
            family: 'openai-compatible',
            models: ['chat', 'image-only'],
          },
        },
      } as unknown as Config,
      registry([
        provider('media', [
          { id: 'chat', output: ['text'] },
          { id: 'image-only', output: ['image'] },
          { id: 'video-only', output: ['video'] },
        ]),
      ]),
      { allModels: true },
    );

    expect(targets).toEqual([{ providerId: 'media', modelId: 'chat' }]);
  });
});

describe('model smoke runner', () => {
  it('runs sequentially, reuses one provider instance, and continues after a model failure', async () => {
    const calls: string[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const response: Response = {
      content: [{ type: 'text', text: 'OK' }],
      stopReason: 'end_turn',
      usage: { input: 5, output: 1 },
      model: 'test',
    };
    const complete = vi.fn(async (request: { model: string }) => {
      activeCalls++;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      calls.push(request.model);
      await Promise.resolve();
      activeCalls--;
      if (request.model === 'bad') throw new Error('broken model');
      return { ...response, model: request.model };
    });
    const createProvider = vi.fn(
      (): Provider =>
        ({
          id: 'alpha',
          capabilities: {},
          complete,
          stream: vi.fn(),
        }) as unknown as Provider,
    );

    const results = await runModelSmokeTests({
      targets: [
        { providerId: 'alpha', modelId: 'good' },
        { providerId: 'alpha', modelId: 'bad' },
        { providerId: 'alpha', modelId: 'after' },
      ],
      options: { timeoutMs: 1000, maxTokens: 7 },
      createProvider,
    });

    expect(calls).toEqual(['good', 'bad', 'after']);
    expect(maxActiveCalls).toBe(1);
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status)).toEqual(['passed', 'failed', 'passed']);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'good', maxTokens: 7 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
