import type {
  Agent,
  AttachmentStore,
  AutonomousCoordinator,
  CoordinatorEvent,
  Director,
  EventBus,
  Message,
  QueueStore,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { writeErr, type AutonomyStage, GlobalMailbox, createHqPublisherFromEnv, resolveProjectDir, wstackGlobalRoot } from '@wrongstack/core';
import type { VisionAdapters } from '@wrongstack/runtime/vision';
import { render } from 'ink';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import React from 'react';
import { App } from './app.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import { MOUSE_OFF } from './mouse.js';
import { startTerminalTitle } from './terminal-title.js';

// Re-export autonomy stage types from core for backward compatibility
export type { AutonomyStage };

export interface RunTuiOptions {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
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
   * Called with the queue's display texts (head first) on EVERY queue change
   * — enqueue, /queue delete, /queue clear, dequeue-for-delivery. The CLI
   * mirrors the snapshot onto the live agent Context (core's
   * setQueuedMessagesSnapshot) so a running agent learns what's waiting at
   * its next iteration boundary without the queue being delivered early.
   */
  onQueueChange?: ((items: string[]) => void) | undefined;
  /** Surfaces the "⚠ YOLO" chip in the status bar. */
  yolo?: boolean | undefined;
  /** Query live YOLO state from the permission policy. */
  getYolo?: (() => boolean) | undefined;
  /** Query the live autonomy mode. */
  getAutonomy?: (() => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') | undefined;
  /**
   * Access the eternal-autonomy engine. When autonomy mode flips to
   * 'eternal' the TUI drives `runOneIteration()` from the post-slash hook
   * so the engine and TUI never race for the shared Context.
   */
  getEternalEngine?: (() => import('@wrongstack/core').EternalAutonomyEngine | null) | undefined;
  /**
   * Access the parallel-eternal engine. When autonomy mode flips to
   * 'eternal-parallel' the TUI drives `runOneIteration()` from the post-slash
   * hook so the engine and TUI never race for the shared Context.
   */
  getParallelEngine?: (() => import('@wrongstack/core').ParallelEternalEngine | null) | undefined;
  /**
   * Access the active SDD parallel run's control surface (or null). The TUI's
   * SIGINT handler uses it to stop a running `/sdd parallel` on the first Ctrl+C.
   */
  getSddRun?: (() => import('@wrongstack/core').SddRunControl | null) | undefined;
  /**
   * Apply a post-run SDD lifecycle op (clean / rollback / destroy) from the host.
   * Drives the board overlay keys c / z / x so they work after the run ends.
   */
  onSddLifecycle?:
    | ((
        op: 'cleanup_worktrees' | 'rollback' | 'destroy',
        opts?: { revertMerged?: boolean },
      ) => Promise<import('@wrongstack/core').SddLifecycleResult>)
    | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal engine.
   * Returns an unsubscribe function. TUI uses this to render each
   * iteration as a live timeline entry as it lands.
   */
  subscribeEternalIteration?: ((
    fn: (entry: import('@wrongstack/core').JournalEntry) => void,
  ) => () => void) | undefined;
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
  /** Snapshot of keyed providers + their model lists for the `/model` picker. Async — the catalog fetch may need to hit disk/network. */
  getPickableProviders?: (() => Promise<import('./components/model-picker.js').ProviderOption[]>) | undefined;
  /** Apply a (provider, model) pair after the picker confirms. Returns an error string on failure. */
  switchProviderAndModel?:
    | ((providerId: string, modelId: string) => string | null | Promise<string | null>)
    | undefined;
  /** Apply an autonomy mode after the picker confirms. Returns an error string on failure. */
  switchAutonomy?: ((
    mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel',
  ) => string | null) | undefined;
  /**
   * Model-specific maxContext (tokens), resolved by the CLI via the
   * ModelsRegistry. When omitted, the TUI falls back to the provider
   * family's baseline (e.g. anthropic = 200_000), which can be wrong
   * for variants like the 1M-context Opus build. The status bar's
   * context chip uses this for its progress denominator.
   */
  effectiveMaxContext?: number | undefined;
  /** Absolute project root for goal.json loading. */
  projectRoot?: string | undefined;
  /** Full app config, used for HQ client publishing settings. */
  appConfig?: import('@wrongstack/core').Config | undefined;

  /**
   * Terminal title animation on/off. Defaults to true. When false, the
   * OSC-0 window/tab title stays static (the app name only, no spinner).
   * Controlled via /settings → Terminal title animation.
   */
  titleAnimation?: boolean | undefined;
  /** Play terminal bell (\\x07) when agent run completes. */
  chime?: boolean | undefined;
  /**
   * Enable terminal mouse tracking (SGR; click + wheel). Stays in the normal
   * screen buffer so native scrollback survives, BUT while tracking is on the
   * plain wheel reports to the app instead of scrolling history — only
   * Shift+wheel reaches native scrollback. Off by default; opt in here or via
   * WRONGSTACK_MOUSE=1. See mouse.ts for the trade-off rationale.
   */
  mouse?: boolean | undefined;
  /** Show "confirm exit" message on first Ctrl+C instead of "exit". */
  confirmExit?: boolean | undefined;
  /** Active agent mode label shown in the status bar (e.g. "teach", "brief"). */
  modeLabel?: string | undefined;
  /** Token-saving mode indicator — shown in the TUI status bar. */
  tokenSavingMode?: boolean | undefined;
  /** Number of registered tools — shown on the status bar line 2. */
  toolCount?: number | undefined;
  /** Live getter for the agent mode label so the status bar updates after /mode. */
  getModeLabel?: (() => string) | undefined;
  /**
   * Called ONCE on mount by the App to install its debug-stream telemetry
   * callback. The CLI wires this to setDebugStreamCallback() from
   * @wrongstack/providers. On App unmount, the default stderr callback
   * is restored.
   */
  registerDebugStreamCallback?: ((cb: (stats: {
    chunkCount: number;
    lastChunkSize: number;
    lastDeltaMs: number;
    totalBytes: number;
    lastChunkAt: string;
  }) => void) => void) | undefined;
  /** Called on App unmount — restores the default stderr debug-stream callback. */
  restoreDebugStreamCallback?: (() => void) | undefined;
  /** Called from /clear so the TUI can wipe its history entries while agent.ctx + memory are cleared separately. */
  onClearHistory?: ((
    dispatch: React.Dispatch<
      | { type: 'clearHistory' }
      | { type: 'resetContextChip' }
      | { type: 'streamReset' }
      | { type: 'toolStreamClear' }
    >,
  ) => void) | undefined;

  // --- Fleet surface (director mode) ---

  /**
   * Live director instance. When set, the TUI renders a fleet panel
   * showing every spawned subagent, its current task, streaming output,
   * and runtime cost — updated live from the FleetBus. Pass null or omit
   * when multi-agent / director mode is disabled.
   */
  director?: Director | null | undefined;
  /**
   * Optional roster reference for resolving subagent role ids to
   * human-readable names. Same value passed to director.tools().
   */
  fleetRoster?: Record<string, { name: string }> | undefined;
  /**
   * Shared controller for the `/fleet stream on|off` toggle. The slash
   * command runs in the CLI process and needs to flip TUI reducer state;
   * the App installs a dispatch-backed `setEnabled` here on mount so
   * both sides stay synchronized.
   */
  /**
   * Shared controller for the `/fleet stream on|off` toggle. The slash
   * command runs in the CLI process and needs to flip TUI reducer state;
   * the App installs a dispatch-backed `setEnabled` here on mount so
   * both sides stay synchronized.
   */
  fleetStreamController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  } | undefined;
  /**
   * Controller for the `/interrupt` slash command. The App installs the real
   * `abortLeader` on mount so the command can abort the in-flight leader run.
   */
  interruptController?:
    | {
        abortLeader: () => boolean;
      }
    | undefined;
  /**
   * Controller for the `/enhance on|off` prompt-refinement toggle. The App
   * installs a dispatch-backed `setEnabled` here on mount so the slash command
   * (run in the CLI process) flips the TUI's reducer flag. Mirrors
   * `fleetStreamController`.
   */
  enhanceController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  } | undefined;
  /**
   * Controller for status bar hidden items. App installs a dispatch-backed
   * setter on mount so the /statusline slash command can update the TUI's
   * visible bar without a round-trip. The initial value is loaded from
   * the config file before App mounts.
   */
  statuslineHiddenItems: StatuslineItem[];
  setStatuslineHiddenItems: (items: StatuslineItem[]) => void;
  /**
   * Atomically updates in-memory state AND persists to
   * ~/.wrongstack/statusline.json. Used by the statusline picker to
   * make each toggle immediately durable.
   */
  saveStatuslineHiddenItems: (items: StatuslineItem[]) => Promise<void>;
  /**
   * Controller for the agents monitor overlay. App installs a dispatch-backed
   * setter on mount so the `/agents on|off` slash command can toggle the
   * overlay without a round-trip.
   */
  agentsMonitorController?: {
    visible: boolean;
    setVisible: (visible: boolean) => void;
  } | undefined;
  /**
   * Mutable ref for opening TUI panels from slash commands. The slash commands
   * call `onPanelOpen.current(action)` to open panels. The App sets
   * `onPanelOpen.current` to its actual dispatch function on mount.
   */
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;

  /**
   * If set, the App boots straight into goal mode — the text is wrapped
   * in the GOAL preamble and submitted as the first turn. Lets users
   * launch directly from the shell:
   *   wstack --tui --director --goal "audit packages/core for races"
   * The chat shows a one-line "🎯 Goal locked: …" hint; the actual
   * preamble is hidden from the visible history (same as `/goal`).
   */
  initialGoal?: string | undefined;
  /**
   * If set, submitted as the first turn verbatim (no preamble). Mainly
   * for scripted shell aliases — `wstack --tui --ask "summarize foo.md"`
   * — that want one turn pre-populated without the goal-mode framing.
   * Ignored when `initialGoal` is also set.
   */
  initialAsk?: string | undefined;
  /**
   * Directory containing session JSONL files. Required for rewind
   * functionality. When provided the TUI can list checkpoints and
   * trigger a rewind via `/rewind` or Ctrl+R.
   */
  sessionsDir?: string | undefined;
  /** Live active session id for cross-surface client registration. */
  getSessionId?: (() => string | undefined) | undefined;
  /**
   * SDD session context getter. When an SDD session is active, returns
   * the AI prompt context to inject into user messages.
   */
  getSDDContext?: (() => Promise<string | null>) | undefined;
  /**
   * Process AI output for SDD auto-detection (spec, tasks, plan).
   * Returns displayable status messages.
   */
  onSDDOutput?: ((output: string) => Promise<string[]>) | undefined;
  /**
   * Subscribe to AutoPhase phase/graph events from the PhaseOrchestrator.
   * Returns an unsubscribe function. The TUI uses this to drive the
   * PhaseMonitor and PhasePanel live views via dispatch actions.
   */
  subscribeAutoPhase?: ((handler: (event: string, payload: unknown) => void) => () => void) | undefined;
  /**
   * Read the persisted autonomy settings (defaultMode, autoProceedDelayMs).
   * Used by the SettingsPicker in the TUI on mount and after Ctrl+S toggle.
   */
  getSettings?: (() => import('./app-state.js').Settings) | undefined;
  /**
   * Persist settings changes. Returns null on success, or an
   * error string on failure (so the TUI can display it as a hint).
   */
  saveSettings?: ((s: import('./app-state.js').Settings) =>
    | string
    | null
    | Promise<string | null>) | undefined;
  /**
   * Predict likely next steps after a completed turn. The CLI wires this from
   * the session provider and the `/next` toggle; it returns [] when prediction
   * is disabled or autonomy isn't 'off'. Display-only — never executed.
   */
  predictNext?: ((input: {
    userRequest: string;
    assistantSummary: string;
  }) => Promise<string[]>) | undefined;
  /**
   * Called after each agent turn with the assistant's final output text.
   * The host parses "💡 Next steps" suggestions from the text and stores
   * them in the shared suggestion store so `/next 1`, `/next 1 2 3` work.
   */
  onSuggestionsParsed?: ((finalText: string) => void) | undefined;
  /**
   * Retrieve current suggestions from the shared suggestion store.
   * Used by the TUI to display and auto-submit next steps in 'auto' mode.
   */
  getSuggestions?: (() => string[]) | undefined;
  /**
   * Retrieve current auto suggestions (items with auto="true" attribute).
   * Used by YOLO+auto mode for automatic next-step submission.
   */
  getAutoSuggestions?: (() => string[]) | undefined;
  /**
   * Autonomy next prompt template for YOLO+auto mode. Contains {{suggestion}} placeholder.
   */
  autonomyNextPrompt?: string | undefined;
  /**
   * Write parsed next steps into the shared suggestion store.
   * Called by the Entry component after parsing each assistant message
   * so /next 1 and the auto-submit countdown can access them.
   */
  setSuggestions?: ((steps: string[]) => void) | undefined;
  /**
   * Messages restored from a previous session. When provided (non-empty),
   * the TUI renders the prior conversation as history entries so a resumed
   * session shows its full chat context, not just the LLM's internal state.
   */
  restoredMessages?: Message[] | undefined;
  /**
   * Tool execution records from a previous session, keyed by tool_use id.
   * Used to render tool entries (name, duration, ok/error) in the TUI on
   * resume. Events are `tool_call_end` records from the session JSONL.
   */
  restoredToolCalls?: Array<{
    name: string;
    id: string;
    durationMs: number;
    ok: boolean;
    outputBytes?: number | undefined;
    outputTokens?: number | undefined;
    outputLines?: number | undefined;
  }> | undefined;

  /**
   * List recent session summaries for the /resume picker. The CLI reads
   * from the session store and returns ResumeSessionEntry-shaped data.
   */
  listSessions?: ((limit?: number) => Promise<import('./app-state.js').ResumeSessionEntry[]>) | undefined;

  /**
   * Resume a session by id: load JSONL events, replay history entries,
   * rebuild agent context, and return hydrated entries for the TUI to
   * display. Returns null when resume fails.
   */
  onResumeSession?: ((sessionId: string) => Promise<{
    entries: import('./components/history/types.js').HistoryEntry[];
    nextId: number;
    sessionId: string;
  } | null>) | undefined;

  // --- Project / Session switching ---
  getProjectPickerItems?: (() => Promise<import('./components/project-picker.js').ProjectPickerItem[]>) | undefined;
  onProjectSelect?: ((key: string, kind: 'project' | 'action') => void) | undefined;
  /**
   * Request the TUI to exit with a specific code. Used by the project picker
   * to trigger a clean exit before spawning a new wstack process in a different
   * project directory. The host CLI catches this exit code and performs the
   * actual project switch.
   */
  requestExit?: (code: number) => void;
  getLiveSessions?: (() => Promise<import('./components/sessions-panel.js').LiveSessionEntry[]>) | undefined;
  onSwitchToSession?: ((sessionId: string, projectRoot: string, projectName: string) => void) | undefined;
  /**
   * When true, the agents monitor (F3) is open by default at TUI startup.
   * Used by the `wrongstack quick` command to show agents panel immediately.
   */
  initialAgentsMonitorOpen?: boolean | undefined;

  // --- AutonomousCoordinator (project-level multi-session coordination) ---

  /**
   * Access the project-level AutonomousCoordinator instance. When set, the TUI
   * renders a coordination panel showing live goals, pending tasks, consensus
   * decisions, and shared knowledge from all active sessions. The coordinator
   * runs independently of the session — it coordinates multiple sessions.
   */
  getAutonomousCoordinator?: () => AutonomousCoordinator | null | undefined;
  /**
   * Subscribe to live events from the AutonomousCoordinator:
   * - `goal:added` — new coordination goal received
   * - `goal:completed` — goal finished successfully
   * - `goal:failed` — goal failed after max attempts
   * - `task:ready` — task's dependencies are satisfied, ready to execute
   * - `task:completed` — task finished
   * - `knowledge:added` — new shared fact published
   * - `consensus:reached` — multi-session agreement reached
   * Returns an unsubscribe function.
   */
  subscribeCoordinatorEvents?: (fn: (event: CoordinatorEvent) => void) => () => void;
  /**
   * Start the AutonomousCoordinator loop. Fire-and-forget — run() loops
   * asynchronously. Pass a goal string to begin decomposition and task
   * auction immediately.
   */
  onCoordinatorStart?: ((goal?: string) => void) | undefined;
  /** Stop the AutonomousCoordinator loop. */
  onCoordinatorStop?: (() => void) | undefined;
  /** List pending coordinator tasks claimable by this terminal. */
  onCoordinatorTasks?: (() => Promise<Array<{ id: string; title: string; priority: string; tags: string[] }> | null>) | undefined;
  /** Claim a coordinator task. Returns description on success. */
  onCoordinatorClaim?: ((taskId: string) => Promise<string | null | { description: string }>) | undefined;
  /** Mark a claimed task as completed. */
  onCoordinatorComplete?: ((taskId: string, result?: string) => Promise<string | null>) | undefined;
  /** Mark a claimed task as failed. */
  onCoordinatorFail?: ((taskId: string, error: string) => Promise<string | null>) | undefined;
  /** Get coordinator stats for status display. */
  onCoordinatorStatus?: (() => Promise<{
    goals: { total: number; done: number; pending: number; failed: number };
    dag: { running: number; ready: number; done: number; failed: number };
    auction: { pending: number; inProgress: number };
  } | null>) | undefined;
}

// Bracketed paste mode wraps any pasted text with these markers, letting us
// distinguish a paste from typed input even when chunks arrive identically.
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';

// ── Console / stderr / warning silencing ──────────────────────────────
// Ink owns the terminal while the TUI is running. Any write to stdout or
// stderr that doesn't go through Ink's render cycle will interleave with
// ANSI control sequences, causing visible content to jump from the bottom
// and corrupt the chat-history / input-area layout.
//
// What we silence:
//  1. console.log / warn / error / debug — 60+ sites across core + CLI
//     that bypass the DefaultLogger (which already suppresses stderr in
//     TUI mode). These fire during AutoPhase, session store, security
//     scanner, config loader, and plugin teardown.
//  2. process.emitWarning — used by Director, FleetManager, and
//     SpecBuilder for non-fatal warnings. Node writes these to stderr by
//     default. A no-op 'warning' listener swallows them.
//  3. process.stderr.write — the memory-consolidator writes a summary
//     line on every session close. Patching this is safe because Ink's
//     rendering goes through process.stdout, which we leave untouched.
//
// All silenced output is lost during TUI mode — it never reaches disk or
// memory. The DefaultLogger still writes structured logs to the log file
// even with stderr suppressed. For post-hoc debugging, check the log file
// at ~/.wrongstack/logs/<date>.log.
// ──────────────────────────────────────────────────────────────────────

const origConsoleLog = console.log;
const origConsoleWarn = console.warn;
const origConsoleError = console.error;
const origConsoleDebug = console.debug;
const origConsoleInfo = console.info;
const origConsoleTable = console.table;
const origConsoleTrace = console.trace;
const origStderrWrite = process.stderr.write.bind(process.stderr);

const consoleNoop = (..._args: unknown[]): void => {};
const stderrNoop = ((_chunk: string | Uint8Array, _encodingOrCb?: BufferEncoding | ((err?: Error) => void), _cb?: (err?: Error) => void): boolean => {
  // Preserve Node's callback contract so callers that pass a cb don't hang.
  // process.stderr.write has two overloads:
  //   write(buffer, cb?)          → second arg is a callback
  //   write(str, encoding?, cb?)  → second arg is encoding, third is callback
  if (typeof _encodingOrCb === 'function') _encodingOrCb();
  else if (typeof _cb === 'function') _cb();
  return true;
}) as typeof process.stderr.write;
const warningNoop = (_warning: Error): void => {};

export function silenceTerminal(): void {
  console.log = consoleNoop;
  console.warn = consoleNoop;
  console.error = consoleNoop;
  console.debug = consoleNoop;
  console.info = consoleNoop;
  console.table = consoleNoop;
  console.trace = consoleNoop;
  process.stderr.write = stderrNoop as typeof process.stderr.write;
  process.on('warning', warningNoop);
}

export function unsilenceTerminal(): void {
  console.log = origConsoleLog;
  console.warn = origConsoleWarn;
  console.error = origConsoleError;
  console.debug = origConsoleDebug;
  console.info = origConsoleInfo;
  console.table = origConsoleTable;
  console.trace = origConsoleTrace;
  process.stderr.write = origStderrWrite;
  process.off('warning', warningNoop);
}

export async function runTui(opts: RunTuiOptions): Promise<number> {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // Ink requires a TTY on both stdin and stdout. Without this guard the
  // render call would fail with a terse internal Ink error; bail with a
  // clear message so a piped invocation (`echo hi | wstack --tui`) tells
  // the user what to do instead.
  if (!stdout.isTTY || !stdin.isTTY) {
    writeErr(
      'wstack: --tui requires an interactive terminal on both stdin and stdout.\n' +
        '       Drop the flag (use the plain REPL) or run wstack directly without piping.\n',
    );
    return 2;
  }

  // Silence all console / stderr / process-warning output so external
  // writes don't interleave with Ink's terminal control sequences. See
  // the block comment above `silenceTerminal` for the full rationale.
  silenceTerminal();

  stdout.write(BRACKETED_PASTE_ON);

  // Resolve the global mouse-tracking opt-in. The App component owns the actual
  // enable/disable lifecycle (it also turns tracking on per-overlay); cleanup()
  // below sends MOUSE_OFF unconditionally so the terminal is never left
  // reporting mouse events after exit.
  const mouseEnabled =
    opts.mouse ?? opts.getSettings?.().mouseMode ?? process.env.WRONGSTACK_MOUSE === '1';

  // Clear the VISIBLE screen (not scrollback) before Ink's first paint. The
  // REPL boot output (provider banner, Director roster, fleet paths, recovery
  // prompts) typically fills the terminal, so without this Ink mounts with its
  // live region (input + status bar) jammed against the bottom edge. The first
  // post-mount re-render — async git/fleet/goal state landing a frame later —
  // then grows/shifts that region by a row or two, the terminal scrolls, and
  // the top of the live region (the `›` input row + status-bar border) is
  // stranded permanently in scrollback (the "two prompts on launch" bug).
  // \x1b[2J scrolls the boot output up into native scrollback (still reachable
  // with the mouse wheel / Shift+PgUp), \x1b[H homes the cursor so Ink starts
  // from a clean top-of-screen with a full screen of headroom below it.
  stdout.write('\x1b[2J\x1b[H');

  const inkStdin: NodeJS.ReadStream = stdin;

  // Animated window/tab title: a braille spinner + live status (thinking /
  // running a tool) driven by the EventBus, scrolling the app name when idle.
  // Out-of-band OSC sequence, so it never touches Ink's render. Reset on
  // cleanup(). Disabled when WRONGSTACK_NO_TITLE=1 (handled inside
  // startTerminalTitle) or titleAnimation is false.
  //
  // Wrapped in a small start/stop controller (idempotent) so the TUI
  // `/settings` picker can toggle the title animation live without a restart.
  let titleStop: (() => void) | null = null;
  const startTitle = () => {
    if (titleStop) return; // already running
    titleStop = startTerminalTitle({
      stdout,
      events: opts.events,
      model: opts.model,
      appName: opts.projectRoot ? path.basename(opts.projectRoot) : undefined,
    });
  };
  const stopTitle = () => {
    try {
      titleStop?.();
    } catch {
      // title controller already torn down — ignore.
    }
    titleStop = null;
  };
  const titleController = {
    setEnabled(on: boolean) {
      if (on) startTitle();
      else stopTitle();
    },
  };
  if (opts.titleAnimation !== false) startTitle();

  // Take over EVERY keystroke. Raw mode (Ink turns this on when render
  // mounts) already disables ICANON/ECHO/ISIG/IXON on Linux+macOS, so
  // Ctrl+C/Z/\\/S/Q arrive as input bytes instead of generating
  // signals or being eaten by the terminal driver. Belt-and-suspenders:
  // install no-op handlers for the suspend/quit signals just in case
  // some shell or terminal still surfaces them — without these, a
  // stray Ctrl+Z could background the TUI mid-session.
  const swallowSignals: NodeJS.Signals[] = ['SIGTSTP', 'SIGQUIT', 'SIGTTIN', 'SIGTTOU'];
  const swallow = () => {};
  for (const s of swallowSignals) {
    try {
      process.on(s, swallow);
    } catch {
      // Signal not supported on this platform (Windows ignores most of
      // these). Safe to skip — there's nothing for the terminal to
      // deliver in the first place.
    }
  }

  // Track cleanup state so signal handlers don't double-disable.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unregisterTuiClient();
    unsilenceTerminal();
    try {
      stopTitle();
    } catch {
      // title controller already torn down — ignore.
    }
    try {
      stdout.write(BRACKETED_PASTE_OFF);
      // Disabling unset modes is a no-op, so this is safe even when mouse
      // tracking was never enabled — guarantees no leaked mouse reporting.
      stdout.write(MOUSE_OFF);
    } catch {
      // stdout may already be closed during shutdown — ignore.
    }
  };

  // ── Rapid Ctrl+C force-exit ─────────────────────────────────────────────
  // Tracks consecutive SIGINT signals. When the user presses Ctrl+C 3 times
  // within RAPID_EXIT_WINDOW_MS, we force-exit immediately instead of going
  // through the normal cleanup + Ink unmount path. This is intentional: the
  // user explicitly wants to kill the app, and waiting for Ink to unmount
  // can take seconds. The counter resets after the window expires so a long
  // pause between presses doesn't count as "rapid".
  const RAPID_EXIT_WINDOW_MS = 2_000;
  const RAPID_EXIT_THRESHOLD = 3;
  let ctrlCPressTimestamps: number[] = [];

  const forceExitViaRapidCtrlC = (): void => {
    // Detach all listeners first so cleanup() doesn't race with process.exit()
    detachListeners();
    unregisterTuiClient();
    stdout.write(BRACKETED_PASTE_OFF);
    stdout.write(MOUSE_OFF);
    process.exit(130);
  };

  // ── Signal / exit handlers ───────────────────────────────────────────────
  // If the process is killed externally (terminal closed, SIGTERM from a
  // supervisor) waitUntilExit's .then/.catch never runs. Register signal +
  // exit listeners so the terminal isn't left in bracketed-paste mode.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];
  const signalHandler = () => cleanup();
  const exitHandler = () => cleanup();

  // SIGINT (Ctrl+C) gets special treatment: track rapid presses.
  const sigintHandler = (): void => {
    const now = Date.now();
    // Prune timestamps outside the window
    ctrlCPressTimestamps = ctrlCPressTimestamps.filter((t) => now - t < RAPID_EXIT_WINDOW_MS);
    ctrlCPressTimestamps.push(now);

    if (ctrlCPressTimestamps.length >= RAPID_EXIT_THRESHOLD) {
      // 3+ rapid Ctrl+C — force exit immediately
      ctrlCPressTimestamps = [];
      forceExitViaRapidCtrlC();
      return;
    }
    // First or second press — normal cleanup; the user can press again
    cleanup();
  };

  process.on('SIGINT', sigintHandler);
  for (const s of ['SIGTERM', 'SIGHUP']) {
    try {
      process.on(s, signalHandler);
    } catch {
      // Platform may not support this signal
    }
  }
  process.on('exit', exitHandler);

  const detachListeners = () => {
    process.off('SIGINT', sigintHandler);
    for (const s of signals) process.off(s, signalHandler);
    for (const s of swallowSignals) {
      try {
        process.off(s, swallow);
      } catch {
        // ignore — see install site
      }
    }
    process.off('exit', exitHandler);
  };

  // ── Client (REPL/TUI/WebUI) registration ─────────────────────────────────
  // Register this TUI instance as a client in the global mailbox so other
  // TUIs, WebUIs, and REPLs on the same project can see it as "online".
  // Clients heartbeat more frequently than agents (15s vs 30s) since they
  // have no other activity to drive the registration.
  let clientHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let clientSyncTimer: ReturnType<typeof setInterval> | null = null;
  const CLIENT_HEARTBEAT_MS = 15_000;
  /** Sync client counts from the shared registry every 30s so closed clients disappear promptly. */
  const CLIENT_SYNC_MS = 30_000;

  const registerTuiClient = async (): Promise<string | null> => {
    if (!opts.projectRoot) return null;
    try {
      const projectDir = resolveProjectDir(opts.projectRoot, wstackGlobalRoot());
      const hqPublisher = createHqPublisherFromEnv({ clientKind: 'tui', projectRoot: opts.projectRoot, projectName: path.basename(opts.projectRoot), appConfig: opts.appConfig } as never as Parameters<typeof createHqPublisherFromEnv>[0]);
      hqPublisher?.connect();
      const mailbox = new GlobalMailbox(projectDir, opts.events, hqPublisher);
      // Unique per-process: tui@<uuid>
      const clientId = `tui@${randomUUID().slice(0, 8)}`;
      await mailbox.registerClient({
        clientId,
        sessionId: opts.getSessionId?.() ?? opts.projectRoot,
        name: `TUI [${path.basename(opts.projectRoot)}]`,
        source: 'tui',
        pid: process.pid,
      });

      // Heartbeat to keep registration alive
      clientHeartbeatTimer = setInterval(() => {
        mailbox.clientHeartbeat({ clientId, sessionId: opts.getSessionId?.() ?? opts.projectRoot }).catch(() => {
          // best-effort — ignore heartbeat failures during shutdown
        });
      }, CLIENT_HEARTBEAT_MS);
      clientHeartbeatTimer.unref();

      // Periodically sync authoritative client counts from the shared registry.
      // This corrects the count when other clients disconnect (their registrations
      // expire after 60s without a heartbeat) and when this TUI restarts.
      const syncClients = async (): Promise<void> => {
        try {
          const statuses = await mailbox.getClientStatuses();
          const counts = { tui: 0, webui: 0, repl: 0 };
          for (const s of statuses) {
            if (s.online && s.source in counts) {
              counts[s.source as keyof typeof counts]++;
            }
          }
          opts.events.emitCustom('mailbox.sync_clients', counts);
        } catch {
          // best-effort — sync failures should not affect TUI operation
        }
      };
      // First sync after 5s (give other clients time to register), then every CLIENT_SYNC_MS
      setTimeout(() => { void syncClients(); }, 5_000);
      clientSyncTimer = setInterval(() => { void syncClients(); }, CLIENT_SYNC_MS);
      clientSyncTimer.unref();

      return clientId;
    } catch {
      // best-effort — client registration errors should not block TUI startup
      return null;
    }
  };

  const unregisterTuiClient = (): void => {
    if (clientHeartbeatTimer) {
      clearInterval(clientHeartbeatTimer);
      clientHeartbeatTimer = null;
    }
    if (clientSyncTimer) {
      clearInterval(clientSyncTimer);
      clientSyncTimer = null;
    }
  };

  // Register immediately (fire-and-forget)
  registerTuiClient();

  return new Promise<number>((resolve) => {
    let exitCode = 0;
    let hardExitTimer: ReturnType<typeof setTimeout> | null = null;
    const onExit = (code: number) => {
      exitCode = code;
    };
    const settle = (code: number) => {
      // The unmount completed normally — cancel the hang fallback. Leaving it
      // armed used to hard-kill the HOST ~400ms after a project switch,
      // racing the post-TUI respawn logic in execution.ts.
      if (hardExitTimer) {
        clearTimeout(hardExitTimer);
        hardExitTimer = null;
      }
      cleanup();
      detachListeners();
      resolve(code);
    };

    /**
     * Request the TUI to exit with a specific code. This triggers Ink's unmount
     * (restoring terminal state) and resolves the runTui promise with the given code.
     * Used for clean exits when switching projects — the host CLI catches the exit
     * code and spawns a new wstack process in the target directory.
     */
    const requestExit = (code: number) => {
      onExit(code);
      // Trigger Ink's unmount — it restores terminal state (raw mode off,
      // cursor shown) and resolves waitUntilExit(). A bare process.exit()
      // would skip this and leave the terminal in a broken state.
      // Hard-exit ONLY if Ink's unmount hangs (settle() cancels this timer
      // on the normal path).
      instance?.unmount();
      hardExitTimer = setTimeout(() => process.exit(code), 5_000);
      hardExitTimer.unref();
    };

    // Wire requestExit to the options so the App can call it
    opts.requestExit = requestExit;

    let instance: ReturnType<typeof render>;

    // Physically clear the terminal on `/clear`. `instance.clear()` erases the
    // live frame AND resyncs Ink's log-update line tracking, so the subsequent
    // raw clear-screen write doesn't fight Ink's cursor math (which is exactly
    // why cli-main's onClear skips the escape in TUI mode). Then the same
    // \x1b[2J\x1b[3J\x1b[H used at boot wipes the visible screen + native
    // scrollback so the pre-clear conversation isn't left above the banner.
    // The closure reads `instance` lazily — it only ever runs on a user
    // /clear, long after render() has assigned it.
    const clearTerminal = () => {
      try {
        instance?.clear();
        stdout.write('\x1b[2J\x1b[3J\x1b[H');
      } catch {
        // stdout may be closed mid-teardown — ignore.
      }
    };
    try {
      instance = render(
        React.createElement(App, {
          agent: opts.agent,
          slashRegistry: opts.slashRegistry,
          attachments: opts.attachments,
          events: opts.events,
          tokenCounter: opts.tokenCounter,
          visionAdapters: opts.visionAdapters,
          supportsVision: opts.supportsVision,
          model: opts.model,
          banner: opts.banner ?? true,
          queueStore: opts.queueStore,
          onQueueChange: opts.onQueueChange,
          yolo: opts.yolo,
          getYolo: opts.getYolo,
          getAutonomy: opts.getAutonomy,
          getEternalEngine: opts.getEternalEngine,
          getParallelEngine: opts.getParallelEngine,
          getSddRun: opts.getSddRun,
          onSddLifecycle: opts.onSddLifecycle,
          subscribeEternalIteration: opts.subscribeEternalIteration,
          subscribeEternalStage: opts.subscribeEternalStage,
          subscribeAutoPhase: opts.subscribeAutoPhase,
          appVersion: opts.appVersion,
          provider: opts.provider,
          family: opts.family,
          keyTail: opts.keyTail,
          getPickableProviders: opts.getPickableProviders,
          switchProviderAndModel: opts.switchProviderAndModel,
          switchAutonomy: opts.switchAutonomy,
          effectiveMaxContext: opts.effectiveMaxContext,
          onExit,
          director: opts.director ?? null,
          fleetRoster: opts.fleetRoster,
          onClearHistory: opts.onClearHistory
            ? (dispatch) => opts.onClearHistory?.(dispatch)
            : undefined,
          clearTerminal,
          fleetStreamController: opts.fleetStreamController,
          interruptController: opts.interruptController,
          enhanceController: opts.enhanceController,
          enhanceEnabled: opts.enhanceController?.enabled ?? true,
          midRunSendPicker: opts.getSettings?.().midRunSendPicker ?? true,
          statuslineHiddenItems: opts.statuslineHiddenItems,
          setStatuslineHiddenItems: opts.setStatuslineHiddenItems,
          saveStatuslineHiddenItems: opts.saveStatuslineHiddenItems,
          agentsMonitorController: opts.agentsMonitorController,
          initialGoal: opts.initialGoal,
          initialAsk: opts.initialAsk,
          getSDDContext: opts.getSDDContext,
          onSDDOutput: opts.onSDDOutput,
          sessionsDir: opts.sessionsDir,
          projectRoot: opts.projectRoot,
          getSettings: opts.getSettings,
          saveSettings: opts.saveSettings,
          predictNext: opts.predictNext,
          onSuggestionsParsed: opts.onSuggestionsParsed,
          getSuggestions: opts.getSuggestions,
          getAutoSuggestions: opts.getAutoSuggestions,
          autonomyNextPrompt: opts.autonomyNextPrompt,
          setSuggestions: opts.setSuggestions,
          chime: opts.chime,
          confirmExit: opts.confirmExit,
          titleController,
          mouse: mouseEnabled,
          modeLabel: opts.modeLabel,
          tokenSavingMode: opts.tokenSavingMode,
          toolCount: opts.toolCount,
          getModeLabel: opts.getModeLabel,
          registerDebugStreamCallback: opts.registerDebugStreamCallback,
          restoreDebugStreamCallback: opts.restoreDebugStreamCallback,
          restoredMessages: opts.restoredMessages,
          restoredToolCalls: opts.restoredToolCalls,
          listSessions: opts.listSessions,
          onResumeSession: opts.onResumeSession,
          getProjectPickerItems: opts.getProjectPickerItems,
          onProjectSelect: opts.onProjectSelect,
          requestExit: opts.requestExit,
          getLiveSessions: opts.getLiveSessions,
          onSwitchToSession: opts.onSwitchToSession,
          initialAgentsMonitorOpen: opts.initialAgentsMonitorOpen,
          subscribeCoordinatorEvents: opts.subscribeCoordinatorEvents,
          onPanelOpen: opts.onPanelOpen,
          onCoordinatorStart: opts.onCoordinatorStart,
          onCoordinatorStop: opts.onCoordinatorStop,
          onCoordinatorTasks: opts.onCoordinatorTasks,
          onCoordinatorClaim: opts.onCoordinatorClaim,
          onCoordinatorComplete: opts.onCoordinatorComplete,
          onCoordinatorFail: opts.onCoordinatorFail,
          onCoordinatorStatus: opts.onCoordinatorStatus,
        }),
        { exitOnCtrlC: false, stdin: inkStdin },
      );
    } catch (err) {
      writeErr(
        `wstack: TUI failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      settle(1);
      return;
    }
    // Terminal reflows visible text on resize BEFORE Ink can react, which can
    // leave ghosts below the cursor. Erase from-cursor-to-end on every resize
    // to minimize artifacts. Ink immediately re-renders at the new width.
    let detachResize: (() => void) | null = null;
    const onResize = () => {
      try {
        // \x1b[J = erase from cursor to end of screen. Does NOT touch
        // anything above the cursor, so committed Static history in
        // scrollback is preserved. Ink's useStdout subscriber will
        // immediately re-render the live region at the new width.
        // Do NOT prefix with \x1b[H: homing to (0,0) erases the visible
        // committed output and repositions the live region (input + status
        // bar) at the top of the viewport instead of the bottom.
        stdout.write('\x1b[J');
      } catch {
        // stdout might be detached mid-shutdown — ignore.
      }
    };
    stdout.on('resize', onResize);
    detachResize = () => stdout.off('resize', onResize);

    instance
      .waitUntilExit()
      .then(() => {
        detachResize?.();
        settle(exitCode);
      })
      .catch(() => {
        detachResize?.();
        settle(1);
      });
  });
}
