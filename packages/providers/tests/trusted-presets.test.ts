import { describe, expect, it } from 'vitest';
// Import directly from source to avoid esbuild tree-shaking dropping the
// brand-new export from the @wrongstack/core dist bundle. Once
// ALIBABA_TOKEN_PLAN_MODELS has at least one consumer inside the core
// package, this can switch back to `from '@wrongstack/core'`.
import { ALIBABA_TOKEN_PLAN_MODELS } from '../../core/src/models/alibaba-token-plan-catalog.js';
import {
  buildProviderConfigFromPreset,
  getTrustedProviderPreset,
  isTrustedProviderId,
  listTrustedProviderPresetIds,
  rehydrateCanonicalProviderConfig,
  resolvePresetForAlias,
  TRUSTED_PROVIDER_PRESETS,
} from '../src/index.js';

/**
 * Pure tests for the trusted-preset table. The same constants are
 * consumed by both the standalone @wrongstack/webui-server and the
 * CLI-embedded WS handler, so a regression here breaks both surfaces.
 *
 * Presets cover product-specific endpoints (Kimi Code, Moonshot, Z.AI,
 * MiniMax), general-purpose API providers (DeepSeek, Groq, Perplexity),
 * and the meta-provider OpenRouter. Presets that list models in
 * `provider/model-name` format (OpenRouter) expect users to add more
 * model IDs from the provider's catalog.
 */

describe('TRUSTED_PROVIDER_PRESETS', () => {
  it('contains all product-scoped and general-purpose presets', () => {
    const ids = listTrustedProviderPresetIds().sort();
    expect(ids).toEqual([
      'alibaba-token-plan',
      'deepseek',
      'groq',
      'kimi-for-coding',
      'minimax',
      'mistral',
      'moonshotai',
      'openrouter',
      'perplexity',
      'requesty',
      'zai',
      'zai-coding-plan',
    ]);
  });

  it('Kimi Code preset points at the documented Kimi Code endpoint and aliases', () => {
    const preset = TRUSTED_PROVIDER_PRESETS['kimi-for-coding'];
    expect(preset).toBeDefined();
    expect(preset!.family).toBe('openai-compatible');
    expect(preset!.baseUrl).toBe('https://api.kimi.com/coding/v1');
    expect(preset!.envVars).toEqual(['KIMI_API_KEY']);
    expect(preset!.models).toEqual(['kimi-for-coding', 'kimi-for-coding-highspeed']);
    // K2.7 always streams reasoning as delta.reasoning_content and the
    // `kimi-toggle` quirk ensures an explicit disable is emitted instead
    // of dropped (see packages/providers/src/openai-compatible.ts).
    expect(preset!.quirks?.thinkingParam).toBe('kimi-toggle');
    expect(preset!.usage).toBe('subscription-interactive');
  });

  it('Moonshot Platform preset is the metered product, distinct from Kimi Code', () => {
    const preset = TRUSTED_PROVIDER_PRESETS.moonshotai;
    expect(preset).toBeDefined();
    expect(preset!.baseUrl).toBe('https://api.moonshot.ai/v1');
    expect(preset!.envVars).toEqual(['MOONSHOT_API_KEY']);
    expect(preset!.models).toEqual(['kimi-k2.7-code', 'kimi-k2.7-code-highspeed']);
    expect(preset!.quirks?.thinkingParam).toBe('always-on');
    expect(preset!.usage).toBe('metered-api');
  });

  it('Z.AI metered preset is distinct from the Coding Plan subscription', () => {
    const preset = TRUSTED_PROVIDER_PRESETS.zai;
    expect(preset).toBeDefined();
    expect(preset!.baseUrl).toBe('https://api.z.ai/api/paas/v4');
    expect(preset!.envVars).toEqual(['ZHIPU_API_KEY']);
    expect(preset!.models).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.2',
      'glm-5-turbo',
      'glm-4.7',
    ]);
    expect(preset!.customModels?.['glm-5.3']?.capabilities).toMatchObject({
      maxContext: 1_000_000,
      maxOutput: 128_000,
      reasoning: true,
      vision: false,
    });
    expect(preset!.customModels?.['glm-5.3-flash']?.capabilities).toMatchObject({
      maxContext: 1_000_000,
      maxOutput: 128_000,
      reasoning: true,
      vision: true,
    });
    expect(preset!.quirks?.thinkingParam).toBe('zai-glm');
    expect(preset!.usage).toBe('metered-api');
  });

  it('Z.AI Coding Plan subscription preset uses the dedicated Coding Plan endpoint', () => {
    const preset = TRUSTED_PROVIDER_PRESETS['zai-coding-plan'];
    expect(preset).toBeDefined();
    expect(preset!.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(preset!.models.slice(0, 2)).toEqual(['glm-5.3', 'glm-5.3-flash']);
    expect(preset!.usage).toBe('subscription-interactive');
  });

  it('MiniMax Token Plan preset points at the MiniMax API with current models', () => {
    const preset = TRUSTED_PROVIDER_PRESETS.minimax;
    expect(preset).toBeDefined();
    expect(preset!.baseUrl).toBe('https://api.minimax.io/v1');
    expect(preset!.envVars).toEqual(['MINIMAX_API_KEY']);
    expect(preset!.models).toContain('MiniMax-M3');
    expect(preset!.usage).toBe('subscription-interactive');
  });

  it('Alibaba Token Plan preset points at Model Studio with Personal Edition models only', () => {
    const preset = TRUSTED_PROVIDER_PRESETS['alibaba-token-plan'];
    expect(preset).toBeDefined();
    expect(preset!.family).toBe('openai-compatible');
    expect(preset!.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(preset!.envVars).toEqual(['ALIBABA_API_KEY', 'DASHSCOPE_API_KEY']);
    // Must contain all 11 Personal Edition models
    expect(preset!.models).toHaveLength(11);
    expect(preset!.models).toContain('qwen3.8-max-preview');
    expect(preset!.models).toContain('qwen3.7-max');
    expect(preset!.models).toContain('qwen3.7-plus');
    expect(preset!.models).toContain('qwen3.6-flash');
    expect(preset!.models).toContain('glm-5.2');
    expect(preset!.models).toContain('deepseek-v4-pro');
    expect(preset!.models).toContain('wan2.7-image');
    expect(preset!.models).toContain('wan2.7-image-pro');
    expect(preset!.models).toContain('happyhorse-1.1-t2v');
    expect(preset!.models).toContain('happyhorse-1.1-i2v');
    expect(preset!.models).toContain('happyhorse-1.1-r2v');
    // Must NOT contain Team Edition or pay-per-use models
    expect(preset!.models).not.toContain('deepseek-v4-flash');
    expect(preset!.models).not.toContain('deepseek-v3.2');
    expect(preset!.models).not.toContain('qwen3.6-plus');
    expect(preset!.models).not.toContain('qwen-image-2.0');
    expect(preset!.models).not.toContain('qwen-image-2.0-pro');
    expect(preset!.models).not.toContain('kimi-k2.7-code');
    expect(preset!.models).not.toContain('kimi-k2.6');
    expect(preset!.models).not.toContain('kimi-k2.5');
    expect(preset!.models).not.toContain('glm-5.1');
    expect(preset!.models).not.toContain('glm-5');
    expect(preset!.models).not.toContain('MiniMax-M2.5');
    expect(preset!.models).not.toContain('qwen3-max');
    expect(preset!.models).not.toContain('qwen3-coder-plus');
    expect(preset!.models).not.toContain('qwen3-coder-flash');
    expect(preset!.models).not.toContain('qwen-long');
    expect(preset!.models).not.toContain('qwen3-math-plus');
    // Order is significant — first entry is the recommended default (current), matching ALIBABA_TOKEN_PLAN_MODELS[0]
    expect(preset!.models[0]).toBe('qwen3.8-max-preview');
    expect(preset!.usage).toBe('subscription-interactive');
    // Drift guard: preset.models must match the ALIBABA_TOKEN_PLAN_MODELS catalog exactly
    const floorModelIds = ALIBABA_TOKEN_PLAN_MODELS.map((m) => m.id).sort();
    expect([...preset!.models].sort()).toEqual(floorModelIds);
  });
});

describe('getTrustedProviderPreset / isTrustedProviderId', () => {
  it('returns the preset for canonical ids', () => {
    const preset = getTrustedProviderPreset('kimi-for-coding');
    expect(preset?.id).toBe('kimi-for-coding');
    expect(isTrustedProviderId('kimi-for-coding')).toBe(true);
  });

  it('returns undefined for unrecognised ids without throwing', () => {
    expect(getTrustedProviderPreset('anthropic')).toBeUndefined();
    expect(getTrustedProviderPreset('not-a-provider')).toBeUndefined();
    expect(isTrustedProviderId('anthropic')).toBe(false);
  });
});

describe('resolvePresetForAlias', () => {
  it('matches the canonical id exactly', () => {
    expect(resolvePresetForAlias('alibaba-token-plan')?.id).toBe('alibaba-token-plan');
    expect(resolvePresetForAlias('deepseek')?.id).toBe('deepseek');
    expect(resolvePresetForAlias('groq')?.id).toBe('groq');
    expect(resolvePresetForAlias('kimi-for-coding')?.id).toBe('kimi-for-coding');
    expect(resolvePresetForAlias('mistral')?.id).toBe('mistral');
    expect(resolvePresetForAlias('moonshotai')?.id).toBe('moonshotai');
    expect(resolvePresetForAlias('openrouter')?.id).toBe('openrouter');
    expect(resolvePresetForAlias('perplexity')?.id).toBe('perplexity');
    expect(resolvePresetForAlias('requesty')?.id).toBe('requesty');
    expect(resolvePresetForAlias('zai')?.id).toBe('zai');
  });

  it('matches <canonical>-<suffix> custom aliases so a second key can be saved without losing the preset defaults', () => {
    expect(resolvePresetForAlias('kimi-for-coding-work')?.id).toBe('kimi-for-coding');
    expect(resolvePresetForAlias('kimi-for-coding-team-eu')?.id).toBe('kimi-for-coding');
    expect(resolvePresetForAlias('moonshotai-prod')?.id).toBe('moonshotai');
    expect(resolvePresetForAlias('zai-staging')?.id).toBe('zai');
    expect(resolvePresetForAlias('alibaba-token-plan-work')?.id).toBe('alibaba-token-plan');
    expect(resolvePresetForAlias('alibaba-token-plan-team-eu')?.id).toBe('alibaba-token-plan');
  });

  it('does NOT match short prefixes that would steal the canonical id', () => {
    // `kimi` is a substring of `kimi-for-coding` but not a `<id>-suffix` form
    // — the generic registration path must handle it, not the preset
    // hydration (which would otherwise overwrite the user's endpoint).
    expect(resolvePresetForAlias('kimi')).toBeUndefined();
    expect(resolvePresetForAlias('moonshot')).toBeUndefined();
    expect(resolvePresetForAlias('za')).toBeUndefined();
  });

  it('chooses the longest matching prefix when several presets could match', () => {
    // Both `moonshotai` and `zai` are valid candidate prefixes for
    // `moonshotai-foo`; the resolver must pick the longer match.
    expect(resolvePresetForAlias('moonshotai-foo')?.id).toBe('moonshotai');
  });

  it('returns undefined for arbitrary ids', () => {
    expect(resolvePresetForAlias('openai')).toBeUndefined();
    expect(resolvePresetForAlias('custom-gateway-1')).toBeUndefined();
  });
});

describe('buildProviderConfigFromPreset', () => {
  it('produces a deep-cloned config — callers may mutate without aliasing the preset', () => {
    const preset = TRUSTED_PROVIDER_PRESETS['kimi-for-coding']!;
    const cfg = buildProviderConfigFromPreset(preset);
    cfg.baseUrl = 'https://attacker.example/';
    cfg.models?.push('rogue-model');
    expect(preset.baseUrl).toBe('https://api.kimi.com/coding/v1');
    expect(preset.models).toEqual(['kimi-for-coding', 'kimi-for-coding-highspeed']);
  });

  it('uses the preset id as the canonical type', () => {
    const cfg = buildProviderConfigFromPreset(TRUSTED_PROVIDER_PRESETS['kimi-for-coding']!);
    expect(cfg.type).toBe('kimi-for-coding');
    expect(cfg.family).toBe('openai-compatible');
  });

  it('copies env vars so subsequent mutations do not bleed back', () => {
    const cfg = buildProviderConfigFromPreset(TRUSTED_PROVIDER_PRESETS.moonshotai!);
    cfg.envVars?.push('EXTRA');
    expect(TRUSTED_PROVIDER_PRESETS.moonshotai!.envVars).toEqual(['MOONSHOT_API_KEY']);
  });

  it('deep-clones per-model capabilities', () => {
    const preset = TRUSTED_PROVIDER_PRESETS['zai-coding-plan']!;
    const cfg = buildProviderConfigFromPreset(preset);
    const capabilities = cfg.customModels?.['glm-5.3']?.capabilities;
    expect(capabilities).toBeDefined();
    if (capabilities) capabilities.maxContext = 42;
    expect(preset.customModels?.['glm-5.3']?.capabilities?.maxContext).toBe(1_000_000);
  });

  it('omits optional fields when the preset does not define them', () => {
    // Currently every preset has quirks/models — guard against future
    // presets that legitimately lack one.
    const preset = { ...TRUSTED_PROVIDER_PRESETS.zai! };
    delete preset.quirks;
    const cfg = buildProviderConfigFromPreset(preset);
    expect(cfg.quirks).toBeUndefined();
  });
});
/**
 * Regression guard for the Kimi 401/403 root cause: stale `family: anthropic`
 * + non-preset `k3` model on an already-saved canonical provider. The setup
 * flow sends `key.add` (not `provider.add`), so the only hook available
 * for repair is the upsert path -> must call rehydrateCanonicalProviderConfig
 * on existing entries. User-owned custom endpoints must remain untouched.
 */
describe('rehydrateCanonicalProviderConfig', () => {
  function kimiPreset() {
    const preset = TRUSTED_PROVIDER_PRESETS['kimi-for-coding'];
    if (!preset) throw new Error('kimi-for-coding preset missing');
    return preset;
  }

  it('returns false and leaves the provider alone when the id is unknown', () => {
    const dest: any = { type: 'anthropic', family: 'anthropic', apiKey: 'sk' };
    expect(rehydrateCanonicalProviderConfig('not-a-preset', dest)).toBe(false);
    expect(dest).toEqual({ type: 'anthropic', family: 'anthropic', apiKey: 'sk' });
  });

  it('returns false for an alias id (canonical ids only)', () => {
    const dest: any = { type: 'kimi-for-coding', family: 'openai-compatible' };
    expect(rehydrateCanonicalProviderConfig('kimi-for-coding-work', dest)).toBe(false);
  });

  it('repairs the stale Kimi record (legacy anthropic + k3 model)', () => {
    const preset = kimiPreset();
    const dest: any = {
      type: 'anthropic',
      family: 'anthropic',
      baseUrl: undefined,
      envVars: ['KIMI_API_KEY'],
      models: ['k3'],
      model: 'k3',
      quirks: { thinkingParam: 'kimi-toggle' },
      apiKey: 'sk-kimi-secret',
    };

    expect(rehydrateCanonicalProviderConfig('kimi-for-coding', dest)).toBe(true);
    expect(dest.type).toBe('kimi-for-coding');
    expect(dest.family).toBe(preset.family); // openai-compatible, not anthropic
    expect(dest.baseUrl).toBe(preset.baseUrl);
    expect(dest.envVars).toEqual(preset.envVars);
    expect(dest.models).toEqual(preset.models);
    expect(dest.models).not.toContain('k3');
    expect(dest.model).toBe(preset.models[0]);
    expect(dest.quirks).toEqual({ thinkingParam: 'kimi-toggle' });
    // Credentials are user-owned and must not be touched.
    expect(dest.apiKey).toBe('sk-kimi-secret');
  });

  it('fills missing base URL / envVars without overwriting user values', () => {
    const preset = kimiPreset();
    const dest: any = {
      type: 'kimi-for-coding',
      family: 'openai-compatible',
      baseUrl: undefined,
      envVars: [],
      models: ['custom-fine-tune'],
    };
    rehydrateCanonicalProviderConfig('kimi-for-coding', dest);
    expect(dest.baseUrl).toBe(preset.baseUrl);
    expect(dest.envVars).toEqual(preset.envVars);
    expect(dest.models).toEqual(['custom-fine-tune']); // user allowlist preserved
  });

  it('refreshes the previous Z.AI default model list without replacing custom allowlists', () => {
    const previousDefault: any = {
      type: 'zai-coding-plan',
      family: 'openai-compatible',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      models: ['glm-5.2', 'glm-5-turbo', 'glm-4.7'],
    };
    rehydrateCanonicalProviderConfig('zai-coding-plan', previousDefault);
    expect(previousDefault.models.slice(0, 2)).toEqual(['glm-5.3', 'glm-5.3-flash']);
    expect(previousDefault.customModels['glm-5.3'].capabilities.maxContext).toBe(1_000_000);

    const custom: any = {
      type: 'zai-coding-plan',
      family: 'openai-compatible',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      models: ['company-fine-tune'],
    };
    rehydrateCanonicalProviderConfig('zai-coding-plan', custom);
    expect(custom.models).toEqual(['company-fine-tune']);
  });

  it('preserves user-owned fields when baseUrl diverges from the preset', () => {
    const preset = kimiPreset();
    const dest: any = {
      type: 'kimi-for-coding',
      family: 'anthropic',
      baseUrl: 'https://internal.kimi-proxy.example/v1',
      envVars: ['INTERNAL_TOKEN'],
      models: ['internal-fine-tune'],
      quirks: { thinkingParam: 'custom-quirk' },
    };

    rehydrateCanonicalProviderConfig('kimi-for-coding', dest);

    // Custom gateway: protocol / models / env vars / quirks are user-owned.
    expect(dest.family).toBe('anthropic');
    expect(dest.envVars).toEqual(['INTERNAL_TOKEN']);
    expect(dest.models).toEqual(['internal-fine-tune']);
    expect(dest.quirks).toEqual({ thinkingParam: 'custom-quirk' });
    // type is forced to canonical id so the registry can resolve.
    expect(dest.type).toBe('kimi-for-coding');
    // Custom baseUrl never overwritten.
    expect(dest.baseUrl).toBe('https://internal.kimi-proxy.example/v1');
    expect(preset.baseUrl).toBe('https://api.kimi.com/coding/v1'); // sanity
  });

  it('merges quirks with user overrides winning', () => {
    const preset = kimiPreset();
    const dest: any = { type: 'kimi-for-coding', family: 'openai-compatible' };
    dest.quirks = { thinkingParam: 'user-choice', extra: 1 };
    rehydrateCanonicalProviderConfig('kimi-for-coding', dest);
    expect(dest.quirks).toEqual({ thinkingParam: 'user-choice', extra: 1 });
    dest.quirks = undefined;
    rehydrateCanonicalProviderConfig('kimi-for-coding', dest);
    expect(dest.quirks).toEqual(preset.quirks);
  });
});
