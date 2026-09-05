import { systemPromptVariantLabel } from "@wrongstack/core/agent";
import type React from "react";
import { Text } from "../ink.js";
import { activeMemoryContextCount } from "../memory-context-monitor.js";
import { getActiveThemeName, theme } from "../theme.js";
import type { RailSpanEntry } from "./powerline-rail.js";
import { ThinkingChip } from "./status-bar-chips.js";
import {
  contextBarColor,
  fmtElapsed,
  fmtRatioPct,
  fmtTok,
  renderMeter,
  shortenPath,
  truncateChip,
} from "./status-bar-format.js";
import { modeIcon } from "./status-bar-helpers.js";
import { chipColor, STATUSLINE_ICONS } from "./status-bar-icons.js";
import type { StatusBarProps } from "./status-bar-types.js";
import type { StatuslineItem } from "./statusline-picker.js";
import {
  type StatusBarRailBuildParams,
  entry,
  compact,
  icon,
} from "./status-bar-rails-common.js";

// Re-exports for consumers
export type { StatusBarRailBuildParams } from "./status-bar-rails-common.js";
export { densityBounds } from "./status-bar-rails-common.js";
export { buildSafetyWorkEntries } from "./status-bar-rails-safety.js";
export { buildAsyncChipEntries } from "./status-bar-rails-async.js";

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
