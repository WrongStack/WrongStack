import type {
  Agent,
  AttachmentStore,
  Director,
  EventBus,
  FleetBus,
  FleetUsageAggregator,
  QueueStore,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import type { VisionAdapters } from '@wrongstack/runtime/vision';
import { render } from 'ink';
import React from 'react';
import { App } from './app.js';

export interface RunTuiOptions {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  events: EventBus;
  tokenCounter?: TokenCounter;
  visionAdapters?: VisionAdapters;
  /** Resolve current model vision support. Falls back to provider capability when omitted. */
  supportsVision?: () => boolean | Promise<boolean>;
  model: string;
  banner?: boolean;
  /** Persists the input queue across crashes; if omitted, the queue is in-memory only. */
  queueStore?: QueueStore;
  /** Surfaces the "⚠ YOLO" chip in the status bar. */
  yolo?: boolean;
  /** Query live YOLO state from the permission policy. */
  getYolo?: () => boolean;
  /** Query the live autonomy mode. */
  getAutonomy?: () => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  /**
   * Access the eternal-autonomy engine. When autonomy mode flips to
   * 'eternal' the TUI drives `runOneIteration()` from the post-slash hook
   * so the engine and TUI never race for the shared Context.
   */
  getEternalEngine?: () => import('@wrongstack/core').EternalAutonomyEngine | null;
  /**
   * Access the parallel-eternal engine. When autonomy mode flips to
   * 'eternal-parallel' the TUI drives `runOneIteration()` from the post-slash
   * hook so the engine and TUI never race for the shared Context.
   */
  getParallelEngine?: () => import('@wrongstack/core').ParallelEternalEngine | null;
  /**
   * Subscribe to live per-iteration events from the eternal engine.
   * Returns an unsubscribe function. TUI uses this to render each
   * iteration as a live timeline entry as it lands.
   */
  subscribeEternalIteration?: (
    fn: (entry: import('@wrongstack/core').JournalEntry) => void,
  ) => () => void;
  /**
   * Subscribe to per-iteration stage transitions from the eternal engine.
   * TUI uses this to render live status (decide → execute → reflect →
   * sleep/paused/stopped) in the status bar.
   */
  subscribeEternalStage?: (
    fn: (stage: {
      phase: 'idle';
    } | {
      phase: 'decide';
      reason: string;
    } | {
      phase: 'execute';
      task: string;
    } | {
      phase: 'reflect';
      status: 'success' | 'failure' | 'aborted' | 'skipped';
      note?: string;
    } | {
      phase: 'sleep';
      ms: number;
    } | {
      phase: 'paused';
    } | {
      phase: 'stopped';
    } | {
      phase: 'error';
      message: string;
    }) => void,
  ) => () => void;
  /** Renders in the startup banner. Read from the CLI's package.json. */
  appVersion?: string;
  /** Provider id for the startup banner ("openai", "anthropic", ...). */
  provider?: string;
  /** Wire family — shown beneath provider in the banner. */
  family?: string;
  /** Last 3 chars of the active API key — shown in the banner for visual key-pick verification. */
  keyTail?: string;
  /** Snapshot of keyed providers + their model lists for the `/model` picker. Async — the catalog fetch may need to hit disk/network. */
  getPickableProviders?: () => Promise<import('./components/model-picker.js').ProviderOption[]>;
  /** Apply a (provider, model) pair after the picker confirms. Returns an error string on failure. */
  switchProviderAndModel?: (providerId: string, modelId: string) => string | null;
  /** Apply an autonomy mode after the picker confirms. Returns an error string on failure. */
  switchAutonomy?: (mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => string | null;
  /**
   * Model-specific maxContext (tokens), resolved by the CLI via the
   * ModelsRegistry. When omitted, the TUI falls back to the provider
   * family's baseline (e.g. anthropic = 200_000), which can be wrong
   * for variants like the 1M-context Opus build. The status bar's
   * context chip uses this for its progress denominator.
   */
  effectiveMaxContext?: number;
  /** Absolute project root for goal.json loading. */
  projectRoot?: string;
  /** Render into the terminal's alternate screen buffer (like vim/less/htop).
   * Default: false — native scrollback stays live so chat history is
   * scrollable via mouse wheel / Shift+PgUp, which matches the user's
   * "this is a chat app, let me scroll the chat" intuition. Pass true
   * (or run with `--alt-screen`) for the full-screen mode that owns the
   * terminal and prevents resize/overlay leaks of the live region —
   * trade-off is that the terminal's native scrollback is suspended
   * while the TUI is up and only what's currently on screen is visible.
   */
  altScreen?: boolean;
  /**
   * Called right after we exit the alt-screen on a clean shutdown. The
   * CLI uses this to print a one-line "session saved to …" hint into
   * the user's normal terminal, since alt-screen exit erases the whole
   * TUI view.
   */
  onAfterExit?: () => void;
  /** Called from /clear so the TUI can wipe its history entries while agent.ctx + memory are cleared separately. */
  onClearHistory?: (
    dispatch: React.Dispatch<{ type: 'clearHistory' } | { type: 'resetContextChip' }>,
  ) => void;

  // --- Fleet surface (director mode) ---

  /**
   * Live director instance. When set, the TUI renders a fleet panel
   * showing every spawned subagent, its current task, streaming output,
   * and runtime cost — updated live from the FleetBus. Pass null or omit
   * when multi-agent / director mode is disabled.
   */
  director?: Director | null;
  /**
   * Optional roster reference for resolving subagent role ids to
   * human-readable names. Same value passed to director.tools().
   */
  fleetRoster?: Record<string, { name: string }>;
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
  };
  /**
   * Controller for status bar hidden items. App installs a dispatch-backed
   * setter on mount so the /statusline slash command can update the TUI's
   * visible bar without a round-trip. The initial value is loaded from
   * the config file before App mounts.
   */
  statuslineHiddenItems: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>;
  setStatuslineHiddenItems: (items: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>) => void;
  /**
   * Controller for the agents monitor overlay. App installs a dispatch-backed
   * setter on mount so the `/agents on|off` slash command can toggle the
   * overlay without a round-trip.
   */
  agentsMonitorController?: {
    visible: boolean;
    setVisible: (visible: boolean) => void;
  };

  /**
   * If set, the App boots straight into goal mode — the text is wrapped
   * in the GOAL preamble and submitted as the first turn. Lets users
   * launch directly from the shell:
   *   wstack --tui --director --goal "audit packages/core for races"
   * The chat shows a one-line "🎯 Goal locked: …" hint; the actual
   * preamble is hidden from the visible history (same as `/goal`).
   */
  initialGoal?: string;
  /**
   * If set, submitted as the first turn verbatim (no preamble). Mainly
   * for scripted shell aliases — `wstack --tui --ask "summarize foo.md"`
   * — that want one turn pre-populated without the goal-mode framing.
   * Ignored when `initialGoal` is also set.
   */
  initialAsk?: string;
  /**
   * Directory containing session JSONL files. Required for rewind
   * functionality. When provided the TUI can list checkpoints and
   * trigger a rewind via `/rewind` or Ctrl+R.
   */
  sessionsDir?: string;
  /**
   * SDD session context getter. When an SDD session is active, returns
   * the AI prompt context to inject into user messages.
   */
  getSDDContext?: () => string | null;
  /**
   * Process AI output for SDD auto-detection (spec, tasks, plan).
   * Returns displayable status messages.
   */
  onSDDOutput?: (output: string) => Promise<string[]>;
  /**
   * Subscribe to AutoPhase phase/graph events from the PhaseOrchestrator.
   * Returns an unsubscribe function. The TUI uses this to drive the
   * PhaseMonitor and PhasePanel live views via dispatch actions.
   */
  subscribeAutoPhase?: (
    handler: (event: string, payload: unknown) => void,
  ) => () => void;
}

// Bracketed paste mode wraps any pasted text with these markers, letting us
// distinguish a paste from typed input even when chunks arrive identically.
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';

// Alternate-screen buffer (DECSET 1049). Switches the terminal to a
// dedicated virtual screen; on exit, the previous scrollback is restored
// untouched. This is what every "full-screen TUI" uses (vim, less, htop).
// Without it, Ink writes its dynamic area in line with scrollback and
// each redraw can leak the previous frame's input/status into the
// permanent terminal history — the exact bug we hit before this change.
const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HOME = '\x1b[H';

export async function runTui(opts: RunTuiOptions): Promise<number> {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // Ink requires a TTY on both stdin and stdout. Without this guard the
  // render call would fail with a terse internal Ink error; bail with a
  // clear message so a piped invocation (`echo hi | wstack --tui`) tells
  // the user what to do instead.
  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write(
      'wstack: --tui requires an interactive terminal on both stdin and stdout.\n' +
        '       Drop the flag (use the plain REPL) or run wstack directly without piping.\n',
    );
    return 2;
  }

  const useAltScreen = opts.altScreen === true;
  if (useAltScreen) {
    stdout.write(ALT_SCREEN_ON);
    stdout.write(CURSOR_HOME);
  }
  stdout.write(BRACKETED_PASTE_ON);

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

  // Track cleanup state so signal handlers don't double-disable. Order
  // matters on exit: paste mode off first (it's a screen-independent
  // setting), then alt-screen off (which restores the user's previous
  // terminal contents).
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      stdout.write(BRACKETED_PASTE_OFF);
      if (useAltScreen) {
        stdout.write(ALT_SCREEN_OFF);
      }
    } catch {
      // stdout may already be closed during shutdown — ignore.
    }
  };

  // If the process is killed externally (terminal closed, SIGTERM from a
  // supervisor) waitUntilExit's .then/.catch never runs. Register signal +
  // exit listeners so the terminal isn't left in bracketed-paste mode.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];
  const signalHandler = () => cleanup();
  const exitHandler = () => cleanup();
  for (const s of signals) process.on(s, signalHandler);
  process.on('exit', exitHandler);

  const detachListeners = () => {
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

  return new Promise<number>((resolve) => {
    let exitCode = 0;
    const onExit = (code: number) => {
      exitCode = code;
    };
    const settle = (code: number) => {
      cleanup();
      detachListeners();
      // Once the alt-screen is dismantled the user is staring at their
      // pre-TUI terminal again — print a quick line so they can see
      // where the session is preserved, instead of wondering "where did
      // my chat go?". Best-effort: callback failures don't change exit.
      if (useAltScreen && opts.onAfterExit) {
        try {
          opts.onAfterExit();
        } catch {
          // ignore — UX helper, not load-bearing
        }
      }
      resolve(code);
    };

    let instance: ReturnType<typeof render>;
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
          yolo: opts.yolo,
          getYolo: opts.getYolo,
          getAutonomy: opts.getAutonomy,
          getEternalEngine: opts.getEternalEngine,
          getParallelEngine: opts.getParallelEngine,
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
            ? (dispatch) => opts.onClearHistory!(dispatch)
            : undefined,
          fleetStreamController: opts.fleetStreamController,
          statuslineHiddenItems: opts.statuslineHiddenItems,
          setStatuslineHiddenItems: opts.setStatuslineHiddenItems,
          agentsMonitorController: opts.agentsMonitorController,
          initialGoal: opts.initialGoal,
          initialAsk: opts.initialAsk,
          getSDDContext: opts.getSDDContext,
          onSDDOutput: opts.onSDDOutput,
          sessionsDir: opts.sessionsDir,
          projectRoot: opts.projectRoot,
        }),
        { exitOnCtrlC: false },
      );
    } catch (err) {
      process.stderr.write(
        `wstack: TUI failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      settle(1);
      return;
    }
    // Non-altScreen mode: terminal reflows visible text on resize BEFORE
    // Ink can react, which leaks one or more lines of the live region
    // (input prompt, status bar) into native scrollback. We can't recover
    // what the terminal already pushed up, but we CAN ensure no leftover
    // ghosts persist below the cursor by erasing from-cursor-to-end on
    // every resize. Combined with Ink's automatic re-render on resize,
    // this minimizes the artifact to (at most) the lines the terminal
    // itself pushed up at the moment of the resize event.
    //
    // For users doing heavy resize / split-pane workflows, --alt-screen
    // is the bullet-proof fix: Ink renders into a separate screen buffer
    // that has no native scrollback, so terminal-side reflow can't push
    // anything anywhere. Trade-off documented in tui/README.md.
    let detachResize: (() => void) | null = null;
    if (!useAltScreen) {
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
    }

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
