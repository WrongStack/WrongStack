/**
 * @wrongstack/plugins — reload idempotency across every official plugin.
 *
 * Plugin state lives at module scope, so `setup()` can run more than once
 * against the same module. The house "H1 pattern" says a second `setup()`
 * must not leave the first one's registrations live.
 *
 * About fifteen plugins broke that contract in the same way: `setup()`
 * reset the handle with `state.hookUnregister = null` instead of calling
 * it. The previous hook stayed in the registry with nothing holding a
 * reference — firing alongside the new one, with a closure over the OLD
 * config. Counters double, warnings appear twice, and a gate can act on
 * settings the user already changed.
 *
 * This walks every official plugin rather than spot-checking, so a new
 * plugin (or a new hook in an existing one) cannot reintroduce it quietly.
 */
import { describe, expect, it } from 'vitest';
import { OFFICIAL_PLUGIN_SPECIFIERS } from '../src/factories/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Registration {
  kind: 'hook' | 'event' | 'pattern' | 'extension' | 'contributor';
  live: boolean;
}

/**
 * A host stub that tracks whether each registration is still live.
 * Everything a plugin might register hands back an unregister function.
 */
function makeApi(): Any {
  const registrations: Registration[] = [];
  const tools: Array<{ name: string }> = [];
  const track = (kind: Registration['kind']) => {
    const entry: Registration = { kind, live: true };
    registrations.push(entry);
    return () => {
      entry.live = false;
    };
  };
  return {
    tools: {
      register: (t: { name: string }) => {
        const i = tools.findIndex((x) => x.name === t.name);
        if (i >= 0) tools.splice(i, 1);
        tools.push(t);
      },
      unregister: () => true,
      get: () => undefined,
      list: () => tools,
      wrap: () => {},
    },
    slashCommands: { register() {}, unregister: () => false, get: () => undefined, list: () => [] },
    providers: { register() {}, unregister() {}, create: () => ({}), list: () => [] },
    mcp: { start: async () => {}, stop: async () => {}, restart: async () => {}, list: () => [] },
    pipelines: {},
    container: {},
    events: { on: () => () => {}, emit() {} },
    config: { extensions: {} },
    log: { info() {}, warn() {}, error() {}, debug() {}, child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
    metrics: { counter() {}, histogram() {}, gauge() {} },
    session: { append: async () => {} },
    // ExtensionRegistry.register returns the unregister FUNCTION directly.
    extensions: { register: () => track('extension') },
    registerSystemPromptContributor: () => track('contributor'),
    registerHook: () => track('hook'),
    onEvent: () => track('event'),
    onPattern: () => track('pattern'),
    emitCustom() {},
    onConfigChange: () => () => {},
    notifier: undefined,
    mailbox: undefined,
    modelsRegistry: undefined,
    llm: undefined,
    _registrations: registrations,
  };
}

function liveCount(api: Any): number {
  return (api._registrations as Registration[]).filter((r) => r.live).length;
}

/**
 * `api.onEvent` / `api.onPattern` unsubscribes are drained by the HOST
 * (DefaultPluginAPI keeps them and releases them on uninstall), so a
 * plugin is not expected to release those itself on re-setup. Hooks,
 * extensions and prompt contributors are the plugin's own responsibility.
 */
const PLUGIN_OWNED: Registration['kind'][] = ['hook', 'extension', 'contributor'];

function liveOwnedCount(api: Any): number {
  return (api._registrations as Registration[]).filter(
    (r) => r.live && PLUGIN_OWNED.includes(r.kind),
  ).length;
}

const plugins = await Promise.all(
  OFFICIAL_PLUGIN_SPECIFIERS.map(async (spec) => {
    const name = spec.replace('@wrongstack/plugins/', '');
    const mod = (await import(`../src/${name}/index.ts`)) as { default: Any };
    return [name, mod.default] as const;
  }),
);

describe('setup() is idempotent for every official plugin', () => {
  // The reload case runs four setup() passes per plugin (60+ plugins), and
  // the test-runner-gate plugin spawns a process per pass — ~3.5s in
  // isolation, routinely over the 5s default when the workspace suite runs
  // packages in parallel. The extra headroom prevents a deterministic test
  // from flaking under load (verified: passes in isolation every time).
  it.each(plugins)(
    '%s does not stack registrations across reloads',
    { timeout: 15_000 },
    async (_name, plugin) => {
      const api = makeApi();

      await plugin.setup(api, { signal: new AbortController().signal });
      const afterFirst = liveOwnedCount(api);

      // Three more reloads without an intervening teardown.
      for (let i = 0; i < 3; i++) {
        await plugin.setup(api, { signal: new AbortController().signal });
      }

      expect(liveOwnedCount(api)).toBe(afterFirst);
      await plugin.teardown?.(api, { signal: new AbortController().signal });
    },
  );

  it.each(plugins)('%s releases its own registrations on teardown', async (_name, plugin) => {
    const api = makeApi();
    await plugin.setup(api, { signal: new AbortController().signal });
    await plugin.teardown?.(api, { signal: new AbortController().signal });
    expect(liveOwnedCount(api)).toBe(0);
  });

  it('covers the whole official roster', () => {
    // Guard against the list silently shrinking.
    expect(plugins.length).toBe(OFFICIAL_PLUGIN_SPECIFIERS.length);
    expect(plugins.length).toBeGreaterThan(60);
  });

  it('the stub itself reports stacking when nothing unregisters', () => {
    // Sanity check: if a plugin never released anything, the assertion
    // above would actually catch it.
    const api = makeApi();
    const off1 = api.registerHook();
    api.registerHook();
    expect(liveCount(api)).toBe(2);
    off1();
    expect(liveCount(api)).toBe(1);
  });
});
