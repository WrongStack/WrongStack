import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  AttachmentStore,
  AutonomyStage,
  SkillLoader,
  TokenCounter,
  TokenSavingTier,
} from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { QueueStore } from '@wrongstack/core/storage';
import type { VisionAdapters } from '@wrongstack/runtime/vision';
import type { SddLifecycleResult, SddRunControl } from '@wrongstack/sdd';
import type { RunTuiSurfaceOptions } from './run-tui-surface-options.js';
import type { ResourceMenuId, ResourceMenuSnapshot } from './ui-contracts.js';

export interface RunTuiOptions extends RunTuiSurfaceOptions {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
  /** Shared loader used by the interactive `/skill` browser. */
  skillLoader?: SkillLoader | undefined;
  getResourceMenu?: ((id: ResourceMenuId) => Promise<ResourceMenuSnapshot>) | undefined;
  /** Host-owned mutable bridge for slash commands that need masked input. */
  secretInputController?:
    | {
        readSecret(prompt: string): Promise<string>;
        readText?(prompt: string): Promise<string>;
      }
    | undefined;
  attachments: AttachmentStore;
  events: EventBus;
  tokenCounter?: TokenCounter | undefined;
  visionAdapters?: VisionAdapters | undefined;
  /** Resolve current model vision support. Falls back to provider capability when omitted. */
  supportsVision?: (() => boolean | Promise<boolean>) | undefined;
  model: string;
  banner?: boolean | undefined;
  /** Persists the input queue across crashes; if omitted, the queue is in-memory only. */
  queueStore?: QueueStore | undefined;
  /**
   * The queue store of another session. With it, `/resume` brings that
   * session's queue along (the WebUI keeps its queue in the same file) and
   * leaves the previous session's on disk.
   */
  queueStoreFor?: ((sessionId: string) => QueueStore | undefined) | undefined;
  /**
   * Called with the queue's display texts (head first) on EVERY queue change
   * — enqueue, /queue delete, /queue clear, dequeue-for-delivery. The CLI
   * mirrors the snapshot onto the live agent Context (core's
   * setQueuedMessagesSnapshot) so a running agent learns what's waiting at
   * its next iteration boundary without the queue being delivered early.
   */
  onQueueChange?: ((items: string[]) => void) | undefined;
  /**
   * Background-delegation auto-wake controller (core
   * `LeaderAutoWakeController`). When present the TUI binds a wake port for
   * the foreground session and reports user runs / idle-after-run to it.
   */
  leaderAutoWake?: import('./app-props.js').TuiLeaderAutoWake | undefined;
  /** Surfaces the "⚠ YOLO" chip in the status bar. */
  yolo?: boolean | undefined;
  /** Query live YOLO state from the permission policy. */
  getYolo?: (() => boolean) | undefined;
  /** Set live YOLO state from TUI-owned controls such as ConfirmPrompt. */
  onYolo?: ((enabled: boolean) => boolean) | undefined;
  /** Query the live autonomy mode. */
  getAutonomy?: (() => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') | undefined;
  /**
   * Access the eternal-autonomy engine. When autonomy mode flips to
   * 'eternal' the TUI drives `runOneIteration()` from the post-slash hook
   * so the engine and TUI never race for the shared Context.
   */
  getEternalEngine?:
    | (() => import('@wrongstack/core/execution').EternalAutonomyEngine | null)
    | undefined;
  /**
   * Access the parallel-eternal engine. When autonomy mode flips to
   * 'eternal-parallel' the TUI drives `runOneIteration()` from the post-slash
   * hook so the engine and TUI never race for the shared Context.
   */
  getParallelEngine?:
    | (() => import('@wrongstack/core/coordination').ParallelEternalEngine | null)
    | undefined;
  /**
   * Access the active SDD parallel run's control surface (or null). The TUI's
   * SIGINT handler uses it to stop a running `/sdd parallel` on the first Ctrl+C.
   */
  getSddRun?: (() => SddRunControl | null) | undefined;
  /**
   * Apply a post-run SDD lifecycle op (clean / rollback / destroy) from the host.
   * Drives the board overlay keys c / z / x so they work after the run ends.
   */
  onSddLifecycle?:
    | ((
        op: 'cleanup_worktrees' | 'rollback' | 'destroy',
        opts?: { revertMerged?: boolean },
      ) => Promise<SddLifecycleResult>)
    | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal engine.
   * Returns an unsubscribe function. TUI uses this to render each
   * iteration as a live timeline entry as it lands.
   */
  subscribeEternalIteration?:
    | ((fn: (entry: import('@wrongstack/goal').JournalEntry) => void) => () => void)
    | undefined;
  /**
   * Subscribe to per-iteration stage transitions from the autonomy engines.
   * TUI uses this to render live status in the status bar.
   */
  subscribeEternalStage?: ((fn: (stage: AutonomyStage) => void) => () => void) | undefined;
  /** Renders in the startup banner. Read from the CLI's package.json. */
  appVersion?: string | undefined;
  /** Provider id for the startup banner ("openai", "anthropic", ...). */
  provider?: string | undefined;
  /** Wire family — shown beneath provider in the banner. */
  family?: string | undefined;
  /** Last 3 chars of the active API key — shown in the banner for visual key-pick verification. */
  keyTail?: string | undefined;
  /** Active fallback profile name, shown in the banner (e.g. "default"). */
  profile?: string | undefined;
  /** Absolute path to the active profile's config.json
   *  (e.g. "~/.wrongstack/profiles/default/config.json"). When present,
   *  the banner shows the full path with the profile name highlighted,
   *  instead of the bare {@link profile} string. */
  profileConfigPath?: string | undefined;
  /** Background autonomy agents to display in the banner (Brain, Shadow,
   *  Kanban, Mailbox, Memory, etc.). Read from the mailbox at boot. */
  autonomyAgents?: import('./components/history/types.js').AutonomyAgentStatus[] | undefined;
  /** Latest version published to the npm registry (drives the
   *  "update available" indicator next to the banner version chip).
   *  Sourced from the CLI's preflight update-check. */
  latestVersion?: string | undefined;
  /** True when the preflight update-check found a newer version than
   *  {@link appVersion}. The banner renders `(update available)` next to
   *  the version chip when this is true, so users notice without having
   *  to read the stderr notice. */
  updateAvailable?: boolean | undefined;
  /**
   * The standalone executable's background update: called with the version
   * once it is downloaded, verified and waiting to be swapped in when this
   * session exits. The status bar's version chip then says so.
   */
  subscribeUpdateReady?: ((listener: (version: string) => void) => () => void) | undefined;
  /** Snapshot of keyed providers + their model lists for the `/model` picker. Async — the catalog fetch may need to hit disk/network. */
  getPickableProviders?:
    | (() => Promise<import('./components/model-picker.js').ProviderOption[]>)
    | undefined;
  /** Apply a (provider, model) pair after the picker confirms. Returns an error string on failure. */
  switchProviderAndModel?:
    | ((providerId: string, modelId: string) => string | null | Promise<string | null>)
    | undefined;
  /** Apply an autonomy mode after the picker confirms. Returns an error string on failure. */
  switchAutonomy?:
    | ((mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => string | null)
    | undefined;
  /**
   * Model-specific maxContext (tokens), resolved by the CLI via the
   * ModelsRegistry. When omitted, the TUI falls back to the provider's
   * reported window, which is 0 (unknown) until the catalog resolves one.
   * The status bar's context chip uses this for its progress denominator.
   */
  effectiveMaxContext?: number | undefined;
  /** Absolute project root for goal.json loading. */
  projectRoot?: string | undefined;
  /** Full app config, used for HQ client publishing settings. */
  appConfig?: import('@wrongstack/contracts/types').Config | undefined;
  /**
   * The embedding host already owns the HQ publisher and telemetry bridges.
   * Prevents this UI surface from opening a duplicate heartbeat-only client.
   */
  hqTelemetryOwnedExternally?: boolean | undefined;

  /**
   * Terminal title animation on/off. Defaults to true. When false, the
   * OSC-0 window/tab title stays static (the app name only, no spinner).
   * Controlled via /settings → Terminal title animation.
   */
  titleAnimation?: boolean | undefined;
  /** Play terminal bell (\\x07) when agent run completes. */
  chime?: boolean | undefined;
  /**
   * Enable full terminal mouse interaction (SGR drag + clickable UI). The TUI
   * runs in the alternate screen and always owns plain wheel reports for its
   * bounded chat viewport; this option additionally enables pointer dragging
   * and app chrome clicks. Off by default; opt in here or via
   * WRONGSTACK_MOUSE=1. See mouse.ts for the trade-off rationale.
   */
  mouse?: boolean | undefined;
  /** Show "confirm exit" message on first Ctrl+C instead of "exit". */
  confirmExit?: boolean | undefined;
  /** Active agent mode label shown in the status bar (e.g. "teach", "brief"). */
  modeLabel?: string | undefined;
  /** Token-saving tier — shown as a `💾 <tier>` chip in the TUI status bar (hidden when `'off'`). */
  tokenSavingMode?: TokenSavingTier | undefined;
  /** Number of registered tools — shown on the status bar line 2. */
  toolCount?: number | undefined;
  /** Live getter for the agent mode label so the status bar updates after /mode. */
  getModeLabel?: (() => string) | undefined;
  /**
   * Get all available agent modes with their names, descriptions, and the
   * currently active mode id. Used by the `/mode` picker in the TUI.
   */
  getModes?:
    | (() => Promise<{
        modes: import('@wrongstack/contracts/types').Mode[];
        activeId: string | null;
      }>)
    | undefined;
  /** Switch to a different agent mode by id (e.g. "teach", "brief"). */
  switchMode?: ((modeId: string) => Promise<string | null>) | undefined;
  /**
   * Called ONCE on mount by the App to install its debug-stream telemetry
   * callback. The CLI wires this to setDebugStreamCallback() from
   * @wrongstack/providers. On App unmount, the default stderr callback
   * is restored.
   */
  registerDebugStreamCallback?:
    | ((
        cb: (stats: {
          chunkCount: number;
          lastChunkSize: number;
          lastDeltaMs: number;
          totalBytes: number;
          lastChunkAt: string;
        }) => void,
      ) => void)
    | undefined;
  /** Called on App unmount — restores the default stderr debug-stream callback. */
  restoreDebugStreamCallback?: (() => void) | undefined;
  /** Called from /clear so the TUI can wipe its history entries while agent.ctx + memory are cleared separately. */
  onClearHistory?:
    | ((
        dispatch: React.Dispatch<
          | { type: 'clearHistory'; model?: string | undefined; provider?: string | undefined }
          | { type: 'resetContextChip' }
          | { type: 'streamReset' }
          | { type: 'toolStreamClear' }
        >,
      ) => void)
    | undefined;
}
