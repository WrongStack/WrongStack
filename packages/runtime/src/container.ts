import {
  type Config,
  Container,
  DefaultConfigStore,
  DefaultErrorHandler,
  DefaultMemoryStore,
  DefaultModeStore,
  DefaultPermissionPolicy,
  DefaultRetryPolicy,
  DefaultPromptLoader,
  DefaultSecretScrubber,
  DefaultSessionStore,
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  DefaultTokenCounter,
  type EventBus,
  createStrategyCompactor,
  buildRecoveryStrategies,
  type Logger,
  type ModelsRegistry,
  TOKENS,
  type Tool,
  type WstackPaths,
} from '@wrongstack/core';
import type { DefaultSystemPromptBuilderOptions } from '@wrongstack/core';

export interface CreateContainerOptions {
  config: Config;
  wpaths: WstackPaths;
  logger: Logger;
  modelsRegistry: ModelsRegistry;
  /**
   * Optional event bus — passed to DefaultMemoryStore so plugins and
   * subsystems can react to memory mutations in real time.
   */
  events?: EventBus | undefined;
  permission?: {
    yolo?: boolean | undefined;
    yoloDestructive?: boolean | undefined;
    /** @deprecated Use `yoloDestructive`. */
    forceAllYolo?: boolean | undefined;
    /** When true, destructive ops prompt even in YOLO mode. */
    confirmDestructive?: boolean | undefined;
    promptDelegate?: (
      tool: Tool,
      input: unknown,
      suggestedPattern: string,
    ) => Promise<'yes' | 'no' | 'always' | 'deny'>;
  };
  compactor?: { preserveK?: number | undefined; eliseThreshold?: number | undefined };
  systemPrompt?: Partial<DefaultSystemPromptBuilderOptions> | undefined;
  /** Bundled skills directory path (resolved at boot time). */
  bundledSkillsDir?: string | undefined;
  /** Bundled prompt dataset directory path (`<core>/data/prompts`, resolved at boot). */
  bundledPromptsDir?: string | undefined;
}

/**
 * Create a Container pre-bound with all default service implementations.
 * Both CLI and WebUI use this factory so container wiring stays in one place.
 */
export function createDefaultContainer(opts: CreateContainerOptions): Container {
  const { config, wpaths, logger, modelsRegistry } = opts;
  const container = new Container();

  const configStore = new DefaultConfigStore(config);
  container.bind(TOKENS.ConfigStore, () => configStore);
  container.bind(TOKENS.Logger, () => logger);
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  // Wire the compactor into the recovery chain so a 413 / context-overflow
  // response can shed tokens and retry. Without an explicit compactor the
  // default `context_overflow_reduce` strategy is a no-op. The Compactor
  // binding is resolved lazily (it is registered further below).
  container.bind(
    TOKENS.ErrorHandler,
    () =>
      new DefaultErrorHandler(
        buildRecoveryStrategies({
          compactor: container.resolve(TOKENS.Compactor),
          modelsRegistry,
          getConfig: () => configStore.get(),
        }),
      ),
  );
  container.bind(TOKENS.ModelsRegistry, () => modelsRegistry);
  container.bind(
    TOKENS.TokenCounter,
    () => new DefaultTokenCounter({ registry: modelsRegistry, providerId: config.provider, events: opts.events }),
  );

  const modeStore = new DefaultModeStore({ directory: wpaths.configDir });
  container.bind(TOKENS.ModeStore, () => modeStore);
  container.bind(
    TOKENS.SessionStore,
    () =>
      new DefaultSessionStore({
        dir: wpaths.projectSessions,
        // Scrub secrets out of persisted user/model turns (F-06). Tool output
        // is already scrubbed by the executor.
        secretScrubber: container.resolve(TOKENS.SecretScrubber),
      }),
  );

  const memoryStore = new DefaultMemoryStore({ paths: wpaths, events: opts.events });
  container.bind(TOKENS.MemoryStore, () => memoryStore);

  const skillLoader = new DefaultSkillLoader({ paths: wpaths, bundledDir: opts.bundledSkillsDir });
  container.bind(TOKENS.SkillLoader, () => skillLoader);

  const promptLoader = new DefaultPromptLoader({ paths: wpaths, bundledDir: opts.bundledPromptsDir });
  container.bind(TOKENS.PromptLoader, () => promptLoader);

  if (opts.systemPrompt) {
    container.bind(
      TOKENS.SystemPromptBuilder,
      () =>
        new DefaultSystemPromptBuilder({
          instructionPaths: {
            globalDir: wpaths.globalInstructions,
            projectDir: wpaths.inProjectInstructions,
          },
          ...(opts.systemPrompt as DefaultSystemPromptBuilderOptions),
        }),
    );
  }

  container.bind(
    TOKENS.PermissionPolicy,
    () => {
      const policyOptions: ConstructorParameters<typeof DefaultPermissionPolicy>[0] = {
        trustFile: wpaths.projectTrust,
        yolo: opts.permission?.yolo ?? false,
        yoloDestructive: opts.permission?.yoloDestructive ?? opts.permission?.forceAllYolo ?? false,
        confirmDestructive: opts.permission?.confirmDestructive ?? false,
      };
      if (opts.permission?.promptDelegate !== undefined) {
        policyOptions.promptDelegate = opts.permission.promptDelegate;
      }
      return new DefaultPermissionPolicy(policyOptions);
    },
  );

  container.bind(
    TOKENS.Compactor,
    () =>
      // Strategy comes from config.context.strategy: 'hybrid' (default, lossless
      // rules, no LLM), 'intelligent' (LLM summarization), or 'selective'
      // (LLM-driven selection). The LLM strategies resolve their provider from
      // ctx at compact()-time, so binding here (before context.provider exists)
      // is safe. preserveK / eliseThreshold are class-level fallbacks; the active
      // ContextWindowPolicy in ctx.meta normally overrides both at runtime.
      // eliseThreshold is a TOKEN COUNT — a previous value of 0.7 elided
      // essentially every tool_result (anything > 1 token).
      createStrategyCompactor({
        strategy: config.context?.strategy,
        preserveK: opts.compactor?.preserveK ?? 10,
        eliseThreshold: opts.compactor?.eliseThreshold ?? 2000,
        smart: true,
        summarizerModel: config.context?.summarizerModel,
        llmSelector: config.context?.llmSelector,
      }),
  );

  return container;
}
