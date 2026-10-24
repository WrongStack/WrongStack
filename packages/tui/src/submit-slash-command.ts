import { toErrorMessage } from '@wrongstack/core/utils';

import { INLINE_TOKEN_SRC } from './input-tokens.js';

import { emptyMemoryContextMonitor } from './memory-context-monitor.js';

import { resolveAttachmentTokens } from './token-previews.js';

export async function submitSlashCommand({
  trimmed,
  sessionGenerationRef,
  attachments,
  tokenPreviewsRef,
  isAutomaticBugHuntReplay,
  dispatch,
  pushSubmittedHistory,
  clearDraft,
  slashRegistry,
  agent,
  refreshGoalSummary,
  onBugHuntStarted,
  mouseMode,
  nativeMouse,
  setNativeMouse,
  setMouseMode,
  getSettings,
  saveSettings,
  liveModel,
  setLiveModel,
  liveProvider,
  setLiveProvider,
  activeMaxContext,
  setActiveMaxContext,
  getYolo,
  yoloLive,
  setYoloLive,
  getAutonomy,
  autonomyLive,
  setAutonomyLive,
  getEternalEngine,
  runEternalLoopRef,
  getParallelEngine,
  runParallelLoopRef,
  getModeLabel,
  liveModeLabel,
  setLiveModeLabel,
  getToolsItems,
  setLiveToolCount,
  exit,
  onExit,
  builderRef,
  waitForIdleSettle,
  stateRef,
  runBlocks,
  liveDirector,
  clearTerminal,
  onClearHistory,
  setMemoryContextMonitor,
  tokenCounter,
  enhanceAbortRef,
  enhanceCancelledRef,
  enhanceOriginalRef,
  nextStepsAutoSubmitTimerRef,
  autoSubmitStreakRef,
  autoSubmitCapWarnedRef,
  autoSubmitLoopGuardRef,
  onAfterClear,
}: {
  trimmed: string;
  sessionGenerationRef: import('./shared-types.js').MutableCell<number>;
  attachments: import('@wrongstack/contracts/types').AttachmentStore;
  tokenPreviewsRef: import('./shared-types.js').MutableCell<
    import('./token-previews.js').TokenPreviewStore
  >;
  isAutomaticBugHuntReplay: boolean;
  dispatch: (action: import('./app-action-type.js').Action) => void;
  pushSubmittedHistory: () => void;
  clearDraft: () => void;
  slashRegistry: import('@wrongstack/core/registry').SlashCommandRegistry;
  agent: import('@wrongstack/core/agent').Agent;
  refreshGoalSummary: () => void;
  onBugHuntStarted: (command: string, totalRounds?: number | undefined) => void;
  mouseMode: boolean;
  nativeMouse: boolean;
  setNativeMouse: (value: boolean) => void;
  setMouseMode: (value: boolean) => void;
  getSettings: (() => import('./app-settings-type.js').Settings) | undefined;
  saveSettings:
    | ((
        settings: import('./app-settings-type.js').Settings,
      ) => string | Promise<string | null> | null)
    | undefined;
  liveModel: string;
  setLiveModel: (value: string) => void;
  liveProvider: string;
  setLiveProvider: (value: string) => void;
  activeMaxContext: number | undefined;
  setActiveMaxContext: (value: number) => void;
  getYolo: (() => boolean) | undefined;
  yoloLive: boolean;
  setYoloLive: (value: boolean) => void;
  getAutonomy: (() => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') | undefined;
  autonomyLive: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  setAutonomyLive: (value: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => void;
  getEternalEngine: (() => unknown) | undefined;
  runEternalLoopRef: import('./shared-types.js').MutableCell<() => Promise<void>>;
  getParallelEngine: (() => unknown) | undefined;
  runParallelLoopRef: import('./shared-types.js').MutableCell<() => Promise<void>>;
  getModeLabel: (() => string) | undefined;
  liveModeLabel: string | undefined;
  setLiveModeLabel: (value: string) => void;
  getToolsItems: (() => { enabled: boolean }[]) | undefined;
  setLiveToolCount: (value: number) => void;
  exit: () => void;
  onExit: (code: number) => void;
  builderRef: import('./shared-types.js').MutableCell<
    import('@wrongstack/core/agent').InputBuilder | null
  >;
  waitForIdleSettle: (
    isIdle: () => boolean,
    deadlineMs: number,
    opts?: { maxPollMs?: number },
  ) => Promise<boolean>;
  stateRef: import('./shared-types.js').MutableCell<import('./app-state.js').State>;
  runBlocks: (
    blocks: import('@wrongstack/contracts/types').ContentBlock[],
    options?: import('./tui-host-capabilities.js').RunBlocksOptions,
  ) => Promise<void>;
  liveDirector: () => import('@wrongstack/core/coordination').Director | null;
  clearTerminal: (() => void) | undefined;
  onClearHistory: import('./tui-host-capabilities.js').SubmitCapabilities['onClearHistory'];
  setMemoryContextMonitor: (
    value: import('./memory-context-monitor.js').MemoryContextMonitorState,
  ) => void;
  tokenCounter: import('@wrongstack/contracts/types').TokenCounter | undefined;
  enhanceAbortRef: import('./shared-types.js').MutableCell<AbortController | null>;
  enhanceCancelledRef: import('./shared-types.js').MutableCell<boolean>;
  enhanceOriginalRef: import('./shared-types.js').MutableCell<string>;
  nextStepsAutoSubmitTimerRef: import('./shared-types.js').MutableCell<NodeJS.Timeout | undefined>;
  autoSubmitStreakRef: import('./shared-types.js').MutableCell<number>;
  autoSubmitCapWarnedRef: import('./shared-types.js').MutableCell<boolean>;
  autoSubmitLoopGuardRef: import('./shared-types.js').MutableCell<{ reset(): void }>;
  onAfterClear: (() => void) | undefined;
}) {
  // Bind the initial slash dispatch flow to the session that submitted it.
  // `/clear` may complete while attachment expansion or command dispatch is
  // parked; an older continuation must not render or execute in the fresh
  // transcript after the generation changes.
  const slashGeneration = sessionGenerationRef.current;
  // Resolve full content from the canonical attachment store; the preview
  // cache intentionally retains only bounded display snippets.
  const resolvedForDispatch = await resolveAttachmentTokens(trimmed, attachments);
  if (slashGeneration !== sessionGenerationRef.current) return;
  const pasteParts: string[] = [];
  for (const m of trimmed.matchAll(new RegExp(INLINE_TOKEN_SRC, 'g'))) {
    const token = m[0];
    const preview = tokenPreviewsRef.current.get(token);
    pasteParts.push(token);
    if (preview) pasteParts.push(`  ${preview.split('\n').join('\n  ')}`);
  }
  const pasteContent = pasteParts.length > 0 ? pasteParts.join('\n') : undefined;

  const secretBearingSetup = /^\/(?:telegram-setup|tg-setup)\s+\d+:[A-Za-z0-9_-]+(?:\s|$)/i.test(
    trimmed,
  );
  if (!isAutomaticBugHuntReplay) {
    dispatch({
      type: 'addEntry',
      entry: {
        kind: 'user',
        text: secretBearingSetup ? '/telegram-setup [token redacted]' : trimmed,
        pasteContent,
      },
    });
  }
  pushSubmittedHistory();
  clearDraft();
  const cmd = trimmed.slice(1).split(/\s+/, 1)[0];
  try {
    const res = await slashRegistry.dispatch(resolvedForDispatch, agent.ctx);
    const cleared = cmd === 'clear' && res?.metadata?.cleared === true;
    // /clear itself advances the generation via resetSession before it
    // returns, and /rewind stops the session's producers the same way. Their
    // own result must still render (a failed rewind used to vanish). Other
    // commands and results superseded by a later boundary remain stale.
    const advancedByCommand = cleared || res?.metadata?.advancedSessionGeneration === true;
    const resetByCommand =
      advancedByCommand && sessionGenerationRef.current === slashGeneration + 1;
    if (slashGeneration !== sessionGenerationRef.current && !resetByCommand) return;
    // Refresh goal summary after any slash command — `/goal clear` or
    // `/goal set` changed the goal file on disk; the status bar chip
    // must reflect the new state (or disappear).
    refreshGoalSummary();
    if (res?.message) {
      dispatch({ type: 'addEntry', entry: { kind: 'info', text: res.message } });
    }
    const bugHuntMatch = trimmed.match(
      /^\/(?:bughunt|sechunt|secproof|racehunt|leakhunt|flakehunt|debloat|deadcode|excise|uipolish|a11yhunt|uihunt|typehunt|boundaryhunt|testgap|covhunt|invarianthunt)(?:\s+--rounds(?:\s+|=)(\d+))?(?:\s|$)/,
    );
    if (bugHuntMatch && res?.runText) {
      onBugHuntStarted(trimmed, bugHuntMatch[1] ? Number(bugHuntMatch[1]) : undefined);
    }
    // goalRunInit: when /goal start succeeds, the graph title is
    // embedded in metadata so the TUI can show the PhasePanel immediately
    // even before the first orchestrator event fires.
    if (res?.metadata?.goalRunInit) {
      const m = res.metadata.goalRunInit as { title: string };
      dispatch({ type: 'goalRunInit', title: m.title });
    }
    // /mouse toggles full pointer support. Managed chat wheel tracking stays
    // active in both modes because virtualized rows cannot be reached via
    // native terminal scrollback. The command is stateless (it doesn't
    // know the live value), so it emits an intent and the App resolves it
    // against its own `mouseMode` state, persists, and prints the result.
    const mouseToggle = res?.metadata?.mouseToggle as
      | 'on'
      | 'off'
      | 'native'
      | 'toggle'
      | 'query'
      | undefined;
    if (mouseToggle) {
      const nextVal =
        mouseToggle === 'on'
          ? true
          : mouseToggle === 'off'
            ? false
            : mouseToggle === 'toggle'
              ? !mouseMode
              : mouseMode;
      // `native` is a third level, not a value of `mouseMode`: it releases
      // tracking entirely. Any other intent takes the mouse back, so the
      // flag is cleared on every non-native, non-query command — otherwise
      // `/mouse on` would appear to do nothing while native was latched.
      const nextNative = mouseToggle === 'native';
      const nativeChanged = mouseToggle !== 'query' && nextNative !== nativeMouse;
      const modeChanged = mouseToggle !== 'query' && !nextNative && nextVal !== mouseMode;
      if (nativeChanged) setNativeMouse(nextNative);
      if (modeChanged) setMouseMode(nextVal);
      if (nativeChanged || modeChanged) {
        const cur = getSettings?.();
        if (cur && saveSettings) {
          Promise.resolve(
            saveSettings({
              ...cur,
              ...(modeChanged ? { mouseMode: nextVal } : {}),
              ...(nativeChanged ? { mouseNative: nextNative } : {}),
            }),
          ).catch((err: unknown) =>
            dispatch({
              type: 'addEntry',
              entry: {
                kind: 'error',
                text: `Could not save mouse setting: ${toErrorMessage(err)}`,
              },
            }),
          );
        }
      }
      const effectiveNative = mouseToggle === 'query' ? nativeMouse : nextNative;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'info',
          text: effectiveNative
            ? 'Mouse mode: NATIVE — the terminal owns the mouse, so click-drag selects and copies text. The wheel scrolls the terminal, not the transcript; use PgUp/PgDn or Ctrl+U/D to page history. /mouse on or /mouse off takes it back.'
            : nextVal
              ? 'Mouse mode: ON — chat wheel, scrollbar drag, and clickable UI are managed in-app.'
              : 'Mouse mode: OFF — chat wheel remains managed in-app; scrollbar drag and clickable UI are disabled.',
        },
      });
    }
    // Slash commands like /model and /use mutate agent.ctx directly.
    // Re-sync the visible status bar so the user sees the switch
    // landed; otherwise the bar keeps the startup-time values and
    // /model "feels" broken even when subsequent requests use the
    // new model.
    const ctxModel = agent.ctx.model;
    if (ctxModel && ctxModel !== liveModel) setLiveModel(ctxModel);
    const ctxProviderId = (agent.ctx.provider as { id?: string | undefined } | undefined)?.id;
    if (ctxProviderId && ctxProviderId !== liveProvider) setLiveProvider(ctxProviderId);
    const ctxMaxContext = agent.ctx.provider.capabilities.maxContext;
    if (ctxMaxContext > 0 && ctxMaxContext !== activeMaxContext) {
      setActiveMaxContext(ctxMaxContext);
    }
    if (getYolo) {
      const currentYolo = getYolo();
      if (currentYolo !== yoloLive) setYoloLive(currentYolo);
    }
    if (getAutonomy) {
      const currentAutonomy = getAutonomy();
      if (currentAutonomy !== autonomyLive) setAutonomyLive(currentAutonomy);
      // When /autonomy eternal lands, kick off the engine-driven loop.
      // Fire-and-forget — the loop runs until autonomy flips away from
      // 'eternal' or the engine's currentState goes !== 'running'.
      // Without this, the slash command would set the flag but the
      // TUI would just sit at the prompt waiting for user input.
      if (currentAutonomy === 'eternal' && getEternalEngine) {
        void runEternalLoopRef.current();
      }
      if (currentAutonomy === 'eternal-parallel' && getParallelEngine) {
        void runParallelLoopRef.current();
      }
    }
    if (getModeLabel) {
      const currentMode = getModeLabel();
      if (currentMode !== liveModeLabel) setLiveModeLabel(currentMode);
    }
    if (getToolsItems) {
      setLiveToolCount(getToolsItems().filter((item) => item.enabled).length);
    }
    if (res?.exit) {
      exit();
      onExit(0);
    }
    // `runText` lets a slash command queue a follow-up user-role
    // message (used by `/steer <text>` to send the STEERING
    // preamble + new direction as if the user had typed it).
    // Run AFTER the message is rendered so the user sees the
    // slash result before the model's response streams.
    if (res?.runText) {
      const b = builderRef.current;
      if (b) {
        b.appendText(res.runText);
        const blocks = await b.submit();
        if (slashGeneration !== sessionGenerationRef.current) return;
        // Wait briefly for any in-flight abort to settle into
        // 'idle' before kicking the next iteration — otherwise
        // runBlocks would early-return on the busy guard.
        await waitForIdleSettle(() => stateRef.current.status === 'idle', 1500);
        if (slashGeneration !== sessionGenerationRef.current) return;
        // Submit directly without placing the text into the input field.
        // The draft was already cleared above (clearDraft before dispatch),
        // and runBlocks will handle the execution. The finally block
        // ensures the input stays cleared even if runBlocks throws.
        try {
          await runBlocks(blocks);
        } finally {
          if (slashGeneration === sessionGenerationRef.current) clearDraft();
        }
      }
    }
    // Only fire onClearHistory for `/clear` — without this gate every
    // slash command (`/model`, `/use`, `/help`, …) would wipe the
    // conversation. Match the command name segment, not just the
    // prefix, so `/clearfoo` doesn't trigger.
    if (cleared) {
      // Terminate any running subagents BEFORE clearing state. Without
      // this, in-flight subagents keep executing and their completion
      // events (task.completed, fleetDone, addEntry) re-pollute the
      // freshly-cleared history within seconds — the fleet event bridge
      // dispatches directly with no generation check, so it bypasses
      // the provider-response guards below.
      const clearDir = liveDirector();
      if (clearDir) {
        const cap = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1500);
          t.unref?.();
        });
        void Promise.race([clearDir.terminateAll().catch(() => undefined), cap]);
      }
      // Bump the session generation so provider-response/text-delta
      // listeners discard any stale output from the aborted run.
      if (!resetByCommand) sessionGenerationRef.current++;
      // Physically wipe the terminal (screen + scrollback) FIRST so the
      // old conversation isn't left reachable above the fresh banner;
      // the clearHistory remount below then reprints the banner onto a
      // clean screen.
      clearTerminal?.();
      onClearHistory?.(dispatch);
      setMemoryContextMonitor(emptyMemoryContextMonitor());
      // Reset cumulative token/cost counters so the status bar
      // reflects a fresh session, not pre-clear stats.
      tokenCounter?.reset();
      // ── Reset mutable refs that survive the reducer dispatch ─────
      // The reducer clears state fields, but these refs hold data
      // outside React state and must be reset manually.
      // Abort any in-flight prompt-refinement call so it cannot
      // dispatch into the cleared session.
      enhanceAbortRef.current?.abort('session cleared');
      enhanceAbortRef.current = null;
      enhanceCancelledRef.current = true;
      enhanceOriginalRef.current = '';
      // Cancel a pending next-steps auto-submit timer so it cannot
      // fire a stale suggestion into the new session.
      if (nextStepsAutoSubmitTimerRef.current !== undefined) {
        clearInterval(nextStepsAutoSubmitTimerRef.current);
        nextStepsAutoSubmitTimerRef.current = undefined;
      }
      // Reset the auto-submit streak and loop guard so the new
      // session starts clean.
      autoSubmitStreakRef.current = 0;
      autoSubmitCapWarnedRef.current = false;
      autoSubmitLoopGuardRef.current.reset();
      // Delegate remaining ref cleanup (paste, prompt-usage,
      // next-steps suggestion) to the host callback.
      onAfterClear?.();
    }
  } catch (err) {
    // Old command failures are as stale as old successful results. Keep
    // failures of /clear itself visible when its reset already advanced
    // the generation, so persistence/teardown errors are not hidden.
    if (
      slashGeneration !== sessionGenerationRef.current &&
      !(cmd === 'clear' && sessionGenerationRef.current === slashGeneration + 1)
    )
      return;
    dispatch({
      type: 'addEntry',
      entry: { kind: 'error', text: toErrorMessage(err) },
    });
  }
  return;
}
