import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DefaultSystemPromptBuilder,
  type DefaultSystemPromptBuilderOptions,
  FallbackProfileManager,
} from '@wrongstack/core/agent';
import { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
// PR-C1 (66c4eb68): execution/ and infrastructure/ symbols come from the
// published subpaths now that types/index.ts no longer re-exports them.
import {
  buildRecoveryStrategies,
  createStrategyCompactor,
  DefaultErrorHandler,
  DefaultPromptLoader,
  DefaultRetryPolicy,
  DefaultSkillLoader,
} from '@wrongstack/core/execution';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { Container, type EventBus, TOKENS } from '@wrongstack/core/kernel';
import { DefaultModeStore } from '@wrongstack/core/models';
import {
  DefaultPermissionPolicy,
  DefaultSecretScrubber,
  DirectoryPermissionPolicy,
  validateDirectoryPolicy,
} from '@wrongstack/core/security';
import {
  DefaultConfigStore,
  DefaultSessionStore,
  getSessionRegistry,
} from '@wrongstack/core/storage';
import type { Config, Logger, ModelsRegistry, Tool } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { createProjectSageMemoryPort, isSqliteAvailable } from '@wrongstack/sage';

export interface CreateContainerOptions {
  config: Config;
  wpaths: WstackPaths;
  logger: Logger;
  modelsRegistry: ModelsRegistry;
  /**
   * Optional event bus — passed to SageStore so plugins and
   * subsystems can react to memory mutations in real time.
   */
  events?: EventBus | undefined;
  permission?: {
    yolo?: boolean | undefined;
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
  const fallbackProfileManager = new FallbackProfileManager(config);
  configStore.watch((next) => fallbackProfileManager.reload(next as Config));
  container.bind(TOKENS.ConfigStore, () => configStore);
  container.bind(TOKENS.FallbackProfileManager, () => fallbackProfileManager);
  // Shared (provider, model) health tracker. The leader's runtime wiring
  // (brain-and-orchestration.ts) constructs its own tracker and threads it
  // into MultiAgentHostOptions; the runtime container ships a default so
  // makeLightSubagentFactory's fallback extension has something to write
  // into when webui-server boots standalone. The CLI factory passes a
  // separate leader-owned instance; the tracker singleton pattern is
  // contractually the same. Without this binding, light-factory subagents
  // (e.g. SDD parallel runs) silently no-op the 429 → waiting-room trigger
  // on the first rate-limit burst — see SAGE memory
  // 01KYSCC8A49TS9ENCVCS2J3WJ8 for the parallel gap to the CLI factory.
  container.bind(TOKENS.ProviderModelStatusTracker, () => new ProviderModelStatusTracker());
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
    () =>
      new DefaultTokenCounter({
        registry: modelsRegistry,
        providerId: config.provider,
        events: opts.events,
      }),
  );

  const modeStore = new DefaultModeStore({ directory: wpaths.configDir });
  container.bind(TOKENS.ModeStore, () => modeStore);
  container.bind(
    TOKENS.SessionStore,
    () =>
      new DefaultSessionStore({
        dir: wpaths.projectSessions,
        projectRoot: wpaths.projectRoot,
        logger,
        // Scrub secrets out of persisted user/model turns (F-06). Tool output
        // is already scrubbed by the executor.
        secretScrubber: container.resolve(TOKENS.SecretScrubber),
        // Cross-process guard consulted by delete(): refuses to remove a
        // session that a LIVE terminal/TUI/WebUI in this project is using.
        isSessionInUse: async (sessionId) => {
          try {
            const registry = getSessionRegistry(wpaths.globalRoot);
            const live = await registry.listByProject(wpaths.projectSlug);
            const hit = live.find((e) => e.sessionId === sessionId);
            if (hit) {
              return `active in ${hit.projectName} (PID ${hit.pid})`;
            }
          } catch {
            // Registry failures must not make the session store unavailable.
          }
          return null;
        },
      }),
  );

  // Single memory backend: SAGE is the only store. `Sage.enabled`
  // no longer swaps the backend — it only gates automatic context injection and
  // session-end hygiene (see wiring/sage.ts). This guarantees "one memory
  // system, no other" across TUI, slash commands, agent tools, and WebUI.
  //
  // The project SAGE server is the sole production owner of SQLite. Legacy
  // JSONL data is imported by that owner on first open; hosts only hold IPC
  // ports and cannot silently open a competing writable backend.
  if (!isSqliteAvailable()) {
    throw new Error(
      'SAGE requires synchronous SQLite (node:sqlite on Node >= 22.5 or bun:sqlite on Bun). ' +
        'The JSONL compatibility fallback has been removed.',
    );
  }
  const memoryStore = createProjectSageMemoryPort({
    projectRoot: wpaths.projectRoot,
    directory: config.Sage?.storage?.directory,
    events: opts.events,
    workspaceRoot: wpaths.projectRoot,
  });
  container.bind(TOKENS.MemoryStore, () => memoryStore);
  container.bind(TOKENS.MemoryPort, () => memoryStore);

  const skillLoader = new DefaultSkillLoader({
    paths: wpaths,
    bundledDir: opts.bundledSkillsDir,
    readClaudeSkills: config.skills?.readClaudeSkills,
    foreignSources: config.skills?.foreignSources,
    extraDirs: config.skills?.extraDirs,
  });
  container.bind(TOKENS.SkillLoader, () => skillLoader);

  const promptLoader = new DefaultPromptLoader({
    paths: wpaths,
    bundledDir: opts.bundledPromptsDir,
  });
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
          skillMode: config.skills?.mode,
          skillEagerMaxChars: config.skills?.eagerMaxChars,
          // SAGE's turn middleware owns memory injection — don't also
          // inject a static prompt section. Callers may override via
          // opts.systemPrompt if they truly want the static section.
          injectMemory: false,
          ...opts.systemPrompt,
        }),
    );
  }

  const directoryPolicyPath = path.join(wpaths.projectRoot, '.wrongstack', 'directory-rules.json');
  let directoryPolicy: ConstructorParameters<typeof DirectoryPermissionPolicy>[1]['policy'] = {
    schemaVersion: 1,
    rules: [],
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(directoryPolicyPath, 'utf8')) as unknown;
    const validation = validateDirectoryPolicy(parsed);
    if (!validation.ok) {
      throw new Error(
        validation.diagnostics
          .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
          .join('; '),
      );
    }
    directoryPolicy = validation.policy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `Invalid directory permission policy at ${directoryPolicyPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  container.bind(TOKENS.PermissionPolicy, () => {
    const policyOptions: ConstructorParameters<typeof DefaultPermissionPolicy>[0] = {
      trustFile: wpaths.projectTrust,
      yolo: opts.permission?.yolo ?? false,
    };
    if (opts.permission?.promptDelegate !== undefined) {
      policyOptions.promptDelegate = opts.permission.promptDelegate;
    }
    return new DirectoryPermissionPolicy(new DefaultPermissionPolicy(policyOptions), {
      policy: directoryPolicy,
    });
  });

  container.bind(TOKENS.Compactor, () =>
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
