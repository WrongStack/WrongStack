import { describe, expect, it } from 'vitest';
import {
  resolveModelRuntime,
  resolveReasoningForRequest,
  resolveCacheForRequest,
  resolveParametersForRequest,
  mergeModelRuntime,
} from '../../src/execution/model-runtime.js';
import type { ModelRuntimeConfig } from '../../src/types/config.js';
import type { Capabilities, ReasoningConfig } from '../../src/types/provider.js';

const capsOn: ReasoningConfig = {
  default: 'enabled',
  disableSupported: true,
  effortSupported: true,
  effortLevels: ['low', 'medium', 'high'],
  preserveThinking: 'optional',
};

const capsAlwaysOn: ReasoningConfig = {
  default: 'always_on',
  disableSupported: false,
  effortSupported: false,
  effortLevels: [],
  preserveThinking: 'always_on',
};

const capsWithoutPreserve: ReasoningConfig = {
  ...capsOn,
  preserveThinking: 'unsupported',
};

/**
 * B6 tri-state: a model that reasons but whose effort vocabulary the catalog
 * does not document (`reasoning: true` with no `reasoning_options`).
 * Normalization leaves `effortSupported` unset; the resolver must FORWARD the
 * requested effort (transport adapters apply their own gating) instead of
 * claiming "does not support effort" — an assertion the catalog never made.
 */
const capsUndocumentedEffort: ReasoningConfig = {
  default: 'always_on',
  disableSupported: false,
  effortSupported: undefined,
  effortLevels: [],
  preserveThinking: 'unsupported',
};

describe('resolveModelRuntime', () => {
  it('returns undefined fields when settings are absent', () => {
    const r = resolveModelRuntime(undefined, capsOn);
    expect(r.reasoning).toBeUndefined();
    expect(r.cache).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it('maps mode "off" to enabled:false when disableSupported', () => {
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'off' } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toEqual({ enabled: false });
    expect(r.warnings).toEqual([]);
  });

  it('suppresses mode "off" and warns when disable unsupported / always_on', () => {
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'off' } };
    const r = resolveModelRuntime(settings, capsAlwaysOn);
    expect(r.reasoning).toBeUndefined();
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/always on/i);
  });

  it('maps mode "on" to enabled:true', () => {
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'on' } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toEqual({ enabled: true });
  });

  it('maps effort only when supported and in effortLevels', () => {
    const settings: ModelRuntimeConfig = { reasoning: { effort: 'high' } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toEqual({ effort: 'high' });
  });

  it('warns when effort not in supported levels', () => {
    const settings: ModelRuntimeConfig = { reasoning: { effort: 'xhigh' } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toBeUndefined();
    expect(r.warnings[0]).toMatch(/not supported/);
  });

  it('forwards effort when the model reasons but levels are undocumented (B6)', () => {
    const settings: ModelRuntimeConfig = { reasoning: { effort: 'high' } };
    const r = resolveModelRuntime(settings, capsUndocumentedEffort);
    expect(r.reasoning).toEqual({ effort: 'high' });
    expect(r.warnings).toEqual([]);
  });

  it('mode "on" is representable when effortSupported is undocumented (B6)', () => {
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'on', effort: 'medium' } };
    const r = resolveModelRuntime(settings, capsUndocumentedEffort);
    expect(r.reasoning).toEqual({ enabled: true, effort: 'medium' });
  });

  it('still drops effort with a warning when effort is documented absent', () => {
    const settings: ModelRuntimeConfig = { reasoning: { effort: 'high' } };
    const r = resolveModelRuntime(settings, capsAlwaysOn);
    expect(r.reasoning).toBeUndefined();
    expect(r.warnings[0]).toMatch(/does not support effort control/);
  });

  it('maps preserve when preserveThinking !== unsupported', () => {
    const settings: ModelRuntimeConfig = { reasoning: { preserve: true } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toEqual({ preserve: true });
  });

  it('warns when preserve is enabled for an unsupported model', () => {
    const settings: ModelRuntimeConfig = { reasoning: { preserve: true } };
    const r = resolveModelRuntime(settings, capsWithoutPreserve);
    expect(r.reasoning).toBeUndefined();
    expect(r.warnings).toEqual([
      'reasoning preserve requested, but this model does not support preserved thinking; the setting was omitted.',
    ]);
  });

  it('silently omits preserve false for an unsupported model', () => {
    const settings: ModelRuntimeConfig = { reasoning: { preserve: false } };
    const r = resolveModelRuntime(settings, capsWithoutPreserve);
    expect(r.reasoning).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it('maps cache ttl to Request.cache', () => {
    const settings: ModelRuntimeConfig = { cache: { ttl: '1h' } };
    const r = resolveModelRuntime(settings, undefined);
    expect(r.cache).toEqual({ ttl: '1h' });
  });

  it('is conservative and silent when capabilities are unknown', () => {
    // When the model's reasoning config is unknown, the resolver drops
    // explicit fields rather than risk sending unsupported values to the
    // provider. No warning is emitted: the user has no actionable response,
    // and warning per request would be pure noise.
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'off', effort: 'high' } };
    const r = resolveModelRuntime(settings, undefined);
    expect(r.reasoning).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it('mode auto never sends explicit fields', () => {
    const settings: ModelRuntimeConfig = { reasoning: { mode: 'auto', effort: 'high' } };
    const r = resolveModelRuntime(settings, capsOn);
    expect(r.reasoning).toEqual({ effort: 'high' });
  });
});

describe('mergeModelRuntime', () => {
  it('overlays scoped reasoning without dropping cache or parameters', () => {
    expect(
      mergeModelRuntime(
        { reasoning: { mode: 'auto', effort: 'high' }, cache: { ttl: '1h' }, parameters: { user: 'leader' } },
        { reasoning: { effort: 'low' } },
      ),
    ).toEqual({
      reasoning: { mode: 'auto', effort: 'low' },
      cache: { ttl: '1h' },
      parameters: { user: 'leader' },
    });
  });
});

describe('resolveReasoningForRequest (isolated)', () => {
  it('returns undefined when no reasoning config in settings', () => {
    const warnings: string[] = [];
    const r = resolveReasoningForRequest({}, capsOn, warnings);
    expect(r).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe('resolveCacheForRequest (isolated)', () => {
  it('returns undefined when no cache in settings', () => {
    const r = resolveCacheForRequest({ reasoning: { mode: 'auto' } }, []);
    expect(r).toBeUndefined();
  });
});

describe('resolveParametersForRequest', () => {
  const anthropicCaps: Capabilities = {
    tools: true, parallelTools: true, vision: true, streaming: true,
    promptCache: true, systemPrompt: true, jsonMode: false, reasoning: false,
    maxContext: 200_000, cacheControl: 'native',
    topK: true, frequencyPenalty: false, presencePenalty: false, seed: false,
    structuredOutput: false, logprobs: false, audio: false, multipleCompletions: false,
  };

  const openaiCaps: Capabilities = {
    tools: true, parallelTools: true, vision: true, streaming: true,
    promptCache: false, systemPrompt: true, jsonMode: true, reasoning: false,
    maxContext: 128_000, cacheControl: 'auto',
    topK: false, frequencyPenalty: true, presencePenalty: true, seed: true,
    structuredOutput: true, logprobs: true, audio: true, multipleCompletions: true,
  };

  it('returns undefined when params is undefined', () => {
    expect(resolveParametersForRequest(undefined, openaiCaps, [])).toBeUndefined();
  });

  it('returns undefined when params has no fields set', () => {
    expect(resolveParametersForRequest({}, openaiCaps, [])).toBeUndefined();
  });

  it('passes topK when caps.topK is true (Anthropic)', () => {
    const r = resolveParametersForRequest({ topK: 40 }, anthropicCaps, []);
    expect(r?.topK).toBe(40);
  });

  it('suppresses topK when caps.topK is false (OpenAI)', () => {
    const r = resolveParametersForRequest({ topK: 40 }, openaiCaps, []);
    expect(r?.topK).toBeUndefined();
  });

  it('passes frequencyPenalty when caps.frequencyPenalty is true', () => {
    const r = resolveParametersForRequest({ frequencyPenalty: 0.5 }, openaiCaps, []);
    expect(r?.frequencyPenalty).toBe(0.5);
  });

  it('suppresses frequencyPenalty when caps.frequencyPenalty is false', () => {
    const r = resolveParametersForRequest({ frequencyPenalty: 0.5 }, anthropicCaps, []);
    expect(r?.frequencyPenalty).toBeUndefined();
  });

  it('passes presencePenalty when caps.presencePenalty is true', () => {
    const r = resolveParametersForRequest({ presencePenalty: 0.3 }, openaiCaps, []);
    expect(r?.presencePenalty).toBe(0.3);
  });

  it('suppresses presencePenalty when caps.presencePenalty is false', () => {
    const r = resolveParametersForRequest({ presencePenalty: 0.3 }, anthropicCaps, []);
    expect(r?.presencePenalty).toBeUndefined();
  });

  it('passes seed when caps.seed is true', () => {
    const r = resolveParametersForRequest({ seed: 42 }, openaiCaps, []);
    expect(r?.seed).toBe(42);
  });

  it('suppresses seed when caps.seed is false', () => {
    const r = resolveParametersForRequest({ seed: 42 }, anthropicCaps, []);
    expect(r?.seed).toBeUndefined();
  });

  it('passes user regardless of capabilities', () => {
    const r = resolveParametersForRequest({ user: 'abc' }, anthropicCaps, []);
    expect(r?.user).toBe('abc');
  });

  it('passes logprobs + topLogprobs when caps.logprobs is true', () => {
    const r = resolveParametersForRequest({ logprobs: true, topLogprobs: 5 }, openaiCaps, []);
    expect(r?.logprobs).toBe(true);
    expect(r?.topLogprobs).toBe(5);
  });

  it('suppresses logprobs when caps.logprobs is false', () => {
    const r = resolveParametersForRequest({ logprobs: true, topLogprobs: 5 }, anthropicCaps, []);
    expect(r?.logprobs).toBeUndefined();
    expect(r?.topLogprobs).toBeUndefined();
  });

  it('passes all params when caps is undefined (safe default)', () => {
    const r = resolveParametersForRequest(
      { topK: 40, frequencyPenalty: 0.5, seed: 42, user: 'abc', logprobs: true },
      undefined, [],
    );
    expect(r?.topK).toBe(40);
    expect(r?.frequencyPenalty).toBe(0.5);
    expect(r?.seed).toBe(42);
    expect(r?.user).toBe('abc');
    expect(r?.logprobs).toBe(true);
  });
});
