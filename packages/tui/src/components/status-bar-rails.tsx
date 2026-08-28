import { systemPromptVariantLabel } from '@wrongstack/core/agent';
import type React from 'react';
import { Text } from '../ink.js';
import { activeMemoryContextCount } from '../memory-context-monitor.js';
import { getActiveThemeName, theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import type { AnimationStyle } from './animation-style.js';
import type { RailSpanEntry } from './powerline-rail.js';
import { BrainChip, EternalStageChip, ThinkingChip } from './status-bar-chips.js';
import {
  contextBarColor,
  fmtDebugBytes,
  fmtElapsed,
  fmtTok,
  renderMeter,
  truncateChip,
} from './status-bar-format.js';
import { countdownColor, formatSuggestionLabel, modeIcon } from './status-bar-helpers.js';
import { chipColor, STATUSLINE_ICONS } from './status-bar-icons.js';
import type { FleetAgentDetail, MailboxStatus, StatusBarProps } from './status-bar-types.js';
import type { StatuslineItem } from './statusline-picker.js';

export interface StatusBarRailBuildParams {
  showChip: (item: StatuslineItem) => boolean;
  isNoColor: boolean;
  model: string;
  provider?: string | undefined;
  version?: string | undefined;
  latestVersion?: string | undefined;
  updateAvailable?: boolean | undefined;
  yolo?: boolean | undefined;
  autonomy?: StatusBarProps['autonomy'];
  processCount?: number | undefined;
  stateStatusChip: React.ReactElement | null;
  fleetWorkingTime?: number | undefined;
  primaryChips: React.ReactElement[];
  context?: StatusBarProps['context'];
  contextStrategy?: string | undefined;
  showTokenDisplay: boolean;
  displayTokens: { input: number; output: number };
  cost?: { total: number } | undefined;
  cache?:
    | {
        hitRatio: number;
        readTokens: number;
        writeTokens: number;
        savedUsd: number;
      }
    | undefined;
  queueCount?: number | undefined;
  hint?: string | undefined;
  breakerCountdown?: StatusBarProps['breakerCountdown'];
  projectName?: string | undefined;
  workingDir?: string | undefined;
  git?: StatusBarProps['git'];
  modeLabel?: string | undefined;
  themeName?: string | undefined;
  sessionCount?: number | undefined;
  toolCount?: number | undefined;
  tokenSavingMode?: string | undefined;
  sideEffectCount?: number | undefined;
  todos?: StatusBarProps['todos'];
  todosCleared: boolean;
  plan?: StatusBarProps['plan'];
  tasks?: StatusBarProps['tasks'];
  hasTaskActivity: boolean | null | undefined;
  fleet?: StatusBarProps['fleet'];
  fleetHasActivity: boolean | null | undefined;
  subagentCount: number;
  showBrain: boolean;
  brain?: StatusBarProps['brain'];
  showDebugStream: boolean;
  debugStreamStats?: StatusBarProps['debugStreamStats'];
  showEnhance: boolean;
  enhanceCountdown?: StatusBarProps['enhanceCountdown'];
  hasNextStepsAutoSubmit: boolean;
  nextStepsAutoSubmitCountdown?: StatusBarProps['nextStepsAutoSubmitCountdown'];
  nextStepsAutoSubmitLabel?: StatusBarProps['nextStepsAutoSubmitLabel'];
  nextStepsColor: string;
  showEternalStage: boolean;
  eternalStage?: StatusBarProps['eternalStage'];
  hasActiveGoal: boolean;
  goalSummary?: StatusBarProps['goalSummary'];
  hasAutoProceed: boolean;
  autoProceedCountdown?: StatusBarProps['autoProceedCountdown'];
  droppedTools?: number | undefined;
  minimalWorkParts: string[];
  thinking: boolean;
  statePrefix: string;
  stateLabel: string;
  stateColor: string;
  animationStyle: AnimationStyle | 'cycle';
  spinnerIdx: number;
  cycleTick: number;
  memoryContextMonitor?: StatusBarProps['memoryContextMonitor'];
  Sage?: StatusBarProps['Sage'];
  indexState?: StatusBarProps['indexState'];
  /** Mailbox status for the connectivity rail (line 4). */
  mailbox?: MailboxStatus | undefined;
  /** Per-agent live detail rows for the connectivity rail (line 4). */
  fleetAgents?: FleetAgentDetail[] | undefined;
  /** Whether the mailbox chip is eligible (not hidden + has activity). */
  showMailbox: boolean;
  /** Pre-built memory-context chips for the connectivity rail (line 4). */
  memoryDetailChips: React.ReactElement[];
  /** Active system-prompt variant (Lite / Standard / Pro) — line 1 identity chip. */
  promptVariant?: 'lite' | 'default' | 'pro' | undefined;
}

/**
 * The ctx·tokens·cost·cache telemetry composite for the run-state rail.
 * queue/hint/breaker are separate entries in buildRunStateChipEntries so
 * each keeps a stable click-map id and its urgency-sorted position.
 */
export function buildPrimaryChips(p: StatusBarRailBuildParams): React.ReactElement[] {
  const {
    context,
    showTokenDisplay,
    cost,
    cache,
    showChip,
    isNoColor,
    displayTokens,
    contextStrategy,
  } = p;
  return [
    (context || showTokenDisplay || (cost?.total ?? 0) > 0 || (cache?.hitRatio ?? 0) > 0) &&
    (showChip('context') || showChip('tokens') || showChip('cost') || showChip('cache'))
      ? (() => {
          const ratio = context ? Math.min(context.used / context.max, 1) : 0;
          const barColor = isNoColor ? undefined : contextBarColor(ratio);
          const hasTokens = showTokenDisplay && showChip('tokens');
          const hasCost = cost && cost.total > 0 && showChip('cost');
          const hasCache = cache && cache.hitRatio > 0 && showChip('cache');
          const segments: string[] = [];
          if (context) segments.push('meter');
          if (hasTokens) segments.push('tokens');
          if (hasCost) segments.push('cost');
          if (hasCache) segments.push('cache');
          const sep = segments.length > 1;
          return (
            <Text>
              {context ? (
                <Text color={barColor}>
                  <Text dimColor={!isNoColor}>{`${STATUSLINE_ICONS.context} ctx `}</Text>
                  {renderMeter(ratio, 8)} {fmtTok(context.used)}/{fmtTok(context.max)}
                  {contextStrategy ? (
                    <Text dimColor={!isNoColor}>{` [${contextStrategy}]`}</Text>
                  ) : null}
                </Text>
              ) : null}
              {sep && context && hasTokens ? <Text dimColor={!isNoColor}>{' · '}</Text> : null}
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
                  {STATUSLINE_ICONS.cost} {cost.total.toFixed(4)}
                </Text>
              ) : null}
              {sep && hasCache && (context || hasTokens || hasCost) ? (
                <Text dimColor={!isNoColor}>{' · '}</Text>
              ) : null}
              {hasCache ? (
                <Text dimColor={!isNoColor}>
                  {STATUSLINE_ICONS.cache} {(cache.hitRatio * 100).toFixed(0)}%
                  {/* Compact read/write figures — `r`/`w` prefixes distinguish
                      cache tokens from the ↑/↓ request tokens of the tokens
                      chip. Saved USD last, only when cache reads actually
                      saved money (0 = no priced cache reads yet). */}
                  <Text> r{fmtTok(cache.readTokens)}</Text>
                  <Text> w{fmtTok(cache.writeTokens)}</Text>
                  {cache.savedUsd > 0 ? <Text> ~${cache.savedUsd.toFixed(2)}</Text> : null}
                </Text>
              ) : null}
            </Text>
          );
        })()
      : null,
  ].filter((chip): chip is React.ReactElement => chip !== null);
}

export function buildWorkspaceChipEntries(
  p: StatusBarRailBuildParams,
  modelStatusChip: React.ReactElement | null,
): RailSpanEntry[] {
  const {
    showChip,
    isNoColor,
    projectName,
    workingDir,
    git,
    modeLabel,
    promptVariant,
    themeName,
    sessionCount,
    toolCount,
  } = p;
  return (
    [
      {
        id: 'project',
        node:
          projectName && showChip('project') ? (
            <Text color={chipColor(theme.accent, isNoColor)}>
              {isNoColor
                ? truncateChip(projectName, 24)
                : `${STATUSLINE_ICONS.project} ${truncateChip(projectName, 24)}`}
            </Text>
          ) : null,
      },
      {
        id: 'working_dir',
        node:
          workingDir && showChip('working_dir') ? (
            <Text color={chipColor(theme.accent, isNoColor)}>
              {isNoColor
                ? truncateChip(workingDir, 28)
                : `${STATUSLINE_ICONS.working_dir} ${truncateChip(workingDir, 28)}`}
            </Text>
          ) : null,
      },
      {
        id: 'git',
        node:
          git && showChip('git') ? (
            <Text>
              <Text color={theme.monitor.agents}>
                {STATUSLINE_ICONS.git} {truncateChip(git.branch, 24)}
              </Text>
              {git.deleted > 0 ? <Text color={theme.error}> -{git.deleted}</Text> : null}
              {git.untracked > 0 ? <Text dimColor={!isNoColor}> ?{git.untracked}</Text> : null}
            </Text>
          ) : null,
      },
      { id: 'model', node: modelStatusChip },
      {
        id: 'mode',
        node:
          modeLabel && showChip('mode') ? (
            <Text color={chipColor(theme.accent, isNoColor)}>
              {isNoColor ? modeLabel : modeIcon(modeLabel)}
            </Text>
          ) : null,
      },
      {
        id: 'prompt_variant',
        node:
          promptVariant && showChip('prompt_variant') ? (
            <Text color={chipColor(theme.brand, isNoColor)}>
              {isNoColor
                ? `prompt ${systemPromptVariantLabel(promptVariant).toUpperCase()}`
                : `${STATUSLINE_ICONS.prompt_variant} ${systemPromptVariantLabel(promptVariant).toUpperCase()}`}
            </Text>
          ) : null,
      },
      // Static session trivia — deliberately the L1 tail so overflow drops
      // them before anything dynamic. theme ALWAYS renders (getActiveThemeName
      // fallback); it used to sit on the run-state rail where it permanently
      // displaced live telemetry on narrow terminals.
      {
        id: 'theme',
        node:
          (themeName ?? getActiveThemeName()) && showChip('theme') ? (
            <Text color={chipColor(theme.brand, isNoColor)}>
              {isNoColor
                ? truncateChip(themeName ?? getActiveThemeName(), 24)
                : `${STATUSLINE_ICONS.theme} ${truncateChip(themeName ?? getActiveThemeName(), 24)}`}
            </Text>
          ) : null,
      },
      {
        id: 'sessions',
        node:
          sessionCount != null && sessionCount > 0 && showChip('sessions') ? (
            <Text color={isNoColor ? undefined : theme.accent}>
              {isNoColor
                ? `${sessionCount} session${sessionCount === 1 ? '' : 's'}`
                : `${STATUSLINE_ICONS.sessions} ${sessionCount} session${sessionCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
      },
      {
        id: 'tools',
        node:
          toolCount != null && showChip('tools') ? (
            <Text color={isNoColor ? undefined : theme.accent}>
              {isNoColor
                ? `${toolCount} tool${toolCount === 1 ? '' : 's'}`
                : `${STATUSLINE_ICONS.tools} ${toolCount} tool${toolCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
      },
    ] as Array<{ id: string; node: React.ReactElement | null }>
  ).filter((entry): entry is RailSpanEntry => entry.node != null);
}

export function buildRunStateChipEntries(p: StatusBarRailBuildParams): RailSpanEntry[] {
  const {
    yolo,
    showChip,
    isNoColor,
    autonomy,
    processCount,
    primaryChips,
    stateStatusChip,
    fleetWorkingTime,
    tokenSavingMode,
    sideEffectCount,
    showEternalStage,
    eternalStage,
    queueCount,
    hint,
    breakerCountdown,
  } = p;
  return (
    [
      { id: 'state', node: stateStatusChip },
      {
        id: 'yolo',
        node:
          yolo && showChip('yolo') ? (
            <Text color={chipColor(theme.error, isNoColor)} bold>
              {isNoColor ? 'YOLO' : `${STATUSLINE_ICONS.yolo} YOLO`}
            </Text>
          ) : null,
      },
      {
        id: 'autonomy',
        node:
          autonomy && autonomy !== 'off' && showChip('autonomy') ? (
            <Text
              color={chipColor(
                autonomy === 'eternal'
                  ? theme.error
                  : autonomy === 'auto'
                    ? theme.warn
                    : theme.accent,
                isNoColor,
              )}
              bold
            >
              {isNoColor ? autonomy.toUpperCase() : `∞ ${autonomy.toUpperCase()}`}
            </Text>
          ) : null,
      },
      {
        id: 'eternal_stage',
        node:
          showEternalStage && eternalStage ? (
            <EternalStageChip stage={eternalStage} monochrome={isNoColor} />
          ) : null,
      },
      // Urgency-sorted: the breaker countdown is seconds-level safety state,
      // so it leads the dynamic block — ahead of vitals and ahead of the
      // dim hint text it used to trail inside buildPrimaryChips.
      {
        id: 'breaker',
        node:
          breakerCountdown && showChip('breaker')
            ? (() => {
                const secs = Math.ceil(breakerCountdown.remainingMs / 1000);
                const c = secs > 20 ? theme.success : secs > 10 ? theme.warn : theme.error;
                return (
                  <Text color={isNoColor ? undefined : c} bold>
                    {STATUSLINE_ICONS.breaker} kill/reset in {secs}s
                  </Text>
                );
              })()
            : null,
      },
      ...primaryChips.map((node, i) => ({ id: `primary-${i}`, node })),
      // Run backlog sits right after the telemetry composite it feeds.
      {
        id: 'queue',
        node:
          queueCount && queueCount > 0 && showChip('queue') ? (
            <Text color={isNoColor ? undefined : theme.accent}>
              {STATUSLINE_ICONS.queue} queued {queueCount}
            </Text>
          ) : null,
      },
      {
        id: 'processes',
        node:
          processCount != null && processCount > 0 && showChip('processes') ? (
            <Text color={isNoColor ? undefined : theme.error}>
              {STATUSLINE_ICONS.processes} {processCount}{' '}
              {processCount === 1 ? 'process' : 'processes'}
            </Text>
          ) : null,
      },
      {
        id: 'elapsed',
        node:
          fleetWorkingTime != null && fleetWorkingTime > 0 && showChip('elapsed') ? (
            <Text dimColor={!isNoColor}>
              {isNoColor
                ? fmtElapsed(fleetWorkingTime)
                : `${STATUSLINE_ICONS.elapsed} ${fmtElapsed(fleetWorkingTime)}`}
            </Text>
          ) : null,
      },
      {
        id: 'token_saving',
        node:
          tokenSavingMode !== undefined && tokenSavingMode !== 'off' && showChip('token_saving') ? (
            <Text color={isNoColor ? undefined : theme.warn} bold>
              {isNoColor ? tokenSavingMode : `${STATUSLINE_ICONS.token_saving} ${tokenSavingMode}`}
            </Text>
          ) : null,
      },
      {
        id: 'side_effects',
        node:
          sideEffectCount != null && sideEffectCount > 0 && showChip('side_effects') ? (
            <Text color={isNoColor ? undefined : theme.warn}>
              {isNoColor
                ? `${sideEffectCount} audit${sideEffectCount === 1 ? '' : 's'}`
                : `${STATUSLINE_ICONS.side_effects} ${sideEffectCount} audit${sideEffectCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
      },
      // Ephemeral notices (copied notice / running tools) — deliberately the
      // last chip on the rail so overflow drops it first. It used to render
      // between the telemetry composite and processes inside buildPrimaryChips.
      {
        id: 'hint',
        node: hint && showChip('hint') ? <Text dimColor={!isNoColor}>{hint}</Text> : null,
      },
    ] as Array<{ id: string; node: React.ReactElement | null }>
  ).filter((entry): entry is RailSpanEntry => entry.node != null);
}

export function buildMinimumChips(p: StatusBarRailBuildParams): React.ReactElement[] {
  const {
    showChip,
    thinking,
    statePrefix,
    stateLabel,
    animationStyle,
    spinnerIdx,
    cycleTick,
    isNoColor,
    stateColor,
    model,
    provider,
    context,
    showTokenDisplay,
    displayTokens,
    yolo,
    autonomy,
    fleetWorkingTime,
    minimalWorkParts,
  } = p;
  return [
    showChip('state') && thinking ? (
      <ThinkingChip
        text={`${statePrefix} ${stateLabel}`}
        style={animationStyle}
        phase={spinnerIdx}
        cycleTick={cycleTick}
      />
    ) : showChip('state') ? (
      <Text color={chipColor(stateColor, isNoColor)}>
        {statePrefix} {stateLabel}
      </Text>
    ) : null,
    yolo && showChip('yolo') ? (
      <Text color={chipColor(theme.error, isNoColor)} bold>
        {isNoColor ? 'YOLO' : `${STATUSLINE_ICONS.yolo} YOLO`}
      </Text>
    ) : null,
    showChip('model') ? (
      <Text color={chipColor(theme.monitor.agents, isNoColor)}>
        {provider ? `${provider}/` : ''}
        {model}
      </Text>
    ) : null,
    context && showChip('context')
      ? (() => {
          const ratio = context ? Math.min(context.used / context.max, 1) : 0;
          const c = context ? contextBarColor(ratio) : theme.textSecondary;
          return (
            <Text color={chipColor(c, isNoColor)}>
              {context ? <Text dimColor={!isNoColor}>{'ctx '}</Text> : null}
              {context ? renderMeter(ratio, 6) : ''} {context ? fmtTok(context.used) : ''}
            </Text>
          );
        })()
      : null,
    showTokenDisplay && showChip('tokens') ? (
      <Text color={chipColor(theme.textSecondary, isNoColor)}>
        ↑<Text color={chipColor(theme.accent, isNoColor)}>{fmtTok(displayTokens.input)}</Text> ↓
        <Text color={chipColor(theme.accent, isNoColor)}>{fmtTok(displayTokens.output)}</Text>
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
    fleetWorkingTime != null && fleetWorkingTime > 0 && showChip('elapsed') ? (
      <Text dimColor={!isNoColor}>{fmtElapsed(fleetWorkingTime)}</Text>
    ) : null,
    ...(minimalWorkParts.length > 0
      ? [<Text dimColor={!isNoColor}>{minimalWorkParts.slice(0, 2).join(' · ')}</Text>]
      : []),
  ].filter((c): c is React.ReactElement => c !== null);
}

function buildMailboxDetailChips(
  mailbox: MailboxStatus | undefined,
  showMailbox: boolean,
  isNoColor: boolean,
  fleetAgents?: FleetAgentDetail[] | undefined,
  showFleetAgents?: boolean | undefined,
): React.ReactElement[] {
  const chips: React.ReactElement[] = [];
  if (mailbox && showMailbox) {
    chips.push(
      mailbox.unread > 0 ? (
        <Text color={isNoColor ? undefined : theme.warn} bold>
          {STATUSLINE_ICONS.mailbox} {mailbox.unread} new
        </Text>
      ) : (
        <Text dimColor={!isNoColor}>{STATUSLINE_ICONS.mailbox} 0</Text>
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
      chips.push(
        <Text dimColor={!isNoColor}>
          {mailbox.lastFrom ? `${mailbox.lastFrom}: ` : ''}
          {truncateChip(mailbox.lastSubject, 40)}
        </Text>,
      );
    }
  }
  if (fleetAgents && showFleetAgents) {
    for (const agent of fleetAgents) {
      chips.push(
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
            >{` · ${glyphs.process} ×${agent.extensions}`}</Text>
          ) : null}
        </Text>,
      );
    }
  }
  return chips;
}

export function buildWorkRowEntries(p: StatusBarRailBuildParams): RailSpanEntry[] {
  const {
    todos,
    todosCleared,
    showChip,
    isNoColor,
    plan,
    hasTaskActivity,
    tasks,
    hasNextStepsAutoSubmit,
    nextStepsAutoSubmitCountdown,
    nextStepsAutoSubmitLabel,
    nextStepsColor,
    hasActiveGoal,
    goalSummary,
    hasAutoProceed,
    autoProceedCountdown,
    showEnhance,
    enhanceCountdown,
    droppedTools,
  } = p;

  return (
    [
      {
        id: 'goal',
        node: hasActiveGoal ? (
          <Text
            color={
              isNoColor
                ? undefined
                : goalSummary!.goalState === 'abandoned'
                  ? theme.textMuted
                  : goalSummary!.goalState === 'active' || goalSummary!.goalState === 'completed'
                    ? theme.success
                    : theme.warn
            }
          >
            {isNoColor ? '' : `${STATUSLINE_ICONS.goal} `}
            {goalSummary!.goal.length > 40
              ? `${goalSummary!.goal.slice(0, 37)}…`
              : goalSummary!.goal}{' '}
            [{goalSummary!.goalState}] (iter {goalSummary!.iterations})
          </Text>
        ) : null,
      },
      {
        id: 'todos',
        node:
          todos &&
          (todos.pending > 0 || todos.inProgress > 0 || (todos.completed > 0 && !todosCleared)) &&
          showChip('todos') ? (
            <Text>
              <Text dimColor={!isNoColor}>todos </Text>
              {todos.inProgress > 0 ? (
                <Text color={isNoColor ? undefined : theme.warn}>
                  {isNoColor ? `?${todos.inProgress}` : `${glyphs.running} ${todos.inProgress}`}
                </Text>
              ) : null}
              {todos.inProgress > 0 && (todos.pending > 0 || todos.completed > 0) ? ' ' : ''}
              {todos.pending > 0 ? (
                <Text dimColor={!isNoColor}>
                  {isNoColor ? `.${todos.pending}` : `${glyphs.pending} ${todos.pending}`}
                </Text>
              ) : null}
              {todos.pending > 0 && todos.completed > 0 ? ' ' : ''}
              {todos.completed > 0 ? (
                <Text color={isNoColor ? undefined : theme.success}>
                  {isNoColor ? `+${todos.completed}` : `${glyphs.success} ${todos.completed}`}
                </Text>
              ) : null}
            </Text>
          ) : null,
      },
      {
        id: 'plan',
        node:
          plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0) && showChip('plan') ? (
            <Text>
              <Text color={isNoColor ? undefined : theme.accent}>
                {isNoColor ? '' : `${STATUSLINE_ICONS.plan} `}
              </Text>
              {plan.inProgress > 0 ? (
                <Text color={isNoColor ? undefined : theme.warn}>
                  {isNoColor ? `?${plan.inProgress}` : `${glyphs.running} ${plan.inProgress}`}
                </Text>
              ) : null}
              {plan.inProgress > 0 && (plan.open > 0 || plan.done > 0) ? ' ' : ''}
              {plan.open > 0 ? (
                <Text dimColor={!isNoColor}>
                  {isNoColor ? `.${plan.open}` : `${glyphs.pending} ${plan.open}`}
                </Text>
              ) : null}
              {plan.open > 0 && plan.done > 0 ? ' ' : ''}
              {plan.done > 0 ? (
                <Text color={isNoColor ? undefined : theme.success}>
                  {isNoColor ? `+${plan.done}` : `${glyphs.success} ${plan.done}`}
                </Text>
              ) : null}
              {plan.scope ? <Text dimColor={!isNoColor}> [{plan.scope}]</Text> : null}
            </Text>
          ) : null,
      },
      {
        id: 'tasks',
        node:
          hasTaskActivity && showChip('tasks') ? (
            <Text>
              <Text color={isNoColor ? undefined : theme.monitor.agents}>
                {isNoColor ? '' : `${STATUSLINE_ICONS.tasks} `}
              </Text>
              {tasks!.inProgress > 0 ? (
                <Text color={isNoColor ? undefined : theme.warn}>
                  {isNoColor ? `?${tasks!.inProgress}` : `${glyphs.running} ${tasks!.inProgress}`}
                </Text>
              ) : null}
              {tasks!.inProgress > 0 && (tasks!.pending > 0 || tasks!.blocked > 0) ? ' ' : ''}
              {tasks!.pending > 0 ? (
                <Text dimColor={!isNoColor}>
                  {isNoColor ? `.${tasks!.pending}` : `${glyphs.pending} ${tasks!.pending}`}
                </Text>
              ) : null}
              {tasks!.pending > 0 && tasks!.blocked > 0 ? ' ' : ''}
              {tasks!.blocked > 0 ? (
                <Text color={isNoColor ? undefined : theme.error}>
                  {isNoColor ? `!${tasks!.blocked}` : `${glyphs.warning} ${tasks!.blocked}`}
                </Text>
              ) : null}
              {(tasks!.pending > 0 || tasks!.blocked > 0) &&
              (tasks!.completed > 0 || tasks!.failed > 0)
                ? ' '
                : ''}
              {tasks!.completed > 0 ? (
                <Text color={isNoColor ? undefined : theme.success}>
                  {isNoColor ? `+${tasks!.completed}` : `${glyphs.success} ${tasks!.completed}`}
                </Text>
              ) : null}
              {tasks!.completed > 0 && tasks!.failed > 0 ? ' ' : ''}
              {tasks!.failed > 0 ? (
                <Text color={isNoColor ? undefined : theme.error}>
                  {isNoColor ? `x${tasks!.failed}` : `${glyphs.failure} ${tasks!.failed}`}
                </Text>
              ) : null}
              {tasks!.scope ? <Text dimColor={!isNoColor}> [{tasks!.scope}]</Text> : null}
            </Text>
          ) : null,
      },
      {
        id: 'next_steps',
        node:
          hasNextStepsAutoSubmit &&
          nextStepsAutoSubmitCountdown != null &&
          showChip('next_steps') ? (
            <>
              <Text color={isNoColor ? undefined : nextStepsColor} bold>
                {isNoColor
                  ? `${nextStepsAutoSubmitCountdown}s`
                  : `${STATUSLINE_ICONS.next_steps} ${nextStepsAutoSubmitCountdown}s`}
              </Text>
              <Text dimColor={!isNoColor}>
                {' '}
                {nextStepsAutoSubmitLabel ? formatSuggestionLabel(nextStepsAutoSubmitLabel) : ''}
                {' · ⇥ edit'}
              </Text>
            </>
          ) : null,
      },
      {
        id: 'auto_proceed',
        node:
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
                : `${STATUSLINE_ICONS.auto_proceed} auto in ${autoProceedCountdown}s`}
            </Text>
          ) : null,
      },
      {
        id: 'enhance',
        node: showEnhance ? (
          <Text color={isNoColor ? undefined : countdownColor(enhanceCountdown!, 15, 5)}>
            {isNoColor
              ? `refined · send in ${enhanceCountdown}s`
              : `${STATUSLINE_ICONS.enhance} refinement ready · send in ${enhanceCountdown}s`}
          </Text>
        ) : null,
      },
      {
        id: 'dropped_tools',
        node:
          droppedTools && droppedTools > 0 && showChip('dropped_tools') ? (
            <Text color={isNoColor ? undefined : theme.warn}>
              {isNoColor
                ? `-${droppedTools} tools`
                : `${STATUSLINE_ICONS.dropped_tools} -${droppedTools}`}
            </Text>
          ) : null,
      },
    ] as Array<{ id: string; node: React.ReactElement | null }>
  ).filter((entry): entry is RailSpanEntry => entry.node != null);
}

export function buildConnectivityChipEntries(p: StatusBarRailBuildParams): RailSpanEntry[] {
  const {
    showChip,
    isNoColor,
    fleetHasActivity,
    fleet,
    subagentCount,
    showBrain,
    brain,
    showDebugStream,
    debugStreamStats,
    mailbox,
    fleetAgents,
    showMailbox,
    memoryDetailChips,
  } = p;
  const mailboxChips = buildMailboxDetailChips(
    mailbox,
    showMailbox,
    isNoColor,
    fleetAgents,
    showChip('fleet_agents'),
  );
  return (
    [
      {
        id: 'fleet',
        node:
          fleetHasActivity && showChip('fleet') ? (
            fleet ? (
              <Text>
                <Text color={isNoColor ? undefined : theme.accent}>
                  {isNoColor ? '' : `${STATUSLINE_ICONS.fleet} `}
                </Text>
                {fleet.running > 0 ? (
                  <Text color={isNoColor ? undefined : theme.warn}>
                    {isNoColor ? `>${fleet.running}` : `${glyphs.running} ${fleet.running}`}
                  </Text>
                ) : null}
                {fleet.running > 0 && (fleet.pending > 0 || fleet.idle > 0 || fleet.completed > 0)
                  ? ' '
                  : ''}
                {fleet.pending > 0 ? (
                  <Text dimColor={!isNoColor}>
                    {isNoColor ? `.${fleet.pending}` : `${glyphs.pending} ${fleet.pending}`}
                  </Text>
                ) : null}
                {fleet.pending > 0 && (fleet.idle > 0 || fleet.completed > 0) ? ' ' : ''}
                {fleet.idle > 0 ? <Text dimColor={!isNoColor}>·{fleet.idle}idle</Text> : null}
                {fleet.idle > 0 && fleet.completed > 0 ? ' ' : ''}
                {fleet.completed > 0 ? (
                  <Text color={isNoColor ? undefined : theme.success}>
                    {isNoColor ? `+${fleet.completed}` : `${glyphs.success} ${fleet.completed}`}
                  </Text>
                ) : null}
              </Text>
            ) : (
              <Text color={isNoColor ? undefined : theme.accent}>
                {isNoColor
                  ? `${subagentCount} agent${subagentCount === 1 ? '' : 's'}`
                  : `${STATUSLINE_ICONS.fleet} ${subagentCount} agent${subagentCount === 1 ? '' : 's'}`}
              </Text>
            )
          ) : null,
      },
      ...mailboxChips.map((node, i) => ({ id: i === 0 ? 'mailbox' : `detail-${i}`, node })),
      {
        id: 'brain',
        node: showBrain ? <BrainChip brain={brain!} monochrome={isNoColor} /> : null,
      },
      {
        id: 'debug_stream',
        node: showDebugStream ? (
          <Text color={isNoColor ? undefined : theme.accent}>
            <Text bold>{isNoColor ? 'stream' : `${STATUSLINE_ICONS.debug_stream} stream`}</Text>
            <Text dimColor={!isNoColor}> #{debugStreamStats!.chunkCount}</Text>
            <Text dimColor={!isNoColor}> · {debugStreamStats!.lastChunkSize}B</Text>
            <Text dimColor={!isNoColor}> · +{debugStreamStats!.lastDeltaMs}ms</Text>
            <Text dimColor={!isNoColor}> · {fmtDebugBytes(debugStreamStats!.totalBytes)}</Text>
          </Text>
        ) : null,
      },
      ...memoryDetailChips.map((node, i) => ({ id: `memory-${i}`, node })),
    ] as Array<{ id: string; node: React.ReactElement | null }>
  ).filter((entry): entry is RailSpanEntry => entry.node != null);
}

export function buildIndexStatusChip(
  indexState: StatusBarProps['indexState'],
  showChip: (item: StatuslineItem) => boolean,
  isNoColor: boolean,
): React.ReactElement | null {
  if (!indexState || !showChip('index')) return null;
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
      {STATUSLINE_ICONS.index} {label}
    </Text>
  );
}

export function buildMemoryDetailChips(
  memoryContextMonitor: StatusBarProps['memoryContextMonitor'],
  Sage: StatusBarProps['Sage'],
  isNoColor: boolean,
): React.ReactElement[] {
  const memorySummary = memoryContextMonitor?.latest;
  // No memory telemetry at all → no chips (not even the section label), so
  // an index-only line 4 renders the index chip without a bare `✦ Memory`.
  if (!Sage && !memorySummary) return [];
  const memoryDetailChips: React.ReactElement[] = [];
  const liveActive = memoryContextMonitor
    ? activeMemoryContextCount(memoryContextMonitor as never)
    : 0;
  const reportedActive = memoryContextMonitor ? liveActive : (Sage?.activeInContext ?? 0);
  memoryDetailChips.push(
    <Text color={chipColor(theme.accent, isNoColor)} key="mem-label">
      {isNoColor ? 'Memory ' : `${STATUSLINE_ICONS.memory_context} Memory `}
    </Text>,
  );
  if (Sage) {
    memoryDetailChips.push(
      <Text key="total">
        {Sage.total} total
        {reportedActive > 0 ? (
          <>
            <Text dimColor={!isNoColor}> · </Text>
            <Text color={chipColor(theme.success, isNoColor)}>{reportedActive} actv</Text>
          </>
        ) : null}
      </Text>,
    );
  } else if (reportedActive > 0) {
    memoryDetailChips.push(
      <Text key="actv">
        <Text color={chipColor(theme.success, isNoColor)}>{reportedActive} actv</Text>
      </Text>,
    );
  }
  if (memorySummary && memorySummary.outcome !== 'error') {
    const hasPipeline =
      memorySummary.matched > 0 || memorySummary.injected > 0 || memorySummary.filtered > 0;
    if (hasPipeline) {
      memoryDetailChips.push(
        <Text key="pipeline">
          <Text dimColor={!isNoColor}>{' · '}</Text>
          <Text dimColor={!isNoColor}>{memorySummary.matched} matched</Text>
          <Text dimColor={!isNoColor}>{' · '}</Text>
          <Text color={chipColor(theme.success, isNoColor)}>{memorySummary.injected} inj</Text>
          <Text dimColor={!isNoColor}>{' · '}</Text>
          <Text color={chipColor(theme.warn, isNoColor)}>{memorySummary.filtered} filt</Text>
        </Text>,
      );
    }
    if (memorySummary.contextPressure > 0) {
      const pressurePct = Math.round(memorySummary.contextPressure * 100);
      const pressureColor =
        pressurePct >= 80 ? theme.error : pressurePct >= 65 ? theme.warn : theme.textSecondary;
      memoryDetailChips.push(
        <Text key="pressure">
          <Text dimColor={!isNoColor}>{' · '}</Text>
          <Text color={chipColor(pressureColor, isNoColor)}>{pressurePct}% ctx</Text>
        </Text>,
      );
    }
  }
  return memoryDetailChips;
}
