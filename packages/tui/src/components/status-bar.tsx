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
  buildIndexStatusChip,
  buildMemoryDetailChips,
  buildMinimumChips,
  buildPrimaryChips,
  type StatusBarRailBuildParams,
} from './status-bar-rails.js';
import { buildDetailedRails, type DetailedRail } from './status-line-registry.js';
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

export { chipColor, SPINNER_INTERVAL_MS, STACK_ORANGE, STATUSLINE_ICONS } from './status-bar-icons.js';;

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
 * Four-rail status bar — one semantic question per line, left-to-right in
 * descending importance:
 *
 *  L1 workspace & identity (static): project, working_dir, git, model, mode,
 *     prompt_variant, theme, sessions, tools; version right-anchored.
 *  L2 run state, safety & vitals (live): state, yolo, autonomy,
 *     eternal_stage, breaker, ctx·tokens·cost·cache, queue, processes,
 *     elapsed, token_saving, side_effects; hint last (first dropped).
 *  L3 active work & countdowns (conditional): goal, todos, plan, tasks,
 *     next_steps, auto_proceed, enhance, dropped_tools.
 *  L4 fleet, connectivity & services (conditional): fleet, mailbox, brain,
 *     debug_stream, memory; index right-anchored.
 *
 * L3/L4 gates derive from the rendered entries themselves, so an empty rail
 * never renders and a vanilla session keeps its two-line footprint.
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
  statuslineLines,
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

  // Four detailed rails: the builders remain the single source of chip JSX
  // and data gating (a hidden or data-less chip emits no entry and can never
  // open a rail); the registry partitions the surviving entries per the
  // user's line assignment. With no overrides this is exactly the
  // pre-registry four-rail composition pinned by the rail-order suites.
  const detailedRails = buildDetailedRails(buildParams, {
    lines: statuslineLines,
    modelChip: modelStatusChip,
    versionChip: versionStatusChip,
    indexChip: indexStatusChip,
  });

  // Rails 1–2 always render so a vanilla session keeps its two-line
  // footprint; conditional rails render when they have content. The index
  // chip alone opens the services rail (right-anchored, no left chips).
  const rendersRail = (rail: DetailedRail, logical: number): boolean =>
    logical < 2 || rail.entries.length > 0 || rail.rightAnchor != null;

  // Click-map: physical rows are the rails that publish left spans, top to
  // bottom — conditional rows shift up when an earlier rail is gated off
  // (the separators suite pins fleet's physical line for exactly this).
  // Right-anchored chips carry no left spans, so an anchor-only rail
  // publishes no row.
  if (clickMapRef) {
    const railBudget = Math.max(12, termWidth);
    const clickableRails = detailedRails.filter(
      (rail, logical) => logical < 2 || rail.entries.length > 0,
    );
    clickMapRef.current =
      mode === 'minimum'
        ? { lines: [] }
        : {
            lines: clickableRails.map((rail, physical) => ({
              line: physical,
              spans: computeRailSpans(
                physical === 0 && isCompact ? rail.entries.slice(0, 5) : rail.entries,
                railBudget,
                rail.rightAnchor,
              ),
            })),
          };
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
      {/* Logical rails 1–4: workspace & identity, run state & safety, active
          work & countdowns, fleet/connectivity & services. Conditional rails
          drop out when empty; the click-map renumbers physical rows to match. */}
      {detailedRails.map((rail, logical) =>
        rendersRail(rail, logical) ? (
          <PowerlineRail
            key={`rail-${logical}`}
            segments={
              logical === 0 && isCompact
                ? rail.entries.slice(0, 5).map((entry) => entry.node)
                : rail.entries.map((entry) => entry.node)
            }
            rightAnchor={rail.rightAnchor}
            budget={Math.max(12, termWidth)}
            monochrome={isNoColor}
            fillBg={LINE_BG_COLORS[logical as 0 | 1 | 2 | 3]}
          />
        ) : null,
      )}
    </Box>
  );
}
