import { readFile } from 'node:fs/promises';
import type { Config } from '@wrongstack/contracts/types/config/root';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderInstructionLayer } from '../../../core/src/core/instruction-template.js';
import { ToolRegistry } from '@wrongstack/core/registry';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import { registerJevTools } from '../../src/management/jev-registration.js';
import { jevActivitySnapshot } from '../../../core/src/typesafe/activity.js';
import {
  createJevTool,
  type JevToolInput,
  jevToolStatus,
} from '../../../core/src/typesafe/jev-tool.js';
import { resetTypeSafeJudgesForTests } from '../../../core/src/typesafe/judgments.js';
import { resetSharedTypeSafeRestGatesForTests } from '../../../core/src/typesafe/rest.js';

const input: JevToolInput = {
  state: { evidence: 'All tests passed' },
  questions: {
    ready: { type: 'noul', instructions: 'Did the tests pass?' },
    action: {
      type: 'choice',
      instructions: 'Choose an action.',
      criteria: { accept: 'Passed', retry: 'Failed' },
    },
    quality: {
      type: 'score',
      instructions: 'Rate test quality.',
      criteria: ['No tests passed', 'All tests passed'],
    },
  },
};
const answers = {
  ready: { type: 'noul', noul: 0.99 },
  action: {
    type: 'choice',
    choice: 'accept',
    probabilities: { accept: 0.99, retry: 0.01 },
    confidence: 0.9,
  },
  quality: {
    type: 'score',
    score: 1,
    confidence: 0.9,
    legend: { '0': 'No tests passed', '1': 'All tests passed' },
  },
};
let config: Config;
let transport: ReturnType<typeof vi.fn>;
const run = (value: unknown = input, signal = new AbortController().signal) =>
  createJevTool(() => config).execute(value as JevToolInput, {} as never, { signal });

beforeEach(() => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  config = { version: 1, typesafe: { enabled: true, apiKey: 'test-key' } } as Config;
  transport = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          answers,
          model: 'jev-test',
          usage: { input_tokens: 9, output_tokens: 2 },
        }),
      ),
  );
  vi.stubGlobal('fetch', transport);
});
afterEach(() => {
  resetTypeSafeJudgesForTests();
  resetSharedTypeSafeRestGatesForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Jev callable decisions', () => {
  it.each(['typesafe', 'openrouter'] as const)(
    'uses the configured %s route and records runtime tool activity',
    async (route) => {
      config.typesafe = { enabled: true, apiKey: 'test-key', route };
      const result = await run();
      expect(result).toMatchObject({
        model: 'jev-test',
        usage: { inputTokens: 9, outputTokens: 2 },
        answers: { ready: answers.ready, action: answers.action },
      });
      const [url, request] = transport.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(
        route === 'typesafe'
          ? 'https://api.typesafe.ai/v1/systemone'
          : 'https://openrouter.ai/api/alpha/decisions',
      );
      expect(JSON.parse(request.body as string)).toEqual({
        ...input,
        model: route === 'typesafe' ? 'jev-latest' : '~typesafe/jev-latest',
      });
      expect(
        jevActivitySnapshot().entries.some(
          (entry) =>
            entry.feature === 'tool' && entry.purpose === 'runtime' && entry.outcome === 'answered',
        ),
      ).toBe(true);
    },
  );

  it('checks readiness without network and rejects stale calls after disable or key removal', async () => {
    expect(jevToolStatus(config)).toMatchObject({ enabled: true, available: true });
    expect(transport).not.toHaveBeenCalled();
    config.typesafe = { enabled: true, apiKey: 'test-key', judgments: { tool: false } };
    expect(jevToolStatus(config)).toMatchObject({ available: false, reason: 'disabled' });
    await expect(run()).rejects.toThrow('Jev unavailable');
    config.typesafe = { enabled: true };
    await expect(run()).rejects.toThrow('Jev unavailable');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { state: {}, questions: {} },
    { ...input, model: 'override' },
    {
      state: {},
      questions: { x: { type: 'choice', instructions: 'Pick', criteria: { only: null } } },
    },
    { state: {}, questions: { x: { type: 'score', instructions: 'Rate', criteria: ['one'] } } },
    { state: {}, questions: { x: { type: 'noul', instructions: '', criteria: {} } } },
    {
      state: {},
      questions: { x: { type: 'noul', instructions: 'Judge', criteria: { yes: 'yes' } } },
    },
  ])('rejects invalid input before network: %j', async (value) => {
    await expect(run(value)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ...answers, ready: { type: 'noul', noul: 2 } },
    { ...answers, ready: answers.action },
    {
      ...answers,
      action: { type: 'choice', choice: 'unknown', probabilities: { unknown: 1 }, confidence: 1 },
    },
    { ...answers, quality: { ...answers.quality, score: 2 } },
  ])('rejects malformed, missing and mismatched answers: %j', async (value) => {
    transport.mockImplementation(async () => new Response(JSON.stringify({ answers: value })));
    await expect(run()).rejects.toThrow('missing or incompatible');
  });

  it('preserves the shared auth breaker and resumes after credential replacement', async () => {
    transport.mockImplementation(async () => new Response('{}', { status: 401 }));
    for (let i = 0; i < 3; i++) await expect(run()).rejects.toThrow();
    expect(jevToolStatus(config)).toMatchObject({ available: false, reason: 'auth-rejected' });
    await expect(run()).rejects.toThrow('auth-rejected');
    expect(transport).toHaveBeenCalledTimes(3);
    config.typesafe = { enabled: true, apiKey: 'replacement-key' };
    expect(jevToolStatus(config).available).toBe(true);
  });

  it('reports shared cooldowns without repeatedly calling the unavailable service', async () => {
    transport.mockImplementation(async () => new Response('{}', { status: 429 }));
    await expect(run()).rejects.toThrow();
    expect(jevToolStatus(config)).toMatchObject({ available: false, reason: 'resting' });
    const count = transport.mock.calls.length;
    await expect(run()).rejects.toThrow('resting');
    expect(transport).toHaveBeenCalledTimes(count);
  });

  it('propagates cancellation without starting a request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(input, controller.signal)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('Jev live discovery and prompt guidance', () => {
  it('honors saved tool disables when optional tools are registered after boot', () => {
    const store = new DefaultConfigStore({
      ...config,
      tools: { disabledTools: ['jev', 'jev_status'] },
    } as Config);
    const registry = new ToolRegistry();
    const stop = registerJevTools(registry, store);
    expect(registry.get('jev')).toBeUndefined();
    expect(registry.get('jev_status')).toBeUndefined();
    registry.enable('jev');
    store.update({ model: 'other-model' });
    expect(registry.get('jev')).toBeDefined();
    stop();
  });

  it('tracks settings and preserves manual tool disable across feature toggles', async () => {
    const store = new DefaultConfigStore({ version: 1 } as Config);
    const registry = new ToolRegistry();
    registry.setProviderToolNames([]);
    const stop = registerJevTools(registry, store);
    expect(registry.get('jev')).toBeUndefined();
    expect(registry.get('jev_status')).toBeDefined();
    expect(registry.listForProvider().map((tool) => tool.name)).toEqual(['jev_status']);
    store.update({ typesafe: { enabled: true, apiKey: 'test-key' } });
    expect(registry.get('jev')).toBeDefined();
    expect(registry.listForProvider().map((tool) => tool.name)).toEqual(['jev_status', 'jev']);
    const tools = registry.list();
    store.update({ model: 'other-model' });
    expect(registry.list()).toBe(tools);
    registry.disable('jev');
    await expect(
      registry
        .get('jev_status')!
        .execute({}, {} as never, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ available: false, reason: 'tool-disabled' });
    store.update({ typesafe: { enabled: true, apiKey: 'test-key', judgments: { tool: false } } });
    store.update({ typesafe: { enabled: true, apiKey: 'test-key', judgments: { tool: true } } });
    expect(registry.get('jev')).toBeUndefined();
    registry.enable('jev');
    expect(registry.get('jev')).toBeDefined();
    store.update({ typesafe: { enabled: true, apiKey: '' } });
    expect(registry.get('jev')).toBeUndefined();
    stop();
    store.update({ typesafe: { enabled: true, apiKey: 'test-key' } });
    expect(registry.get('jev')).toBeUndefined();
  });

  it.each(['off', 'light', 'medium', 'aggressive', 'minimal'] as const)(
    'keeps Jev guidance conditional on the live tool catalog at tier %s',
    async (tier) => {
      const template = await readFile(
        new URL('../../../core/instructions/shared/system/tool-landscape.md', import.meta.url),
        'utf8',
      );
      const render = (names: string[]) =>
        renderInstructionLayer(template, {
          toolNames: new Set(names),
          tier,
          subagent: false,
          strictToolReferences: true,
        });
      expect(render(['jev', 'jev_status'])).toContain('Jev structured decisions');
      expect(render(['jev', 'jev_status'])).toContain('"type":"noul"');
      expect(render(['jev', 'jev_status'])).toContain('distribution concentration');
      expect(render(['jev_status'])).not.toContain('Jev structured decisions');
      expect(render([])).not.toContain('jev_status({})');
    },
  );
});
