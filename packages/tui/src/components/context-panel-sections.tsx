import type { ContextBreakdown } from '@wrongstack/core/agent';
import type React from 'react';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
// The bracket-style `[000o····]` meter is the statusline's context bar; reuse
// it here so the panel's fill bars mirror the statusline instead of using a
// second (block `█░`) visual language.
import type { ContextPanelData } from './context-panel-types.js';
import { SectionLabel } from './monitor-shell.js';
import { fmtPct, fmtRatioPct, renderMeter } from './status-bar-format.js';

export { CacheSection, MemoryContextSection } from './context-panel-cache-memory.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

type ZoneLevel = 'safe' | 'warning' | 'critical' | 'danger';

export function zoneFor(pct: number): ZoneLevel {
  if (pct > 0.95) return 'danger';
  if (pct > 0.85) return 'critical';
  if (pct > 0.6) return 'warning';
  return 'safe';
}

export function zoneColor(zone: ZoneLevel): string {
  switch (zone) {
    case 'safe':
      return theme.success;
    case 'warning':
      return theme.warn;
    case 'critical':
      return theme.error;
    case 'danger':
      return theme.error;
  }
}

export function zoneEmoji(pct: number): string {
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

export function zoneLabel(pct: number): string {
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
  'user-instructions': '~/AGENTS.md',
  'project-instructions': 'AGENTS.md',
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

export function PressureSection({
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
export function CompositionSection({
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
        {fmtRatioPct(Number.isFinite(breakdown.usedPct) ? breakdown.usedPct : 0)} of{' '}
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
              <Text color={theme.textMuted}>{fmtRatioPct(frac).padStart(6)}</Text>
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

export function ThresholdSection({
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
  const diffPct = nextBoundary ? nextBoundary.from - curVal : 0;
  const headroom =
    nextBoundary && maxTok > 0
      ? `${fmtPct(diffPct)} (${fmtTok((diffPct / 100) * maxTok)}) until ${nextBoundary.desc}`
      : nextBoundary
        ? `${fmtPct(diffPct)} until ${nextBoundary.desc}`
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
          {renderMeter(pct, barWidth)} {fmtPct(curVal)}
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
          {'◆'} {fmtPct(curVal)} {zoneLabel(pct)}
        </Text>
        <Text color={theme.textMuted}> · {headroom}</Text>
      </Box>
    </Box>
  );
}

export function CompactionSection({ data }: { data: ContextPanelData }): React.ReactElement {
  const max = data.ctxMaxTokens ?? 0;
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
        <Text color={theme.textSecondary}>
          {' '}
          {max > 0 ? `${(max * 0.85).toLocaleString('en-US')} (85%)` : 'unknown window'}
        </Text>
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

export function AgentFootprintSection({
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
        const aPct = fmtRatioPct(apct).padStart(6);
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

export function MetricsSection({ data }: { data: ContextPanelData }): React.ReactElement {
  if (data.ctxTokens == null) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <SectionLabel>TOKEN METRICS</SectionLabel>
        <Text color={theme.textMuted}>No token count reported yet.</Text>
      </Box>
    );
  }
  const used = data.ctxTokens;
  const max = data.ctxMaxTokens ?? 0;
  const pct = data.ctxPct ?? (max > 0 ? used / max : 0);
  const free = max > 0 ? max - used : 0;
  const freePct = max > 0 ? fmtRatioPct(free / max) : '0%';
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
              {max > 0 ? `${free.toLocaleString('en-US')} (${freePct})` : '—'}
            </Text>
          </Text>
        </Box>
        <Box>
          <Text>
            <Text color={theme.textMuted}>Cap </Text>
            <Text color={theme.textPrimary}>
              {max > 0 ? max.toLocaleString('en-US') : 'unknown'}
            </Text>
          </Text>
        </Box>
      </Box>

      {/* Utilization bar (wide) with zone color */}
      <Box>
        <Text color={theme.textMuted}>Utilization</Text>
        <Text> </Text>
        <Text color={zClr}>{utilBar20}</Text>
        <Text> </Text>
        <Text color={theme.textSecondary}>{fmtRatioPct(pct)}</Text>
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

/** Renders a compact horizontal bar using block chars. Clamps pct to [0,1]. */
function tuiMiniBar(pct: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

export function StatusSection({ data }: { data: ContextPanelData }): React.ReactElement {
  const pct = data.ctxPct ?? 0;
  const z = zoneFor(pct);
  const emoji = zoneEmoji(pct);
  const zClr = zoneColor(z);
  const used = data.ctxTokens ?? 0;
  const max = data.ctxMaxTokens ?? 0;
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
          {bar} {fmtRatioPct(pct)}
        </Text>
        <Text> </Text>
        <Text color={theme.textMuted}>
          {used.toLocaleString('en-US')} / {max > 0 ? max.toLocaleString('en-US') : '?'}
        </Text>
      </Box>
      <Text color={zClr}>
        {emoji} {verdict}
      </Text>
    </Box>
  );
}
