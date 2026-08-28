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
import { describe, expect, it } from 'vitest';
import { bindRequestConversation } from '../../src/core/request-conversation-binding.js';
import { applyModelRuntime } from '../../src/execution/model-runtime.js';
import type { ModelRuntimeConfig } from '../../src/types/config.js';
import type { ReasoningConfig, Request } from '../../src/types/provider.js';

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
    getCapabilities: () => ({
      streaming: true,
      tools: true,
      parallelTools: false,
      vision: false,
      promptCache: false,
      systemPrompt: true,
      jsonMode: false,
      reasoning: true,
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

  it('carries the binding onto the request it returns', () => {
    // Middleware returns a copy; the next middleware in the pipeline must
    // still be able to see whose request this is.
    const req = request();
    bindRequestConversation(req, { meta: { reasoningEffort: 'high' } });
    const first = applyModelRuntime(req, opts(PROJECT));

    expect(applyModelRuntime(first, opts(PROJECT)).reasoning?.effort).toBe('high');
  });
});
