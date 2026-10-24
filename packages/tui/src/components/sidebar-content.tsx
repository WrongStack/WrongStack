// Compact sidebar content — a layered, color-coded mission-control rail.
//
// Designed for the narrow RightSidebar region (~20-48 columns). Each section
// is a "card" with a glyph header, a dotted leader line, and a right-aligned
// status badge. Shows, top to bottom:
//   1. Context — big % badge + full-width block meter + token count
//   2. Model — provider/model identity line
//   2b. Plan quota — the active provider's subscription windows (when metered)
//   3. Agent Swarm — LIVE badge, composition summary, per-agent 2-line rows
//   4. Mission Queue — a longer todo board (up to 8 rows) with done/total badge
//   5. Sessions — live sessions (F10) + recent resume sessions (/resume)
//
// All data is passed as props — this component is pure presentation with no
// hooks, no event listeners, no keyboard input. It fits inside the sidebar
// shell (components/sidebar.tsx).
//
// Width contract: every section box is exactly `innerWidth` columns wide so
// dotted-leader fills and block meters line up. Row counts deliberately mirror
// computeMaxSidebarScroll() in reducers/workspace-panels.ts — keep the two in
// sync when changing the layout.

import type { CacheStats } from '@wrongstack/contracts/types';
import type { ContextBreakdown, TodoItem } from '@wrongstack/core/agent';
import type React from 'react';
import type { ResumeSessionEntry } from '../app-state.js';
import type { FleetEntry } from '../app-state-fleet.js';
import type { HeapSample } from '../heap-watchdog.js';
import { Box, Text } from '../ink.js';
import { getActiveThemeName, theme } from '../theme.js';
import type { PanelId } from '../ui-contracts.js';
import { SIDEBAR_MISSION_ROWS } from '../ui-contracts.js';
import { glyphs } from '../ui-glyphs.js';
import type { LiveSessionEntry } from './sessions-panel.js';
import { CacheCard } from './sidebar-cache-card.js';
import { Card } from './sidebar-card.js';
import { SidebarSectionHeader } from './sidebar-panel-frame.js';
import type { MissionRow } from './sidebar-presentation.js';
import {
  buildMissionRows,
  contextSpectrum,
  DialRow,
  fmtRelative,
  isCurrentSession,
  liveSessionColor,
  liveSessionIcon,
  outcomeBadge,
  statusGlyph,
  trunc,
} from './sidebar-presentation.js';
import { QuotaCard } from './sidebar-quota.js';
import type { QuotaCardModel } from './sidebar-quota-model.js';
import {
  contextBarColor,
  fmtMemory,
  fmtPct,
  fmtRatioPct,
  fmtTok,
  renderMeter,
} from './status-bar-format.js';

interface SidebarContentProps {
  /** Live context window data from useStatusbarViewModel. */
  contextWindow: { used: number; max: number } | undefined;
  /** Honest per-category accounting behind the context window display. */
  contextBreakdown?: ContextBreakdown | undefined;
  /**
   * Live prompt-cache hit ratio + token counts for the sidebar card.
   * Surfaced so a user staring at the right rail can see how much of
   * the spend is hitting the prompt cache without opening `/context`.
   */
  cacheStats?: CacheStats | undefined;
  /**
   * Subscription quota of the active provider, narrowed to the active model,
   * plus one row per other provider that has reported. Absent — and the card
   * not rendered — when no provider meters a plan (API-key sessions).
   */
  quota?: QuotaCardModel | undefined;
  /** Fleet entries (leader + subagents) from useStatusbarViewModel. */
  entries: Record<string, FleetEntry>;
  /** Fleet counts summary. */
  fleetCounts: { running: number; idle: number; pending: number; completed: number } | undefined;
  /** Current provider label for display. */
  provider?: string | undefined;
  /** Current model label for display. */
  model?: string | undefined;
  /** Active theme preset name for display. */
  themeName?: string | undefined;
  /** Actual sidebar width in columns (including border+padding chrome).
   *  Used to size the content area and truncate text appropriately. */
  width: number;
  /** Vertical scroll offset — number of rows scrolled from the top. */
  scrollOffset?: number | undefined;
  /** When true, the sidebar has keyboard focus (↑↓ scroll). */
  focused?: boolean | undefined;
  /** Live leader todo board — rendered as a compact mission queue. */
  todos?: readonly TodoItem[] | undefined;
  /** When true, show the agent-swarm + mission-queue section. Gated by the
   *  effective agent-swarm panel mode being 'sidebar' (see app-view.tsx). */
  showSwarmSection?: boolean | undefined;
  /** Live sessions from the SessionRegistry — same data as the F10 panel.
   *  Shown as compact "live" rows with project name + status + agent count. */
  liveSessions?: readonly LiveSessionEntry[] | undefined;
  /** Recent stored sessions for the `/resume` picker. Shown as compact rows
   *  with title + last-activity + outcome badge. */
  resumeSessions?: readonly ResumeSessionEntry[] | undefined;
  /** The current session ID — used to highlight the active session row. */
  currentSessionId?: string | undefined;
  /** Current RSS/heap sample for this CLI process. */
  processMemory?: HeapSample | undefined;
  /** CPU usage percentage (0-100). Derived from process.cpuUsage delta. */
  cpuPercent?: number | undefined;
  /** Recent CPU ratios (0-1, oldest → newest) for the trend sparkline. */
  cpuHistory?: readonly number[] | undefined;
  /** Recent RSS/totalMem ratios (0-1) for the trend sparkline. */
  rssHistory?: readonly number[] | undefined;
  /** Recent heap-pressure ratios (0-1) for the trend sparkline. */
  heapHistory?: readonly number[] | undefined;
  /** Total physical RAM in bytes — denominator of the RAM ratio. */
  totalMem?: number | undefined;
  /**
   * Set of F-key panels that are routed to the sidebar AND win a slot
   * under `SIDEBAR_PANEL_LIMIT` this render. The persistent AGENT SWARM /
   * MISSIONS / SESSIONS cards check this set and skip themselves when the
   * corresponding F twin is already mounted above — otherwise the user
   * would see the same data rendered twice (once as a routed twin, once
   * as a persistent card). The F twin wins because it has its own Card
   * chrome and richer header / status affordances; the persistent card
   * is the fallback when the twin is at the bottom (F-key default).
   */
  effectiveSidebarRoutes?: ReadonlySet<PanelId> | undefined;
}

export function SidebarContent({
  contextWindow,
  contextBreakdown,
  cacheStats,
  quota,
  entries,
  fleetCounts,
  provider,
  model,
  themeName,
  width,
  scrollOffset = 0,
  focused = false,
  todos,
  showSwarmSection = false,
  liveSessions,
  resumeSessions,
  currentSessionId,
  processMemory,
  cpuPercent,
  cpuHistory,
  rssHistory,
  heapHistory,
  totalMem,
  effectiveSidebarRoutes,
}: SidebarContentProps): React.ReactElement {
  // Subtract border (2) + padding (2) = 4 cols of chrome to get content area
  const innerWidth = Math.max(8, width - 4);

  // Context meter
  const ctxRatio = contextWindow ? Math.min(1, contextWindow.used / contextWindow.max) : 0;
  const ctxColor = contextBarColor(ctxRatio);
  const ctxPct = fmtRatioPct(ctxRatio);
  // The context spectrum is sized to the *body* width (innerWidth - sides
  // - padding) inside the Card's render prop, NOT to `innerWidth` here.
  // Sizing to `innerWidth` would make the spectrum 4 cols wider than the
  // `│` frame's content area, so the right edge would be truncated with
  // `…` instead of completing naturally to 100%.
  const modelIdentity = provider && model ? `${provider}/${model}` : (model ?? provider);

  // Fleet entries: show leader first, then running subagents.
  // Cap at 12 agents total (leader + up to 11 subagents), each rendered
  // as a 2-line row (name+ctx% on line 1, status+tool on line 2).
  const MAX_SIDEBAR_AGENTS = 12;
  const allEntries = Object.values(entries);
  const leader = allEntries.find((e) => e.id === 'leader' || e.name === 'Leader Agent');
  const subagents = allEntries.filter((e) => e !== leader);
  const runningSubagents = subagents.filter((e) => e.status === 'running');
  const agentCap = leader ? MAX_SIDEBAR_AGENTS - 1 : MAX_SIDEBAR_AGENTS;
  const shownAgents = [...(leader ? [leader] : []), ...runningSubagents.slice(0, agentCap)];
  const hiddenAgentCount = runningSubagents.length - agentCap;

  const running = fleetCounts?.running ?? runningSubagents.length;

  // Mission queue — a longer board than the bottom swarm panel. Sorted by
  // status priority (in_progress → pending → completed), capped at
  // SIDEBAR_MISSION_ROWS. Only populated when the swarm section is enabled.
  const mission = showSwarmSection
    ? buildMissionRows(todos, SIDEBAR_MISSION_ROWS)
    : { rows: [] as MissionRow[], overflow: 0, done: 0, total: 0 };

  return (
    <Box flexDirection="column" gap={0} marginTop={scrollOffset > 0 ? -scrollOffset : undefined}>
      {/* ── Focus indicator ── */}
      {focused ? (
        <Box
          width={innerWidth}
          marginBottom={1}
          justifyContent="space-between"
          {...(theme.supportsBackground ? { backgroundColor: theme.surfaceRaised } : {})}
        >
          <Text color={theme.borderActive} bold>
            {glyphs.pillLeft} FOCUS {glyphs.pillRight}
          </Text>
          <Text color={theme.textMuted}>↑↓ scroll · Shift+Tab exits</Text>
        </Box>
      ) : null}

      {/* ── Model + context hero: the statusbar identity, elevated into a stage. ── */}
      <Card innerWidth={innerWidth} accent={ctxColor}>
        {(bodyWidth) => (
          <>
            {/* Stage banner: rail glyph + MODEL CORE */}
            <Box width={bodyWidth} justifyContent="space-between">
              <Box>
                <Text color={theme.accent} bold>
                  {glyphs.railHeavy}
                </Text>
                <Text color={theme.brand} bold wrap="truncate">
                  {` ${glyphs.star4} MODEL CORE`}
                </Text>
              </Box>
              {bodyWidth >= 28 && (themeName || getActiveThemeName()) ? (
                <Text color={theme.textSecondary} wrap="truncate">
                  {`${glyphs.palette} ${themeName ?? getActiveThemeName()}`}
                </Text>
              ) : null}
            </Box>
            {modelIdentity ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color={theme.textMuted} wrap="truncate">
                  {provider
                    ? `${glyphs.diamondOpen} ${trunc(provider.toUpperCase(), Math.max(1, bodyWidth - 2))}`
                    : `${glyphs.diamondOpen} ACTIVE`}
                </Text>
                <Text color={theme.textPrimary} bold wrap="truncate">
                  {trunc(modelIdentity, bodyWidth)}
                </Text>
              </Box>
            ) : null}
            {contextWindow ? (
              <>
                {(() => {
                  const tokensLabel = `${fmtTok(contextWindow.used)} / ${fmtTok(contextWindow.max)}`;
                  const pctLabel = `${ctxPct} `;
                  const availableForMeter = bodyWidth - pctLabel.length - tokensLabel.length - 2;
                  const meterInner = Math.min(10, availableForMeter - 2);
                  const dynamicMeter = meterInner >= 3 ? renderMeter(ctxRatio, meterInner) : null;
                  return (
                    <Box width={bodyWidth} flexDirection="row" justifyContent="space-between">
                      <Box flexDirection="row">
                        <Text color={ctxColor} bold>
                          {pctLabel}
                        </Text>
                        {dynamicMeter ? <Text color={ctxColor}>{dynamicMeter}</Text> : null}
                      </Box>
                      <Text color={theme.textMuted} wrap="truncate">
                        {tokensLabel}
                      </Text>
                    </Box>
                  );
                })()}
                <Box width={bodyWidth} flexDirection="row">
                  <Text wrap="truncate">
                    {contextSpectrum(contextBreakdown, contextWindow, bodyWidth).map((segment) => (
                      <Text key={segment.shortLabel} color={segment.color}>
                        {(segment.shortLabel === 'FREE' ? '·' : '━').repeat(segment.cells)}
                      </Text>
                    ))}
                  </Text>
                </Box>
                {(() => {
                  const activeSegments = contextSpectrum(
                    contextBreakdown,
                    contextWindow,
                    bodyWidth,
                  ).filter((s) => s.tokens > 0 || s.shortLabel === 'FREE');
                  if (bodyWidth >= 28) {
                    const rows: Array<
                      [(typeof activeSegments)[0], (typeof activeSegments)[0] | undefined]
                    > = [];
                    for (let i = 0; i < activeSegments.length; i += 2) {
                      rows.push([activeSegments[i]!, activeSegments[i + 1]]);
                    }
                    return rows.map(([left, right]) => {
                      const leftPct = fmtRatioPct(left.tokens / Math.max(1, contextWindow.max));
                      const rightPct = right
                        ? fmtRatioPct(right.tokens / Math.max(1, contextWindow.max))
                        : '0%';
                      return (
                        <Box
                          key={left.shortLabel}
                          flexDirection="row"
                          width={bodyWidth}
                          justifyContent="space-between"
                        >
                          <Text color={left.color} wrap="truncate">
                            {left.glyph} {left.shortLabel} {fmtTok(left.tokens)}
                            <Text color={theme.textMuted}> {leftPct}</Text>
                          </Text>
                          {right ? (
                            <Text color={right.color} wrap="truncate">
                              {right.glyph} {right.shortLabel} {fmtTok(right.tokens)}
                              <Text color={theme.textMuted}> {rightPct}</Text>
                            </Text>
                          ) : null}
                        </Box>
                      );
                    });
                  }
                  return activeSegments.map((segment) => {
                    const pct = fmtRatioPct(segment.tokens / Math.max(1, contextWindow.max));
                    return (
                      <Box
                        key={segment.shortLabel}
                        flexDirection="row"
                        width={bodyWidth}
                        justifyContent="space-between"
                      >
                        <Text color={segment.color} wrap="truncate">
                          {segment.glyph} {segment.shortLabel}
                        </Text>
                        <Text color={segment.color} wrap="truncate">
                          {fmtTok(segment.tokens)} <Text color={theme.textMuted}>{pct}</Text>
                        </Text>
                      </Box>
                    );
                  });
                })()}
              </>
            ) : (
              <Text color={theme.textMuted}>{glyphs.dividerDot} awaiting telemetry</Text>
            )}
          </>
        )}
      </Card>

      {/* ── Plan quota: the active provider's subscription windows ── */}
      {quota ? <QuotaCard quota={quota} innerWidth={innerWidth} /> : null}

      {/* ── Prompt cache card: hit ratio + coverage ── */}
      <CacheCard cacheStats={cacheStats} innerWidth={innerWidth} />

      {/* ── System vitals: CPU, RAM, heap ── */}
      {processMemory || cpuPercent != null ? (
        <Card innerWidth={innerWidth}>
          {(bodyWidth) => {
            const isHighLoad = (cpuPercent ?? 0) > 85 || (processMemory?.load ?? 0) > 0.85;
            const isWarnLoad = (cpuPercent ?? 0) > 60 || (processMemory?.load ?? 0) > 0.6;
            const healthBadge = isHighLoad ? 'HIGH' : isWarnLoad ? 'WARN' : 'HEALTHY';
            const healthColor = isHighLoad ? theme.error : isWarnLoad ? theme.warn : theme.success;
            return (
              <>
                <SidebarSectionHeader
                  glyph={glyphs.cpu}
                  label="SYSTEM VITALS"
                  color={theme.accent}
                  badge={healthBadge}
                  badgeColor={healthColor}
                  innerWidth={bodyWidth}
                  pill
                />
                {cpuPercent != null ? (
                  <DialRow
                    label="CPU "
                    value={fmtPct(cpuPercent)}
                    ratio={cpuPercent / 100}
                    history={cpuHistory}
                    innerWidth={bodyWidth}
                  />
                ) : null}
                {processMemory ? (
                  <>
                    <DialRow
                      label="RAM "
                      value={fmtMemory(processMemory.rss)}
                      ratio={
                        totalMem && totalMem > 0
                          ? Math.min(1, processMemory.rss / totalMem)
                          : processMemory.load
                      }
                      history={rssHistory}
                      innerWidth={bodyWidth}
                    />
                    <DialRow
                      label="HEAP"
                      value={fmtMemory(processMemory.heapUsed)}
                      ratio={processMemory.load}
                      history={heapHistory}
                      innerWidth={bodyWidth}
                    />
                  </>
                ) : null}
              </>
            );
          }}
        </Card>
      ) : null}

      {/* ── Agent Swarm: one gated, raised surface for summary + rows ── */}
      {/* Skip when the F2 (fleet) twin is routed to the sidebar — the
          twin renders the same fleet data with its own Card chrome and
          richer header / status affordances, so showing the persistent
          card as well would duplicate the same rows. */}
      {showSwarmSection && !effectiveSidebarRoutes?.has('fleet') ? (
        <Card
          innerWidth={innerWidth}
          accent={running > 0 ? theme.monitor.fleet : theme.borderSubtle}
        >
          {(bodyWidth) => (
            <>
              <SidebarSectionHeader
                glyph={glyphs.fleet}
                label="AGENT SWARM"
                color={theme.monitor.fleet}
                badge={running > 0 ? `${running} LIVE` : 'IDLE'}
                badgeColor={running > 0 ? theme.success : theme.textMuted}
                innerWidth={bodyWidth}
                pill
                badgeMuted={running === 0}
              />
              <Box>
                <Text color={running > 0 ? theme.success : theme.textMuted}>
                  {running > 0 ? glyphs.pulseHigh : glyphs.pulseLow}
                </Text>
                <Text color={running > 0 ? theme.textSecondary : theme.textMuted} wrap="truncate">
                  {running > 0
                    ? ` ${running} active node${running > 1 ? 's' : ''}`
                    : ' all nodes idle'}
                </Text>
              </Box>
              {shownAgents.map((entry, idx) => {
                const { icon, color } = statusGlyph(entry);
                const isRunning = entry.status === 'running';
                const isLeader = entry.id === 'leader' || entry.name === 'Leader Agent';
                const isLast = idx === shownAgents.length - 1;
                const treePrefix = isLeader ? '♛ ' : isLast ? glyphs.treeLast : glyphs.treeBranch;
                const name = trunc(entry.name || entry.id, bodyWidth - (isLeader ? 8 : 10));
                const ctxPctAgent = entry.ctxPct != null ? fmtRatioPct(entry.ctxPct) : '';
                const statusLabel =
                  entry.status === 'running'
                    ? 'running'
                    : entry.status === 'idle'
                      ? 'idle'
                      : entry.status;
                const tool = entry.currentTool?.name
                  ? trunc(entry.currentTool.name, Math.max(4, bodyWidth - statusLabel.length - 8))
                  : '';
                return (
                  <Box key={entry.id} flexDirection="column">
                    {/* Line 1: accent rail + tree node + identity + context telemetry. */}
                    <Box flexDirection="row" width={bodyWidth}>
                      <Text color={color}>{glyphs.railMid}</Text>
                      <Text color={theme.borderSubtle}>{treePrefix}</Text>
                      <Text color={color}>{icon} </Text>
                      <Text
                        color={isRunning ? theme.textPrimary : theme.textSecondary}
                        bold={isRunning}
                        wrap="truncate"
                      >
                        {name}
                      </Text>
                      <Box flexGrow={1} />
                      {ctxPctAgent ? (
                        <Text color={contextBarColor(entry.ctxPct ?? 0)}>{ctxPctAgent}</Text>
                      ) : null}
                    </Box>
                    {/* Line 2: status + current tool, aligned beneath node identity. */}
                    <Box flexDirection="row" width={bodyWidth}>
                      <Text color={color}>{glyphs.railMid}</Text>
                      <Text color={theme.borderSubtle}>
                        {isLeader ? '   ' : isLast ? '   ' : `${glyphs.treeThrough} `}
                      </Text>
                      <Text color={theme.textMuted} wrap="truncate">
                        {statusLabel}
                        {tool ? ` ${glyphs.dividerDiamond} ${tool}` : ''}
                      </Text>
                    </Box>
                  </Box>
                );
              })}
              {hiddenAgentCount > 0 ? (
                <Text color={theme.textMuted}>
                  {glyphs.railMid} {glyphs.dividerDot} +{hiddenAgentCount} more
                </Text>
              ) : null}
            </>
          )}
        </Card>
      ) : null}

      {/* ── Mission Queue card (longer board than the bottom panel) ── */}
      {/* Skip when the F6 (todos) twin is routed to the sidebar — same
          todo board, richer twin chrome. */}
      {mission.total > 0 && !effectiveSidebarRoutes?.has('todos') ? (
        <Card
          innerWidth={innerWidth}
          accent={mission.done === mission.total ? theme.success : theme.warn}
        >
          {(bodyWidth) => (
            <>
              <SidebarSectionHeader
                glyph={glyphs.queue}
                label="MISSIONS"
                color={theme.warn}
                badge={`${mission.done}/${mission.total}`}
                badgeColor={mission.done === mission.total ? theme.success : theme.warn}
                innerWidth={bodyWidth}
                pill
              />
              {/* Progress matrix bar — filled + rail + percent tail. */}
              <Box width={bodyWidth}>
                <Text color={theme.success}>
                  {glyphs.barFull.repeat(
                    Math.round(
                      (mission.done / Math.max(1, mission.total)) * Math.max(4, bodyWidth - 8),
                    ),
                  )}
                </Text>
                <Text color={theme.borderSubtle}>
                  {glyphs.barEmpty.repeat(
                    Math.max(
                      0,
                      Math.max(4, bodyWidth - 8) -
                        Math.round(
                          (mission.done / Math.max(1, mission.total)) * Math.max(4, bodyWidth - 8),
                        ),
                    ),
                  )}
                </Text>
                <Text color={theme.textMuted}>
                  {' '}
                  {fmtRatioPct(mission.done / Math.max(1, mission.total))}
                </Text>
              </Box>
              {mission.rows.map((m) => {
                if (m.status === 'completed') {
                  return (
                    <Box key={m.id} width={bodyWidth} flexDirection="row">
                      <Text color={theme.success}>{glyphs.success} </Text>
                      <Text color={theme.textMuted} dimColor strikethrough>
                        {m.label}
                      </Text>
                    </Box>
                  );
                }
                if (m.status === 'in_progress') {
                  return (
                    <Box key={m.id} width={bodyWidth} flexDirection="row">
                      <Text color={theme.accent}>{glyphs.running} </Text>
                      <Text color={theme.textPrimary} bold>
                        {m.label}
                      </Text>
                    </Box>
                  );
                }
                return (
                  <Box key={m.id} width={bodyWidth} flexDirection="row">
                    <Text color={theme.textMuted}>{glyphs.pending} </Text>
                    <Text color={theme.textSecondary}>{m.label}</Text>
                  </Box>
                );
              })}
              {mission.overflow > 0 ? (
                <Text color={theme.textMuted} dimColor>
                  {glyphs.dividerDot} +{mission.overflow} more
                </Text>
              ) : null}
            </>
          )}
        </Card>
      ) : null}

      {/* ── Sessions card ── */}
      {/* Skip when the F10 (sessions) twin is routed to the sidebar — same
          live + resume session data, richer twin chrome. */}
      {((liveSessions?.length ?? 0) > 0 || (resumeSessions?.length ?? 0) > 0) &&
      !effectiveSidebarRoutes?.has('sessions') ? (
        <Card innerWidth={innerWidth} marginBottom={0} accent={theme.success}>
          {(bodyWidth) => (
            <>
              <SidebarSectionHeader
                glyph={glyphs.sessions}
                label="SESSIONS"
                color={theme.success}
                badge={String((liveSessions?.length ?? 0) + (resumeSessions?.length ?? 0))}
                badgeColor={theme.textSecondary}
                innerWidth={bodyWidth}
                pill
              />

              {/* Live sessions (F10) */}
              {liveSessions && liveSessions.length > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                  {liveSessions.slice(0, 3).map((s) => {
                    const isCurrent = isCurrentSession(s.sessionId, currentSessionId);
                    const icon = isCurrent ? '●' : liveSessionIcon(s.status);
                    const color = liveSessionColor(s.status);
                    const name = trunc(s.projectName, bodyWidth - 6);
                    const agents = s.agentCount > 0 ? ` ${s.agentCount}a` : '';
                    return (
                      <Box key={s.sessionId} flexDirection="row" width={bodyWidth}>
                        <Text color={color}>{icon} </Text>
                        <Text
                          color={isCurrent ? theme.accent : theme.textSecondary}
                          wrap="truncate"
                          bold={isCurrent}
                        >
                          {name}
                        </Text>
                        <Text color={theme.textMuted}>{agents}</Text>
                      </Box>
                    );
                  })}
                </Box>
              ) : null}

              {/* Resume sessions (/resume) */}
              {resumeSessions && resumeSessions.length > 0 ? (
                <Box
                  flexDirection="column"
                  marginTop={liveSessions && liveSessions.length > 0 ? 1 : 0}
                >
                  {resumeSessions.slice(0, 3).map((rs) => {
                    const isCurrent = isCurrentSession(rs.id, currentSessionId, rs.isCurrent);
                    const badge = outcomeBadge(rs.outcome);
                    const title = trunc(rs.title || rs.lastUserMessage || rs.id, bodyWidth - 8);
                    const rel = fmtRelative(rs.lastActivityAt ?? rs.endedAt);
                    return (
                      <Box key={rs.id} flexDirection="row" width={bodyWidth}>
                        <Text color={badge ? badge.color : theme.textMuted}>
                          {badge ? badge.label : glyphs.dividerDot}{' '}
                        </Text>
                        <Text
                          color={isCurrent ? theme.accent : theme.textSecondary}
                          wrap="truncate"
                          bold={isCurrent}
                        >
                          {title}
                        </Text>
                        {rel ? <Text color={theme.textMuted}> {rel}</Text> : null}
                      </Box>
                    );
                  })}
                </Box>
              ) : null}
            </>
          )}
        </Card>
      ) : null}
    </Box>
  );
}
export { contextSpectrum, isCurrentSession } from './sidebar-presentation.js';
