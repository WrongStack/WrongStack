import { buildDirectorToolset, FLEET_ROSTER } from '@wrongstack/core/coordination';
import { ToolRegistry } from '@wrongstack/core/registry';
import { registerCanonicalHostTools } from '@wrongstack/runtime/tool-registration';
import { describe, expect, it } from 'vitest';
import { ensureDirectorAndAnnounce } from '../../src/wiring/director-announcement.js';

/**
 * Boot-time tool-surface contract.
 *
 * Two shipped regressions hid in the seam this file covers, and both were
 * invisible to the existing wiring tests because those mock the registry:
 *
 *   1. `define_subagent` was registered by BOTH the brain/orchestration phase
 *      and the Director's own toolset. `ToolRegistry.register` throws on a
 *      duplicate name, so every interactive boot — REPL, TUI, WebUI, SimpleUI —
 *      died with `Tool "define_subagent" already registered`.
 *
 *   2. Director tools were registered but never exposed. Below the `off`
 *      token-saving tier the registry carries an explicit direct-surface name
 *      set that is computed before the Director exists, so the whole fleet
 *      surface stayed out of every provider request.
 *
 * Both are only reachable with a REAL ToolRegistry driven through BOTH
 * registration phases, which is what this test does. A fake registry that
 * merely records calls cannot see either one.
 */
describe('boot tool surface', () => {
  /** Registry seeded exactly the way a default (`minimal` tier) host seeds it. */
  function seedCanonicalHost(): ToolRegistry {
    const registry = new ToolRegistry();
    registerCanonicalHostTools({
      registry,
      // `auto` resolves to `minimal` on any modern context window, so this is
      // the shipped default rather than an edge case.
      tier: 'minimal',
      memory: { enabled: false },
      nextSteps: { enabled: false },
    });
    return registry;
  }

  function makeArgs(registry: ToolRegistry) {
    const director = {
      setCheckpointState: () => undefined,
      tools: () => buildDirectorToolset({} as never, FLEET_ROSTER),
    };
    return {
      multiAgentHost: { ensureDirector: async () => director } as never,
      priorFleetState: undefined,
      renderer: { writeInfo: () => undefined },
      toolRegistry: registry,
      flags: {},
      fleetRoot: 'D:/fleet',
      manifestPath: 'D:/manifest',
      sharedScratchpadPath: 'D:/scratchpad',
      subagentSessionsRoot: 'D:/subagents',
    };
  }

  it('activates the Director without colliding with the canonical catalog', async () => {
    const registry = seedCanonicalHost();

    // The brain/orchestration phase runs first and marks `define_subagent` as
    // direct. Marking a not-yet-registered name is supported and is what lets
    // the Director own the single registration.
    registry.exposeToProvider('define_subagent');

    await expect(ensureDirectorAndAnnounce(makeArgs(registry))).resolves.not.toBeNull();
  });

  it('puts the fleet orchestration tools in front of the model', async () => {
    const registry = seedCanonicalHost();
    await ensureDirectorAndAnnounce(makeArgs(registry));

    const exposed = new Set(registry.listForProvider().map((tool) => tool.name));
    // A leader that cannot see these has the roster and no way to reach it.
    for (const name of ['spawn_subagent', 'assign_task', 'await_tasks', 'define_subagent']) {
      expect(registry.get(name), `${name} must be registered`).toBeDefined();
      expect(exposed.has(name), `${name} must reach the provider surface`).toBe(true);
    }
  });

  it('exposes every tool the Director registers, not a hand-maintained subset', async () => {
    const registry = seedCanonicalHost();
    await ensureDirectorAndAnnounce(makeArgs(registry));

    const exposed = new Set(registry.listForProvider().map((tool) => tool.name));
    const missing = buildDirectorToolset({} as never, FLEET_ROSTER)
      .map((tool) => tool.name)
      .filter((name) => !exposed.has(name));
    expect(missing).toEqual([]);
  });

  it('leaves the built-in tier surface alone', async () => {
    const registry = seedCanonicalHost();
    const before = registry.listForProvider().length;
    await ensureDirectorAndAnnounce(makeArgs(registry));

    const exposed = new Set(registry.listForProvider().map((tool) => tool.name));
    // Director activation widens the surface; it must not smuggle the tools the
    // tier deliberately withheld (`git`, `test`, the browser suite, …) back in.
    expect(registry.listForProvider().length).toBeGreaterThan(before);
    expect(exposed.has('browser_open')).toBe(false);
    expect(exposed.has('read')).toBe(true);
  });
});
