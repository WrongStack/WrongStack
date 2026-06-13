// PR 3 of Issue #29: extract the PathResolver + EventBus + container
// setup block (the 49 lines that ran between `runPreflight()` and
// the modeId/modelCapabilities resolution) into a separate file.
//
// Why this split:
//
//   - The wiring is order-sensitive: PathResolver and EventBus are
//     stand-alone, but `createDefaultContainer({...})` consumes them
//     and must come *after* both. Pulling the wiring into a single
//     `wireContainer()` call makes the order explicit and reviewable
//     in one place, instead of being scattered across the middle of
//     the 2,300-line main() body.
//
//   - The wiring is also pretty much the *only* place that uses
//     `@wrongstack/runtime`'s `createDefaultContainer` factory.
//     Collapsing it into a 25-line helper means future readers
//     don't have to know the runtime API surface to follow the
//     boot sequence; they just see `wireContainer(...)`.
//
//   - The `container.bind(TOKENS.X, ...)` calls (ConfigStore,
//     PathResolver, Renderer, InputReader) are bootstrap-level
//     "overrides" on top of `createDefaultContainer`'s defaults.
//     Inlining them into the helper means a future change to the
//     bootstrap bindings (e.g. swapping the Renderer for a stub in
//     tests) only needs to touch one file.
//
// What is *not* in this helper:
//
//   - The replay wiring. That block is a `flags['replay']` /
//     `flags['record']` check, not a container-binding step, and
//     moving it in here would force the helper to know about CLI
//     flags. It's slated for a separate PR (boot/replay.ts or
//     similar) that the cli-main refactor issue #29 will track.
//
//   - The modeId/modelCapabilities resolution. That comes *after*
//     the container is wired, and depends on the resolved
//     container's services. It will land in a follow-up PR
//     (system-prompt.ts or similar).

import type { Config, EventBus, Logger, Renderer, ModelsRegistry, WstackPaths } from '@wrongstack/core';
import { DefaultPathResolver, EventBus as CoreEventBus, TOKENS } from '@wrongstack/core';
import { createDefaultContainer } from '@wrongstack/runtime';
import { makePromptDelegate } from '../permission-prompt.js';
import { resolveBundledSkillsDir } from '../cli-bundled-skills.js';

export interface WireContainerDeps {
  config: Config;
  wpaths: WstackPaths;
  cwd: string;
  logger: Logger;
  reader: Parameters<typeof makePromptDelegate>[0];
  renderer: Renderer;
  modelsRegistry: ModelsRegistry;
  yoloDestructive: boolean;
  confirmDestructive: boolean;
}

/**
 * Build the PathResolver, create the EventBus, call
 * `createDefaultContainer(...)`, then bind the bootstrap-level
 * services (PathResolver, Renderer, InputReader) on top.
 * Returns the new `events` bus alongside the container so main()
 * can keep publishing to it without re-creating one.
 *
 * The function is intentionally synchronous: every input is a
 * plain value or an already-constructed object, so the boot
 * sequence doesn't fork on async here. Async work (e.g. loading
 * the bundled skills dir) happens inside `createDefaultContainer`
 * and is awaited by the caller.
 */
export function wireContainer(deps: WireContainerDeps): {
  pathResolver: InstanceType<typeof DefaultPathResolver>;
  events: EventBus;
  container: ReturnType<typeof createDefaultContainer>;
} {
  const pathResolver = new DefaultPathResolver(deps.cwd);
  const events = new CoreEventBus();
  events.setLogger(deps.logger);

  const container = createDefaultContainer({
    config: deps.config,
    wpaths: deps.wpaths,
    logger: deps.logger,
    modelsRegistry: deps.modelsRegistry,
    events,
    permission: {
      yolo: deps.config.yolo,
      yoloDestructive: deps.yoloDestructive,
      confirmDestructive: deps.confirmDestructive,
      promptDelegate: makePromptDelegate(deps.reader) as NonNullable<NonNullable<Parameters<typeof createDefaultContainer>[0]['permission']>['promptDelegate']>,
    },
    compactor: {
      preserveK: deps.config.context.preserveK,
      eliseThreshold: deps.config.context.eliseThreshold,
    },
    bundledSkillsDir: deps.config.features.skills ? resolveBundledSkillsDir() : undefined,
  });

  // Bootstrap-level overrides on top of `createDefaultContainer`'s
  // defaults. These are the services main() needs to inject *after*
  // the factory runs (the factory doesn't know about the CLI's
  // PathResolver, Renderer, or InputReader — those are constructed
  // by main() and passed in via `wireContainer`'s deps).
  container.bind(TOKENS.PathResolver, () => pathResolver);
  container.bind(TOKENS.Renderer, () => deps.renderer);
  container.bind(TOKENS.InputReader, () => deps.reader);

  return { pathResolver, events, container };
}
