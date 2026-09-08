import { describe, expect, it, vi } from 'vitest';
import { ProviderAuthRegistry } from '../../src/registry/provider-auth-registry.js';
import type { ProviderAuthStrategy } from '../../src/types/provider-auth.js';

function strategy(
  id: string,
  aliases: readonly string[] = [],
  begin = vi.fn(),
): ProviderAuthStrategy {
  return {
    id,
    providerId: `${id}-provider`,
    label: `Login with ${id}`,
    aliases,
    interactionTypes: ['browser'],
    begin,
  };
}

describe('ProviderAuthRegistry', () => {
  it('resolves ids and aliases case-insensitively', () => {
    const registry = new ProviderAuthRegistry();
    registry.register(strategy('chatgpt', ['codex', 'openai-codex']));

    expect(registry.resolveId(' CODEX ')).toBe('chatgpt');
    expect(registry.get('OPENAI-CODEX')?.providerId).toBe('chatgpt-provider');
  });

  it('returns metadata without executable strategy functions', () => {
    const registry = new ProviderAuthRegistry();
    registry.register(strategy('chatgpt', ['codex']));

    expect(registry.list()).toEqual([
      {
        id: 'chatgpt',
        providerId: 'chatgpt-provider',
        label: 'Login with chatgpt',
        aliases: ['codex'],
        interactionTypes: ['browser'],
      },
    ]);
    expect(registry.list()[0]).not.toHaveProperty('begin');
  });

  it('dispatches begin through the resolved strategy', async () => {
    const begin = vi.fn().mockResolvedValue({ strategyId: 'x' });
    const registry = new ProviderAuthRegistry();
    registry.register(strategy('chatgpt', ['codex'], begin));

    const deps = {};
    const signal = new AbortController().signal;
    await expect(registry.begin('codex', deps, signal)).resolves.toEqual({ strategyId: 'x' });
    expect(begin).toHaveBeenCalledWith(deps, signal);
  });

  it('rejects alias collisions without mutating the registry', () => {
    const registry = new ProviderAuthRegistry();
    registry.register(strategy('first', ['shared']));

    expect(() => registry.register(strategy('second', ['shared']))).toThrow(
      /already registered by "first"/,
    );
    expect(registry.list().map((entry) => entry.id)).toEqual(['first']);
  });

  it('re-registration releases removed aliases', () => {
    const registry = new ProviderAuthRegistry();
    registry.register(strategy('first', ['old']));
    registry.register(strategy('first', ['new']));

    expect(registry.has('old')).toBe(false);
    expect(registry.resolveId('new')).toBe('first');
  });

  it('unregister accepts an alias and removes all aliases', () => {
    const registry = new ProviderAuthRegistry();
    registry.register(strategy('first', ['alias']));

    expect(registry.unregister('alias')).toBe(true);
    expect(registry.has('first')).toBe(false);
    expect(registry.has('alias')).toBe(false);
  });

  it('validates identifiers and override ownership', () => {
    const registry = new ProviderAuthRegistry();
    expect(() => registry.register(strategy('bad id'))).toThrow(/invalid/);
    expect(() => registry.override('missing', strategy('missing'))).toThrow(/cannot override/);
  });
});
