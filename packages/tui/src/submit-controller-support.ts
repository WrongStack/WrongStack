import type { AttachmentStore, ContentBlock } from '@wrongstack/contracts/types';
import type { InputBuilder } from '@wrongstack/core/agent';
import type { Director } from '@wrongstack/core/coordination';
import type { Action, State } from './app-reducer.js';
import type { emptyMemoryContextMonitor } from './memory-context-monitor.js';
import type { MutableCell } from './shared-types.js';
import type { TokenPreviewStore } from './token-previews.js';
import type { RunBlocksOptions, SubmitCapabilities } from './tui-host-capabilities.js';

/**
 * Wait up to `deadlineMs` for an in-flight run to settle into `idle` before
 * kicking the next iteration. Polls `isIdle` rather than spinning: the cadence
 * starts tight (so we react quickly when the abort settles early) and backs
 * off toward the deadline, so a long wait never hammers the event loop at a
 * fixed high frequency. Returns true if idle was reached before the deadline.
 */
export async function waitForIdleSettle(
  isIdle: () => boolean,
  deadlineMs: number,
  opts: { maxPollMs?: number } = {},
): Promise<boolean> {
  const maxPollMs = opts.maxPollMs ?? 150;
  const start = Date.now();
  let pollMs = 20;
  while (!isIdle()) {
    const remaining = deadlineMs - (Date.now() - start);
    if (remaining <= 0) return false;
    const wait = Math.min(Math.max(pollMs, 1), maxPollMs, remaining);
    await new Promise((resolve) => setTimeout(resolve, wait));
    pollMs = Math.min(pollMs * 2, maxPollMs);
  }
  return true;
}

export interface SubmitControllerHost {
  readonly capabilities: SubmitCapabilities;
  readonly state: State;
  readonly live: {
    readonly mouseMode: boolean;
    /** Mouse tracking released to the terminal (`/mouse native`). */
    readonly nativeMouse: boolean;
    readonly model: string;
    readonly provider: string;
    readonly maxContext: number | undefined;
    readonly yolo: boolean;
    readonly autonomy: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
    readonly modeLabel: string | undefined;
    setMouseMode(value: boolean): void;
    setNativeMouse(value: boolean): void;
    setModel(value: string): void;
    setProvider(value: string): void;
    setMaxContext(value: number): void;
    setYolo(value: boolean): void;
    setAutonomy(value: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel'): void;
    setModeLabel(value: string): void;
    setToolCount(value: number): void;
  };
  readonly refs: {
    readonly state: MutableCell<State>;
    readonly interrupts: MutableCell<number>;
    readonly autoSubmitStreak: MutableCell<number>;
    readonly autoSubmitCapWarned: MutableCell<boolean>;
    readonly autoSubmitLoopGuard: MutableCell<{ reset(): void }>;
    readonly tokenPreviews: MutableCell<TokenPreviewStore>;
    readonly attachments: AttachmentStore;
    readonly builder: MutableCell<InputBuilder | null>;
    readonly sessionGeneration: MutableCell<number>;
    readonly eternalLoop: MutableCell<() => Promise<void>>;
    readonly parallelLoop: MutableCell<() => Promise<void>>;
    readonly enhanceEnabled: MutableCell<boolean>;
    readonly enhanceOriginal: MutableCell<string>;
    readonly enhanceAbort: MutableCell<AbortController | null>;
    readonly enhanceCancelled: MutableCell<boolean>;
    readonly nextStepsTimer: MutableCell<ReturnType<typeof setInterval> | undefined>;
    readonly midRunSendPicker: MutableCell<boolean>;
    /** Managed-history scroll surface; null until ScrollableHistory mounts. */
    readonly historyScroll: MutableCell<
      import('./components/scrollable-history.js').HistoryScrollController | null
    >;
  };
  readonly actions: {
    dispatch(action: Action): void;
    clearDraft(): void;
    setDraft(buffer: string, cursor: number): void;
    pasteClipboardImage(): Promise<void>;
    openPromptPicker(): Promise<void>;
    refreshGoalSummary(): void;
    exit(): void;
    runBlocks(blocks: ContentBlock[], options?: RunBlocksOptions): Promise<void>;
    liveDirector(): Director | null;
    setMemoryContextMonitor(value: ReturnType<typeof emptyMemoryContextMonitor>): void;
    runSteerSequence(direction: string): { preamble: string };
    setEnhanceStartedAt(value: number | null): void;
    setEnhanceDuration(value: number | null): void;
    setRefineProvider(value: string | null): void;
    setRefineModel(value: string | null): void;
    onBugHuntStarted(command: string, totalRounds?: number): void;
    stopBugHuntAfterCurrentRound(): void;
    consumeBugHuntReplay(command: string): boolean;
    /** Called after /clear dispatches clearHistory — app.tsx uses this to
     *  reset mutable refs that the reducer cannot reach (paste accumulator,
     *  next-steps auto-submit, prompt-usage store, enhance abort). */
    onAfterClear?(): void;
  };
}
