/**
 * The standalone server's agent pipelines.
 *
 * They used to be built bare: a reasoning effort or cache TTL chosen in its
 * settings was saved and never reached a request, and a plugin middleware's
 * crash failed the whole turn. Its tabs can run different models, so the
 * reasoning profile comes from the model each request goes to, and a setting
 * changed at runtime applies to the next one.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, ModelsRegistry, Provider, Request } from '@wrongstack/contracts/types';
import type { UserInputPayload } from '@wrongstack/core/agent';
import {
  getPromptJournalEntries,
  PROMPT_JOURNAL_RAW_MARKER,
  recordPromptJournalEntry,
} from '@wrongstack/core/prompts';
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
  it('records standalone user submissions in the canonical project journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'standalone-journal-'));
    try {
      await recordPromptJournalEntry({
        projectRoot: root,
        sessionId: 'control',
        category: 'raw_user',
        content: 'Valid journal writer control',
      });
      expect((await getPromptJournalEntries(root, { sessionId: 'control' })).length).toBe(1);
      const { pipelines } = setup(undefined);
      const payload = {
        text: 'A real standalone user submission',
        ctx: {
          projectRoot: root,
          session: { id: 'standalone-user' },
          model: 'fixture',
          provider: { id: 'local' },
          meta: {},
        },
      } as unknown as UserInputPayload;
      expect(await pipelines.userInput.run(payload)).toBe(payload);
      await expect
        .poll(
          async () =>
            (
              await getPromptJournalEntries(root, {
                sessionId: 'standalone-user',
                category: 'raw_user',
              })
            ).map((entry) => entry.content),
          { timeout: 1500 },
        )
        .toEqual(['A real standalone user submission']);
      const refined = {
        ...payload,
        text: 'Approved refined instructions',
        ctx: {
          ...payload.ctx,
          session: { id: 'refined-session' },
          meta: {
            [PROMPT_JOURNAL_RAW_MARKER]: 'Original instructions',
            standalonePromptJournalOrigin: 'queue',
          },
        },
      } as unknown as UserInputPayload;
      await pipelines.userInput.run(refined);
      await expect
        .poll(
          async () =>
            (
              await getPromptJournalEntries(root, {
                sessionId: 'refined-session',
                category: 'refined_user',
              })
            ).map((entry) => entry.rawContent),
          { timeout: 1500 },
        )
        .toEqual(['Original instructions']);
      expect(refined.ctx.meta[PROMPT_JOURNAL_RAW_MARKER]).toBeUndefined();
      const internal = {
        ...payload,
        text: 'Internal auto-wake input',
        ctx: {
          ...payload.ctx,
          session: { id: 'internal-session' },
          meta: { standalonePromptJournalOrigin: 'runtime' },
        },
      } as unknown as UserInputPayload;
      await pipelines.userInput.run(internal);
      expect(
        await getPromptJournalEntries(root, {
          sessionId: 'internal-session',
          category: 'raw_user',
        }),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
  it('journals delegations and clarify questions from the toolCall pipeline, as the CLI does', async () => {
    const root = await mkdtemp(join(tmpdir(), 'standalone-journal-tools-'));
    try {
      const { pipelines } = setup(undefined);
      const ctx = {
        projectRoot: root,
        session: { id: 'tools-session' },
        model: 'fixture',
        provider: { id: 'local' },
        meta: {},
      };
      for (const toolUse of [
        { id: 't1', name: 'delegate', input: { task: 'Audit the parser', role: 'reviewer' } },
        { id: 't2', name: 'clarify', input: { question: 'Which branch?' } },
        { id: 't3', name: 'read', input: { path: 'a.ts' } },
      ])
        await pipelines.toolCall.run({ toolUse, ctx } as never);
      await expect
        .poll(
          async () =>
            (await getPromptJournalEntries(root, { sessionId: 'tools-session' }))
              .map((entry) => `${entry.category}:${entry.content}`)
              .sort(),
          { timeout: 1500 },
        )
        .toEqual(['clarify_interaction:Which branch?', 'subagent_delegation:Audit the parser']);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
  it("applies the reasoning effort by the profile of the request's own model", async () => {
    const { send } = setup({ reasoning: { mode: 'on', effort: 'high' } });

    expect((await send('reasoner', 'thinker')).reasoning?.effort).toBe('high');
    // A tab on a model with no known profile gets no reasoning field at all.
    expect((await send('plain', 'thinker')).reasoning).toBeUndefined();
  });

  it('applies the effort to a WrongForge-led tab, which has no catalog entry', async () => {
    const { send } = setup({ reasoning: { mode: 'on', effort: 'xhigh' } });

    expect((await send('wrongforge', 'claude-opus-5-5')).reasoning?.effort).toBe('xhigh');
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
