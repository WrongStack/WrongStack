/**
 * WebUI dispatch — extracted from the tail of `execute()`.
 *
 * PR 6 of Issue #29 (partial). The TUI-vs-REPL-vs-WebUI fork at the
 * end of `execute()` is a ~1,600-line `if/else if/else if/else`
 * chain. The WebUI branch is the most self-contained of the four: it
 * constructs a `runWebUI` options object from already-available deps,
 * wires SIGINT handling, and returns an exit code. Extracting it
 * first lets `execute()` shrink by ~100 lines and isolates the
 * WebUI-specific wiring (port resolution, browser banner, recovery
 * lock re-pointing, autonomy forwarding) in a single named module.
 *
 * The TUI branch (~1,388 lines) and the single-shot branch are left
 * inline — they are too deeply coupled to local mutable state for a
 * single-PR extraction.
 */
import type {
  Agent,
  BrainArbiter,
  Config,
  EventBus,
  JournalEntry,
  MemoryStore,
  ModelsRegistry,
  ModeStore,
  SessionStore,
  SessionWriter,
  SkillLoader,
} from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { TerminalRenderer } from '../renderer.js';
import type { AutonomyMode } from '../slash-commands/autonomy.js';

export interface WebUIDispatchContext {
  agent: Agent;
  events: EventBus;
  session: SessionWriter;
  config: Config;
  flags: Record<string, string | boolean>;
  projectRoot: string;
  globalConfigPath: string;
  projectSessionsDir: string;
  modelsRegistry: ModelsRegistry;
  mcpRegistry: MCPRegistry;
  brain: BrainArbiter | undefined;
  brainSettings:
    | {
        maxAutoRisk: import('@wrongstack/core').BrainAutoRisk;
        mode?: import('@wrongstack/core').BrainEscalationMode | undefined;
        poolLabels?: string[] | undefined;
        councilLabels?: string[] | undefined;
      }
    | undefined;
  getBrainLog:
    | (() => Array<{ at: number; kind: string; question: string; outcome: string }>)
    | undefined;
  /** Live-editable Brain config owner (brain.config.get/set WS handlers). */
  brainRuntime?: import('@wrongstack/core').BrainRuntime | undefined;
  subscribeEternalIteration: ((fn: (entry: JournalEntry) => void) => () => void) | undefined;
  sessionStore: SessionStore | undefined;
  memoryStore: MemoryStore | undefined;
  skillLoader: SkillLoader | undefined;
  promptLoader: import('@wrongstack/core').PromptLoader | undefined;
  modeStore: ModeStore | undefined;
  modeId: string | undefined;
  needsSetup: boolean | undefined;
  renderer: TerminalRenderer;
  onAutonomy: ((mode: AutonomyMode) => void) | undefined;
  applyLiveSettings?: ((settings: { yolo?: boolean }) => void) | undefined;
  onModelContextResolved?:
    | ((providerId: string, modelId: string, maxContext: number) => void)
    | undefined;
  activeRecoveryLock: {
    clear: () => Promise<void>;
    write: (sessionId: string) => Promise<void>;
  };
  /** Per-task agent factory for the SDD wizard's multi-agent run. */
  sddSubagentFactory?: import('@wrongstack/core').AgentFactory | undefined;
  onKanbanDispatch?:
    | ((
        description: string,
        opts?: {
          provider?: string | undefined;
          model?: string | undefined;
          fallbackModels?: string[] | undefined;
          fallbackProfile?: string | undefined;
          skills?: string[] | undefined;
          tools?: string[] | undefined;
          name?: string | undefined;
          allowedCapabilities?: readonly string[] | undefined;
          onDone?:
            | ((result: {
                status: 'completed' | 'failed';
                result?: string | undefined;
                error?: string | undefined;
              }) => void | Promise<void>)
            | undefined;
        },
      ) => Promise<string>)
    | undefined;
}

/**
 * Run the WebUI server and block until it shuts down.
 *
 * Returns the exit code: 0 on clean shutdown, 1 on server error.
 */
export async function runWebUIDispatch(ctx: WebUIDispatchContext): Promise<number> {
  const {
    agent,
    events,
    session,
    config,
    flags,
    projectRoot,
    globalConfigPath,
    projectSessionsDir,
    modelsRegistry,
    mcpRegistry,
    brain,
    brainSettings,
    brainRuntime,
    getBrainLog,
    subscribeEternalIteration,
    sessionStore,
    memoryStore,
    skillLoader,
    promptLoader,
    modeStore,
    modeId,
    needsSetup,
    renderer,
    onAutonomy,
    applyLiveSettings,
    onModelContextResolved,
    activeRecoveryLock,
    sddSubagentFactory,
    onKanbanDispatch,
  } = ctx;
  const isSimpleUi = flags['simpleui'] === true;

  // Route permission confirmations to the browser (tool.confirm_needed
  // events) instead of inline terminal prompts — runWebUI forwards them to
  // the WebUI and resolves on the client's tool.confirm_result. Without
  // this, approvals appear in the terminal even when you're driving the
  // agent from the browser.
  agent.disableInteractiveConfirmation();
  // Silence CLI rendering — WebUI owns the output surface. The writeInfo
  // calls below still flow (stderr), but streaming text/tool events are
  // suppressed so they don't appear in both the terminal and the browser.
  renderer.setSilent(true);
  const { runWebUI } = await import('../webui-server.js');

  const flagValue = (names: string[]): string | undefined => {
    for (const name of names) {
      if (!Object.hasOwn(flags, name)) continue;
      const value = flags[name];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      throw new Error(`--${name} requires a value`);
    }
    return undefined;
  };
  const flagBoolean = (names: string[]): boolean | undefined => {
    for (const name of names) {
      if (!Object.hasOwn(flags, name)) continue;
      const value = flags[name];
      if (value === undefined) continue;
      if (typeof value === 'boolean') return value;
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
      throw new Error(`--${name} must be a boolean value`);
    }
    return undefined;
  };
  const envFlag = (name: string): boolean => {
    const value = process.env[name]?.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
  };
  const parsePort = (value: string | undefined, fallback: number, label: string): number => {
    if (value === undefined) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`${label} must be a port between 1 and 65535`);
    }
    return parsed;
  };

  let webuiHost: string;
  let webuiHttpPort: number;
  let webuiWsPort: number;
  let webuiAccessToken: string | undefined;
  let webuiPublicUrl: string | undefined;
  let webuiPublicWsUrl: string | undefined;
  let webuiRequireToken: boolean;
  let frontendDistDir: string | undefined;
  try {
    webuiHost =
      flagValue(['webui-host', 'host']) ??
      process.env['WEBUI_HOST'] ??
      process.env['WS_HOST'] ??
      '127.0.0.1';
    webuiHttpPort = parsePort(
      flagValue(['webui-port', 'http-port']) ?? process.env['WEBUI_PORT'] ?? process.env['PORT'],
      3456,
      '--webui-port',
    );
    webuiWsPort = parsePort(
      flagValue(['ws-port']) ?? flagValue(['port']) ?? process.env['WS_PORT'],
      3457,
      '--ws-port',
    );
    webuiAccessToken =
      flagValue(['webui-token']) ?? process.env['WEBUI_TOKEN'] ?? process.env['WEBUI_AUTH_TOKEN'];
    webuiPublicUrl =
      flagValue(['webui-public-url', 'public-url']) ?? process.env['WEBUI_PUBLIC_URL'];
    webuiPublicWsUrl =
      flagValue(['webui-public-ws-url', 'public-ws-url']) ?? process.env['WEBUI_PUBLIC_WS_URL'];
    webuiRequireToken =
      flagBoolean(['webui-require-token', 'require-token']) ?? envFlag('WEBUI_REQUIRE_TOKEN');
    if (isSimpleUi) {
      const { resolveSimpleUiDistDir } = await import('../simpleui-dist.js');
      frontendDistDir = resolveSimpleUiDistDir();
    }
  } catch (err) {
    renderer.setSilent(false);
    renderer.writeInfo(color.red(`  ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  const webuiPromise = runWebUI({
    agent,
    events,
    session,
    host: webuiHost,
    port: webuiWsPort,
    httpPort: webuiHttpPort,
    frontendDistDir,
    accessToken: webuiAccessToken,
    publicUrl: webuiPublicUrl,
    publicWsUrl: webuiPublicWsUrl,
    requireToken: webuiRequireToken,
    projectRoot,
    appConfig: config,
    open: !!flags.open,
    hqAllowExec: flagBoolean(['hq-allow-exec']) ?? false,
    modelsRegistry,
    globalConfigPath,
    mcpRegistry,
    subscribeEternalIteration,
    sessionStore,
    sessionsDir: projectSessionsDir,
    brain,
    brainSettings,
    brainRuntime,
    getBrainLog,
    onSessionSwapped: (newSessionId: string) => {
      // Re-point crash recovery (active.json) at the resumed session —
      // otherwise a crash after an in-app resume would offer recovery
      // for the OLD (cleanly finalized) session and miss the live one.
      void activeRecoveryLock
        .clear()
        .then(() => activeRecoveryLock.write(newSessionId))
        .catch(() => undefined);
      void import('@wrongstack/tools/session-kanban').then(({ hydrateSessionKanban }) =>
        hydrateSessionKanban(agent.ctx),
      );
    },
    onModelContextResolved,
    memoryStore,
    skillLoader,
    promptLoader,
    modeStore,
    modeId,
    needsSetup,
    sddSubagentFactory,
    onKanbanDispatch,
    // Print the "open this" banner only once the server is actually
    // listening, using the RESOLVED ports. Requested ports auto-advance past
    // busy ports inside runWebUI, so a banner printed up-front lies whenever
    // 3456/3457 are taken (a second instance, leftover sockets).
    onListening: ({ url }) => {
      const surface = isSimpleUi ? 'SimpleUI' : 'WebUI';
      renderer.writeInfo(color.green(`  ✦ ${surface} running → ${color.bold(url)}`));
      renderer.writeInfo(
        color.dim(`  Press Ctrl+C in this terminal to stop the ${surface} server.\n`),
      );
    },
    // Make autonomy.switch from the browser flip the CLI's real
    // autonomy mode — context.meta alone never reaches the run loop.
    onAutonomySwitch: (mode: string) => {
      if (
        mode === 'off' ||
        mode === 'suggest' ||
        mode === 'auto' ||
        mode === 'eternal' ||
        mode === 'eternal-parallel'
      ) {
        onAutonomy?.(mode as AutonomyMode);
      }
    },
    onYoloSwitch: (enabled: boolean) => {
      applyLiveSettings?.({ yolo: enabled });
    },
  });
  // In --webui mode, skip the full REPL — just keep the process alive
  // until the WebUI server shuts down. The WebUI WS handler listens for
  // /exit or abort signals and resolves webuiPromise when the server stops.
  // The ready banner is printed from `onListening` above (with the resolved
  // ports), not here — printing it up-front with the requested port lied
  // whenever the port auto-advanced.
  const webuiExit = new Promise<number>((resolve) => {
    // SIGINT/SIGTERM handlers are owned by `runWebUI` itself (via
    // registerWebuiSignalHandlers + createWebuiShutdown, which does the
    // real teardown chain: abort in-flight runs → unsubscribe events →
    // close clients → unregister → close HTTP/WS → resolve). The dispatch
    // does NOT install its own SIGINT handlers — doing so races the
    // internal shutdown and was the source of the SIGINT bug where the
    // outer promise resolved with 0 immediately while the WebUI server
    // kept running until the parent process exited.
    webuiPromise
      .then(() => {
        renderer.setSilent(false);
        renderer.write('\n');
        renderer.writeInfo(
          color.yellow(`  Shutting down ${isSimpleUi ? 'SimpleUI' : 'WebUI'} server…`),
        );
        resolve(0);
      })
      .catch((err) => {
        renderer.setSilent(false);
        console.debug(`[execution] webui error: ${err}`);
        resolve(1);
      });
  });
  return webuiExit;
}
