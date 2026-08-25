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
import { getActiveThemeName, theme } from '../theme.js';
import type { AnimationStyle } from './animation-style.js';
import { computeRailSpans, PowerlineRail } from './powerline-rail.js';
import { ThinkingChip } from './status-bar-chips.js';
import {
  hasTokenDisplay,
  stateChip,
  tokenDisplayTotals,
  truncateChip,
} from './status-bar-format.js';
import {
  countdownColor,
  hasMailboxActivity,
  isStreamChipVisible,
  modeIcon,
} from './status-bar-helpers.js';
import {
  chipColor,
  COMPACT_THRESHOLD,
  LINE_BG_COLORS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  STACK_ORANGE,
  STATUSLINE_ICONS,
} from './status-bar-icons.js';
import {
  buildIndexStatusChip,
  buildMailboxDetailChips,
  buildMemoryDetailChips,
  buildMinimumChips,
  buildModeChipEntries,
  buildPrimaryChips,
  buildWorkRowEntries,
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

  const memoryDetailChips = buildMemoryDetailChips(memoryContextMonitor, Sage, isNoColor);
  const hasMemoryDetail = (memoryContextMonitor?.latest != null || Sage != null) && showChip('memory_context');

  const detailChips = buildMailboxDetailChips(
    mailbox,
    showMailbox,
    isNoColor,
    fleetAgents,
    showChip('fleet_agents'),
  );

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
    detailChips,
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

  const modeChipEntries = buildModeChipEntries(buildParams, modelStatusChip);
  const modeChips = modeChipEntries.map((entry) => entry.node);

  const showUpdateNotice =
    Boolean(updateAvailable) &&
    typeof latestVersion === 'string' &&
    latestVersion.length > 0 &&
    latestVersion !== version;
  const versionStatusChip = version ? (
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

  const hasWorkActivity =
    (todos &&
      (todos.pending > 0 || todos.inProgress > 0 || (todos.completed > 0 && !todosCleared))) ||
    (plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0)) ||
    hasTaskActivity ||
    fleetHasActivity ||
    showBrain ||
    showDebugStream ||
    showEnhance ||
    hasNextStepsAutoSubmit ||
    buildParams.hasActiveGoal ||
    hasAutoProceed ||
    buildParams.showEternalStage ||
    detailChips.length > 0;

  const workRowEntries = buildWorkRowEntries(buildParams);
  const workRowChips = workRowEntries.map((entry) => entry.node);

  if (clickMapRef) {
    const railBudget = Math.max(12, termWidth);
    clickMapRef.current =
      mode === 'minimum'
        ? { lines: [] }
        : {
            lines: [
              {
                line: 0,
                spans: computeRailSpans(
                  isCompact ? modeChipEntries.slice(0, 5) : modeChipEntries,
                  railBudget,
                  versionStatusChip,
                ),
              },
              ...(hasWorkActivity
                ? [{ line: 2, spans: computeRailSpans(workRowEntries, railBudget) }]
                : []),
            ],
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
      {/* Line 1 — Runtime + mode chips */}
      <PowerlineRail
        segments={isCompact ? modeChips.slice(0, 5) : modeChips}
        rightAnchor={versionStatusChip}
        budget={Math.max(12, termWidth)}
        monochrome={isNoColor}
        fillBg={LINE_BG_COLORS[0]}
      />

      {/* Line 2 — Session context */}
      <PowerlineRail
        segments={[
          projectName && showChip('project') ? (
            <Text color={chipColor(theme.accent, isNoColor)}>
              {isNoColor
                ? truncateChip(projectName, 24)
                : `${STATUSLINE_ICONS.project} ${truncateChip(projectName, 24)}`}
            </Text>
          ) : null,
          workingDir && showChip('working_dir') ? (
            <Text color={chipColor(theme.accent, isNoColor)}>
              {isNoColor
                ? truncateChip(workingDir, 28)
                : `${STATUSLINE_ICONS.working_dir} ${truncateChip(workingDir, 28)}`}
            </Text>
          ) : null,
          git && showChip('git') ? (
            <Text>
              <Text color={theme.monitor.agents}>
                {STATUSLINE_ICONS.git} {truncateChip(git.branch, 24)}
              </Text>
              {git.deleted > 0 ? <Text color={theme.error}> -{git.deleted}</Text> : null}
              {git.untracked > 0 ? <Text dimColor={!isNoColor}> ?{git.untracked}</Text> : null}
            </Text>
          ) : null,
          modeLabel && showChip('mode') ? (
            <Text color={chipColor(theme.accent, isNoColor)}>
              {isNoColor ? modeLabel : modeIcon(modeLabel)}
            </Text>
          ) : null,
          (themeName ?? getActiveThemeName()) && showChip('theme') ? (
            <Text color={chipColor(theme.brand, isNoColor)}>
              {isNoColor
                ? truncateChip(themeName ?? getActiveThemeName(), 24)
                : `${STATUSLINE_ICONS.theme} ${truncateChip(themeName ?? getActiveThemeName(), 24)}`}
            </Text>
          ) : null,
          sessionCount != null && sessionCount > 0 && showChip('sessions') ? (
            <Text color={isNoColor ? undefined : theme.accent}>
              {isNoColor
                ? `${sessionCount} session${sessionCount === 1 ? '' : 's'}`
                : `${STATUSLINE_ICONS.sessions} ${sessionCount} session${sessionCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
          toolCount != null && showChip('tools') ? (
            <Text color={isNoColor ? undefined : theme.accent}>
              {isNoColor
                ? `${toolCount} tool${toolCount === 1 ? '' : 's'}`
                : `${STATUSLINE_ICONS.tools} ${toolCount} tool${toolCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
          tokenSavingMode !== undefined && tokenSavingMode !== 'off' && showChip('token_saving') ? (
            <Text color={isNoColor ? undefined : theme.warn} bold>
              {isNoColor ? tokenSavingMode : `${STATUSLINE_ICONS.token_saving} ${tokenSavingMode}`}
            </Text>
          ) : null,
          sideEffectCount > 0 && showChip('side_effects') ? (
            <Text color={isNoColor ? undefined : theme.warn}>
              {isNoColor
                ? `${sideEffectCount} audit${sideEffectCount === 1 ? '' : 's'}`
                : `${STATUSLINE_ICONS.side_effects} ${sideEffectCount} audit${sideEffectCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
        ].filter((c): c is React.ReactElement => c !== null)}
        budget={Math.max(12, termWidth)}
        monochrome={isNoColor}
        fillBg={LINE_BG_COLORS[1]}
      />

      {/* Line 3 — Active work + Connectivity */}
      {hasWorkActivity ? (
        <PowerlineRail
          segments={workRowChips}
          budget={Math.max(12, termWidth)}
          monochrome={isNoColor}
          fillBg={LINE_BG_COLORS[2]}
        />
      ) : null}

      {/* Line 4 — Background-service detail */}
      {hasMemoryDetail || indexStatusChip ? (
        <PowerlineRail
          segments={memoryDetailChips}
          rightAnchor={indexStatusChip}
          budget={Math.max(12, termWidth)}
          monochrome={isNoColor}
          fillBg={LINE_BG_COLORS[3]}
        />
      ) : null}
    </Box>
  );
}
