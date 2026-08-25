import { expectDefined } from '@wrongstack/core/utils';
import type React from 'react';
import { useMemo } from 'react';
import {
  computeTokenFingerprint,
  useChipStalenessGuard,
} from '../hooks/use-chip-staleness-guard.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { useTodosAutoClear } from '../hooks/use-todos-auto-clear.js';
import { useTokenCounterRefresh } from '../hooks/use-token-counter-refresh.js';
import { Box, Text, useAnimation } from '../ink.js';
import { theme } from '../theme.js';
import type { AnimationStyle } from './animation-style.js';
import { computeRailSpans, PowerlineRail } from './powerline-rail.js';
import { ThinkingChip } from './status-bar-chips.js';
import {
  hasTokenDisplay,
  stateChip,
  tokenDisplayTotals,
} from './status-bar-format.js';
import {
  countdownColor,
  hasMailboxActivity,
  isStreamChipVisible,
} from './status-bar-helpers.js';
import {
  COMPACT_THRESHOLD,
  LINE_BG_COLORS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  STACK_ORANGE,
  STATUSLINE_ICONS,
} from './status-bar-icons.js';
import {
  buildConnectivityChipEntries,
  buildIndexStatusChip,
  buildMemoryDetailChips,
  buildMinimumChips,
  buildPrimaryChips,
  buildRunStateChipEntries,
  buildWorkRowEntries,
  buildWorkspaceChipEntries,
  type StatusBarRailBuildParams,
} from './status-bar-rails.js';
import type { StatusBarProps } from './status-bar-types.js';
import type { StatuslineItem } from './statusline-picker.js';

export {
  contextBarColor,
  fmtElapsed,
  hasTokenDisplay,
  nodeText,
  planChipFit,
  renderMeter,
  renderProgress,
  stateChip,
  type TokenDisplayTotals,
  tokenDisplayTotals,
  truncateChip,
} from './status-bar-format.js';

export {
  chipColor,
  COMPACT_THRESHOLD,
  LINE_BG_COLORS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  STACK_ORANGE,
  STATUSLINE_ICONS,
} from './status-bar-icons.js';

export type {
  BrainStatusChip,
  ContextWindow,
  FleetAgentDetail,
  FleetCounts,
  MailboxStatus,
  PlanCounts,
  StatusBarProps,
  TaskCounts,
  TodoCounts,
} from './status-bar-types.js';

/**
 * Two-line status bar. The first line stays compact and shows the
 * workspace route followed by provider/model, context, tokens, cost, queue,
 * and other runtime essentials. The second line opts in only when there's actually something
 * to show — git branch, elapsed time, todo counts, YOLO marker — so a
 * vanilla session keeps the original single-line footprint.
 */
export function StatusBar({
  model,
  provider,
  version,
  latestVersion,
  updateAvailable,
  state,
  thinkingWord,
  thinkingAnimationStyle,
  tokenCounter,
  hint,
  queueCount = 0,
  yolo = false,
  autonomy,
  fleetWorkingTime,
  todos,
  plan,
  tasks,
  fleet,
  fleetAgents,
  git,
  subagentCount = 0,
  brain,
  projectName,
  workingDir,
  processCount,
  context,
  estimatedContextTokens,
  Sage,
  memoryContextMonitor,
  contextStrategy,
  hiddenItems,
  mode = 'detailed',
  events,
  sessionId,
  eternalStage,
  goalSummary,
  droppedTools,
  indexState,
  breakerCountdown,
  modeLabel,
  promptVariant,
  themeName,
  debugStreamStats,
  enhanceCountdown,
  nextStepsAutoSubmitCountdown,
  nextStepsAutoSubmitLabel,
  autoProceedCountdown,
  sessionCount,
  mailbox,
  tokenSavingMode,
  toolCount,
  visibleChips = [],
  sideEffectCount = 0,
  maxWidth,
  clickMapRef,
}: StatusBarProps): React.ReactElement {
  const { columns: termWidth } = useTerminalSize({ maxWidth, fallbackColumns: 90 });

  const isCompact = termWidth < COMPACT_THRESHOLD;
  const isNoColor = mode === 'no-color';
  const hiddenSet = useMemo(() => new Set(hiddenItems), [hiddenItems]);
  const showChip = (item: StatuslineItem): boolean => !hiddenSet.has(item);

  const tokenData = useTokenCounterRefresh(tokenCounter, events, sessionId);
  const usage = tokenData?.usage;
  const displayTokens = tokenDisplayTotals(
    usage,
    tokenData?.currentRequest,
    estimatedContextTokens,
  );
  const showTokenDisplay = hasTokenDisplay(displayTokens);
  const cost = tokenData?.cost;
  const cache = tokenData?.cacheStats;

  const animationActive = state !== 'idle' && state !== 'aborting';
  const { frame: spinnerIdx, time: animationTime } = useAnimation({
    interval: SPINNER_INTERVAL_MS,
    isActive: animationActive,
  });
  const spinner = expectDefined(SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length]);

  const tokenFingerprint = computeTokenFingerprint(
    displayTokens.input,
    displayTokens.output,
    cost?.total,
  );
  const stalenessGuard = useChipStalenessGuard({
    agentState: state,
    spinnerPhase: spinnerIdx,
    tokenFingerprint,
    contextRatio: context && context.max > 0 ? context.used / context.max : undefined,
    tokenSubscriptionActive: events != null,
  });

  const todosCleared = useTodosAutoClear(todos);

  const animationStyle: AnimationStyle | 'cycle' = thinkingAnimationStyle ?? 'rainbow';
  const cycleTick = Math.floor(animationTime / 1000);

  const { label: stateLabel, color: stateColor } = stateChip(
    state,
    fleet?.running ?? 0,
    thinkingWord,
  );
  const statePrefix =
    state === 'idle' || state === 'aborting' ? '●' : animationStyle === 'static' ? '●' : spinner;
  const thinking = state === 'running' || state === 'streaming';

  const hasAutoProceed = autoProceedCountdown != null && autoProceedCountdown > 0;

  const fleetHasActivity =
    (fleet && (fleet.running > 0 || fleet.idle > 0 || fleet.pending > 0 || fleet.completed > 0)) ||
    subagentCount > 0;
  const showBrain = isStreamChipVisible('brain', brain, hiddenSet, visibleChips);
  const showDebugStream = isStreamChipVisible(
    'debug_stream',
    debugStreamStats,
    hiddenSet,
    visibleChips,
  );
  const showEnhance = isStreamChipVisible('enhance', enhanceCountdown, hiddenSet, visibleChips);
  const showMailbox = showChip('mailbox') && hasMailboxActivity(mailbox);
  const hasNextStepsAutoSubmit =
    nextStepsAutoSubmitCountdown != null && nextStepsAutoSubmitCountdown > 0;

  const nextStepsColor =
    nextStepsAutoSubmitCountdown != null
      ? countdownColor(nextStepsAutoSubmitCountdown, 20, 10)
      : theme.success;

  const hasTaskActivity =
    tasks &&
    (tasks.pending > 0 ||
      tasks.inProgress > 0 ||
      tasks.completed > 0 ||
      tasks.blocked > 0 ||
      tasks.failed > 0);

  const minimalWorkParts = [
    queueCount > 0 && showChip('queue') ? `q${queueCount}` : '',
    todos && showChip('todos') && todos.inProgress + todos.pending > 0
      ? `todo ${todos.inProgress}/${todos.pending}`
      : '',
    hasTaskActivity && showChip('tasks') ? `task ${tasks!.inProgress}/${tasks!.pending}` : '',
    fleetHasActivity && showChip('fleet')
      ? fleet
        ? `agent ▶${fleet.running} ·${fleet.idle}`
        : `agent ${subagentCount}`
      : '',
    processCount != null && processCount > 0 && showChip('processes')
      ? `${STATUSLINE_ICONS.processes} ${processCount}`
      : '',
  ].filter(Boolean);

  const stateStatusChip =
    showChip('state') && thinking ? (
      <ThinkingChip
        text={`${statePrefix} ${stateLabel}`}
        style={animationStyle}
        phase={spinnerIdx}
        cycleTick={cycleTick}
      />
    ) : showChip('state') ? (
      <Text color={isNoColor ? undefined : stateColor}>
        {statePrefix} {stateLabel}
      </Text>
    ) : null;

  const modelStatusChip = showChip('model') ? (
    <Text color={isNoColor ? undefined : theme.monitor.agents}>
      {provider ? <Text dimColor>{provider}/</Text> : null}
      {model}
    </Text>
  ) : null;

  const indexStatusChip = buildIndexStatusChip(indexState, showChip, isNoColor);

  const memoryDetailChips = showChip('memory_context')
    ? buildMemoryDetailChips(memoryContextMonitor, Sage, isNoColor)
    : [];

  const buildParams: StatusBarRailBuildParams = {
    showChip,
    isNoColor,
    model,
    provider,
    version,
    latestVersion,
    updateAvailable,
    yolo,
    autonomy,
    processCount,
    stateStatusChip,
    fleetWorkingTime,
    primaryChips: [],
    context,
    contextStrategy,
    showTokenDisplay,
    displayTokens,
    cost,
    cache,
    queueCount,
    hint,
    breakerCountdown,
    projectName,
    workingDir,
    git,
    modeLabel,
    themeName,
    sessionCount,
    toolCount,
    tokenSavingMode,
    sideEffectCount,
    todos,
    todosCleared,
    plan,
    tasks,
    hasTaskActivity,
    fleet,
    fleetHasActivity,
    subagentCount,
    showBrain,
    brain,
    showDebugStream,
    debugStreamStats,
    showEnhance,
    enhanceCountdown,
    hasNextStepsAutoSubmit,
    nextStepsAutoSubmitCountdown,
    nextStepsAutoSubmitLabel,
    nextStepsColor,
    showEternalStage: eternalStage != null && showChip('eternal_stage'),
    eternalStage,
    hasActiveGoal: goalSummary != null && showChip('goal'),
    goalSummary,
    hasAutoProceed,
    autoProceedCountdown,
    droppedTools,
    mailbox,
    fleetAgents,
    showMailbox,
    memoryDetailChips,
    promptVariant,
    minimalWorkParts,
    thinking,
    statePrefix,
    stateLabel,
    stateColor,
    animationStyle,
    spinnerIdx,
    cycleTick,
    memoryContextMonitor,
    Sage,
    indexState,
  };

  const primaryChips = buildPrimaryChips(buildParams);
  buildParams.primaryChips = primaryChips;

  const workspaceChipEntries = buildWorkspaceChipEntries(buildParams, modelStatusChip);
  const runStateChipEntries = buildRunStateChipEntries(buildParams);
  const workspaceChips = workspaceChipEntries.map((entry) => entry.node);
  const runStateChips = runStateChipEntries.map((entry) => entry.node);

  const showUpdateNotice =
    Boolean(updateAvailable) &&
    typeof latestVersion === 'string' &&
    latestVersion.length > 0 &&
    latestVersion !== version;
  const versionStatusChip =
    version && showChip('version') ? (
      <Text>
        <Text color={isNoColor ? undefined : theme.textSecondary} dimColor={!isNoColor}>
          v{version}
        </Text>
        {showUpdateNotice ? (
          <Text color={isNoColor ? undefined : STACK_ORANGE}> · (update v{latestVersion})</Text>
        ) : null}
      </Text>
    ) : null;

  const minimumChips = buildMinimumChips(buildParams);

  const workRowEntries = buildWorkRowEntries(buildParams);
  const workRowChips = workRowEntries.map((entry) => entry.node);

  // Line 3 gate — active work & countdowns only. Derived from the entries
  // themselves because every entry already applies its own showChip gate —
  // so a hidden chip (e.g. droppedTools > 0 with 'dropped_tools' toggled
  // off) can never open an empty rail. Connectivity chips (mailbox, fleet,
  // brain, debug_stream) live on line 4 and never open this rail.
  const hasWorkActivity = workRowEntries.length > 0;

  // Line 4 gate — fleet, connectivity & background services.
  const connectivityEntries = buildConnectivityChipEntries(buildParams);
  const connectivityChips = connectivityEntries.map((entry) => entry.node);
  const hasConnectivityActivity = connectivityChips.length > 0;

  // Click-map: physical lines are 0 (L1 workspace), 1 (L2 run state) —
  // unconditional rails — and 2/3 only when their conditional rails render.
  // Model/autonomy/state/todos hit targets now live on these physical lines.
  if (clickMapRef) {
    const railBudget = Math.max(12, termWidth);
    const clickLines = [
      {
        line: 0,
        spans: computeRailSpans(
          isCompact ? workspaceChipEntries.slice(0, 5) : workspaceChipEntries,
          railBudget,
          versionStatusChip,
        ),
      },
      {
        line: 1,
        spans: computeRailSpans(runStateChipEntries, railBudget),
      },
    ];
    if (hasWorkActivity) {
      clickLines.push({ line: 2, spans: computeRailSpans(workRowEntries, railBudget) });
    }
    if (hasConnectivityActivity) {
      // The connectivity rail renders directly below the work rail; when the
      // work rail is gated off, connectivity physically sits on line 2.
      clickLines.push({
        line: hasWorkActivity ? 3 : 2,
        spans: computeRailSpans(connectivityEntries, railBudget),
      });
    }
    clickMapRef.current =
      mode === 'minimum' ? { lines: [] } : { lines: clickLines };
  }

  if (mode === 'minimum') {
    return (
      <Box key={`sb-${stalenessGuard.renderNonce}`} flexDirection="column" paddingX={1}>
        <PowerlineRail
          segments={minimumChips}
          rightAnchor={versionStatusChip}
          budget={Math.max(12, termWidth)}
          monochrome={isNoColor}
          fillBg={LINE_BG_COLORS[0]}
        />
      </Box>
    );
  }

  return (
    <Box key={`sb-${stalenessGuard.renderNonce}`} flexDirection="column" paddingX={0}>
      {/* Line 1 — Workspace & identity */}
      <PowerlineRail
        segments={isCompact ? workspaceChips.slice(0, 5) : workspaceChips}
        rightAnchor={versionStatusChip}
        budget={Math.max(12, termWidth)}
        monochrome={isNoColor}
        fillBg={LINE_BG_COLORS[0]}
      />

      {/* Line 2 — Run state & safety */}
      <PowerlineRail
        segments={runStateChips}
        budget={Math.max(12, termWidth)}
        monochrome={isNoColor}
        fillBg={LINE_BG_COLORS[1]}
      />

      {/* Line 3 — Active work & countdowns */}
      {hasWorkActivity ? (
        <PowerlineRail
          segments={workRowChips}
          budget={Math.max(12, termWidth)}
          monochrome={isNoColor}
          fillBg={LINE_BG_COLORS[2]}
        />
      ) : null}

      {/* Line 4 — Fleet, connectivity & background services */}
      {hasConnectivityActivity || indexStatusChip ? (
        <PowerlineRail
          segments={connectivityChips}
          rightAnchor={indexStatusChip}
          budget={Math.max(12, termWidth)}
          monochrome={isNoColor}
          fillBg={LINE_BG_COLORS[3]}
        />
      ) : null}
    </Box>
  );
}
