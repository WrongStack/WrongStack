import type { Director } from '@wrongstack/core/coordination';
import type { Action, State } from './app-reducer.js';
import { coerceAgentSwarmMode, coercePanelPositionMap } from './app-settings-type.js';
import { clearConfirmationKeyResult } from './components/clear-confirm-panel.js';
import { exitConfirmationDecision } from './components/exit-confirm-panel.js';
import type { KeyEvent } from './components/input.js';
import { DEFAULT_STATUSLINE_MODE } from './components/settings-picker.js';
import { slashConfirmationDecision } from './components/slash-confirm-panel.js';
import { escCloseAction } from './esc-close-panels.js';
import type { MutableCell } from './shared-types.js';
import type { SettingsCapabilities } from './tui-host-capabilities.js';

/**
 * Minimum time (ms) before the same Esc press is re-processed after a
 * steer/dismiss action. Prevents double-fire from repeated Esc events.
 */
const ESC_DISMISS_COOLDOWN_MS = 300;

interface PointerOverlayRoute {
  isOpen(state: State): boolean;
  cancel(state: State): Action;
}

/**
 * Pointer routing follows the same first-match order as `usePickerKeys`.
 * `helpPanel` is the slash-command browser, not the separate `helpOpen`
 * keyboard overlay. Keeping selection and cancellation in one table prevents
 * new pickers from gaining left-click support without right-click cleanup.
 */
const POINTER_OVERLAY_ROUTES: readonly PointerOverlayRoute[] = [
  { isOpen: (s) => s.authPanel.open, cancel: () => ({ type: 'authClose' }) },
  {
    isOpen: (s) => s.modelPicker.open,
    cancel: (s) =>
      s.modelPicker.step === 'model' ? { type: 'modelPickerBack' } : { type: 'modelPickerClose' },
  },
  { isOpen: (s) => s.modePicker.open, cancel: () => ({ type: 'modePickerClose' }) },
  { isOpen: (s) => s.autonomyPicker.open, cancel: () => ({ type: 'autonomyPickerClose' }) },
  { isOpen: (s) => s.themePicker.open, cancel: () => ({ type: 'themePickerClose' }) },
  { isOpen: (s) => s.designPicker.open, cancel: () => ({ type: 'designPickerClose' }) },
  { isOpen: (s) => s.promptPicker.open, cancel: () => ({ type: 'promptPickerClose' }) },
  { isOpen: (s) => s.resumePicker.open, cancel: () => ({ type: 'resumePickerClose' }) },
  { isOpen: (s) => s.settingsPicker.open, cancel: () => ({ type: 'settingsClose' }) },
  { isOpen: (s) => s.pluginPicker.open, cancel: () => ({ type: 'pluginPickerClose' }) },
  { isOpen: (s) => s.mcpPicker.open, cancel: () => ({ type: 'mcpPickerClose' }) },
  { isOpen: (s) => s.toolsPicker.open, cancel: () => ({ type: 'toolsPickerClose' }) },
  { isOpen: (s) => s.helpPanel.open, cancel: () => ({ type: 'helpClose' }) },
  { isOpen: (s) => s.brainPanel.open, cancel: () => ({ type: 'brainClose' }) },
  { isOpen: (s) => s.shadowPanel.open, cancel: () => ({ type: 'shadowClose' }) },
  { isOpen: (s) => s.statuslinePicker.open, cancel: () => ({ type: 'statuslineClose' }) },
  { isOpen: (s) => s.projectPicker.open, cancel: () => ({ type: 'projectPickerClose' }) },
  { isOpen: (s) => s.sessionsPanelOpen, cancel: () => ({ type: 'toggleSessionsPanel' }) },
  { isOpen: (s) => s.slashPicker.open, cancel: () => ({ type: 'slashPickerClose' }) },
  { isOpen: (s) => s.fKeyPicker.open, cancel: () => ({ type: 'fKeyPickerClose' }) },
  { isOpen: (s) => s.picker.open, cancel: () => ({ type: 'pickerClose' }) },
];

/**
 * Terminal geometry for pointer→key mapping. `viewportRows` is the managed
 * history band height; every selectable overlay renders BELOW it (see
 * hit-test.ts's layout contract), so a left press only maps to Enter when it
 * lands in that bottom region. Without this gate a stray click anywhere on
 * screen — including deep in the chat history — confirmed the focused item
 * of whatever picker happened to be open (worst case: the project picker,
 * where confirm triggers an exit-42 respawn).
 */
export interface PointerOverlayGeometry {
  termRows: number;
  viewportRows: number;
}

export function overlayPointerKey(
  state: State,
  input: string,
  key: KeyEvent,
  geometry: PointerOverlayGeometry,
): { isEnter: boolean; cancelAction: Action | null } {
  const route = POINTER_OVERLAY_ROUTES.find((candidate) => candidate.isOpen(state));
  const inBottomRegion =
    !!key.mouse && key.mouse.y > geometry.viewportRows && key.mouse.y <= geometry.termRows;
  const leftPress = key.mouse?.kind === 'press' && key.mouse.button === 'left' && inBottomRegion;
  const rightPress = key.mouse?.kind === 'press' && key.mouse.button === 'right';
  return {
    isEnter: key.return || input === '\r' || input === '\n' || (!!route && leftPress),
    cancelAction: route && rightPress ? route.cancel(state) : null,
  };
}

export interface BusyInterruptKeyHost {
  readonly state: State;
  readonly dismissedAt: MutableCell<number>;
  readonly streamingText: MutableCell<string>;
  readonly confirmExit: MutableCell<boolean>;
  readonly activeController: MutableCell<AbortController | null>;
  dispatch(action: Action): void;
  clearPendingConfirms(): void;
  liveDirector(): Director | null;
}

/**
 * Handle Esc-to-steer, including optional confirmation and fleet teardown.
 * Open panels never reach this: `handleKey` routes Esc through
 * `escCloseAction` / `escSelfOwnedPanelOpen` first, so by the time this
 * runs an Esc press really means "interrupt the run".
 */
export function routeBusyInterruptKey(host: BusyInterruptKeyHost, key: KeyEvent): boolean {
  const { state, dispatch } = host;
  if (
    !key.escape ||
    state.status === 'idle' ||
    state.confirmQueue.length > 0 ||
    Date.now() - host.dismissedAt.current <= ESC_DISMISS_COOLDOWN_MS
  ) {
    return false;
  }

  const runningTools = Array.from(state.runningTools.values()).map((tool) => tool.name);
  const subagents = Object.values(state.fleet)
    .filter((entry) => entry.status === 'running')
    .map((entry) => ({
      label: entry.name,
      status: entry.status,
      tool: entry.currentTool?.name,
    }));
  const subagentsTerminated = subagents.length;
  const snapshot = {
    runningTools,
    subagents,
    subagentsTerminated,
    partialAssistantText: host.streamingText.current.slice(-1500),
  };
  if (host.confirmExit.current) {
    dispatch({ type: 'escConfirmOpen', snapshot });
    return true;
  }

  host.activeController.current?.abort();
  host.clearPendingConfirms();
  dispatch({ type: 'status', status: 'aborting' });
  dispatch({ type: 'steerStart', snapshot });
  const director = host.liveDirector();
  if (director && subagentsTerminated > 0) {
    const cap = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      timer.unref?.();
    });
    void Promise.race([director.terminateAll().catch(() => undefined), cap]);
  }

  const droppedCount = state.queue.length;
  if (droppedCount > 0) dispatch({ type: 'queueClear' });
  const droppedTag = droppedCount > 0 ? ` · dropped ${droppedCount} queued` : '';
  const fleetTag =
    subagentsTerminated > 0
      ? ` · stopped ${subagentsTerminated} subagent${subagentsTerminated === 1 ? '' : 's'}`
      : '';
  dispatch({
    type: 'addEntry',
    entry: {
      kind: 'warn',
      text: `↯ Interrupted${droppedTag}${fleetTag}. Type your new direction.`,
    },
  });
  return true;
}

export interface ModalOverlayKeyHost {
  readonly state: State;
  readonly enhanceCancelled: MutableCell<boolean>;
  readonly enhanceController: MutableCell<AbortController | null>;
  dispatch(action: Action): void;
}

/** Route the modal overlay ladder that has precedence over every composer key. */
export function routeModalOverlayKey(
  host: ModalOverlayKeyHost,
  input: string,
  key: KeyEvent,
): boolean {
  const { state, dispatch } = host;
  if (state.status === 'aborting' && !state.steeringPending && state.interrupts === 0) return true;
  if (state.confirmQueue.length > 0 || state.shellCommandWarning || state.brainPrompt) return true;

  if (state.clearConfirm) {
    const info = state.clearConfirm;
    const result = clearConfirmationKeyResult(info.value, input, key);
    if (result.decision !== null) {
      dispatch({ type: 'clearConfirmClose' });
      info.resolve(result.decision);
    } else if (result.value !== info.value) {
      dispatch({ type: 'clearConfirmSetValue', value: result.value });
    }
    return true;
  }
  if (state.exitConfirm) {
    const info = state.exitConfirm;
    const decision = exitConfirmationDecision(input, key);
    if (decision !== null) {
      dispatch({ type: 'exitConfirmClose' });
      info.resolve(decision);
    }
    return true;
  }
  if (state.slashConfirm) {
    const info = state.slashConfirm;
    const decision = slashConfirmationDecision(input, key, info.defaultYes);
    if (decision !== null) {
      dispatch({ type: 'slashConfirmClose' });
      info.resolve(decision === 'cancel' ? null : decision);
    }
    return true;
  }
  // The remote topic check is a short, bounded pre-submit gate. Consume keys
  // while it owns the composer so a second Enter cannot duplicate the submit.
  if (state.topicCheckBusy) return true;
  if (state.enhanceBusy) {
    if (key.escape) {
      host.enhanceCancelled.current = true;
      host.enhanceController.current?.abort();
    }
    return true;
  }
  // The pre-refine grace countdown owns every key while it is up. Its own
  // useInput decides proceed/skip/cancel; the composer must not ALSO see the
  // key. It is the one modal that opens while `buffer` still holds the
  // submitted text (clearDraft runs after refinement), so a leaked Enter
  // re-submitted the same prompt and started a SECOND refine flow — two
  // PROMPT REFINER panels, one wedged at "refining in 0s…" forever because
  // its resolve was orphaned, permanently eating history viewport rows.
  if (
    state.refineCountdown ||
    state.enhance ||
    state.refineFailure ||
    state.continueConfirm ||
    state.escConfirm ||
    state.sendModePicker
  ) {
    return true;
  }
  // Overlays with their own useInput handler (broadcast delivery still
  // reaches them): consume everything centrally so Enter doesn't ALSO
  // submit the composer, arrows don't ALSO walk input history, and Esc
  // doesn't ALSO trigger the busy-interrupt ladder.
  //  - fallbackOverlay: Enter picks a model / Esc accepts auto-switch
  //    (fallback-overlay.tsx)
  //  - rewindOverlay: Enter performs a destructive session rewind
  //    (checkpoint-timeline.tsx)
  if (state.fallbackOverlay != null || state.rewindOverlay != null) {
    return true;
  }
  if (state.helpOpen) {
    if (key.escape || input === '?' || input === 'q') dispatch({ type: 'toggleHelp' });
    return true;
  }
  return false;
}

export interface SettingsOverlayKeyHost {
  readonly state: State;
  readonly getSettings: SettingsCapabilities['getSettings'];
  readonly saveSettings: SettingsCapabilities['saveSettings'];
  readonly lastEnterAt: MutableCell<number>;
  dispatch(action: Action): void;
}

/** Route the settings editor and its Ctrl+S open/close chord. */
export function routeSettingsOverlayKey(
  host: SettingsOverlayKeyHost,
  input: string,
  key: KeyEvent,
  isEnter: boolean,
): boolean {
  const { state, dispatch } = host;
  if (state.settingsPicker.open) {
    if (key.escape) dispatch({ type: 'settingsClose' });
    else if (key.upArrow) dispatch({ type: 'settingsFieldMove', delta: -1 });
    else if (key.downArrow) dispatch({ type: 'settingsFieldMove', delta: 1 });
    else if (key.leftArrow) dispatch({ type: 'settingsValueChange', delta: -1 });
    else if (key.rightArrow) dispatch({ type: 'settingsValueChange', delta: 1 });
    // Mouse clicks must not change settings — only ←/→ arrows.
    else if (key.mouse) {
      /* consume silently */
    } else if (isEnter) {
      const now = Date.now();
      if (now - host.lastEnterAt.current >= 50) {
        host.lastEnterAt.current = now;
        dispatch({ type: 'settingsValueChange', delta: 1 });
      }
    } else if (key.ctrl && input === 's') {
      // Ctrl+S while picker is open: close the picker (single dispatch site —
      // the outer Ctrl+S block below is only reached when the picker is closed,
      // so both paths dispatch settingsClose exactly once).
      dispatch({ type: 'settingsClose' });
    } else {
      // Consume all keys while the picker is open to prevent characters from
      // reaching the composer and being inserted into the draft invisibly.
      return true;
    }
    return true;
  }

  if (!(key.ctrl && input === 's')) return false;
  if (!host.getSettings || !host.saveSettings) return true;

  dispatch({ type: 'closeAllPanels' });
  const config = host.getSettings();
  dispatch({
    type: 'settingsOpen',
    mode: config.mode,
    delayMs: config.delayMs,
    titleAnimation: config.titleAnimation ?? true,
    yolo: config.yolo ?? false,
    fleetChat: config.fleetChatVerbosity ?? 'off',
    chime: config.chime ?? false,
    confirmExit: config.confirmExit ?? true,
    nextPrediction: config.nextPrediction ?? false,
    featureMcp: config.featureMcp ?? true,
    featurePlugins: config.featurePlugins ?? true,
    featureMemory: config.featureMemory ?? true,
    featureSkills: config.featureSkills ?? true,
    featureModelsRegistry: config.featureModelsRegistry ?? true,
    tokenSavingTier: config.featureTokenSaving ?? 'off',
    allowOutsideProjectRoot: config.allowOutsideProjectRoot ?? true,
    contextAutoCompact: config.contextAutoCompact ?? true,
    contextStrategy: config.contextStrategy ?? 'hybrid',
    contextMode: config.contextMode ?? 'balanced',
    maxConcurrent: config.maxConcurrent ?? 10,
    logLevel: config.logLevel ?? 'info',
    auditLevel: config.auditLevel ?? 'standard',
    indexOnStart: config.indexOnStart ?? true,
    multiDiffSummaryThreshold: config.multiDiffSummaryThreshold ?? 5,
    lastSettingsField: config.lastSettingsField ?? 0,
    maxIterations: config.maxIterations ?? 500,
    autoProceedMaxIterations: config.autoProceedMaxIterations ?? 50,
    enhanceDelayMs: config.enhanceDelayMs ?? 60_000,
    enhanceEnabled: config.enhanceEnabled ?? true,
    enhanceLanguage: config.enhanceLanguage ?? 'original',
    debugStream: config.debugStream ?? false,
    statuslineMode: config.statuslineMode ?? DEFAULT_STATUSLINE_MODE,
    reasoningMode: config.reasoningMode ?? 'auto',
    reasoningEffort: config.reasoningEffort ?? 'high',
    reasoningPreserve: config.reasoningPreserve ?? false,
    thinkingWord: config.thinkingWord ?? 'thinking',
    cacheTtl: config.cacheTtl ?? 'default',
    configScope: config.configScope ?? 'global',
    animationStyle: config.animationStyle ?? 'rainbow',
    breakerEnabled: config.breakerEnabled ?? false,
    breakerAutoKillResetMs: config.breakerAutoKillResetMs ?? 60_000,
    showModelReasoning: config.showModelReasoning ?? true,
    showAgentSwarmPanel: coerceAgentSwarmMode(config.showAgentSwarmPanel),
    // Migrate the legacy `showAgentSwarmPanel: 'sidebar'` tri-state into
    // the new per-panel `panelPositions.fleet` map so users with old
    // configs don't lose their sidebar routing. The legacy field governed
    // the FleetPanel swarm (F2), not the F3 agents monitor — mapping to
    // `agents` would double-render both surfaces.
    //
    // Only migrate when the per-panel key is UNDEFINED — the new field
    // is an independent toggle that persists verbatim, so an explicit
    // `panelPositions.fleet: 'bottom'` must NOT be reverted to
    // `'sidebar'` on every Ctrl+S open.
    panelPositions: coercePanelPositionMap({
      ...config.panelPositions,
      ...(coerceAgentSwarmMode(config.showAgentSwarmPanel) === 'sidebar' &&
      config.panelPositions?.fleet === undefined
        ? { fleet: 'sidebar' as const }
        : {}),
    }),
    showSageMemoryInject: config.showSageMemoryInject ?? false,
    sageMemoryInjectThreshold: config.sageMemoryInjectThreshold ?? 0.85,
    nextStepsTool: config.nextStepsTool ?? false,
    readSymbols: config.readSymbols ?? false,
    // WrongProxy / WrongTrace: hydrate from the persisted Config (CLI
    // adapter owns the read/write — see LiveSettingsInput + the
    // tui-settings-adapter.ts branch tree).
    wrongProxyEnabled: config.wrongProxyEnabled ?? false,
    wrongProxyUrl: config.wrongProxyUrl ?? 'http://localhost:3444',
  });
  return true;
}

/**
 * Close the highest-priority panel on Esc and keep ProcessList modal.
 * `processListOnBottom` carries the panel-position routing: when the process
 * list is routed to the sidebar its modal `useInput` never mounts, so
 * swallowing every key here froze the composer with no visible panel.
 */
export function routePanelEscapeKey(
  state: State,
  key: KeyEvent,
  dispatch: (action: Action) => void,
  processListOnBottom: boolean,
): boolean {
  if (key.escape) {
    const action = escCloseAction(state);
    if (action) {
      dispatch(action);
      return true;
    }
  }
  return state.processListOpen && processListOnBottom;
}
