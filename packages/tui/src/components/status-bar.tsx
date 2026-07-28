import { expectDefined } from '@wrongstack/core/utils';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  computeTokenFingerprint,
  useChipStalenessGuard,
} from '../hooks/use-chip-staleness-guard.js';
import { useTodosAutoClear } from '../hooks/use-todos-auto-clear.js';
import { useTokenCounterRefresh } from '../hooks/use-token-counter-refresh.js';
import { Box, Text, useAnimation, useStdout } from '../ink.js';
import { activeMemoryContextCount } from '../memory-context-monitor.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { type AnimationStyle, COLOR_TICK_MS, colorPhaseFromTime } from './animation-style.js';
import { PowerlineRail } from './powerline-rail.js';
import { BrainChip, EternalStageChip, ThinkingChip } from './status-bar-chips.js';
import {
  contextBarColor,
  fmtDebugBytes,
  fmtElapsed,
  fmtMemory,
  fmtTok,
  hasTokenDisplay,
  renderMeter,
  stateChip,
  tokenDisplayTotals,
  truncateChip,
} from './status-bar-format.js';
import {
  countdownColor,
  formatSuggestionLabel,
  hasMailboxActivity,
  isStreamChipVisible,
  modeIcon,
} from './status-bar-helpers.js';
import type { StatusBarProps } from './status-bar-types.js';
import type { StatuslineItem } from './statusline-picker.js';

export {
  contextBarColor,
  fmtElapsed,
  fmtMemory,
  hasTokenDisplay,
  nodeText,
  planChipFit,
  renderMeter,
  renderProgress,
  stateChip,
  statusBarAutonomySpan,
  statusBarModelSpan,
  statusBarTodosSpan,
  type TokenDisplayTotals,
  tokenDisplayTotals,
  truncateChip,
} from './status-bar-format.js';

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
/** Minimum terminal width before we switch to ultra-compact mode. */
export const COMPACT_THRESHOLD = 50;
/** Above this width, show most available information. */
const COMFORTABLE_THRESHOLD = 90;

function chipColor(color: string, isNoColor: boolean): string | undefined {
  return isNoColor ? undefined : color;
}

const LINE_BG_COLORS = [theme.surface, theme.surface, theme.surface, theme.surface] as const;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 1_000;

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
  processMemory,
  cpuPercent,
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
  indexState,
  breakerCountdown,
  modeLabel,
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
}: StatusBarProps): React.ReactElement {
  // Track terminal width so we can adapt layout on narrow terminals.
  // We snapshot into state so that renders are stable — we don't want
  // the live-region to churn on every resize event during active streaming.
  const { stdout } = useStdout();
  const [termWidth, setTermWidth] = useState(stdout?.columns ?? 90);
  useEffect(() => {
    const handleResize = () => setTermWidth(stdout?.columns ?? 90);
    handleResize(); // snapshot immediately
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [stdout]);

  const isCompact = termWidth < COMPACT_THRESHOLD;
  const isComfortable = termWidth >= COMFORTABLE_THRESHOLD;
  const isNoColor = mode === 'no-color';
  const hiddenSet = useMemo(() => new Set(hiddenItems), [hiddenItems]);
  const showChip = (item: StatuslineItem): boolean => !hiddenSet.has(item);
  // Use the refresh hook so token/cost updates appear immediately when
  // the provider responds, instead of waiting for the next nowTick poll.
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

  // Animated braille spinner — cycles while the agent is thinking/streaming.
  // Stops when idle so the interval doesn't drive unnecessary re-renders.
  const animationActive = state !== 'idle' && state !== 'aborting';
  const { frame: spinnerIdx, time: animationTime } = useAnimation({
    interval: SPINNER_INTERVAL_MS,
    isActive: animationActive,
  });
  const spinner = expectDefined(SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length]);

  // Fast color animation tick — separate from the 1s spinner so the
  // rainbow/wave/pulse gradient moves smoothly (~8 updates/s).
  const { time: colorTime } = useAnimation({
    interval: COLOR_TICK_MS,
    isActive: animationActive,
  });
  const colorPhase = animationActive ? colorPhaseFromTime(colorTime) : 0;

  // ── Chip staleness guard ──────────────────────────────────────────────────
  // Detects when a chip fails to refresh (animation frozen, data source stale,
  // subscription dropped) and forces a re-render to recover.
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
  // `stalenessGuard.renderNonce` is consumed as a `key` on the chip-rail
  // <Box> containers in both return paths below (minimum-mode and full-mode).
  // When the hook detects staleness it bumps the nonce internally, React sees
  // a new key, unmounts the stale subtree, and remounts a fresh one — forcing
  // every chip to re-render from scratch. See use-chip-staleness-guard.ts:42-43.

  const todosCleared = useTodosAutoClear(todos);

  // Animation style for the working/thinking chip. Defaults to `rainbow`
  // when omitted (legacy callers) so the chip still works. Special value
  // `'cycle'` rotates through wave → pulse → dots → breathe every
  // `CYCLE_INTERVAL_SECONDS`, derived from the shared spinner clock.
  const animationStyle: AnimationStyle | 'cycle' = thinkingAnimationStyle ?? 'rainbow';
  const cycleTick = Math.floor(animationTime / 1000);

  const { label: stateLabel, color: stateColor } = stateChip(
    state,
    fleet?.running ?? 0,
    thinkingWord,
  );
  // Animated spinner for thinking/streaming; static ● for idle/aborting.
  const statePrefix = state === 'idle' || state === 'aborting' ? '●' : spinner;
  // When the agent is actively working, paint the state chip as a moving
  // rainbow wave (each glyph cycles through the hue wheel, offset per char and
  // shifted by the spinner tick). Idle/aborting stay flat-colored.
  const thinking = state === 'running' || state === 'streaming';

  // Line 2 is *session context* — slow-moving facts about where you
  // are: the project, the branch, the elapsed clock, YOLO chip. These
  // change at most once per session.
  const hasAutoProceed = autoProceedCountdown != null && autoProceedCountdown > 0;

  // Line 3 is *active work* — the dynamic chips that mutate as the
  // agent / subagents make progress. Hidden when nothing is in flight
  // so a fresh session keeps the two-line baseline.
  const fleetHasActivity =
    (fleet && (fleet.running > 0 || fleet.idle > 0 || fleet.pending > 0 || fleet.completed > 0)) ||
    subagentCount > 0;
  // Stream chip visibility — these gate both the chip render AND the separator before it.
  // Unlike the raw hasBrainActivity flags, these respect the hidden set and expiration.
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

  // Next-steps auto-submit countdown color: green → yellow → red as the timer
  // drops (thresholds 20s / 10s), via the shared countdownColor ramp.
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
    typeof processCount === 'number' && processCount > 0 && showChip('processes')
      ? `proc ${processCount}`
      : '',
    typeof cpuPercent === 'number' && showChip('cpu') ? `cpu ${Math.round(cpuPercent)}%` : '',
  ].filter(Boolean);

  const stateStatusChip =
    showChip('state') && thinking ? (
      <ThinkingChip
        text={`${statePrefix} ${stateLabel}`}
        style={animationStyle}
        phase={spinnerIdx}
        cycleTick={cycleTick}
        colorPhase={colorPhase}
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
  const memoryColor = processMemory
    ? processMemory.load >= 0.85
      ? theme.error
      : processMemory.load >= 0.6
        ? theme.warn
        : theme.success
    : theme.textSecondary;
  const memoryStatusChip =
    processMemory && showChip('memory') ? (
      <Text color={isNoColor ? undefined : memoryColor}>
        RAM {fmtMemory(processMemory.rss)}
        {isComfortable ? (
          <Text dimColor={!isNoColor}> · heap {fmtMemory(processMemory.heapUsed)}</Text>
        ) : null}
      </Text>
    ) : null;
  const cpuStatusChip =
    typeof cpuPercent === 'number' && showChip('cpu') ? (
      <Text
        color={
          isNoColor
            ? undefined
            : cpuPercent > 80
              ? theme.error
              : cpuPercent > 50
                ? theme.warn
                : theme.success
        }
      >
        {glyphs.cpu} {Math.round(cpuPercent)}%
      </Text>
    ) : null;
  const SageStatusChip = null;

  const indexStatusChip =
    indexState && showChip('index')
      ? (() => {
          const server = indexState.server;
          const serverLabel =
            server?.status === 'connected'
              ? `${server.health?.status === 'healthy' ? 'healthy' : 'connected'}${server.pid ? ` #${server.pid}` : ''}${server.health?.latencyMs != null ? ` · ${server.health.latencyMs}ms` : ''}`
              : server?.status === 'degraded'
                ? `degraded${server.health?.missedHeartbeats ? ` · missed ${server.health.missedHeartbeats}` : ''}`
                : server?.status === 'unresponsive'
                  ? `unresponsive${server.health?.missedHeartbeats ? ` · missed ${server.health.missedHeartbeats}` : ''}`
                  : server?.status === 'offline'
                    ? 'disconnected'
                    : server?.status === 'unavailable'
                      ? 'server unavailable'
                      : server?.status;
          const label = indexState.indexing
            ? `indexing ${indexState.currentFile}/${indexState.totalFiles}${serverLabel ? ` · ${serverLabel}` : ''}`
            : indexState.circuit?.state === 'open'
              ? `index paused${serverLabel ? ` · ${serverLabel}` : ''}`
              : serverLabel
                ? `index ${serverLabel}`
                : null;
          if (!label) return null;
          const color =
            server?.status === 'error' ||
            server?.status === 'unresponsive' ||
            indexState.circuit?.state === 'open'
              ? theme.error
              : indexState.indexing ||
                  server?.status === 'connecting' ||
                  server?.status === 'stopping' ||
                  server?.status === 'degraded'
                ? theme.warn
                : server?.status === 'connected'
                  ? theme.success
                  : theme.textMuted;
          return (
            <Text color={isNoColor ? undefined : color}>
              {glyphs.index} {label}
            </Text>
          );
        })()
      : null;

  // ── Background-service detail line (4th row) ──────────────────────────
  const memoryMonitor = memoryContextMonitor;
  const memorySummary = memoryMonitor?.latest;
  const hasMemoryDetail = (memorySummary != null || Sage != null) && showChip('memory_context');
  const memoryDetailChips: React.ReactElement[] = [];
  if (hasMemoryDetail) {
    const records = memoryMonitor ? Object.values(memoryMonitor.memories) : [];
    const active = memoryMonitor ? activeMemoryContextCount(memoryMonitor) : 0;
    const pending = records.filter((m) => m.state === 'injected').length;
    const left = records.filter((m) => m.state === 'exited').length;
    memoryDetailChips.push(
      <Text color={chipColor(theme.accent, isNoColor)} key="mem-label">
        {isNoColor ? 'Memory ' : `Memory ${glyphs.brain} `}
      </Text>,
    );
    // Total records + active-in-context (moved from line 1)
    if (Sage) {
      memoryDetailChips.push(
        <Text key="total">
          {Sage.total} total
          <Text dimColor={!isNoColor}> · </Text>
          <Text color={chipColor(theme.success, isNoColor)}>{Sage.activeInContext} ctx</Text>
          {memorySummary != null ? <Text dimColor={!isNoColor}> · </Text> : null}
        </Text>,
      );
    }
    if (memorySummary != null) {
      memoryDetailChips.push(
        <Text key="matched">
          {memorySummary.matched} matched
          <Text dimColor={!isNoColor}> · </Text>
          <Text color={chipColor(theme.success, isNoColor)}>{memorySummary.injected} inj</Text>
          <Text dimColor={!isNoColor}> · </Text>
          <Text color={chipColor(theme.warn, isNoColor)}>{memorySummary.filtered} filt</Text>
          <Text dimColor={!isNoColor}> · </Text>
          <Text color={chipColor(theme.accent, isNoColor)}>{active} actv</Text>
          {pending > 0 ? (
            <>
              <Text dimColor={!isNoColor}> · </Text>
              <Text color={chipColor(theme.accent, isNoColor)}>{pending} pend</Text>
            </>
          ) : null}
          {left > 0 ? (
            <>
              <Text dimColor={!isNoColor}> · </Text>
              <Text color={chipColor(theme.textMuted, isNoColor)}>{left} left</Text>
            </>
          ) : null}
        </Text>,
      );
      memoryDetailChips.push(
        <Text color={chipColor(theme.textMuted, isNoColor)} key="trigger">
          {memorySummary.trigger.length > 25
            ? `${memorySummary.trigger.slice(0, 22)}…`
            : memorySummary.trigger}
          <Text dimColor={!isNoColor}>
            {' · ctx '}
            {Math.round(memorySummary.contextPressure * 100)}%{' · +'}
            {memorySummary.injectedChars >= 1024
              ? `${(memorySummary.injectedChars / 1024).toFixed(1)}K`
              : memorySummary.injectedChars}
            {' chars'}
          </Text>
        </Text>,
      );
    }
  }

  const primaryChips: React.ReactElement[] = [
    // Combined context bar: meter · tokens · cost
    (context || showTokenDisplay || (cost?.total ?? 0) > 0) &&
    (showChip('context') || showChip('tokens') || showChip('cost'))
      ? (() => {
          const ratio = context ? Math.min(context.used / context.max, 1) : 0;
          const barColor = isNoColor ? undefined : contextBarColor(ratio);
          const hasTokens = showTokenDisplay && showChip('tokens');
          const hasCost = cost && cost.total > 0 && showChip('cost');
          const segments: string[] = [];
          if (context) segments.push('meter');
          if (hasTokens) segments.push('tokens');
          if (hasCost) segments.push('cost');
          const sep = segments.length > 1;
          return (
            <Text>
              {context ? (
                <Text color={barColor}>
                  <Text dimColor={!isNoColor}>{'ctx '}</Text>
                  {renderMeter(ratio, 8)} {fmtTok(context.used)}/{fmtTok(context.max)}
                  {contextStrategy ? (
                    <Text dimColor={!isNoColor}>{` [${contextStrategy}]`}</Text>
                  ) : null}
                </Text>
              ) : null}
              {sep && context ? <Text dimColor={!isNoColor}>{' · '}</Text> : null}
              {hasTokens ? (
                <Text>
                  <Text color={isNoColor ? undefined : theme.textSecondary}>{'↑'}</Text>
                  <Text color={isNoColor ? undefined : theme.accent}>
                    {fmtTok(displayTokens.input)}
                  </Text>
                  <Text color={isNoColor ? undefined : theme.textSecondary}>{' ↓'}</Text>
                  <Text color={isNoColor ? undefined : theme.accent}>
                    {fmtTok(displayTokens.output)}
                  </Text>
                </Text>
              ) : null}
              {sep && hasCost && (context || hasTokens) ? (
                <Text dimColor={!isNoColor}>{' · '}</Text>
              ) : null}
              {hasCost ? (
                <Text color={isNoColor ? undefined : theme.warn}>
                  {glyphs.cost}
                  {cost.total.toFixed(4)}
                </Text>
              ) : null}
            </Text>
          );
        })()
      : null,
    SageStatusChip,
    cache && cache.hitRatio > 0 && isComfortable && showChip('cache') ? (
      <Text dimColor={!isNoColor}>cache {(cache.hitRatio * 100).toFixed(0)}%</Text>
    ) : null,
    queueCount > 0 && showChip('queue') ? (
      <Text color={isNoColor ? undefined : theme.accent}>
        {glyphs.queue} queued {queueCount}
      </Text>
    ) : null,
    typeof processCount === 'number' && processCount > 0 && showChip('processes') ? (
      <Text color={isNoColor ? undefined : theme.error}>
        {glyphs.process} {processCount} process{processCount === 1 ? '' : 'es'}
      </Text>
    ) : null,
    hint && showChip('hint') ? <Text dimColor={!isNoColor}>{hint}</Text> : null,
    breakerCountdown && showChip('breaker')
      ? (() => {
          const secs = Math.ceil(breakerCountdown.remainingMs / 1000);
          const c = secs > 20 ? theme.success : secs > 10 ? theme.warn : theme.error;
          return (
            <Text color={isNoColor ? undefined : c} bold>
              {glyphs.warning} kill/reset in {secs}s
            </Text>
          );
        })()
      : null,
  ].filter((chip): chip is React.ReactElement => chip !== null);

  const modeChips = [
    // Line 1 runtime chips: YOLO, autonomy, provider/model,
    // then the context meter and remaining runtime details.
    yolo && showChip('yolo') ? (
      <Text color={chipColor(theme.error, isNoColor)} bold>
        {isNoColor ? 'YOLO' : `${glyphs.warning} YOLO`}
      </Text>
    ) : null,
    autonomy && autonomy !== 'off' && showChip('autonomy') ? (
      <Text
        color={chipColor(
          autonomy === 'eternal' ? theme.error : autonomy === 'auto' ? theme.warn : theme.accent,
          isNoColor,
        )}
        bold
      >
        {isNoColor ? autonomy.toUpperCase() : `∞ ${autonomy.toUpperCase()}`}
      </Text>
    ) : null,
    modelStatusChip,
    ...primaryChips,
    stateStatusChip,
    fleetWorkingTime != null && fleetWorkingTime > 0 && showChip('elapsed') ? (
      <Text dimColor={!isNoColor}>
        {isNoColor
          ? fmtElapsed(fleetWorkingTime)
          : `${glyphs.clock} ${fmtElapsed(fleetWorkingTime)}`}
      </Text>
    ) : null,
  ].filter((c): c is React.ReactElement => c !== null);

  const minimumChips: React.ReactElement[] = [
    // State with animation
    showChip('state') && thinking ? (
      <ThinkingChip
        text={`${statePrefix} ${stateLabel}`}
        style={animationStyle}
        phase={spinnerIdx}
        cycleTick={cycleTick}
        colorPhase={colorPhase}
      />
    ) : showChip('state') ? (
      <Text color={chipColor(stateColor, isNoColor)}>
        {statePrefix} {stateLabel}
      </Text>
    ) : null,
    // Model
    showChip('model') ? (
      <Text color={chipColor(theme.monitor.agents, isNoColor)}>
        {provider ? `${provider}/` : ''}
        {model}
      </Text>
    ) : null,
    // Context bar (compact: 6 blocks, optional tokens)
    (context || showTokenDisplay) && showChip('context')
      ? (() => {
          const ratio = context ? Math.min(context.used / context.max, 1) : 0;
          const c = context ? contextBarColor(ratio) : theme.textSecondary;
          const hasTokens = showTokenDisplay && showChip('tokens');
          return (
            <Text>
              <Text color={chipColor(c, isNoColor)}>
                {context ? <Text dimColor={!isNoColor}>{'ctx '}</Text> : null}
                {context ? renderMeter(ratio, 6) : ''} {context ? fmtTok(context.used) : ''}
              </Text>
              {hasTokens && context ? <Text dimColor={!isNoColor}>{' · '}</Text> : null}
              {hasTokens ? (
                <Text color={chipColor(theme.textSecondary, isNoColor)}>
                  ↑
                  <Text color={chipColor(theme.accent, isNoColor)}>
                    {fmtTok(displayTokens.input)}
                  </Text>{' '}
                  ↓
                  <Text color={chipColor(theme.accent, isNoColor)}>
                    {fmtTok(displayTokens.output)}
                  </Text>
                </Text>
              ) : null}
            </Text>
          );
        })()
      : null,
    SageStatusChip,
    // Autonomy mode (if active)
    autonomy && autonomy !== 'off' && showChip('autonomy') ? (
      <Text
        color={chipColor(
          autonomy === 'eternal' ? theme.error : autonomy === 'auto' ? theme.warn : theme.accent,
          isNoColor,
        )}
        bold
      >
        {isNoColor ? autonomy.toUpperCase() : `∞ ${autonomy.toUpperCase()}`}
      </Text>
    ) : null,
    // Fleet working time
    fleetWorkingTime != null && fleetWorkingTime > 0 && showChip('elapsed') ? (
      <Text dimColor={!isNoColor}>{fmtElapsed(fleetWorkingTime)}</Text>
    ) : null,
    processMemory && showChip('memory') ? (
      <Text color={chipColor(memoryColor, isNoColor)}>RAM {fmtMemory(processMemory.rss)}</Text>
    ) : null,
    // Work summary (compact)
    ...(minimalWorkParts.length > 0
      ? [<Text dimColor={!isNoColor}>{minimalWorkParts.slice(0, 2).join(' · ')}</Text>]
      : []),
  ].filter((c): c is React.ReactElement => c !== null);

  const fleetAgentChips: React.ReactElement[] =
    fleetAgents && showChip('fleet_agents')
      ? fleetAgents.map((agent) => (
          <Text key={agent.label}>
            <Text color={isNoColor ? undefined : agent.color} bold>
              {agent.label}
            </Text>
            <Text
              color={agent.running && !isNoColor ? theme.warn : undefined}
            >{` ${agent.running ? glyphs.running : '·'} `}</Text>
            <Text dimColor={!isNoColor}>
              {fmtElapsed(agent.elapsedMs)} · {agent.toolCalls}t
            </Text>
            {agent.tool ? (
              <Text color={isNoColor ? undefined : theme.accent}>{` · ${agent.tool}`}</Text>
            ) : null}
            {agent.extensions && agent.extensions > 0 ? (
              <Text
                color={isNoColor ? undefined : theme.warn}
              >{` · ${glyphs.process}×${agent.extensions}`}</Text>
            ) : null}
          </Text>
        ))
      : [];

  const detailChips: React.ReactElement[] = [];
  if (mailbox && showMailbox) {
    detailChips.push(
      mailbox.unread > 0 ? (
        <Text color={isNoColor ? undefined : theme.warn} bold>
          {glyphs.mail} {mailbox.unread} new
        </Text>
      ) : (
        <Text dimColor={!isNoColor}>{glyphs.mail} 0</Text>
      ),
      <Text color={isNoColor ? undefined : theme.accent}>
        {glyphs.peers} {mailbox.onlineAgents} agent{mailbox.onlineAgents === 1 ? '' : 's'}
        {mailbox.onlineClients.tui > 0
          ? ` · ${glyphs.desktop} TUI${mailbox.onlineClients.tui > 1 ? `×${mailbox.onlineClients.tui}` : ''}`
          : ''}
        {mailbox.onlineClients.webui > 0
          ? ` · ${glyphs.web} WebUI${mailbox.onlineClients.webui > 1 ? `×${mailbox.onlineClients.webui}` : ''}`
          : ''}
        {mailbox.onlineClients.repl > 0
          ? ` · ${glyphs.terminal} REPL${mailbox.onlineClients.repl > 1 ? `×${mailbox.onlineClients.repl}` : ''}`
          : ''}
      </Text>,
    );
    if (mailbox.lastSubject) {
      detailChips.push(
        <Text dimColor={!isNoColor}>
          {mailbox.lastFrom ? `${mailbox.lastFrom}: ` : ''}
          {truncateChip(mailbox.lastSubject, 40)}
        </Text>,
      );
    }
  }
  detailChips.push(...fleetAgentChips);

  // ── Line 3 activity detection ──────────────────────────────────────────
  // Only render line 3 when there's active work or connectivity to show.
  const hasActiveGoal = goalSummary != null && showChip('goal');
  const showEternalStage = eternalStage != null && showChip('eternal_stage');
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
    hasActiveGoal ||
    hasAutoProceed ||
    showEternalStage ||
    detailChips.length > 0;

  if (mode === 'minimum') {
    return (
      <Box key={`sb-${stalenessGuard.renderNonce}`} flexDirection="column" paddingX={1}>
        <PowerlineRail
          segments={minimumChips}
          budget={Math.max(12, termWidth)}
          monochrome={isNoColor}
          fillBg={LINE_BG_COLORS[0]}
        />
      </Box>
    );
  }

  return (
    <Box key={`sb-${stalenessGuard.renderNonce}`} flexDirection="column" paddingX={0}>
      {/* Line 1 — Runtime + mode chips: YOLO, autonomy, project/workdir,
          provider/model, context, tokens, cost, queue, processes, hint,
          breaker, state, elapsed */}
      <PowerlineRail
        segments={isCompact ? modeChips.slice(0, 5) : modeChips}
        budget={Math.max(12, termWidth)}
        monochrome={isNoColor}
        fillBg={LINE_BG_COLORS[0]}
      />

      {/* Line 2 — Session context: workdir/project first, then git, mode,
          sessions, tools, token-saving, RAM/heap at the end */}
      <PowerlineRail
        segments={[
          projectName && showChip('project') ? (
            <Text color={chipColor(theme.accent, isNoColor)}>
              {isNoColor
                ? truncateChip(projectName, 24)
                : `${glyphs.folder} ${truncateChip(projectName, 24)}`}
            </Text>
          ) : null,
          workingDir && showChip('working_dir') ? (
            <Text color={chipColor(theme.accent, isNoColor)}>
              {isNoColor
                ? truncateChip(workingDir, 28)
                : `${glyphs.workingDirectory} ${truncateChip(workingDir, 28)}`}
            </Text>
          ) : null,
          git && showChip('git') ? (
            <Text>
              <Text color={theme.monitor.agents}>
                {glyphs.gitBranch} {truncateChip(git.branch, 24)}
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
          sessionCount != null && sessionCount > 0 && showChip('sessions') ? (
            <Text color={isNoColor ? undefined : theme.accent}>
              {isNoColor
                ? `${sessionCount} session${sessionCount === 1 ? '' : 's'}`
                : `${glyphs.sessions} ${sessionCount} session${sessionCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
          toolCount != null && showChip('tools') ? (
            <Text color={isNoColor ? undefined : theme.accent}>
              {isNoColor
                ? `${toolCount} tool${toolCount === 1 ? '' : 's'}`
                : `${glyphs.tools} ${toolCount} tool${toolCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
          tokenSavingMode !== undefined && tokenSavingMode !== 'off' && showChip('token_saving') ? (
            <Text color={isNoColor ? undefined : theme.warn} bold>
              {isNoColor ? tokenSavingMode : `${glyphs.save} ${tokenSavingMode}`}
            </Text>
          ) : null,
          sideEffectCount > 0 ? (
            <Text color={isNoColor ? undefined : theme.warn}>
              {isNoColor
                ? `${sideEffectCount} audit${sideEffectCount === 1 ? '' : 's'}`
                : `${glyphs.audit} ${sideEffectCount} audit${sideEffectCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
          cpuStatusChip,
          memoryStatusChip,
        ].filter((c): c is React.ReactElement => c !== null)}
        budget={Math.max(12, termWidth)}
        monochrome={isNoColor}
        fillBg={LINE_BG_COLORS[1]}
      />

      {/* Line 3 — Active work + Connectivity: todos, plan, tasks, fleet,
          brain, debug stream, enhance, next-steps, mailbox, fleet agents.
          Only rendered when there's something to show. */}
      {hasWorkActivity ? (
        <PowerlineRail
          segments={[
            todos &&
            (todos.pending > 0 || todos.inProgress > 0 || (todos.completed > 0 && !todosCleared)) &&
            showChip('todos') ? (
              <Text>
                <Text dimColor={!isNoColor}>todos </Text>
                {todos.inProgress > 0 ? (
                  <Text color={isNoColor ? undefined : theme.warn}>
                    {isNoColor ? `⌛${todos.inProgress}` : `⌛${todos.inProgress}`}
                  </Text>
                ) : null}
                {todos.inProgress > 0 && (todos.pending > 0 || todos.completed > 0) ? ' ' : ''}
                {todos.pending > 0 ? (
                  <Text dimColor={!isNoColor}>
                    {isNoColor ? `☐${todos.pending}` : `☐${todos.pending}`}
                  </Text>
                ) : null}
                {todos.pending > 0 && todos.completed > 0 ? ' ' : ''}
                {todos.completed > 0 ? (
                  <Text color={isNoColor ? undefined : theme.success}>
                    {isNoColor ? `✓${todos.completed}` : `✓${todos.completed}`}
                  </Text>
                ) : null}
              </Text>
            ) : null,
            plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0) && showChip('plan') ? (
              <Text>
                <Text color={isNoColor ? undefined : theme.accent}>
                  {isNoColor ? '' : `${glyphs.plan} `}
                </Text>
                {plan.inProgress > 0 ? (
                  <Text color={isNoColor ? undefined : theme.warn}>
                    {isNoColor ? `⌛${plan.inProgress}` : `⌛${plan.inProgress}`}
                  </Text>
                ) : null}
                {plan.inProgress > 0 && (plan.open > 0 || plan.done > 0) ? ' ' : ''}
                {plan.open > 0 ? (
                  <Text dimColor={!isNoColor}>{isNoColor ? `☐${plan.open}` : `☐${plan.open}`}</Text>
                ) : null}
                {plan.open > 0 && plan.done > 0 ? ' ' : ''}
                {plan.done > 0 ? (
                  <Text color={isNoColor ? undefined : theme.success}>
                    {isNoColor ? `✓${plan.done}` : `✓${plan.done}`}
                  </Text>
                ) : null}
                {plan.scope ? <Text dimColor={!isNoColor}> [{plan.scope}]</Text> : null}
              </Text>
            ) : null,
            hasTaskActivity && showChip('tasks') ? (
              <Text>
                <Text color={isNoColor ? undefined : theme.monitor.agents}>
                  {isNoColor ? '' : `${glyphs.task} `}
                </Text>
                {tasks!.inProgress > 0 ? (
                  <Text color={isNoColor ? undefined : theme.warn}>
                    {isNoColor ? `⌛${tasks!.inProgress}` : `⌛${tasks!.inProgress}`}
                  </Text>
                ) : null}
                {tasks!.inProgress > 0 && (tasks!.pending > 0 || tasks!.blocked > 0) ? ' ' : ''}
                {tasks!.pending > 0 ? (
                  <Text dimColor={!isNoColor}>
                    {isNoColor ? `☐${tasks!.pending}` : `☐${tasks!.pending}`}
                  </Text>
                ) : null}
                {tasks!.pending > 0 && tasks!.blocked > 0 ? ' ' : ''}
                {tasks!.blocked > 0 ? (
                  <Text color={isNoColor ? undefined : theme.error}>
                    {isNoColor ? `⊘${tasks!.blocked}` : `⊘${tasks!.blocked}`}
                  </Text>
                ) : null}
                {(tasks!.pending > 0 || tasks!.blocked > 0) &&
                (tasks!.completed > 0 || tasks!.failed > 0)
                  ? ' '
                  : ''}
                {tasks!.completed > 0 ? (
                  <Text color={isNoColor ? undefined : theme.success}>
                    {isNoColor ? `✓${tasks!.completed}` : `✓${tasks!.completed}`}
                  </Text>
                ) : null}
                {tasks!.completed > 0 && tasks!.failed > 0 ? ' ' : ''}
                {tasks!.failed > 0 ? (
                  <Text color={isNoColor ? undefined : theme.error}>
                    {isNoColor ? `✗${tasks!.failed}` : `✗${tasks!.failed}`}
                  </Text>
                ) : null}
                {tasks!.scope ? <Text dimColor={!isNoColor}> [{tasks!.scope}]</Text> : null}
              </Text>
            ) : null,
            fleetHasActivity && showChip('fleet') ? (
              fleet ? (
                <Text>
                  <Text color={isNoColor ? undefined : theme.accent}>
                    {isNoColor ? '' : `${glyphs.fleet} `}
                  </Text>
                  {fleet.running > 0 ? (
                    <Text color={isNoColor ? undefined : theme.warn}>
                      {isNoColor ? `▶${fleet.running}` : `▶${fleet.running}`}
                    </Text>
                  ) : null}
                  {fleet.running > 0 && (fleet.pending > 0 || fleet.idle > 0 || fleet.completed > 0)
                    ? ' '
                    : ''}
                  {fleet.pending > 0 ? (
                    <Text dimColor={!isNoColor}>
                      {isNoColor ? `☐${fleet.pending}` : `☐${fleet.pending}`}
                    </Text>
                  ) : null}
                  {fleet.pending > 0 && (fleet.idle > 0 || fleet.completed > 0) ? ' ' : ''}
                  {fleet.idle > 0 ? <Text dimColor={!isNoColor}>·{fleet.idle}idle</Text> : null}
                  {fleet.idle > 0 && fleet.completed > 0 ? ' ' : ''}
                  {fleet.completed > 0 ? (
                    <Text color={isNoColor ? undefined : theme.success}>
                      {isNoColor ? `✓${fleet.completed}` : `✓${fleet.completed}`}
                    </Text>
                  ) : null}
                </Text>
              ) : (
                <Text color={isNoColor ? undefined : theme.accent}>
                  {isNoColor
                    ? `${subagentCount} agent${subagentCount === 1 ? '' : 's'}`
                    : `${glyphs.fleet} ${subagentCount} agent${subagentCount === 1 ? '' : 's'}`}
                </Text>
              )
            ) : null,
            showBrain ? <BrainChip brain={brain!} monochrome={isNoColor} /> : null,
            showDebugStream ? (
              <Text color={isNoColor ? undefined : theme.accent}>
                <Text bold>{isNoColor ? 'stream' : `${glyphs.bug} stream`}</Text>
                <Text dimColor={!isNoColor}> #{debugStreamStats!.chunkCount}</Text>
                <Text dimColor={!isNoColor}> · {debugStreamStats!.lastChunkSize}B</Text>
                <Text dimColor={!isNoColor}> · +{debugStreamStats!.lastDeltaMs}ms</Text>
                <Text dimColor={!isNoColor}> · {fmtDebugBytes(debugStreamStats!.totalBytes)}</Text>
              </Text>
            ) : null,
            showEnhance ? (
              <Text color={isNoColor ? undefined : countdownColor(enhanceCountdown!, 15, 5)}>
                {isNoColor
                  ? `refined · send in ${enhanceCountdown}s`
                  : `${glyphs.auto} refinement ready · send in ${enhanceCountdown}s`}
              </Text>
            ) : null,
            hasNextStepsAutoSubmit &&
            nextStepsAutoSubmitCountdown != null &&
            showChip('next_steps') ? (
              <>
                <Text color={isNoColor ? undefined : nextStepsColor} bold>
                  {isNoColor
                    ? `${nextStepsAutoSubmitCountdown}s`
                    : `${glyphs.auto} ${nextStepsAutoSubmitCountdown}s`}
                </Text>
                <Text dimColor={!isNoColor}>
                  {' '}
                  {nextStepsAutoSubmitLabel ? formatSuggestionLabel(nextStepsAutoSubmitLabel) : ''}
                  {' · ⇥ edit'}
                </Text>
              </>
            ) : null,
            showEternalStage ? (
              <EternalStageChip stage={eternalStage!} monochrome={isNoColor} />
            ) : null,
            hasActiveGoal ? (
              <Text
                color={
                  isNoColor
                    ? undefined
                    : goalSummary!.goalState === 'abandoned'
                      ? theme.textMuted
                      : goalSummary!.goalState === 'active' ||
                          goalSummary!.goalState === 'completed'
                        ? theme.success
                        : theme.warn
                }
              >
                {isNoColor ? '' : `${glyphs.goal} `}
                {goalSummary!.goal.length > 40
                  ? `${goalSummary!.goal.slice(0, 37)}…`
                  : goalSummary!.goal}{' '}
                [{goalSummary!.goalState}] (iter {goalSummary!.iterations})
              </Text>
            ) : null,
            hasAutoProceed && showChip('auto_proceed') ? (
              <Text
                color={
                  isNoColor
                    ? undefined
                    : autoProceedCountdown != null && autoProceedCountdown <= 5
                      ? theme.warn
                      : theme.accent
                }
              >
                {isNoColor
                  ? `auto in ${autoProceedCountdown}s`
                  : `${glyphs.auto} auto in ${autoProceedCountdown}s`}
              </Text>
            ) : null,
            ...detailChips,
          ].filter((c): c is React.ReactElement => c !== null)}
          budget={Math.max(12, termWidth)}
          monochrome={isNoColor}
          fillBg={LINE_BG_COLORS[2]}
        />
      ) : null}

      {/* Line 4 — Background-service detail: memory context lifecycle and
          codebase-index server/indexing health. Keeping this operational
          telemetry off line 1 preserves the primary runtime context.

          The index chip is right-anchored via `rightAnchor` so its column
          position is independent of the memory-detail chip widths (which
          change every heartbeat as matched/injected/filtered counts and
          `ctx N%` / `+N chars` update). Previously the index chip was the
          final segment of a single rail and visibly jittered left/right as
          the memory counters grew or shrank — pinning it to the right edge
          keeps the index/PID column stable. */}
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
