import { systemPromptVariantLabel } from '@wrongstack/core/agent';
import type { StatuslineDensity } from '@wrongstack/core/statusline';
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
  fmtRatioPct,
  fmtTok,
  renderMeter,
  shortenPath,
  truncateChip,
} from './status-bar-format.js';
import { countdownColor, formatSuggestionLabel, modeIcon } from './status-bar-helpers.js';
import { chipColor, STATUSLINE_ICONS } from './status-bar-icons.js';
import type { FleetAgentDetail, MailboxStatus, StatusBarProps } from './status-bar-types.js';
import type { StatuslineItem } from './statusline-picker.js';

export interface StatusBarRailBuildParams {
  showChip: (item: StatuslineItem) => boolean;
  /** Resolved density for a chip ('auto' unless the user pinned one). */
  chipDensity: (item: StatuslineItem) => StatuslineDensity;
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
  tokenSavingMode?: StatusBarProps['tokenSavingMode'];
  sideEffectCount?: number | undefined;
  todos?: StatusBarProps['todos'];
  todosCleared: boolean;
  plan?: StatusBarProps['plan'];
  tasks?: StatusBarProps['tasks'];
  hasTaskActivity: boolean | undefined;
  fleet?: StatusBarProps['fleet'];
  fleetHasActivity: boolean | undefined;
  subagentCount: number;
  showBrain: boolean;
  brain?: StatusBarProps['brain'];
  showDebugStream: boolean;
  debugStreamStats?: StatusBarProps['debugStreamStats'];
  showEnhance: boolean;
  enhanceCountdown?: number | null | undefined;
  hasNextStepsAutoSubmit: boolean;
  nextStepsAutoSubmitCountdown?: number | null | undefined;
  nextStepsAutoSubmitLabel?: string | null | undefined;
  nextStepsColor: string;
  showEternalStage: boolean;
  eternalStage?: StatusBarProps['eternalStage'];
  hasActiveGoal: boolean;
  goalSummary?: StatusBarProps['goalSummary'];
  hasAutoProceed: boolean;
  autoProceedCountdown?: number | null | undefined;
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
  /** Mailbox status for the async rail. */
  mailbox?: MailboxStatus | undefined;
  /** Per-agent live detail rows for the async rail. */
  fleetAgents?: FleetAgentDetail[] | undefined;
  /** Whether the mailbox chip is eligible (not hidden + has activity). */
  showMailbox: boolean;
  /** Pre-built memory-context chips for the async rail. */
  memoryDetailChips: RailSpanEntry[];
  /** Active system-prompt variant (Lite / Standard / Pro) — identity chip. */
  promptVariant?: 'lite' | 'default' | 'pro' | undefined;
}

/**
 * Translate a chip's density setting into the level bounds the rail fitter
 * may use. `auto` leaves the full range open; every other value pins one
 * level (clamped to what the chip actually offers, so a two-level chip
 * pinned to `micro` renders its narrowest form rather than nothing).
 */
export function densityBounds(
  density: StatuslineDensity,
  levelCount: number,
): { lo: number; hi: number } {
  const last = Math.max(0, levelCount - 1);
  switch (density) {
    case 'full':
      return { lo: 0, hi: 0 };
    case 'short': {
      const level = Math.min(1, last);
      return { lo: level, hi: level };
    }
    case 'micro':
      return { lo: last, hi: last };
    default:
      return { lo: 0, hi: last };
  }
}

/**
 * Assemble one rail entry from its density levels (widest → narrowest).
 * Nullish levels are dropped, so a chip can declare `[full, short, micro]`
 * and silently degrade to fewer levels when the data for a richer form
 * isn't there. Returns null when the chip has nothing to render at all.
 */
function entry(
  id: string,
  key: StatuslineItem,
  p: StatusBarRailBuildParams,
  levels: Array<React.ReactElement | null | false | undefined>,
): RailSpanEntry | null {
  const nodes = levels.filter((node): node is React.ReactElement => Boolean(node));
  if (nodes.length === 0) return null;
  const { lo, hi } = densityBounds(p.chipDensity(key), nodes.length);
  return { id, node: nodes[0]!, alt: nodes.slice(1), lo, hi };
}

function compact(entries: Array<RailSpanEntry | null>): RailSpanEntry[] {
  return entries.filter((item): item is RailSpanEntry => item != null);
}

/** `icon ` prefix, or '' in no-color/ASCII-ish mode. */
function icon(glyph: string, isNoColor: boolean): string {
  return isNoColor ? '' : `${glyph} `;
}

export function buildWorkspaceChipEntries(
  p: StatusBarRailBuildParams,
  modelStatusChip: React.ReactElement | null,
  modelShortChip?: React.ReactElement | null,
  modelMicroChip?: React.ReactElement | null,
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
  const accent = chipColor(theme.accent, isNoColor);
  const activeTheme = themeName ?? getActiveThemeName();
  const variantLabel = promptVariant ? systemPromptVariantLabel(promptVariant).toUpperCase() : '';

  return compact([
    projectName && showChip('project')
      ? entry('project', 'project', p, [
          <Text color={accent}>
            {icon(STATUSLINE_ICONS.project, isNoColor)}
            {truncateChip(projectName, 24)}
          </Text>,
          <Text color={accent}>
            {icon(STATUSLINE_ICONS.project, isNoColor)}
            {truncateChip(projectName, 12)}
          </Text>,
          <Text color={accent}>
            {icon(STATUSLINE_ICONS.project, isNoColor)}
            {truncateChip(projectName, 6)}
          </Text>,
        ])
      : null,
    workingDir && showChip('working_dir')
      ? entry('working_dir', 'working_dir', p, [
          <Text color={accent}>
            {icon(STATUSLINE_ICONS.working_dir, isNoColor)}
            {truncateChip(workingDir, 28)}
          </Text>,
          <Text color={accent}>
            {icon(STATUSLINE_ICONS.working_dir, isNoColor)}
            {shortenPath(workingDir, 2)}
          </Text>,
          <Text color={accent}>
            {icon(STATUSLINE_ICONS.working_dir, isNoColor)}
            {shortenPath(workingDir, 1)}
          </Text>,
        ])
      : null,
    git && showChip('git')
      ? entry('git', 'git', p, [
          <Text>
            <Text color={theme.monitor.agents}>
              {STATUSLINE_ICONS.git} {truncateChip(git.branch, 24)}
            </Text>
            {git.deleted > 0 ? <Text color={theme.error}> -{git.deleted}</Text> : null}
            {git.untracked > 0 ? <Text dimColor={!isNoColor}> ?{git.untracked}</Text> : null}
          </Text>,
          <Text color={theme.monitor.agents}>
            {STATUSLINE_ICONS.git} {truncateChip(git.branch, 12)}
          </Text>,
          <Text color={theme.monitor.agents}>
            {STATUSLINE_ICONS.git}
            {truncateChip(git.branch, 7)}
          </Text>,
        ])
      : null,
    modelStatusChip
      ? entry('model', 'model', p, [modelStatusChip, modelShortChip, modelMicroChip])
      : null,
    modeLabel && showChip('mode')
      ? entry('mode', 'mode', p, [
          <Text color={accent}>{isNoColor ? modeLabel : modeIcon(modeLabel)}</Text>,
          <Text color={accent}>
            {isNoColor ? truncateChip(modeLabel, 8) : modeIcon(truncateChip(modeLabel, 8))}
          </Text>,
        ])
      : null,
    promptVariant && showChip('prompt_variant')
      ? entry('prompt_variant', 'prompt_variant', p, [
          <Text color={chipColor(theme.brand, isNoColor)}>
            {isNoColor
              ? `prompt ${variantLabel}`
              : `${STATUSLINE_ICONS.prompt_variant} ${variantLabel}`}
          </Text>,
          <Text color={chipColor(theme.brand, isNoColor)}>
            {isNoColor
              ? variantLabel.slice(0, 3)
              : `${STATUSLINE_ICONS.prompt_variant}${variantLabel.slice(0, 1)}`}
          </Text>,
        ])
      : null,
    // Static session trivia — deliberately the identity tail so overflow
    // sheds them before anything that identifies the session. All three are
    // off by default (DEFAULT_HIDDEN_ITEMS); a user who turns them back on
    // gets them at whatever density the rail can afford.
    activeTheme && showChip('theme')
      ? entry('theme', 'theme', p, [
          <Text color={chipColor(theme.brand, isNoColor)}>
            {icon(STATUSLINE_ICONS.theme, isNoColor)}
            {truncateChip(activeTheme, 24)}
          </Text>,
          <Text color={chipColor(theme.brand, isNoColor)}>
            {icon(STATUSLINE_ICONS.theme, isNoColor)}
            {truncateChip(activeTheme, 10)}
          </Text>,
          isNoColor ? null : (
            <Text color={chipColor(theme.brand, isNoColor)}>{STATUSLINE_ICONS.theme}</Text>
          ),
        ])
      : null,
    sessionCount != null && sessionCount > 0 && showChip('sessions')
      ? entry('sessions', 'sessions', p, [
          <Text color={accent}>
            {icon(STATUSLINE_ICONS.sessions, isNoColor)}
            {sessionCount} session{sessionCount === 1 ? '' : 's'}
          </Text>,
          <Text color={accent}>
            {icon(STATUSLINE_ICONS.sessions, isNoColor)}
            {sessionCount}
          </Text>,
        ])
      : null,
    toolCount != null && showChip('tools')
      ? entry('tools', 'tools', p, [
          <Text color={accent}>
            {icon(STATUSLINE_ICONS.tools, isNoColor)}
            {toolCount} tool{toolCount === 1 ? '' : 's'}
          </Text>,
          <Text color={accent}>
            {icon(STATUSLINE_ICONS.tools, isNoColor)}
            {toolCount}
          </Text>,
        ])
      : null,
  ]);
}

/**
 * The per-turn telemetry chips. Formerly a single 90-column composite whose
 * four contract keys (context/tokens/cost/cache) could neither be assigned
 * to different lines nor partially shed on overflow — they are four real
 * entries now, each independently placeable, degradable and hit-testable.
 */
export function buildVitalsChipEntries(p: StatusBarRailBuildParams): RailSpanEntry[] {
  const {
    context,
    showTokenDisplay,
    cost,
    cache,
    showChip,
    isNoColor,
    displayTokens,
    contextStrategy,
    stateStatusChip,
    fleetWorkingTime,
    queueCount,
    hint,
  } = p;
  const ratio = context ? Math.min(context.used / context.max, 1) : 0;
  const barColor = isNoColor ? undefined : contextBarColor(ratio);
  const hasCost = cost != null && cost.total > 0;
  const hasCache = cache != null && cache.hitRatio > 0;

  return compact([
    stateStatusChip ? entry('state', 'state', p, [stateStatusChip]) : null,
    context && showChip('context')
      ? entry('context', 'context', p, [
          <Text color={barColor}>
            <Text dimColor={!isNoColor}>{`${STATUSLINE_ICONS.context} ctx `}</Text>
            {renderMeter(ratio, 8)} {fmtTok(context.used)}/{fmtTok(context.max)}
            {contextStrategy ? <Text dimColor={!isNoColor}>{` [${contextStrategy}]`}</Text> : null}
          </Text>,
          <Text color={barColor}>
            {renderMeter(ratio, 6)} {fmtRatioPct(ratio, 0)}
          </Text>,
          <Text color={barColor}>
            {STATUSLINE_ICONS.context}
            {fmtRatioPct(ratio, 0)}
          </Text>,
        ])
      : null,
    showTokenDisplay && showChip('tokens')
      ? entry('tokens', 'tokens', p, [
          <Text>
            <Text color={chipColor(theme.textSecondary, isNoColor)}>{'↑'}</Text>
            <Text color={chipColor(theme.accent, isNoColor)}>{fmtTok(displayTokens.input)}</Text>
            <Text color={chipColor(theme.textSecondary, isNoColor)}>{' ↓'}</Text>
            <Text color={chipColor(theme.accent, isNoColor)}>{fmtTok(displayTokens.output)}</Text>
          </Text>,
          <Text color={chipColor(theme.accent, isNoColor)}>
            {`↑${fmtTok(displayTokens.input)}↓${fmtTok(displayTokens.output)}`}
          </Text>,
          <Text color={chipColor(theme.accent, isNoColor)}>
            {`↑${fmtTok(displayTokens.input)}`}
          </Text>,
        ])
      : null,
    hasCost && showChip('cost')
      ? entry('cost', 'cost', p, [
          <Text color={chipColor(theme.warn, isNoColor)}>
            {STATUSLINE_ICONS.cost} {cost.total.toFixed(4)}
          </Text>,
          <Text color={chipColor(theme.warn, isNoColor)}>
            {STATUSLINE_ICONS.cost}
            {cost.total.toFixed(2)}
          </Text>,
        ])
      : null,
    hasCache && showChip('cache')
      ? entry('cache', 'cache', p, [
          // `r`/`w` prefixes distinguish cache tokens from the ↑/↓ request
          // tokens of the tokens chip. Saved USD only when cache reads
          // actually saved money (0 = no priced cache reads yet).
          <Text dimColor={!isNoColor}>
            {STATUSLINE_ICONS.cache} {fmtRatioPct(cache.hitRatio)}
            <Text> r{fmtTok(cache.readTokens)}</Text>
            <Text> w{fmtTok(cache.writeTokens)}</Text>
            {cache.savedUsd > 0 ? <Text> ~${cache.savedUsd.toFixed(2)}</Text> : null}
          </Text>,
          <Text dimColor={!isNoColor}>
            {STATUSLINE_ICONS.cache}
            {fmtRatioPct(cache.hitRatio, 0)}
            {cache.savedUsd > 0 ? <Text> ~${cache.savedUsd.toFixed(2)}</Text> : null}
          </Text>,
          <Text dimColor={!isNoColor}>
            {STATUSLINE_ICONS.cache}
            {fmtRatioPct(cache.hitRatio, 0)}
          </Text>,
        ])
      : null,
    fleetWorkingTime != null && fleetWorkingTime > 0 && showChip('elapsed')
      ? entry('elapsed', 'elapsed', p, [
          <Text dimColor={!isNoColor}>
            {icon(STATUSLINE_ICONS.elapsed, isNoColor)}
            {fmtElapsed(fleetWorkingTime)}
          </Text>,
          <Text dimColor={!isNoColor}>{fmtElapsed(fleetWorkingTime)}</Text>,
        ])
      : null,
    queueCount != null && queueCount > 0 && showChip('queue')
      ? entry('queue', 'queue', p, [
          <Text color={chipColor(theme.accent, isNoColor)}>
            {STATUSLINE_ICONS.queue} queued {queueCount}
          </Text>,
          <Text color={chipColor(theme.accent, isNoColor)}>
            {STATUSLINE_ICONS.queue}
            {queueCount}
          </Text>,
        ])
      : null,
    // Ephemeral notices (copied notice / running tools). Last on the rail so
    // overflow drops it first, and truncated so one long notice can never
    // consume the whole line.
    hint && showChip('hint')
      ? entry('hint', 'hint', p, [
          <Text dimColor={!isNoColor}>{truncateChip(hint, 44)}</Text>,
          <Text dimColor={!isNoColor}>{truncateChip(hint, 18)}</Text>,
          <Text dimColor={!isNoColor}>{truncateChip(hint, 9)}</Text>,
        ])
      : null,
  ]);
}

/**
 * Standing posture (is this session dangerous? is it throttled?) followed by
 * the work in flight. A reader scans this rail left-to-right to answer
 * "what is it allowed to do, and what is it doing".
 */
export function buildSafetyWorkEntries(p: StatusBarRailBuildParams): RailSpanEntry[] {
  const {
    yolo,
    showChip,
    isNoColor,
    autonomy,
    processCount,
    tokenSavingMode,
    sideEffectCount,
    showEternalStage,
    eternalStage,
    breakerCountdown,
    droppedTools,
    todos,
    todosCleared,
    plan,
    hasTaskActivity,
    tasks,
    hasActiveGoal,
    goalSummary,
  } = p;
  const autonomyColor = chipColor(
    autonomy === 'eternal' ? theme.error : autonomy === 'auto' ? theme.warn : theme.accent,
    isNoColor,
  );

  return compact([
    yolo && showChip('yolo')
      ? entry('yolo', 'yolo', p, [
          <Text color={chipColor(theme.error, isNoColor)} bold>
            {isNoColor ? 'YOLO' : `${STATUSLINE_ICONS.yolo} YOLO`}
          </Text>,
          <Text color={chipColor(theme.error, isNoColor)} bold>
            {isNoColor ? 'YOLO' : `${STATUSLINE_ICONS.yolo}Y`}
          </Text>,
        ])
      : null,
    autonomy && autonomy !== 'off' && showChip('autonomy')
      ? entry('autonomy', 'autonomy', p, [
          <Text color={autonomyColor} bold>
            {isNoColor ? autonomy.toUpperCase() : `∞ ${autonomy.toUpperCase()}`}
          </Text>,
          <Text color={autonomyColor} bold>
            {isNoColor
              ? autonomy.slice(0, 1).toUpperCase()
              : `∞${autonomy.slice(0, 1).toUpperCase()}`}
          </Text>,
        ])
      : null,
    showEternalStage && eternalStage
      ? entry('eternal_stage', 'eternal_stage', p, [
          <EternalStageChip stage={eternalStage} monochrome={isNoColor} />,
        ])
      : null,
    // Seconds-level safety state: the breaker leads the posture block.
    breakerCountdown && showChip('breaker')
      ? (() => {
          const secs = Math.ceil(breakerCountdown.remainingMs / 1000);
          const color = countdownColor(secs, 20, 10);
          return entry('breaker', 'breaker', p, [
            <Text color={isNoColor ? undefined : color} bold>
              {STATUSLINE_ICONS.breaker} kill/reset in {secs}s
            </Text>,
            <Text color={isNoColor ? undefined : color} bold>
              {STATUSLINE_ICONS.breaker} {secs}s
            </Text>,
          ]);
        })()
      : null,
    tokenSavingMode !== undefined && tokenSavingMode !== 'off' && showChip('token_saving')
      ? entry('token_saving', 'token_saving', p, [
          <Text color={chipColor(theme.warn, isNoColor)} bold>
            {isNoColor ? tokenSavingMode : `${STATUSLINE_ICONS.token_saving} ${tokenSavingMode}`}
          </Text>,
          <Text color={chipColor(theme.warn, isNoColor)} bold>
            {isNoColor
              ? tokenSavingMode.slice(0, 1)
              : `${STATUSLINE_ICONS.token_saving}${tokenSavingMode.slice(0, 1).toUpperCase()}`}
          </Text>,
        ])
      : null,
    processCount != null && processCount > 0 && showChip('processes')
      ? entry('processes', 'processes', p, [
          <Text color={chipColor(theme.error, isNoColor)}>
            {STATUSLINE_ICONS.processes} {processCount}{' '}
            {processCount === 1 ? 'process' : 'processes'}
          </Text>,
          <Text color={chipColor(theme.error, isNoColor)}>
            {STATUSLINE_ICONS.processes}
            {processCount}
          </Text>,
        ])
      : null,
    sideEffectCount != null && sideEffectCount > 0 && showChip('side_effects')
      ? entry('side_effects', 'side_effects', p, [
          <Text color={chipColor(theme.warn, isNoColor)}>
            {icon(STATUSLINE_ICONS.side_effects, isNoColor)}
            {sideEffectCount} audit{sideEffectCount === 1 ? '' : 's'}
          </Text>,
          <Text color={chipColor(theme.warn, isNoColor)}>
            {icon(STATUSLINE_ICONS.side_effects, isNoColor)}
            {sideEffectCount}
          </Text>,
        ])
      : null,
    droppedTools != null && droppedTools > 0 && showChip('dropped_tools')
      ? entry('dropped_tools', 'dropped_tools', p, [
          <Text color={chipColor(theme.warn, isNoColor)}>
            {isNoColor
              ? `-${droppedTools} tools`
              : `${STATUSLINE_ICONS.dropped_tools} -${droppedTools}`}
          </Text>,
        ])
      : null,
    hasActiveGoal && goalSummary
      ? entry('goal', 'goal', p, [
          <Text
            color={
              isNoColor
                ? undefined
                : goalSummary.goalState === 'abandoned'
                  ? theme.textMuted
                  : goalSummary.goalState === 'active' || goalSummary.goalState === 'completed'
                    ? theme.success
                    : theme.warn
            }
          >
            {icon(STATUSLINE_ICONS.goal, isNoColor)}
            {truncateChip(goalSummary.goal, 40)} [{goalSummary.goalState}] (iter{' '}
            {goalSummary.iterations})
          </Text>,
          <Text color={isNoColor ? undefined : theme.success}>
            {icon(STATUSLINE_ICONS.goal, isNoColor)}
            {truncateChip(goalSummary.goal, 18)} (i{goalSummary.iterations})
          </Text>,
          <Text color={isNoColor ? undefined : theme.success}>
            {icon(STATUSLINE_ICONS.goal, isNoColor)}
            {truncateChip(goalSummary.goal, 8)}
          </Text>,
        ])
      : null,
    todos &&
    (todos.pending > 0 || todos.inProgress > 0 || (todos.completed > 0 && !todosCleared)) &&
    showChip('todos')
      ? (() => {
          const counts = (
            <>
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
            </>
          );
          return entry('todos', 'todos', p, [
            <Text>
              <Text dimColor={!isNoColor}>todos </Text>
              {counts}
            </Text>,
            <Text>{counts}</Text>,
            <Text color={isNoColor ? undefined : theme.warn}>
              {`${STATUSLINE_ICONS.todos}${todos.inProgress + todos.pending}`}
            </Text>,
          ]);
        })()
      : null,
    plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0) && showChip('plan')
      ? (() => {
          const counts = (
            <>
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
            </>
          );
          const lead = (
            <Text color={isNoColor ? undefined : theme.accent}>
              {icon(STATUSLINE_ICONS.plan, isNoColor)}
            </Text>
          );
          return entry('plan', 'plan', p, [
            <Text>
              {lead}
              {counts}
              {plan.scope ? <Text dimColor={!isNoColor}> [{plan.scope}]</Text> : null}
            </Text>,
            <Text>
              {lead}
              {counts}
            </Text>,
            <Text color={isNoColor ? undefined : theme.accent}>
              {`${STATUSLINE_ICONS.plan}${plan.inProgress + plan.open}`}
            </Text>,
          ]);
        })()
      : null,
    hasTaskActivity && tasks && showChip('tasks')
      ? (() => {
          const counts = (
            <>
              {tasks.inProgress > 0 ? (
                <Text color={isNoColor ? undefined : theme.warn}>
                  {isNoColor ? `?${tasks.inProgress}` : `${glyphs.running} ${tasks.inProgress}`}
                </Text>
              ) : null}
              {tasks.inProgress > 0 && (tasks.pending > 0 || tasks.blocked > 0) ? ' ' : ''}
              {tasks.pending > 0 ? (
                <Text dimColor={!isNoColor}>
                  {isNoColor ? `.${tasks.pending}` : `${glyphs.pending} ${tasks.pending}`}
                </Text>
              ) : null}
              {tasks.pending > 0 && tasks.blocked > 0 ? ' ' : ''}
              {tasks.blocked > 0 ? (
                <Text color={isNoColor ? undefined : theme.error}>
                  {isNoColor ? `!${tasks.blocked}` : `${glyphs.warning} ${tasks.blocked}`}
                </Text>
              ) : null}
              {(tasks.pending > 0 || tasks.blocked > 0) && (tasks.completed > 0 || tasks.failed > 0)
                ? ' '
                : ''}
              {tasks.completed > 0 ? (
                <Text color={isNoColor ? undefined : theme.success}>
                  {isNoColor ? `+${tasks.completed}` : `${glyphs.success} ${tasks.completed}`}
                </Text>
              ) : null}
              {tasks.completed > 0 && tasks.failed > 0 ? ' ' : ''}
              {tasks.failed > 0 ? (
                <Text color={isNoColor ? undefined : theme.error}>
                  {isNoColor ? `x${tasks.failed}` : `${glyphs.failure} ${tasks.failed}`}
                </Text>
              ) : null}
            </>
          );
          const lead = (
            <Text color={isNoColor ? undefined : theme.monitor.agents}>
              {icon(STATUSLINE_ICONS.tasks, isNoColor)}
            </Text>
          );
          return entry('tasks', 'tasks', p, [
            <Text>
              {lead}
              {counts}
              {tasks.scope ? <Text dimColor={!isNoColor}> [{tasks.scope}]</Text> : null}
            </Text>,
            <Text>
              {lead}
              {counts}
            </Text>,
            <Text color={isNoColor ? undefined : theme.monitor.agents}>
              {`${STATUSLINE_ICONS.tasks}${tasks.inProgress + tasks.pending}`}
            </Text>,
          ]);
        })()
      : null,
  ]);
}

function buildMailboxDetailEntries(
  p: StatusBarRailBuildParams,
  mailbox: MailboxStatus | undefined,
  showMailbox: boolean,
): RailSpanEntry[] {
  const { isNoColor } = p;
  if (!mailbox || !showMailbox) return [];
  const clients = (short: boolean): string => {
    const parts: string[] = [];
    if (mailbox.onlineClients.tui > 0) {
      parts.push(
        `${glyphs.desktop} TUI${mailbox.onlineClients.tui > 1 ? `×${mailbox.onlineClients.tui}` : ''}`,
      );
    }
    if (mailbox.onlineClients.webui > 0) {
      parts.push(
        `${glyphs.web} WebUI${mailbox.onlineClients.webui > 1 ? `×${mailbox.onlineClients.webui}` : ''}`,
      );
    }
    if (mailbox.onlineClients.repl > 0) {
      parts.push(
        `${glyphs.terminal} REPL${mailbox.onlineClients.repl > 1 ? `×${mailbox.onlineClients.repl}` : ''}`,
      );
    }
    return short || parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
  };

  return compact([
    entry('mailbox', 'mailbox', p, [
      mailbox.unread > 0 ? (
        <Text color={chipColor(theme.warn, isNoColor)} bold>
          {STATUSLINE_ICONS.mailbox} {mailbox.unread} new
        </Text>
      ) : (
        <Text dimColor={!isNoColor}>{STATUSLINE_ICONS.mailbox} 0</Text>
      ),
      <Text
        color={mailbox.unread > 0 ? chipColor(theme.warn, isNoColor) : undefined}
        dimColor={mailbox.unread === 0 && !isNoColor}
      >
        {STATUSLINE_ICONS.mailbox}
        {mailbox.unread}
      </Text>,
    ]),
    entry('mailbox_peers', 'mailbox', p, [
      <Text color={chipColor(theme.accent, isNoColor)}>
        {glyphs.peers} {mailbox.onlineAgents} agent{mailbox.onlineAgents === 1 ? '' : 's'}
        {clients(false)}
      </Text>,
      <Text color={chipColor(theme.accent, isNoColor)}>
        {glyphs.peers}
        {mailbox.onlineAgents}
      </Text>,
    ]),
    mailbox.lastSubject
      ? entry('mailbox_last', 'mailbox', p, [
          <Text dimColor={!isNoColor}>
            {mailbox.lastFrom ? `${mailbox.lastFrom}: ` : ''}
            {truncateChip(mailbox.lastSubject, 40)}
          </Text>,
          <Text dimColor={!isNoColor}>{truncateChip(mailbox.lastSubject, 16)}</Text>,
        ])
      : null,
  ]);
}

/**
 * One entry per live subagent. Each carries the `fleet_agents` contract key
 * (so the whole group moves line together and honours one density setting)
 * but a distinct id, so the rail can shed the 5th agent without shedding the
 * 1st and the hit-test keeps unique spans.
 */
function buildFleetAgentEntries(
  p: StatusBarRailBuildParams,
  agents: FleetAgentDetail[] | undefined,
): RailSpanEntry[] {
  const { isNoColor, showChip } = p;
  if (!agents || !showChip('fleet_agents')) return [];
  return compact(
    agents.map((agent, index) =>
      entry(index === 0 ? 'fleet_agents' : `fleet_agent-${index}`, 'fleet_agents', p, [
        <Text>
          <Text color={isNoColor ? undefined : agent.color} bold>
            {agent.label}
          </Text>
          <Text color={agent.running && !isNoColor ? theme.warn : undefined}>
            {` ${agent.running ? glyphs.running : '·'} `}
          </Text>
          <Text dimColor={!isNoColor}>
            {fmtElapsed(agent.elapsedMs)} · {agent.toolCalls}t
          </Text>
          {agent.tool ? (
            <Text color={isNoColor ? undefined : theme.accent}>{` · ${agent.tool}`}</Text>
          ) : null}
          {agent.extensions && agent.extensions > 0 ? (
            <Text color={isNoColor ? undefined : theme.warn}>
              {` · ${glyphs.process} ×${agent.extensions}`}
            </Text>
          ) : null}
        </Text>,
        <Text>
          <Text color={isNoColor ? undefined : agent.color} bold>
            {truncateChip(agent.label, 10)}
          </Text>
          <Text
            dimColor={!isNoColor}
          >{` ${agent.running ? glyphs.running : '·'} ${fmtElapsed(agent.elapsedMs)}`}</Text>
        </Text>,
        <Text color={isNoColor ? undefined : agent.color} bold>
          {truncateChip(agent.label, 6)}
        </Text>,
      ]),
    ),
  );
}

/**
 * Background activity: fleets, peers, services — plus the countdowns, which
 * tick every second and belong with the other things that arrive and leave
 * on their own schedule rather than with the turn's telemetry.
 */
export function buildAsyncChipEntries(p: StatusBarRailBuildParams): RailSpanEntry[] {
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
    hasNextStepsAutoSubmit,
    nextStepsAutoSubmitCountdown,
    nextStepsAutoSubmitLabel,
    nextStepsColor,
    hasAutoProceed,
    autoProceedCountdown,
    showEnhance,
    enhanceCountdown,
  } = p;

  return compact([
    fleetHasActivity && showChip('fleet')
      ? fleet
        ? (() => {
            const counts = (
              <>
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
              </>
            );
            const lead = (
              <Text color={isNoColor ? undefined : theme.accent}>
                {icon(STATUSLINE_ICONS.fleet, isNoColor)}
              </Text>
            );
            return entry('fleet', 'fleet', p, [
              <Text>
                {lead}
                {counts}
              </Text>,
              <Text>
                {lead}
                <Text color={isNoColor ? undefined : theme.warn}>
                  {`${glyphs.running} ${fleet.running}`}
                </Text>
              </Text>,
              <Text color={isNoColor ? undefined : theme.accent}>
                {`${STATUSLINE_ICONS.fleet}${fleet.running}`}
              </Text>,
            ]);
          })()
        : entry('fleet', 'fleet', p, [
            <Text color={chipColor(theme.accent, isNoColor)}>
              {icon(STATUSLINE_ICONS.fleet, isNoColor)}
              {subagentCount} agent{subagentCount === 1 ? '' : 's'}
            </Text>,
            <Text color={chipColor(theme.accent, isNoColor)}>
              {`${STATUSLINE_ICONS.fleet}${subagentCount}`}
            </Text>,
          ])
      : null,
    ...buildFleetAgentEntries(p, fleetAgents),
    ...buildMailboxDetailEntries(p, mailbox, showMailbox),
    showBrain && brain
      ? entry('brain', 'brain', p, [<BrainChip brain={brain} monochrome={isNoColor} />])
      : null,
    showDebugStream && debugStreamStats
      ? entry('debug_stream', 'debug_stream', p, [
          <Text color={chipColor(theme.accent, isNoColor)}>
            <Text bold>{isNoColor ? 'stream' : `${STATUSLINE_ICONS.debug_stream} stream`}</Text>
            <Text dimColor={!isNoColor}> #{debugStreamStats.chunkCount}</Text>
            <Text dimColor={!isNoColor}> · {debugStreamStats.lastChunkSize}B</Text>
            <Text dimColor={!isNoColor}> · +{debugStreamStats.lastDeltaMs}ms</Text>
            <Text dimColor={!isNoColor}> · {fmtDebugBytes(debugStreamStats.totalBytes)}</Text>
          </Text>,
          <Text color={chipColor(theme.accent, isNoColor)}>
            {`${STATUSLINE_ICONS.debug_stream}${debugStreamStats.chunkCount} · ${fmtDebugBytes(debugStreamStats.totalBytes)}`}
          </Text>,
          <Text color={chipColor(theme.accent, isNoColor)}>
            {`${STATUSLINE_ICONS.debug_stream}${debugStreamStats.chunkCount}`}
          </Text>,
        ])
      : null,
    ...memoryDetailChips,
    hasNextStepsAutoSubmit && nextStepsAutoSubmitCountdown != null && showChip('next_steps')
      ? entry('next_steps', 'next_steps', p, [
          <Text>
            <Text color={isNoColor ? undefined : nextStepsColor} bold>
              {isNoColor
                ? `${nextStepsAutoSubmitCountdown}s`
                : `${STATUSLINE_ICONS.next_steps} ${nextStepsAutoSubmitCountdown}s`}
            </Text>
            <Text dimColor={!isNoColor}>
              {nextStepsAutoSubmitLabel
                ? ` ${formatSuggestionLabel(nextStepsAutoSubmitLabel)}`
                : ''}
              {' · ⇥ edit'}
            </Text>
          </Text>,
          <Text color={isNoColor ? undefined : nextStepsColor} bold>
            {isNoColor
              ? `${nextStepsAutoSubmitCountdown}s ⇥`
              : `${STATUSLINE_ICONS.next_steps} ${nextStepsAutoSubmitCountdown}s ⇥`}
          </Text>,
        ])
      : null,
    hasAutoProceed && showChip('auto_proceed')
      ? entry('auto_proceed', 'auto_proceed', p, [
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
          </Text>,
          <Text color={isNoColor ? undefined : theme.accent}>
            {`${STATUSLINE_ICONS.auto_proceed}${autoProceedCountdown}s`}
          </Text>,
        ])
      : null,
    showEnhance && enhanceCountdown != null
      ? entry('enhance', 'enhance', p, [
          <Text color={isNoColor ? undefined : countdownColor(enhanceCountdown, 15, 5)}>
            {isNoColor
              ? `refined · send in ${enhanceCountdown}s`
              : `${STATUSLINE_ICONS.enhance} refinement ready · send in ${enhanceCountdown}s`}
          </Text>,
          <Text color={isNoColor ? undefined : countdownColor(enhanceCountdown, 15, 5)}>
            {`${STATUSLINE_ICONS.enhance} send ${enhanceCountdown}s`}
          </Text>,
        ])
      : null,
  ]);
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
          const ratio = Math.min(context.used / context.max, 1);
          return (
            <Text color={chipColor(contextBarColor(ratio), isNoColor)}>
              <Text dimColor={!isNoColor}>{'ctx '}</Text>
              {renderMeter(ratio, 6)} {fmtTok(context.used)}
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
  ].filter((chip): chip is React.ReactElement => chip !== null);
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

export function buildMemoryDetailEntries(p: StatusBarRailBuildParams): RailSpanEntry[] {
  const { memoryContextMonitor, Sage, isNoColor } = p;
  const memorySummary = memoryContextMonitor?.latest;
  // No memory telemetry at all → no chips (not even the section label), so
  // an index-only rail renders without a bare `✦ Memory`.
  if (!Sage && !memorySummary) return [];
  const liveActive = memoryContextMonitor
    ? activeMemoryContextCount(memoryContextMonitor as never)
    : 0;
  const reportedActive = memoryContextMonitor ? liveActive : (Sage?.activeInContext ?? 0);
  const entries: Array<RailSpanEntry | null> = [];

  entries.push(
    entry('memory_context', 'memory_context', p, [
      <Text color={chipColor(theme.accent, isNoColor)}>
        {isNoColor ? 'Memory ' : `${STATUSLINE_ICONS.memory_context} Memory `}
        {Sage ? (
          <Text color={undefined}>
            {Sage.total} total
            {reportedActive > 0 ? (
              <>
                <Text dimColor={!isNoColor}> · </Text>
                <Text color={chipColor(theme.success, isNoColor)}>{reportedActive} actv</Text>
              </>
            ) : null}
          </Text>
        ) : reportedActive > 0 ? (
          <Text color={chipColor(theme.success, isNoColor)}>{reportedActive} actv</Text>
        ) : null}
      </Text>,
      <Text color={chipColor(theme.accent, isNoColor)}>
        {STATUSLINE_ICONS.memory_context}
        {Sage ? Sage.total : reportedActive}
        {reportedActive > 0 && Sage ? (
          <Text color={chipColor(theme.success, isNoColor)}>{`·${reportedActive}`}</Text>
        ) : null}
      </Text>,
    ]),
  );

  if (memorySummary && memorySummary.outcome !== 'error') {
    const hasPipeline =
      memorySummary.matched > 0 || memorySummary.injected > 0 || memorySummary.filtered > 0;
    if (hasPipeline) {
      entries.push(
        entry('memory_pipeline', 'memory_context', p, [
          <Text>
            <Text dimColor={!isNoColor}>{memorySummary.matched} matched</Text>
            <Text dimColor={!isNoColor}>{' · '}</Text>
            <Text color={chipColor(theme.success, isNoColor)}>{memorySummary.injected} inj</Text>
            <Text dimColor={!isNoColor}>{' · '}</Text>
            <Text color={chipColor(theme.warn, isNoColor)}>{memorySummary.filtered} filt</Text>
          </Text>,
          <Text>
            <Text color={chipColor(theme.success, isNoColor)}>{`+${memorySummary.injected}`}</Text>
            <Text color={chipColor(theme.warn, isNoColor)}>{`-${memorySummary.filtered}`}</Text>
          </Text>,
        ]),
      );
    }
    if (memorySummary.contextPressure > 0) {
      const pressureVal = memorySummary.contextPressure * 100;
      const pressureColor =
        pressureVal >= 80 ? theme.error : pressureVal >= 65 ? theme.warn : theme.textSecondary;
      entries.push(
        entry('memory_pressure', 'memory_context', p, [
          <Text color={chipColor(pressureColor, isNoColor)}>
            {fmtRatioPct(memorySummary.contextPressure)} ctx
          </Text>,
          <Text color={chipColor(pressureColor, isNoColor)}>
            {fmtRatioPct(memorySummary.contextPressure, 0)}
          </Text>,
        ]),
      );
    }
  }
  return compact(entries);
}
