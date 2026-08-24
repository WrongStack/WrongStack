/**
 * WebUI dispatch — extracted from the tail of `execute()`.
 *
 * PR 6 of Issue #29 (partial). The TUI-vs-REPL-vs-WebUI fork at the
 * end of `execute()` is a ~1,600-line `if/else if/else if/else`
 * chain. The WebUI branch is the most self-contained of the four: it
 * constructs a `runWebUI` options object from already-available deps,
 * wires SIGINT handling, and returns an exit code. Extracting it
 * first lets `execute()` shrink by ~100 lines and isolates the
 * WebUI-specific wiring (port resolution, browser banner and autonomy
 * forwarding) in a single named module.
 *
 * The TUI branch (~1,388 lines) and the single-shot branch are left
 * inline — they are too deeply coupled to local mutable state for a
 * single-PR extraction.
 */
import * as path from 'node:path';
import type { Agent } from '@wrongstack/core/agent';
import type { BrainArbiter } from '@wrongstack/core/coordination';
import type { JournalEntry } from '@wrongstack/core/goal';
import type { EventBus } from '@wrongstack/core/kernel';
import type {
  Config,
  MemoryPort,
  ModelsRegistry,
  ModeStore,
  SessionStore,
  SessionWriter,
  SkillLoader,
} from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import type { TerminalRenderer } from '../renderer.js';
import type { AutonomyMode } from '../services/autonomy-mode.js';
import { terminalLink, terminalText } from '../terminal-format.js';
import type { CliWebUIOptions } from '../webui-server-options.js';
import {
  WEBUI_SESSION_CHILD_CAPABILITIES,
  type WebuiSessionChildOptions,
  writeWebuiSessionChildError,
  writeWebuiSessionChildReady,
} from './webui-session-child.js';

export interface WebUIDispatchContext {
  agent: Agent;
  events: EventBus;
  statusTracker?: import('@wrongstack/core/coordination').ProviderModelStatusTracker | undefined;
  session: SessionWriter;
  config: Config;
  flags: Record<string, string | boolean>;
  projectRoot: string;
  globalConfigPath: string;
  /** Resolved profile config path: ~/.wrongstack/profiles/<activeProfile>/config.json */
  profileConfigPath: string;
  projectSessionsDir: string;
  modelsRegistry: ModelsRegistry;
  mcpRegistry: MCPRegistry;
  brain: BrainArbiter | undefined;
  brainSettings:
    | {
        maxAutoRisk: import('@wrongstack/core/execution').BrainAutoRisk;
        mode?: import('@wrongstack/core/coordination').BrainEscalationMode | undefined;
        poolLabels?: string[] | undefined;
        councilLabels?: string[] | undefined;
      }
    | undefined;
  getBrainLog:
    | (() => Array<{ at: number; kind: string; question: string; outcome: string }>)
    | undefined;
  /** Live-editable Brain config owner (brain.config.get/set WS handlers). */
  brainRuntime?: import('@wrongstack/core/execution').BrainRuntime | undefined;
  subscribeEternalIteration: ((fn: (entry: JournalEntry) => void) => () => void) | undefined;
  sessionStore: SessionStore | undefined;
  memoryStore: MemoryPort | undefined;
  /**
   * Optional vector-memory store. When provided, the four
   * `/api/vector-memory/{status,search,store,store/:id}` endpoints become
   * active on the embedded WebUI server. When omitted, the routes respond
   * with `{ enabled: false }` or 503 — the embedded WebUI stays on its
   * existing surface with zero behavior change.
   */
  getVectorMemoryStore?: (() => VectorMemoryStore | undefined) | undefined;
  /** Model cache directory for the vector-memory provider. */
  vectorMemoryModelCacheDir?: string | undefined;
  skillLoader: SkillLoader | undefined;
  promptLoader: import('@wrongstack/core/types').PromptLoader | undefined;
  modeStore: ModeStore | undefined;
  modeId: string | undefined;
  needsSetup: boolean | undefined;
  renderer: TerminalRenderer;
  onAutonomy: ((mode: AutonomyMode) => void) | undefined;
  applyLiveSettings?: ((settings: { yolo?: boolean }) => void) | undefined;
  onModelContextResolved?:
    | ((providerId: string, modelId: string, maxContext: number) => void)
    | undefined;
  activateSessionIdentity?:
    | ((
        sessionId: string,
        target?: import('../wiring/session-registry.js').SessionIdentityTarget,
      ) => Promise<void>)
    | undefined;
  rebindTodosCheckpoint?:
    | ((sessionId: string, sessionsDir?: string) => void | Promise<void>)
    | undefined;
  /** Read-only worker transcript snapshot used for browser refresh replay. */
  agentTranscripts?:
    | {
        getAllSessions(): import('@wrongstack/core/coordination').AgentVirtualSession[];
        loadSessionsFromDisk(): Promise<
          import('@wrongstack/core/coordination').AgentVirtualSession[]
        >;
      }
    | undefined;
  /**
   * Pre-computed update info from the CLI's preflight version check.
   * When present, surfaces (WebUI, SimpleUI) receive appVersion,
   * latestVersion, and updateAvailable fields in their session.start
   * payload to display an "update available" warning.
   */
  updateInfo?: import('../webui-server/session-start-payload.js').BootUpdateInfo | undefined;
  /** Per-task agent factory for the SDD wizard's multi-agent run. */
  sddSubagentFactory?: import('@wrongstack/core/coordination').AgentFactory | undefined;
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
  /** Live fleet budget for WebUI concurrency/spawn gauges (issue #323). */
  getFleetBudget?: CliWebUIOptions['getFleetBudget'];
  /** Internal one-session child launch metadata, when --webui-session-child is active. */
  webuiSessionChild?: WebuiSessionChildOptions | undefined;
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
    statusTracker,
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
    getVectorMemoryStore,
    vectorMemoryModelCacheDir,
    skillLoader,
    promptLoader,
    modeStore,
    modeId,
    needsSetup,
    renderer,
    onAutonomy,
    applyLiveSettings,
    onModelContextResolved,
    activateSessionIdentity,
    rebindTodosCheckpoint,
    agentTranscripts,
    sddSubagentFactory,
    onKanbanDispatch,
    getFleetBudget,
    webuiSessionChild,
  } = ctx;
  const isSessionChild = Boolean(webuiSessionChild);
  const isSimpleUi = !isSessionChild && flags['simpleui'] === true;

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
  let webuiPort: number;
  let webuiAccessToken: string | undefined;
  let webuiPublicUrl: string | undefined;
  let webuiPublicWsUrl: string | undefined;
  let webuiRequireToken: boolean;
  let frontendDistDir: string | undefined;
  try {
    webuiHost =
      webuiSessionChild?.host ??
      flagValue(['webui-host', 'host']) ??
      process.env['WEBUI_HOST'] ??
      process.env['WS_HOST'] ??
      '127.0.0.1';
    // HTTP and WebSocket upgrades share one listener. Keep the older
    // --http-port/--ws-port and environment names as aliases, but resolve
    // exactly one port so `--port` also controls the page users open.
    const defaultPort = isSimpleUi ? 3466 : 3456;
    webuiPort =
      webuiSessionChild?.port ??
      parsePort(
        flagValue(['webui-port', 'http-port', 'port', 'ws-port']) ??
          process.env['WEBUI_PORT'] ??
          process.env['PORT'] ??
          process.env['WS_PORT'],
        defaultPort,
        '--port',
      );
    webuiAccessToken =
      webuiSessionChild?.token ??
      flagValue(['webui-token']) ??
      process.env['WEBUI_TOKEN'] ??
      process.env['WEBUI_AUTH_TOKEN'];
    webuiPublicUrl =
      webuiSessionChild?.publicUrl ??
      flagValue(['webui-public-url', 'public-url']) ??
      process.env['WEBUI_PUBLIC_URL'];
    webuiPublicWsUrl =
      webuiSessionChild?.publicWsUrl ??
      flagValue(['webui-public-ws-url', 'public-ws-url']) ??
      process.env['WEBUI_PUBLIC_WS_URL'];
    webuiRequireToken =
      webuiSessionChild?.requireToken ??
      flagBoolean(['webui-require-token', 'require-token']) ??
      envFlag('WEBUI_REQUIRE_TOKEN');
    if (isSimpleUi) {
      const { ensureSimpleUiDistDir } = await import('../simpleui-dist.js');
      frontendDistDir = await ensureSimpleUiDistDir();
    }
  } catch (err) {
    if (webuiSessionChild) {
      await writeWebuiSessionChildError(webuiSessionChild.readyFile, {
        protocolVersion: webuiSessionChild.protocolVersion,
        runtimeId: webuiSessionChild.runtimeId,
        parentShellId: webuiSessionChild.parentShellId,
        phase: 'validate_args',
        recoverable: false,
        error: err,
      }).catch(() => undefined);
    }
    renderer.setSilent(false);
    renderer.writeInfo(color.red(`  ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  // The shared `setupSage` wiring owns the process-scoped `session.ended`
  // commit extractor for every dispatched surface. Do not duplicate it in
  // WebUI's per-session lifecycle or the same commits would be scanned twice.
  const webuiPromise = runWebUI({
    agent,
    events,
    statusTracker,
    session,
    surface: isSimpleUi ? 'simpleui' : 'webui',
    host: webuiHost,
    port: webuiPort,
    frontendDistDir,
    accessToken: webuiAccessToken,
    publicUrl: webuiPublicUrl,
    publicWsUrl: webuiPublicWsUrl,
    requireToken: webuiRequireToken,
    strictPort: webuiSessionChild?.strictPort,
    projectRoot,
    appConfig: config,
    open: webuiSessionChild ? false : !!flags.open,
    webuiSessionChild,
    agentTranscripts,
    hqAllowExec: flagBoolean(['hq-allow-exec']) ?? false,
    modelsRegistry,
    globalConfigPath,
    profileConfigPath: ctx.profileConfigPath,
    mcpRegistry,
    subscribeEternalIteration,
    sessionStore,
    ...(getFleetBudget ? { getFleetBudget } : {}),
    sessionsDir: projectSessionsDir,
    claimSession: activateSessionIdentity
      ? async (sessionId: string) => {
          const previousSessionId = agent.ctx.session?.id ?? session.id;
          await activateSessionIdentity(sessionId);
          return async () => activateSessionIdentity(previousSessionId);
        }
      : undefined,
    brain,
    brainSettings,
    brainRuntime,
    getBrainLog,
    onBeforeSessionTodosReplaced: (sessionId, sessionsDir) =>
      rebindTodosCheckpoint?.(sessionId, sessionsDir),
    onSessionSwapped: async (sessionId, target) => {
      if (target && activateSessionIdentity) {
        await activateSessionIdentity(sessionId, target);
      }
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
    updateInfo: ctx.updateInfo,
    onKanbanDispatch,
    getVectorMemoryStore,
    vectorMemoryModelCacheDir,
    // Print the "open this" banner only once the server is actually
    // listening, using the RESOLVED port. Requested ports auto-advance past
    // busy ports inside runWebUI, so a banner printed up-front lies whenever
    // the default when it is taken (a second instance, leftover socket).
    onListening: ({ httpPort, host, url, authToken }) => {
      if (webuiSessionChild) {
        void writeWebuiSessionChildReady(webuiSessionChild.readyFile, {
          type: 'webui.session_child.ready',
          protocolVersion: webuiSessionChild.protocolVersion,
          runtime: {
            role: 'session-child',
            runtimeId: webuiSessionChild.runtimeId,
            pid: process.pid,
            parentPid: webuiSessionChild.parentPid,
            parentShellId: webuiSessionChild.parentShellId,
            startedAt: new Date().toISOString(),
          },
          project: {
            projectRoot,
            workingDir: webuiSessionChild.workingDir,
            projectSlug: path.basename(projectRoot) || projectRoot,
            projectName: path.basename(projectRoot) || projectRoot,
          },
          session: {
            sessionId: session.id,
            created: !webuiSessionChild.resume,
            resumed: webuiSessionChild.resume,
            provider: config.provider,
            model: config.model,
          },
          endpoint: {
            surface: 'webui',
            host,
            httpPort,
            url,
            ...(webuiPublicUrl ? { publicUrl: webuiPublicUrl } : {}),
            ...(webuiPublicWsUrl ? { publicWsUrl: webuiPublicWsUrl } : {}),
            requireToken: webuiRequireToken,
            auth: authToken
              ? { scheme: 'registry-token', tokenPresent: true, token: authToken }
              : { scheme: 'none', tokenPresent: false },
          },
          registry: {
            webuiInstanceRegistered: true,
            sessionRegistered: true,
          },
          capabilities: [...WEBUI_SESSION_CHILD_CAPABILITIES],
        }).catch(() => undefined);
        return;
      }
      const surface = isSimpleUi ? 'SimpleUI' : 'WebUI';
      renderer.writeInfo(
        `  ✦ ${terminalText(surface, 'success', { bold: true })} ${terminalText('running →', 'muted')} ${terminalLink(url)}`,
      );
      renderer.writeInfo(
        `  ${terminalText(`Press Ctrl+C in this terminal to stop the ${surface} server.`, 'muted')}\n`,
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
    onWrongProxyPrefsChange: (payload: Record<string, unknown>) => {
      // Lazy import to keep the WS server's import graph free of the
      // probe's `setInterval` when the user never touches the toggle.
      void import('../wiring/proxy-wiring.js').then(({ applyWrongProxyPrefs }) =>
        applyWrongProxyPrefs(payload),
      );
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
        if (webuiSessionChild) {
          void writeWebuiSessionChildError(webuiSessionChild.readyFile, {
            protocolVersion: webuiSessionChild.protocolVersion,
            runtimeId: webuiSessionChild.runtimeId,
            parentShellId: webuiSessionChild.parentShellId,
            phase: 'start_server',
            recoverable: false,
            error: err,
          }).catch(() => undefined);
        }
        renderer.setSilent(false);
        // Report through the renderer, not console: `runWebUI` installs a
        // quiet console for the interactive surface, and a `console.debug`
        // here would be filtered out — a failed start would print nothing.
        renderer.writeInfo(
          color.red(
            `  ✗ ${isSimpleUi ? 'SimpleUI' : 'WebUI'} failed to start: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
        resolve(1);
      });
  });
  // Promisify `runWebUI` so `cli-main.ts` can `await` it. The
  // `session.ended` commit mining is owned by the shared `setupSage` wiring.
  return webuiExit;
}
