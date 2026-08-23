import type { ContextBreakdown } from '@wrongstack/core/utils';
import type React from 'react';
import { useState } from 'react';
import { Box, Text, useInput } from '../ink.js';
import type { MemoryContextMonitorState } from '../memory-context-monitor.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  SectionLabel,
  useMonitorSize,
  usePanelShortcutsEnabled,
} from './monitor-shell.js';
// The bracket-style `[000o····]` meter is the statusline's context bar; reuse
// it here so the panel's fill bars mirror the statusline instead of using a
// second (block `█░`) visual language.
import { renderMeter } from './status-bar.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContextPanelData {
  ctxPct: number | undefined;
  ctxTokens: number | undefined;
  ctxMaxTokens: number | undefined;
  provider: string;
  model: string;
  mode: string;
  uptime: string;
  /**
   * Cumulative prompt-cache stats from the per-session TokenCounter.
   * Surfaced in the panel so `/context` answers "how much of my spend
   * is hitting the cache" without asking the user to chase the CLI
   * `/context cache` subcommand.
   *
   * `savedUsd` is the gross read-discount USD figure computed by the
   * counter (cache-read tokens × (input price − cache-read price)).
   * `cacheWrite5m` / `cacheWrite1h` are present when the upstream exposed
   * an Anthropic-style TTL split (Anthropic family, including MiniMax
   * routed through the Anthropic Messages surface); OpenAI-family
   * gateways emit only the aggregate and leave them undefined.
   */
  cacheStats?:
    | {
        readTokens: number;
        writeTokens: number;
        cacheWrite5m?: number | undefined;
        cacheWrite1h?: number | undefined;
        hitRatio: number;
        savedUsd: number;
      }
    | undefined;
  /**
   * How far the cached prefix reaches through the live request, in
   * tokens. Drawn on the per-request coverage meter so users see the
   * exact extent of the cache, not just a percentage.
   */
  cacheCoverageTokens?: number | undefined;
  /** Session cache telemetry split by provider, including fallback/model switches. */
  providerCacheStats?:
    | Array<{
        provider: string;
        input: number;
        cacheRead: number;
        cacheWrite: number;
        cacheWrite5m?: number | undefined;
        cacheWrite1h?: number | undefined;
        hitRatio: number;
      }>
    | undefined;
  /**
   * Real, measured per-category token accounting for the live request. When
   * present the Composition tab shows honest numbers; when absent (no request
   * has been assembled yet) the tab shows an empty state instead of fabricated
   * percentages.
   */
  breakdown: ContextBreakdown | undefined;
  fleetEntries: Array<{
    name: string;
    status: string;
    currentTool: string | undefined;
    ctxPct: number | undefined;
  }>;
  leaderIterations: number;
  leaderToolCalls: number;
  leaderStatus: string;
  memoryContext: MemoryContextMonitorState;
}

export interface ContextPanelProps {
  data: ContextPanelData;
  onClose: () => void;
}

type TabId = 'overview' | 'composition' | 'thresholds' | 'agents' | 'memory';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'composition', label: 'Composition' },
  { id: 'thresholds', label: 'Thresholds' },
  { id: 'agents', label: 'Agents' },
  { id: 'memory', label: 'Memory' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

type ZoneLevel = 'safe' | 'warning' | 'critical' | 'danger';

function zoneFor(pct: number): ZoneLevel {
  if (pct > 0.95) return 'danger';
  if (pct > 0.85) return 'critical';
  if (pct > 0.6) return 'warning';
  return 'safe';
}

function zoneColor(zone: ZoneLevel): string {
  switch (zone) {
    case 'safe':
      return theme.success;
    case 'warning':
      return theme.warn;
    case 'critical':
      return theme.error;
    case 'danger':
      return '#f2cdcd'; // flamingo
  }
}

function zoneEmoji(pct: number): string {
  const z = zoneFor(pct);
  switch (z) {
    case 'safe':
      return '🟢';
    case 'warning':
      return '🟡';
    case 'critical':
      return '🔴';
    case 'danger':
      return '⚫';
  }
}

function zoneLabel(pct: number): string {
  const z = zoneFor(pct);
  switch (z) {
    case 'safe':
      return 'HEALTHY';
    case 'warning':
      return 'WARNING';
    case 'critical':
      return 'CRITICAL';
    case 'danger':
      return 'DANGER';
  }
}

/** Compact token formatter, e.g. 30_800 → "30.8k". */
function fmtTok(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Human labels for the system-prompt sub-sources reported by the breakdown. */
const SOURCE_LABEL: Record<string, string> = {
  identity: 'identity',
  'tool-usage': 'tool-usage',
  environment: 'environment',
  skills: 'skills',
  mode: 'mode',
  plan: 'plan',
  'leader-after-task': 'leader',
  contributor: 'contributor',
  ledger: 'ledger',
  nextsteps: 'nextsteps',
  other: 'other',
};

const ZONES: Array<{ label: string; emoji: string; from: number; to: number; desc: string }> = [
  { label: 'Safe', emoji: '🟢', from: 0, to: 60, desc: 'normal operation' },
  { label: 'Warning', emoji: '🟡', from: 60, to: 85, desc: 'compaction advised' },
  { label: 'Critical', emoji: '🔴', from: 85, to: 95, desc: 'compact now' },
  { label: 'Danger', emoji: '⚫', from: 95, to: 100, desc: 'context nearly full' },
];

/** Render the threshold axis line with markers. */
function renderAxis(pct: number, barWidth: number): { axis: string; label: string } {
  const softPos = Math.round(0.6 * barWidth);
  const nowPos = Math.round(pct * barWidth);
  const hardPos = Math.round(0.85 * barWidth);
  const dangerPos = Math.round(0.95 * barWidth);

  const axisChars: string[] = [];
  for (let i = 0; i <= barWidth; i++) {
    if (i === 0) axisChars.push('├');
    else if (i === softPos || i === hardPos || i === dangerPos) axisChars.push('┼');
    else if (i === barWidth) axisChars.push('┤');
    else axisChars.push('─');
  }

  const markers: Array<{ pos: number; text: string }> = [
    { pos: 0, text: '0%' },
    { pos: softPos, text: 'soft' },
    { pos: nowPos, text: '◀now' },
    { pos: hardPos, text: 'hard' },
    { pos: dangerPos, text: 'max' },
    { pos: barWidth, text: '100%' },
  ];
  let label = '';
  let lastEnd = 0;
  for (const m of markers) {
    const pad = Math.max(1, m.pos - lastEnd);
    label += ' '.repeat(pad) + m.text;
    lastEnd = m.pos + m.text.length;
  }

  return { axis: axisChars.join(''), label };
}

// ── Section renderers ─────────────────────────────────────────────────────────

function PressureSection({
  data,
  contentWidth,
}: {
  data: ContextPanelData;
  contentWidth: number;
}): React.ReactElement {
  const pct = data.ctxPct ?? 0;
  const barWidth = Math.min(40, Math.max(10, contentWidth - 14));
  const { axis, label } = renderAxis(pct, barWidth);
  const emoji = zoneEmoji(pct);

  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionLabel>PRESSURE</SectionLabel>
      <Box marginTop={1}>
        <Text color={zoneColor(zoneFor(pct))}>{emoji}</Text>
        <Text> </Text>
        <Text color={zoneColor(zoneFor(pct))}>
          {renderMeter(pct, barWidth)} {(pct * 100).toFixed(0)}%
        </Text>
      </Box>
      <Text color={theme.textMuted}> {axis}</Text>
      <Text color={theme.textMuted}> {label}</Text>
    </Box>
  );
}

/**
 * Real composition, measured from the assembled request. Top-level categories
 * (System / Tools / History / Volatile) each render a bar sized to their share
 * of the total, plus a muted sub-line of the biggest constituents.
 */
function CompositionSection({
  breakdown,
  contentWidth,
}: {
  breakdown: ContextBreakdown | undefined;
  contentWidth: number;
}): React.ReactElement {
  if (!breakdown || breakdown.total <= 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <SectionLabel>CONTEXT COMPOSITION</SectionLabel>
        <Text color={theme.textMuted}>
          No request assembled yet — composition appears once the request begins assembling.
        </Text>
      </Box>
    );
  }

  const total = breakdown.total;
  const barLen = Math.min(24, Math.max(8, contentWidth - 34));

  // Top system sub-sources by token weight, for the System sub-line.
  const topSources = Object.entries(breakdown.system.bySource)
    .filter(([, tok]) => tok > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([src, tok]) => `${SOURCE_LABEL[src] ?? src} ${fmtTok(tok)}`)
    .join(' · ');

  // Top MCP servers, for the Tools sub-line.
  const topServers = Object.entries(breakdown.tools.mcpByServer)
    .filter(([, tok]) => tok > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([srv, tok]) => `${srv} ${fmtTok(tok)}`)
    .join(' · ');

  const rows: Array<{ icon: string; label: string; tokens: number; sub: string }> = [
    {
      icon: '⚙️',
      label: 'System',
      tokens: breakdown.system.total,
      sub: topSources || 'prompt sections',
    },
    {
      icon: '🔧',
      label: 'Tools',
      tokens: breakdown.tools.total,
      sub: `builtin ${fmtTok(breakdown.tools.builtin)} · mcp ${fmtTok(breakdown.tools.mcp)}${
        topServers ? ` (${topServers})` : ''
      } · ${breakdown.tools.count} defs`,
    },
    {
      icon: '💬',
      label: 'History',
      tokens: breakdown.history.total,
      sub: `text ${fmtTok(breakdown.history.text)} · inputs ${fmtTok(
        breakdown.history.toolInputs ?? 0,
      )} · results ${fmtTok(breakdown.history.toolResults)} · thinking ${fmtTok(
        breakdown.history.thinking ?? 0,
      )} · ${breakdown.history.messageCount} msgs`,
    },
    {
      icon: '🎯',
      label: 'Volatile',
      tokens: breakdown.volatile.total,
      sub: `ledger ${fmtTok(breakdown.volatile.ledger)} · next-steps ${fmtTok(
        breakdown.volatile.nextsteps,
      )}`,
    },
  ];

  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionLabel>CONTEXT COMPOSITION</SectionLabel>
      <Text color={theme.textMuted}>
        Measured breakdown of {total.toLocaleString('en-US')} tokens ·{' '}
        {((Number.isFinite(breakdown.usedPct) ? breakdown.usedPct : 0) * 100).toFixed(1)}% of{' '}
        {fmtTok(breakdown.effectiveMaxContext)}
      </Text>
      {rows.map((row) => {
        const frac = total > 0 ? row.tokens / total : 0;
        return (
          <Box key={row.label} flexDirection="column">
            <Text>
              <Text>{row.icon} </Text>
              <Text color={theme.textSecondary}>{row.label.padEnd(9)}</Text>
              <Text color={theme.textMuted}>{renderMeter(frac, barLen)}</Text>
              <Text> </Text>
              <Text color={theme.textMuted}>{(frac * 100).toFixed(1).padStart(4)}%</Text>
              <Text> </Text>
              <Text color={theme.textPrimary}>{fmtTok(row.tokens).padStart(6)}</Text>
            </Text>
            <Text color={theme.textMuted}>
              {'   '}
              {row.sub}
            </Text>
          </Box>
        );
      })}
      {breakdown.warnings.length > 0 ? (
        <Text color={theme.warn}> ⚠ {breakdown.warnings.join(' · ')}</Text>
      ) : null}
    </Box>
  );
}

function ThresholdSection({
  data,
  contentWidth,
}: {
  data: ContextPanelData;
  contentWidth: number;
}): React.ReactElement {
  const pct = data.ctxPct ?? 0;
  const curVal = pct * 100;
  const activeZone = zoneFor(pct);

  const barWidth = Math.min(40, Math.max(10, contentWidth - 14));
  const { axis, label } = renderAxis(pct, barWidth);

  // Distance to the next threshold above the current fill, in % and tokens.
  const nextBoundary = ZONES.find((z) => curVal < z.from);
  const maxTok = data.ctxMaxTokens ?? 0;
  const headroom =
    nextBoundary && maxTok > 0
      ? `${(nextBoundary.from - curVal).toFixed(1)}% (${fmtTok(
          ((nextBoundary.from - curVal) / 100) * maxTok,
        )}) until ${nextBoundary.desc}`
      : nextBoundary
        ? `${(nextBoundary.from - curVal).toFixed(1)}% until ${nextBoundary.desc}`
        : 'in the final zone — compaction is overdue';

  const LABEL_W = 9;
  const RANGE_W = 9;
  const azClr = zoneColor(activeZone);

  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionLabel>THRESHOLD MAP</SectionLabel>

      {/* Compact visual bar with axis */}
      <Box marginTop={1}>
        <Text color={azClr}>
          {renderMeter(pct, barWidth)} {curVal.toFixed(1)}%
        </Text>
      </Box>
      <Text color={theme.textMuted}> {axis}</Text>
      <Text color={theme.textMuted}> {label}</Text>

      {/* Zone table with mini sparkbars */}
      <Box flexDirection="column" marginTop={1}>
        {ZONES.map((z) => {
          const isActive = curVal >= z.from && curVal < z.to;
          const zColor = zoneColor(zoneFor((z.to - 0.01) / 100));
          const range = `${z.from}–${z.to}%`;
          // Mini spark bar showing the zone span
          const zoneSpan = z.to - z.from;
          const fullWidth = 20;
          const fillLen = Math.round((zoneSpan / 100) * fullWidth);
          return (
            <Box key={z.label}>
              <Text color={zColor}>{'●'}</Text>
              <Text color={isActive ? theme.textPrimary : theme.textSecondary}>
                {' '}
                {z.label.padEnd(LABEL_W)}
              </Text>
              <Text color={theme.textMuted}>{range.padStart(RANGE_W)} </Text>
              <Text color={isActive ? theme.textSecondary : theme.textMuted}>
                {'  '}
                {z.desc.padEnd(22)}
              </Text>
              {/* Mini sparkline: filled+empty zones */}
              <Text color={isActive ? zColor : theme.textMuted}>
                {'█'.repeat(fillLen) + '░'.repeat(fullWidth - fillLen)}
              </Text>
              {isActive ? <Text color={zColor}>{' ◀'}</Text> : null}
            </Box>
          );
        })}
      </Box>

      {/* Headroom line with emoji */}
      <Box marginTop={1}>
        <Text color={azClr}>
          {'◆'} {curVal.toFixed(1)}% {zoneLabel(pct)}
        </Text>
        <Text color={theme.textMuted}> · {headroom}</Text>
      </Box>
    </Box>
  );
}

function CompactionSection({ data }: { data: ContextPanelData }): React.ReactElement {
  const max = data.ctxMaxTokens ?? 200_000;
  const pct = data.ctxPct ?? 0;
  const needsCompact = pct > 0.65;

  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionLabel>COMPACTION ENGINE</SectionLabel>
      <Box>
        <Text color={theme.textMuted}>Strategy </Text>
        <Text color={theme.textPrimary}>
          hybrid <Text color={theme.success}>(auto ✅)</Text>
        </Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>Next trigger</Text>
        <Text color={theme.textSecondary}> {(max * 0.85).toLocaleString('en-US')} (85%)</Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>Recommend </Text>
        <Text color={needsCompact ? theme.warn : theme.success}>
          {needsCompact ? '⚠️ Compact soon' : '✅ No compaction needed'}
        </Text>
      </Box>
    </Box>
  );
}

function AgentFootprintSection({
  data,
  contentWidth,
}: {
  data: ContextPanelData;
  contentWidth: number;
}): React.ReactElement {
  const leaderPct = data.ctxPct;
  const fleet = data.fleetEntries.filter((e) => e.ctxPct != null);

  const allAgents: Array<{ name: string; ctxPct: number; status?: string }> = [];
  if (leaderPct != null) allAgents.push({ name: 'LEADER', ctxPct: leaderPct });
  for (const e of fleet) {
    if (e.ctxPct != null) allAgents.push({ name: e.name, ctxPct: e.ctxPct, status: e.status });
  }

  if (allAgents.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <SectionLabel>PER-AGENT FOOTPRINT</SectionLabel>
        <Text color={theme.textMuted}>No agent context data yet.</Text>
      </Box>
    );
  }

  const agentBarLen = Math.min(30, Math.max(8, contentWidth - 30));

  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionLabel>PER-AGENT FOOTPRINT</SectionLabel>
      {allAgents.map((a) => {
        const apct = a.ctxPct;
        const aEmoji = zoneEmoji(apct);
        const aColor = zoneColor(zoneFor(apct));
        const aPct = `${(apct * 100).toFixed(0)}%`.padStart(4);
        const tag = a.name === 'LEADER' ? '👑' : '  ';
        const aBar = renderMeter(apct, agentBarLen);
        // Mini sparkbar alongside the meter
        const spark = tuiMiniBar(apct, 10);
        return (
          <Box key={a.name}>
            <Text>
              <Text>{tag} </Text>
              <Text color={theme.textSecondary}>{a.name.padEnd(14)}</Text>
              <Text color={aColor}>
                {aEmoji} {aBar}
              </Text>
              <Text> </Text>
              <Text color={aColor}>{spark}</Text>
              <Text> </Text>
              <Text color={theme.textPrimary}>{aPct}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function MetricsSection({ data }: { data: ContextPanelData }): React.ReactElement {
  if (data.ctxTokens == null) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <SectionLabel>TOKEN METRICS</SectionLabel>
        <Text color={theme.textMuted}>No token count reported yet.</Text>
      </Box>
    );
  }
  const used = data.ctxTokens;
  const max = data.ctxMaxTokens ?? 200_000;
  const pct = data.ctxPct ?? (max > 0 ? used / max : 0);
  const free = max - used;
  const freePct = max > 0 ? ((free / max) * 100).toFixed(1) : '0.0';
  const utilBar20 = renderMeter(pct, 20);
  const utilBar8 = renderMeter(pct, 8);
  const zClr = zoneColor(zoneFor(pct));

  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionLabel>TOKEN METRICS</SectionLabel>

      {/* Compact three-column usage row */}
      <Box>
        <Box flexGrow={1}>
          <Text>
            <Text color={theme.textMuted}>Used </Text>
            <Text color={theme.textPrimary}>{used.toLocaleString('en-US')}</Text>
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            <Text color={theme.textMuted}>Free </Text>
            <Text color={theme.textSecondary}>
              {free.toLocaleString('en-US')} ({freePct}%)
            </Text>
          </Text>
        </Box>
        <Box>
          <Text>
            <Text color={theme.textMuted}>Cap </Text>
            <Text color={theme.textPrimary}>{max.toLocaleString('en-US')}</Text>
          </Text>
        </Box>
      </Box>

      {/* Utilization bar (wide) with zone color */}
      <Box>
        <Text color={theme.textMuted}>Utilization</Text>
        <Text> </Text>
        <Text color={zClr}>{utilBar20}</Text>
        <Text> </Text>
        <Text color={theme.textSecondary}>{(pct * 100).toFixed(1)}%</Text>
        <Text> </Text>
        <Text color={zClr}>{utilBar8}</Text>
      </Box>

      <Box>
        <Text>
          <Text color={theme.textMuted}>Model </Text>
          <Text color={theme.textPrimary}>{data.model}</Text>
          <Text color={theme.textMuted}> · </Text>
          <Text color={theme.textPrimary}>{data.provider}</Text>
          <Text color={theme.textMuted}> · Mode </Text>
          <Text color={theme.textSecondary}>{data.mode}</Text>
          <Text color={theme.textMuted}> · Uptime </Text>
          <Text color={theme.textSecondary}>{data.uptime}</Text>
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Cache coverage section — answers "exactly how far does the prompt cache
 * extend into the live request?" Renders the cumulative cache hit ratio
 * plus a per-request coverage meter that visibly marks where the cached
 * prefix ends. Hidden when nothing has been cached yet so the panel does
 * not advertise a 0% figure as if it were meaningful.
 */
function CacheSection({ data }: { data: ContextPanelData }): React.ReactElement {
  const cs = data.cacheStats ?? { readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 };
  const hasCache = cs.readTokens > 0 || cs.writeTokens > 0;
  // Anthropic-family providers (incl. MiniMax on the Anthropic surface) expose
  // the 5-min / 1-hour cache-write split. OpenAI-family gateways emit only
  // the aggregate and leave both undefined, in which case the panel skips
  // the TTL sub-row entirely instead of advertising two fabricated zeros.
  const hasTtlSplit =
    cs.cacheWrite5m !== undefined && cs.cacheWrite1h !== undefined;
  const coverage = Math.max(0, data.cacheCoverageTokens ?? 0);
  const max = data.ctxMaxTokens ?? 0;
  const covBarLen = 30;
  const covPct = max > 0 ? Math.min(100, (coverage / max) * 100) : 0;
  const covFilled = Math.round((covPct / 100) * covBarLen);

  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionLabel>PROMPT CACHE</SectionLabel>

      <Box>
        <Text color={theme.textMuted}>Hit ratio </Text>
        <Text color={hasCache ? theme.success : theme.textMuted} bold>
          {(cs.hitRatio * 100).toFixed(1)}%
        </Text>
        <Text color={theme.textMuted}> · read </Text>
        <Text color={theme.textPrimary}>{cs.readTokens.toLocaleString('en-US')}</Text>
        <Text color={theme.textMuted}> · write </Text>
        <Text color={theme.textSecondary}>{cs.writeTokens.toLocaleString('en-US')}</Text>
        {cs.savedUsd > 0 ? (
          <>
            <Text color={theme.textMuted}> · saved </Text>
            <Text color={theme.success}>~${cs.savedUsd.toFixed(2)}</Text>
          </>
        ) : null}
      </Box>

      {hasTtlSplit ? (
        <Box>
          <Text color={theme.textMuted}>Write TTL </Text>
          <Text color={theme.textPrimary}>
            5m {((cs.cacheWrite5m ?? 0)).toLocaleString('en-US')}
          </Text>
          <Text color={theme.textMuted}> · </Text>
          <Text color={theme.textSecondary}>
            1h {((cs.cacheWrite1h ?? 0)).toLocaleString('en-US')}
          </Text>
        </Box>
      ) : null}

      {(data.providerCacheStats?.length ?? 0) > 0 ? (
        <Box flexDirection="column">
          <Text color={theme.textMuted}>Providers</Text>
          {data.providerCacheStats?.map((provider) => (
            <Text key={provider.provider}>
              <Text color={theme.textPrimary}> {provider.provider}</Text>
              <Text color={theme.textMuted}> · </Text>
              <Text color={provider.cacheRead > 0 ? theme.success : theme.textMuted}>
                {(provider.hitRatio * 100).toFixed(1)}%
              </Text>
              <Text color={theme.textMuted}> · read </Text>
              <Text color={theme.textPrimary}>
                {provider.cacheRead.toLocaleString('en-US')}
              </Text>
              <Text color={theme.textMuted}> · write </Text>
              <Text color={theme.textSecondary}>
                {provider.cacheWrite.toLocaleString('en-US')}
              </Text>
              {provider.cacheWrite5m !== undefined && provider.cacheWrite1h !== undefined ? (
                <>
                  <Text color={theme.textMuted}> (</Text>
                  <Text color={theme.textPrimary}>
                    5m {provider.cacheWrite5m.toLocaleString('en-US')}
                  </Text>
                  <Text color={theme.textMuted}>, </Text>
                  <Text color={theme.textSecondary}>
                    1h {provider.cacheWrite1h.toLocaleString('en-US')}
                  </Text>
                  <Text color={theme.textMuted}>)</Text>
                </>
              ) : null}
            </Text>
          ))}
        </Box>
      ) : null}

      {coverage > 0 && max > 0 ? (
        <>
          {/* Coverage meter — `■` cells mark the cached span, `┊` line
              pins the exact endpoint. `□` shows the rest of the window
              that was billed at full input rate. */}
          <Box marginTop={1}>
            <Text color={theme.textMuted}>Coverage </Text>
            <Text color={theme.success}>{'■'.repeat(Math.max(0, covFilled))}</Text>
            <Text color={theme.textSecondary}>{'┊'}</Text>
            <Text color={theme.borderSubtle}>{'□'.repeat(Math.max(0, covBarLen - covFilled))}</Text>
            <Text color={theme.textMuted}> </Text>
            <Text color={theme.success}>
              {coverage.toLocaleString('en-US')} / {max.toLocaleString('en-US')} (
              {covPct.toFixed(1)}%)
            </Text>
          </Box>
          <Text color={theme.textMuted}>
            The first {coverage.toLocaleString('en-US')} tokens of this prompt are served from the
            provider cache; everything after the marked boundary is fresh.
          </Text>
        </>
      ) : (
        <Text color={theme.textMuted}>
          No cached prefix on the current request — the next assistant turn will start building one.
        </Text>
      )}
    </Box>
  );
}

/** Renders a compact horizontal bar using block chars. Clamps pct to [0,1]. */
function tuiMiniBar(pct: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

function StatusSection({ data }: { data: ContextPanelData }): React.ReactElement {
  const pct = data.ctxPct ?? 0;
  const z = zoneFor(pct);
  const emoji = zoneEmoji(pct);
  const zClr = zoneColor(z);
  const used = data.ctxTokens ?? 0;
  const max = data.ctxMaxTokens ?? 200_000;
  const barWidth = 20;
  const bar = tuiMiniBar(pct, barWidth);

  let verdict: string;
  if (pct > 0.85) {
    verdict = `CRITICAL — Consider compacting or a fresh session.`;
  } else if (pct > 0.65) {
    verdict = `WARNING  — Plan compaction soon.`;
  } else if (pct > 0.45) {
    verdict = `MODERATE — Healthy, monitor as it grows.`;
  } else {
    verdict = `HEALTHY  — Plenty of room for more conversation.`;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionLabel>STATUS</SectionLabel>
      <Box>
        <Text color={zClr}>
          {bar} {(pct * 100).toFixed(1)}%
        </Text>
        <Text> </Text>
        <Text color={theme.textMuted}>
          {used.toLocaleString('en-US')} / {max.toLocaleString('en-US')}
        </Text>
      </Box>
      <Text color={zClr}>
        {emoji} {verdict}
      </Text>
    </Box>
  );
}

function MemoryContextSection({ data }: { data: ContextPanelData }): React.ReactElement {
  const ctx = data.memoryContext;
  if (!ctx || (Object.keys(ctx.memories).length === 0 && ctx.transitions.length === 0)) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <SectionLabel>SAGE IN CONTEXT</SectionLabel>
        <Text color={theme.textMuted}>No memory has entered this session context.</Text>
      </Box>
    );
  }
  const records = Object.values(ctx.memories)
    .slice()
    .sort((a, b) => {
      if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt < a.lastSeenAt ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  let active = 0;
  let pending = 0;
  let exited = 0;
  for (const m of records) {
    if (m.state === 'active') active++;
    else if (m.state === 'injected') pending++;
    else exited++;
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionLabel>SAGE IN CONTEXT</SectionLabel>
      <Text>
        <Text color={theme.success}>{`${active} ctx`}</Text>
        <Text color={theme.warn}>{` · ${pending} pending`}</Text>
        <Text color={theme.textMuted}>{` · ${exited} left · exact provider request snapshot`}</Text>
      </Text>
      {records.slice(0, 6).map((memory) => {
        const stateLabel =
          memory.state === 'active' ? 'CONTEXT' : memory.state === 'injected' ? 'PENDING' : 'LEFT';
        const arrow = memory.state === 'exited' ? '↳' : '↲';
        const stateColor =
          memory.state === 'active'
            ? theme.success
            : memory.state === 'injected'
              ? theme.warn
              : theme.textMuted;
        return (
          <Box key={memory.id} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={stateColor}>{`${arrow} ${stateLabel.padEnd(7)}`}</Text>
              <Text color={theme.assistant}>{memory.id}</Text>
              <Text color={theme.textMuted}>{` [${memory.kind}] ${memory.persistence}`}</Text>
            </Text>
            <Text color={theme.textSecondary}>{memory.text}</Text>
          </Box>
        );
      })}
      {data.memoryContext.transitions.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.textSecondary}>CAME / WENT</Text>
          {data.memoryContext.transitions.slice(0, 6).map((transition) => (
            <Text
              key={transition.id}
              color={transition.action === 'exited' ? theme.textMuted : theme.success}
            >
              {`${transition.action === 'exited' ? '↳' : '↲'} ${transition.action.padEnd(8)} ${transition.memoryId} · ${transition.reason}`}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

function TabBar({ active }: { active: TabId }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.textMuted}>‹ </Text>
      {TABS.map((tab, i) => {
        const isActive = tab.id === active;
        return (
          <Text key={tab.id}>
            {i > 0 ? <Text color={theme.textMuted}> │ </Text> : null}
            <Text
              color={isActive ? theme.accent : theme.textMuted}
              bold={isActive}
              underline={isActive}
            >
              {i + 1} {tab.label}
            </Text>
          </Text>
        );
      })}
      <Text color={theme.textMuted}> ›</Text>
    </Box>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ContextPanel({ data, onClose }: ContextPanelProps): React.ReactElement {
  const size = useMonitorSize();
  const contentWidth = size.contentWidth;
  const [tab, setTab] = useState<TabId>('overview');

  const shortcutsEnabled = usePanelShortcutsEnabled();
  useInput((input, key) => {
    // Esc is owned by the central ESC_CLOSE_PANELS table (esc-close-panels.ts);
    // handling it here too would double-fire the toggle and re-open the panel.
    // With a draft in the composer, every key here (letters, digits, Tab,
    // ←/→) collides with composer editing — the panel goes display-only.
    if (!shortcutsEnabled) return;
    if (input === 'q') {
      onClose();
      return;
    }
    const idx = TABS.findIndex((t) => t.id === tab);
    if (key.rightArrow || key.tab) {
      const next = TABS[(idx + 1) % TABS.length];
      if (next) setTab(next.id);
      return;
    }
    if (key.leftArrow) {
      const prev = TABS[(idx - 1 + TABS.length) % TABS.length];
      if (prev) setTab(prev.id);
      return;
    }
    // Direct 1-{TABS.length} jump. Non-digit input is safely ignored
    // (parseInt returns NaN), and digits > TABS.length have no match.
    const n = Number.parseInt(input, 10);
    const direct = TABS[n - 1];
    if (!Number.isNaN(n) && direct) {
      setTab(direct.id);
    }
  });

  const isEmpty =
    data.ctxPct == null &&
    data.ctxTokens == null &&
    Object.keys(data.memoryContext.memories).length === 0 &&
    data.memoryContext.transitions.length === 0 &&
    data.memoryContext.latest === undefined;

  if (isEmpty) {
    return (
      <MonitorShell
        accent={theme.monitor.fleet}
        icon={glyphs.context}
        title="CONTEXT"
        kicker={size.columns >= 80 ? 'context window' : undefined}
        maxHeight={Math.max(8, size.rows - 1)}
        right={
          <Text color={theme.textMuted}>
            {glyphs.clock} {data.uptime}
          </Text>
        }
        footer={<KeyCap keyName="Esc" label="close" color={theme.monitor.fleet} />}
      >
        <EmptyPanelState
          icon={glyphs.context}
          title="No context data yet"
          detail="Context metrics appear once the agent starts processing a request."
          accent={theme.textMuted}
        />
      </MonitorShell>
    );
  }

  const pct = data.ctxPct ?? 0;
  const z = zoneFor(pct);
  const emoji = zoneEmoji(pct);
  const zoneClr = zoneColor(z);

  return (
    <MonitorShell
      accent={zoneClr}
      icon={glyphs.context}
      title="CONTEXT WINDOW"
      kicker={size.columns >= 80 ? `${data.model} · ${data.provider}` : undefined}
      maxHeight={Math.max(8, size.rows - 1)}
      right={
        <Text>
          <Text color={zoneClr}>{emoji}</Text>
          <Text color={theme.textMuted}> {zoneLabel(pct)}</Text>
          <Text> </Text>
          <Text color={theme.textMuted}>
            {glyphs.clock} {data.uptime}
          </Text>
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="Esc" label="close" color={zoneClr} />
          <Text color={theme.textMuted}>
            ←/→ or Ctrl+1-{TABS.length} switch tab · `/context` for full dashboard
          </Text>
        </Box>
      }
    >
      <Box flexDirection="column" paddingX={1}>
        {/* Identity line */}
        <Box>
          <Text color={theme.textSecondary}>{emoji} </Text>
          <Text color={theme.textPrimary}>{data.model}</Text>
          <Text color={theme.textMuted}> · </Text>
          <Text color={theme.textPrimary}>{data.provider}</Text>
          <Text color={theme.textMuted}> · </Text>
          <Text color={theme.textSecondary}>{data.mode}</Text>
          <Box flexGrow={1} />
          <Text color={theme.textMuted}>
            L{data.leaderIterations} · T{data.leaderToolCalls}
            {data.leaderStatus !== 'idle' ? ` · ${data.leaderStatus}` : ''}
          </Text>
        </Box>

        <TabBar active={tab} />

        {/* Active tab body — only one tab renders, so the panel never overflows. */}
        {tab === 'overview' ? (
          <>
            <PressureSection data={data} contentWidth={contentWidth} />
            <StatusSection data={data} />
            <MetricsSection data={data} />
            <CacheSection data={data} />
          </>
        ) : null}
        {tab === 'composition' ? (
          <CompositionSection breakdown={data.breakdown} contentWidth={contentWidth} />
        ) : null}
        {tab === 'thresholds' ? (
          <>
            <ThresholdSection data={data} contentWidth={contentWidth} />
            <CompactionSection data={data} />
          </>
        ) : null}
        {tab === 'agents' ? (
          <AgentFootprintSection data={data} contentWidth={contentWidth} />
        ) : null}
        {tab === 'memory' ? <MemoryContextSection data={data} /> : null}

        {/* Bottom spacer */}
        <Box height={1} />
      </Box>
    </MonitorShell>
  );
}
