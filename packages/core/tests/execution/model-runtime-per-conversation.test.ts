/**
 * Reasoning is a per-conversation preference.
 *
 * The request pipeline is shared by every conversation the process runs, and
 * `applyModelRuntime` only ever read the project config — so the reasoning
 * effort a tab chose was written to that tab's meta (where nothing consumed
 * it) and applied to EVERY tab's next request from the config. Same shape as
 * the YOLO and auto-compaction fixes: the preference moved to the session, the
 * runtime that applies it stayed process-wide.
 */

import { Pipeline } from '@wrongstack/contracts/kernel/pipeline';
import type { ModelRuntimeConfig } from '@wrongstack/contracts/types/config';
import type { Capabilities, ReasoningConfig, Request } from '@wrongstack/contracts/types/provider';
import { describe, expect, it } from 'vitest';
import { bindRequestConversation } from '../../src/core/request-conversation-binding.js';
import { bindRequestProvider } from '../../src/core/request-provider-binding.js';
import {
  applyModelRuntime,
  createModelRuntimeMiddleware,
} from '../../src/execution/model-runtime.js';

const REASONING: ReasoningConfig = {
  default: 'enabled',
  disableSupported: true,
  effortSupported: true,
  effortLevels: ['low', 'medium', 'high'],
  preserveThinking: 'optional',
};

function request(): Request {
  return { model: 'test-model', messages: [] };
}

function opts(settings: ModelRuntimeConfig | undefined) {
  return {
    getSettings: () => settings,
    getReasoningConfig: () => REASONING,
    getCapabilities: (): Capabilities => ({
      streaming: true,
      tools: true,
      parallelTools: false,
      vision: false,
      promptCache: false,
      systemPrompt: true,
      jsonMode: false,
      reasoning: true,
      cacheControl: 'none',
      maxContext: 100_000,
    }),
  };
}

const PROJECT: ModelRuntimeConfig = { reasoning: { mode: 'on', effort: 'low' } };

describe('applyModelRuntime reasoning scope', () => {
  it('uses the project setting when no conversation is bound', () => {
    // Single-session hosts (CLI, TUI) and requests built outside the agent
    // loop (compaction, one-shot helpers) never bind one.
    const out = applyModelRuntime(request(), opts(PROJECT));
    expect(out.reasoning?.effort).toBe('low');
  });

  it('lets a conversation override the project effort for its own request', () => {
    const req = request();
    bindRequestConversation(req, { meta: { reasoningEffort: 'high' } });

    expect(applyModelRuntime(req, opts(PROJECT)).reasoning?.effort).toBe('high');
  });

  it('keeps two conversations apart on the same shared pipeline', () => {
    const tabA = request();
    const tabB = request();
    bindRequestConversation(tabA, { meta: { reasoningEffort: 'high' } });
    bindRequestConversation(tabB, { meta: { reasoningEffort: 'medium' } });

    expect(applyModelRuntime(tabA, opts(PROJECT)).reasoning?.effort).toBe('high');
    expect(applyModelRuntime(tabB, opts(PROJECT)).reasoning?.effort).toBe('medium');
    // …and a third tab that never chose still gets the project setting.
    expect(applyModelRuntime(request(), opts(PROJECT)).reasoning?.effort).toBe('low');
  });

  it('applies a conversation choice even with no project settings at all', () => {
    const req = request();
    bindRequestConversation(req, { meta: { reasoningEffort: 'high' } });

    expect(applyModelRuntime(req, opts(undefined)).reasoning?.effort).toBe('high');
  });

  it('ignores meta that names no reasoning preference', () => {
    const req = request();
    bindRequestConversation(req, { meta: { yolo: true, mode: 'build' } });

    expect(applyModelRuntime(req, opts(PROJECT)).reasoning?.effort).toBe('low');
  });

  it('treats the WebUI "auto" sentinel as no conversation-level override', () => {
    const req = request();
    bindRequestConversation(req, { meta: { reasoningEffort: 'auto' } });

    // The tab defers to the project setting; 'auto' never reaches the wire.
    expect(applyModelRuntime(req, opts(PROJECT)).reasoning?.effort).toBe('low');
  });

  it('carries the binding onto the request it returns', () => {
    // Middleware returns a copy; the next middleware in the pipeline must
    // still be able to see whose request this is.
    const req = request();
    bindRequestConversation(req, { meta: { reasoningEffort: 'high' } });
    const first = applyModelRuntime(req, opts(PROJECT));

    expect(applyModelRuntime(first, opts(PROJECT)).reasoning?.effort).toBe('high');
  });
});

describe('createModelRuntimeMiddleware with a per-request reasoning lookup', () => {
  // A host whose conversations run different models: the reasoning profile
  // must be the one of the model the request goes to, not the boot model's.
  const provider = (id: string) => ({ id, capabilities: opts(undefined).getCapabilities() });
  const pipeline = () => {
    const p = new Pipeline<Request>();
    p.use(
      createModelRuntimeMiddleware({
        ...opts(PROJECT),
        getReasoningConfig: () => undefined,
        resolveReasoningConfig: async (req, bound) =>
          bound?.id === 'reasoner' && req.model === 'thinker' ? REASONING : undefined,
      }),
    );
    return p;
  };

  it('looks the profile up from the provider and model the request is bound to', async () => {
    const onReasoner = { ...request(), model: 'thinker' };
    bindRequestProvider(onReasoner, provider('reasoner') as never);
    const onPlain = { ...request(), model: 'thinker' };
    bindRequestProvider(onPlain, provider('plain') as never);

    expect((await pipeline().run(onReasoner)).reasoning?.effort).toBe('low');
    // No profile for that model: the capability is unknown, the field is omitted.
    expect((await pipeline().run(onPlain)).reasoning).toBeUndefined();
  });

  it('hands the request on to the middleware after it', async () => {
    const p = pipeline();
    const seen: string[] = [];
    p.use({
      name: 'later',
      handler: (req: Request, next: (r: Request) => Promise<Request>) => {
        seen.push(req.model);
        return next(req);
      },
    });
    await p.run(request());
    expect(seen).toEqual(['test-model']);
  });
});
