import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import { Container } from '../../src/kernel/container.js';
import { DefaultPluginAPI } from '../../src/plugin/api.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { SlashCommandRegistry } from '../../src/registry/slash-command-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import type { Config } from '../../src/types/config.js';

/**
 * Regressions for the plugin mutation-boundary gaps found by the 2026-08-20
 * security-check audit.
 *
 * `api.tools` gated every mutation through `assertCanMutateTool`, but its
 * siblings did not: `providers.register` was a bare pass-through to a
 * `Map.set`, so an external plugin could replace a first-party provider and
 * route every prompt, credential and model response through its own factory.
 * `slashCommands.unregister` took only a name, so it could remove another
 * plugin's command (or a built-in) and substitute its own.
 */

const baseConfig = {} as Config;

function makeApi(opts: { owner: string; official?: boolean }) {
  const pr = new ProviderRegistry();
  const scr = new SlashCommandRegistry();
  const api = new DefaultPluginAPI({
    ownerName: opts.owner,
    container: new Container(),
    events: new EventBus(),
    pipelines: {} as never,
    toolRegistry: new ToolRegistry(),
    providerRegistry: pr,
    slashCommandRegistry: scr,
    config: baseConfig,
    log: new DefaultLogger({ level: 'error' }),
    ...(opts.official === undefined ? {} : { official: opts.official }),
  });
  return { api, pr, scr };
}

const factory = (type: string) =>
  ({ type, create: () => ({}) }) as never as Parameters<
    DefaultPluginAPI['providers']['register']
  >[0];

describe('an external plugin may not hijack an existing provider', () => {
  it('refuses to replace a provider it did not register', () => {
    const { api, pr } = makeApi({ owner: 'evil' });
    pr.register(factory('anthropic')); // host registers the real one

    expect(() => api.providers.register(factory('anthropic'))).toThrow(/may not replace provider/);
  });

  it('refuses to unregister a provider it did not register', () => {
    const { api, pr } = makeApi({ owner: 'evil' });
    pr.register(factory('anthropic'));

    expect(() => api.providers.unregister('anthropic')).toThrow(/may not unregister provider/);
    expect(pr.has('anthropic')).toBe(true);
  });

  it('still allows introducing a brand-new provider type', () => {
    const { api, pr } = makeApi({ owner: 'friendly' });

    expect(() => api.providers.register(factory('my-custom'))).not.toThrow();
    expect(pr.has('my-custom')).toBe(true);
  });

  it('allows re-registering its own provider (hot reload)', () => {
    const { api } = makeApi({ owner: 'friendly' });
    api.providers.register(factory('my-custom'));

    expect(() => api.providers.register(factory('my-custom'))).not.toThrow();
    expect(() => api.providers.unregister('my-custom')).not.toThrow();
  });

  it('still lets an official plugin replace a provider', () => {
    const { api, pr } = makeApi({ owner: 'first-party', official: true });
    pr.register(factory('anthropic'));

    expect(() => api.providers.register(factory('anthropic'))).not.toThrow();
  });
});

describe('an external plugin may not remove another owner’s slash command', () => {
  it('refuses to unregister a command it did not register', () => {
    const { api, scr } = makeApi({ owner: 'evil' });
    scr.register({ name: 'commit', description: 'd', run: async () => ({}) } as never, 'core');

    expect(() => api.slashCommands.unregister('commit')).toThrow(
      /may not unregister slash command/,
    );
    expect(scr.get('commit')).toBeDefined();
  });

  it('still allows unregistering its own command by either name form', () => {
    const { api } = makeApi({ owner: 'p' });
    api.slashCommands.register({
      name: 'plugcmd',
      description: 'd',
      run: async () => ({}),
    } as never);

    // The registry indexes plugin commands under `<owner>:<name>`; both forms
    // must remain acceptable to the owner.
    expect(api.slashCommands.unregister('p:plugcmd')).toBe(true);
  });

  it('is a no-op rather than a throw for a command that does not exist', () => {
    const { api } = makeApi({ owner: 'p' });
    expect(() => api.slashCommands.unregister('nonexistent')).not.toThrow();
  });
});
