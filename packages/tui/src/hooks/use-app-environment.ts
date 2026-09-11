import path from 'node:path';
import type { Dispatch } from 'react';
import React, { useEffect, useRef } from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';
import { resolveAppSidebarLayout } from '../app-ui-state.js';
import { useActiveTheme } from './use-active-theme.js';
import type { AppRefSpine } from './use-app-ref-spine.js';
import { useAutonomyDrivers } from './use-autonomy-drivers.js';
import { useGitSessionStatus } from './use-git-session-status.js';
import { useHistoryViewportSync } from './use-history-viewport-sync.js';
import { useLiveSettingsState } from './use-live-settings-state.js';
import { useMouseTracking } from './use-mouse-tracking.js';
import { useSettingsAutoSave } from './use-settings-auto-save.js';
import { useStatusSyncInterval } from './use-status-sync-interval.js';
import { useStatuslineHiddenSync, useStatuslineLayoutSync } from './use-statusline-hidden-sync.js';
import { useStreamChipExpiration } from './use-stream-chip-expiration.js';
import { useThemeState } from './use-theme-state.js';
import { useTuiActivity } from './use-tui-activity.js';
import { useTuiEnvironmentState } from './use-tui-environment-state.js';
import { useWorkingDirChip } from './use-working-dir-chip.js';

export interface AppEnvironmentDeps
  extends Pick<
    AppProps,
    | 'agent'
    | 'attachments'
    | 'configStore'
    | 'events'
    | 'memoryStore'
    | 'model'
    | 'provider'
    | 'effectiveMaxContext'
    | 'yolo'
    | 'getAutonomy'
    | 'modeLabel'
    | 'statuslineHiddenItems'
    | 'toolCount'
    | 'getSettings'
    | 'setStatuslineHiddenItems'
    | 'saveStatuslineHiddenItems'
    | 'statuslineLines'
    | 'titleController'
    | 'chime'
    | 'confirmExit'
    | 'getYolo'
    | 'getModeLabel'
    | 'getEternalEngine'
    | 'getParallelEngine'
    | 'switchAutonomy'
    | 'subscribeEternalIteration'
    | 'subscribeEternalStage'
    | 'getLiveSessions'
    | 'mouse'
    | 'capability'
    | 'saveSettings'
  > {
  state: State;
  dispatch: Dispatch<Action>;
  mailboxPanelOpen: boolean;
  yolo: boolean;
  chime: NonNullable<AppProps['chime']>;
  confirmExit: NonNullable<AppProps['confirmExit']>;
  mouse: NonNullable<AppProps['mouse']>;
  capability: AppProps['capability'];
  stateRef: AppRefSpine['stateRef'];
  builderRef: AppRefSpine['builderRef'];
  eternalLoopRunningRef: AppRefSpine['eternalLoopRunningRef'];
  parallelLoopRunningRef: AppRefSpine['parallelLoopRunningRef'];
  stdout: NodeJS.WriteStream;
}

/**
 * Facade: theme, environment state, live settings, activity display,
 * layout, mouse/viewport state, and the status sync loop.
 *
 * TUI decomposition Phase 4 A2 (docs/decomposition-a0-app-map.md). Owns
 * useActiveTheme/useThemeState, the useTuiEnvironmentState block, the
 * lines/densities mirrors, projectRoot/projectName/workingDirChip,
 * useLiveSettingsState, the sidebar layout derivation (takes
 * mailboxPanelOpen — the mailbox VM stays with the bridges), the title
 * sync effect, useTuiActivity (moved from execution — its
 * refreshGoalSummary feeds the autonomy drivers here), mouse tracking,
 * history viewport sync, the autonomy drivers + status sync interval
 * (moved from execution — status sync consumes the driver refs),
 * statusline hidden/layout syncs, stream chip expiration, git session
 * status, and settings auto-save.
 *
 * Call-order contract: after `useAppState` (needs `state`) and the ref
 * spine; before consumers of `environment`, layout, mouse, and viewport
 * state. Fixed and unconditional (behavior contract §0.3 of
 * docs/decomposition-plan.md).
 */
export function useAppEnvironment(deps: AppEnvironmentDeps) {
  const {
    agent,
    attachments,
    configStore,
    state,
    dispatch,
    stdout,
    mailboxPanelOpen,
    events,
    memoryStore,
    model,
    provider,
    effectiveMaxContext,
    yolo,
    getAutonomy,
    modeLabel,
    statuslineHiddenItems,
    toolCount,
    getSettings,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    statuslineLines,
    titleController,
    chime,
    confirmExit,
    getYolo,
    getModeLabel,
    getEternalEngine,
    getParallelEngine,
    switchAutonomy,
    subscribeEternalIteration,
    subscribeEternalStage,
    getLiveSessions,
    mouse,
    capability,
    saveSettings,
    stateRef,
    builderRef,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
  } = deps;

  useActiveTheme();
  useThemeState({ configStore });

  const environment = useTuiEnvironmentState({
    events,
    memoryStore,
    model,
    provider,
    effectiveMaxContext,
    yolo,
    getAutonomy,
    modeLabel,
    statuslineHiddenItems,
    toolCount,
    getSettings,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    statuslineLines,
  });
  const {
    liveModel,
    setLiveModel,
    liveProvider,
    setLiveProvider,
    yoloLive,
    setYoloLive,
    autonomyLive,
    setAutonomyLive,
    liveModeLabel,
    setLiveModeLabel,
    hiddenItems,
    setHiddenItems,
    lines,
    setLines,
    densities,
    setDensities,
    setSessionCount,
    hiddenItemsRef,
    setMemoryContextMonitor,
    memoryContextMonitorRef,
    memoryRecordTotalRef,
    setLiveToolCount,
  } = environment;

  // Latest layout, readable from the picker-open callback without making it
  // depend on (and re-create for) every layout keystroke.
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const densitiesRef = useRef(densities);
  densitiesRef.current = densities;

  const projectRoot = agent.ctx.projectRoot;
  const projectName = React.useMemo(() => {
    const base = path.basename(projectRoot);
    return base && base !== path.sep ? base : undefined;
  }, [projectRoot]);

  const workingDirChip = useWorkingDirChip(agent.ctx, projectRoot);

  const {
    liveSettings,
    liveStatuslineMode,
    liveAnimationStyle,
    liveThinkingWord,
    chimeRef,
    confirmExitRef,
  } = useLiveSettingsState({ getSettings, titleController, chime, confirmExit });

  const sidebarLayout = resolveAppSidebarLayout(
    state,
    stdout?.columns ?? 80,
    liveSettings,
    mailboxPanelOpen,
  );

  useEffect(() => {
    titleController?.setModel(liveModel);
  }, [titleController, liveModel]);

  const activity = useTuiActivity({
    status: state.status,
    fleet: state.fleet,
    enhanceBusy: state.enhanceBusy,
    thinkingWord: liveThinkingWord,
    projectRoot,
    stateRef,
    agentContext: agent.ctx,
    dispatch,
    attachments,
    builderRef,
  });
  const { refreshGoalSummary } = activity;

  useStatuslineHiddenSync({
    pickerOpen: state.statuslinePicker.open,
    pickerHidden: state.statuslinePicker.hiddenItems,
    hiddenItems,
    setHiddenItems: (items) => setHiddenItems(items as typeof hiddenItems),
  });

  useStatuslineLayoutSync({
    pickerOpen: state.statuslinePicker.open,
    layoutSeeded: state.statuslinePicker.layoutSeeded,
    pickerLines: state.statuslinePicker.lines,
    pickerDensities: state.statuslinePicker.densities,
    lines,
    densities,
    setLines,
    setDensities,
  });

  useStreamChipExpiration({
    brainPrompt: state.brainPrompt,
    enhance: state.enhance,
    visibleChips: state.statuslinePicker.visibleChips,
    dispatch,
  });

  const { runEternalLoopRef, runParallelLoopRef } = useAutonomyDrivers({
    getEternalEngine,
    getParallelEngine,
    getAutonomy,
    switchAutonomy,
    subscribeEternalIteration,
    subscribeEternalStage,
    refreshGoalSummary,
    autonomyLive,
    setAutonomyLive,
    dispatch,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
  });

  useStatusSyncInterval({
    getAutonomy,
    getYolo,
    getModeLabel,
    getEternalEngine,
    getParallelEngine,
    agent,
    autonomyLive,
    yoloLive,
    liveModeLabel,
    liveModel,
    liveProvider,
    setAutonomyLive,
    setYoloLive,
    setLiveModeLabel,
    setLiveModel,
    setLiveProvider,
    runEternalLoopRef,
    runParallelLoopRef,
  });

  const gitInfo = useGitSessionStatus({ agent, getLiveSessions, setSessionCount, hiddenItems });

  useSettingsAutoSave(state, saveSettings, dispatch);

  const { mouseMode, setMouseMode, nativeMouse, setNativeMouse } = useMouseTracking({
    initialMouseMode: mouse,
    initialNativeMouse: getSettings?.().mouseNative,
    overlayOpen: sidebarLayout.overlayOpen,
    protocol: capability?.mouseProtocol,
    stdout,
  });

  const { bottomRegionRef, statusBarWrapRef, belowStatusBarRef, termRows, statusBarRows } =
    useHistoryViewportSync({
      stdoutRows: stdout?.rows,
      viewportRows: state.viewportRows,
      setViewportRows: (rows) => dispatch({ type: 'setViewportRows', rows }),
    });

  return {
    environment,
    activity,
    refreshGoalSummary,
    linesRef,
    densitiesRef,
    projectRoot,
    projectName,
    workingDirChip,
    liveSettings,
    liveStatuslineMode,
    liveAnimationStyle,
    liveThinkingWord,
    chimeRef,
    confirmExitRef,
    sidebarLayout,
    mouseMode,
    setMouseMode,
    nativeMouse,
    setNativeMouse,
    bottomRegionRef,
    statusBarWrapRef,
    belowStatusBarRef,
    termRows,
    statusBarRows,
    gitInfo,
    runEternalLoopRef,
    runParallelLoopRef,
    hiddenItems,
    setHiddenItems,
    hiddenItemsRef,
    setMemoryContextMonitor,
    memoryContextMonitorRef,
    memoryRecordTotalRef,
    setLiveToolCount,
  };
}

/** Convenience type: the facade's return (consumed by the App destructure). */
export type AppEnvironment = ReturnType<typeof useAppEnvironment>;
