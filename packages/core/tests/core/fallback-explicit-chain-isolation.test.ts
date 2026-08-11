/**
 * Regression: the leader agent's fallback chain must NOT mix favorites,
 * auto-discovered models, the "default" profile, or every configured
 * provider when the user has set an explicit fallbackModels list or
 * a named fallbackProfile. The explicit chain is authoritative.
 */
import { describe, expect, it } from 'vitest';
import { ProviderModelStatusTracker } from '../../src/coordination/provider-status-tracker.js';
import { FallbackProfileManager } from '../../src/core/fallback-profile-manager.js';
import type { Config } from '../../src/types/config.js';

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    provider: 'primary',
    model: 'model-a',
    providers: {
      primary: { type: 'openai', apiKey: 'k1', models: ['model-a', 'model-b'] },
      secondary: { type: 'anthropic', apiKey: 'k2', models: ['claude-3'] },
      tertiary: { type: 'openai', apiKey: 'k3', models: ['gpt-4o'] },
    },
    favoriteModels: ['primary/model-b'],
    fallbackModels: [],
    fallbackProfiles: {
      default: ['secondary/claude-3'],
      custom: ['tertiary/gpt-4o'],
    },
    fallbackAuto: true,
    ...overrides,
  } as never as Config;
}

const target = { providerId: 'primary', model: 'model-a' };

describe('explicit fallback chain isolation', () => {
  it('resolveEffective with explicit fallbackModels does not append every configured provider', () => {
    const cfg = makeConfig({
      fallbackModels: ['secondary/claude-3'],
    });
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveEffective({
      fallbackModels: ['secondary/claude-3'],
      fallbackAuto: true, // auto should be ignored when explicit list is non-empty
      exclude: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);
    // Only the explicit model — NOT gpt-4o, NOT model-b (favorites)
    expect(keys).toEqual(['secondary/claude-3']);
  });

  it('resolveEffective with named profile does not append favorites or auto models', () => {
    const cfg = makeConfig({
      favoriteModels: ['primary/model-b', 'tertiary/gpt-4o'],
    });
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveEffective({
      fallbackProfile: 'custom', // -> tertiary/gpt-4o
      fallbackAuto: true,
      exclude: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);
    expect(keys).toEqual(['tertiary/gpt-4o']);
  });

  it('resolveEffective falls through to auto when profile name is unknown', () => {
    const cfg = makeConfig();
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveEffective({
      fallbackProfile: 'nonexistent',
      fallbackAuto: true,
      exclude: target,
    });
    // Should get auto-derived models, not empty
    expect(chain.length).toBeGreaterThan(0);
  });

  it('resolveAllConfigured returns every configured model', () => {
    const cfg = makeConfig();
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveAllConfigured(target);
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);
    // Should include models from all providers
    expect(keys).toContain('primary/model-b');
    expect(keys).toContain('secondary/claude-3');
    expect(keys).toContain('tertiary/gpt-4o');
  });

  it('resolveAllConfigured is NOT merged into an explicit chain in resolveEffective', () => {
    const cfg = makeConfig({
      fallbackModels: ['secondary/claude-3'],
    });
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveEffective({
      fallbackModels: ['secondary/claude-3'],
      fallbackAuto: true,
      exclude: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);
    // Must NOT contain auto-discovered models from other providers
    expect(keys).not.toContain('tertiary/gpt-4o');
    expect(keys).not.toContain('primary/model-b');
    expect(keys).toEqual(['secondary/claude-3']);
  });

  it('smart default includes favorites first when no explicit chain', () => {
    const cfg = makeConfig({
      favoriteModels: ['primary/model-b'],
    });
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveEffective({
      fallbackAuto: true,
      exclude: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);
    // Favorite should come first in auto-derived chain
    expect(keys[0]).toBe('primary/model-b');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Regression: bridge must not inflate fromExplicitSource. When the user has
// an explicit fallbackModels list but every entry resolves to a dead/unusable
// model, and a fallbackBridge is configured, the chain must still fall through
// to resolveAllConfigured so the one-shot/agent-loop paths retain last-resort
// depth. Previously the one-shot path checked `resolveEffective(...).length > 0`
// which included the bridge, inflating the count and blocking the append.
// ──────────────────────────────────────────────────────────────────────────
describe('resolveCandidates: bridge does not inflate fromExplicitSource', () => {
  it('appends resolveAllConfigured when explicit refs are all dead but bridge is set', () => {
    // Explicit ref points at a valid model but the tracker blocks it → dead.
    // Bridge points at a different valid model → would inflate the count
    // to >0 if the old code counted it (the bug).
    const tracker = new ProviderModelStatusTracker();
    tracker.recordFailure('secondary', 'other-model', 'rate_limit', 429, 'rate limit', {});
    const cfg = makeConfig({
      fallbackModels: ['secondary/other-model'],
      fallbackBridge: 'tertiary/gpt-4o',
      fallbackAuto: true,
    });
    const mgr = new FallbackProfileManager(cfg, { statusTracker: tracker });
    const chain = mgr.resolveCandidates(target, {
      fallbackModels: cfg.fallbackModels,
      primary: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);

    // Bridge must be present (it's always prepended)
    expect(keys).toContain('tertiary/gpt-4o');
    // The dead explicit ref must NOT appear (tracker blocked → filtered by resolveRefs)
    expect(keys).not.toContain('secondary/other-model');
    // resolveAllConfigured must be appended — at least one other configured
    // model should appear as last-resort depth.
    expect(keys.length).toBeGreaterThan(1);
    expect(keys).toContain('primary/model-b');
  });

  it('does NOT append default profile or resolveAllConfigured when fallbackAuto is false', () => {
    // Block the explicit ref via a tracker so explicitUsable=false, forcing
    // the guard's effectiveFallbackAuto term to be the deciding factor.
    // Without the tracker, resolveRefs does not check the provider models
    // allow-list, so the ref resolves → fromExplicitSource=true → the guard
    // short-circuits before effectiveFallbackAuto is reached (vacuous test).
    const tracker = new ProviderModelStatusTracker();
    tracker.recordFailure('secondary', 'claude-3', 'rate_limit', 429, 'rate limit', {});
    const cfg = makeConfig({
      fallbackModels: ['secondary/claude-3'],
      fallbackBridge: 'tertiary/gpt-4o',
      fallbackAuto: false,
    });
    const mgr = new FallbackProfileManager(cfg, { statusTracker: tracker });
    const chain = mgr.resolveCandidates(target, {
      fallbackModels: cfg.fallbackModels,
      primary: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);

    // Bridge is always prepended regardless of fallbackAuto
    expect(keys).toContain('tertiary/gpt-4o');
    // No auto-derived models should appear — fallbackAuto:false suppresses them
    expect(keys).not.toContain('primary/model-b');
    expect(keys).not.toContain('secondary/claude-3');
  });

  it('DOES append auto-derived depth when fallbackAuto is true and explicit refs are dead', () => {
    // Companion to the test above: same dead-explicit setup but with
    // fallbackAuto:true. The dead ref falls through and auto-discovery is
    // enabled, so resolveAllConfigured appends last-resort depth (favorite
    // model first). Together the two tests lock the guard's on/off behavior:
    // removing effectiveFallbackAuto from the condition makes this assertion
    // identical to the one above, proving both branches are exercised.
    const tracker = new ProviderModelStatusTracker();
    tracker.recordFailure('secondary', 'claude-3', 'rate_limit', 429, 'rate limit', {});
    const cfg = makeConfig({
      fallbackModels: ['secondary/claude-3'],
      fallbackBridge: 'tertiary/gpt-4o',
      fallbackAuto: true,
    });
    const mgr = new FallbackProfileManager(cfg, { statusTracker: tracker });
    const chain = mgr.resolveCandidates(target, {
      fallbackModels: cfg.fallbackModels,
      primary: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);

    // Bridge present
    expect(keys).toContain('tertiary/gpt-4o');
    // Auto-derived models ARE appended (favorite first in smartDefault)
    expect(keys).toContain('primary/model-b');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Closed-world permission boundary: a model allowlist never leaks to
// unlisted models. When closedWorld is true, resolveCandidates returns ONLY
// the explicit refs or named-profile entries — no bridge, no configured
// primary, no "default" profile, no resolveAllConfigured. Even when every
// explicit ref is dead, the chain stays empty rather than escaping to
// auto-discovered models.
// ──────────────────────────────────────────────────────────────────────────
describe('resolveCandidates: closed-world permission boundary', () => {
  it('returns ONLY explicit refs — no bridge, primary, default, or auto-discovered', () => {
    const cfg = makeConfig({
      fallbackModels: ['secondary/claude-3', 'tertiary/gpt-4o'],
      fallbackBridge: 'tertiary/gpt-4o',
    });
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveCandidates(target, {
      fallbackModels: cfg.fallbackModels,
      primary: target,
      closedWorld: true,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);

    // Only the explicit refs — current excluded, nothing else appended
    expect(keys).toEqual(['secondary/claude-3', 'tertiary/gpt-4o']);
    expect(keys).not.toContain('primary/model-b');
    expect(keys).not.toContain('primary/model-a');
  });

  it('returns ONLY named-profile entries — no bridge, primary, or auto-discovered', () => {
    const cfg = makeConfig({
      fallbackProfiles: { custom: ['secondary/claude-3', 'tertiary/gpt-4o'] },
    });
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveCandidates(target, {
      fallbackProfile: 'custom',
      primary: target,
      closedWorld: true,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);

    expect(keys).toEqual(['secondary/claude-3', 'tertiary/gpt-4o']);
    expect(keys).not.toContain('primary/model-b');
    expect(keys).not.toContain('primary/model-a');
  });

  it('returns empty chain when explicit refs are all dead — does NOT escape to auto-discovery', () => {
    // The critical permission property: even with a bridge configured and
    // fallbackAuto on, a closed-world chain with dead refs stays empty.
    // It never leaks to models outside the explicit allowlist.
    const tracker = new ProviderModelStatusTracker();
    tracker.recordFailure('secondary', 'claude-3', 'rate_limit', 429, 'rate limit', {});
    const cfg = makeConfig({
      fallbackModels: ['secondary/claude-3'],
      fallbackBridge: 'tertiary/gpt-4o',
      fallbackAuto: true,
    });
    const mgr = new FallbackProfileManager(cfg, { statusTracker: tracker });
    const chain = mgr.resolveCandidates(target, {
      fallbackModels: cfg.fallbackModels,
      primary: target,
      closedWorld: true,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);

    // Dead ref filtered out → empty. No bridge, no auto-discovery escape.
    expect(keys).toEqual([]);
  });

  it('returns empty chain when no explicit refs and no profile are provided', () => {
    const cfg = makeConfig();
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveCandidates(target, {
      primary: target,
      closedWorld: true,
    });
    expect(chain).toEqual([]);
  });
});
