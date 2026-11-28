import type React from 'react';
import { useState } from 'react';
import { Box, Text } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { ResidencySection } from './context-panel-residency.js';
// The bracket-style `[000o····]` meter is the statusline's context bar; reuse
// it here so the panel's fill bars mirror the statusline instead of using a
// second (block `█░`) visual language.
import {
  AgentFootprintSection,
  CacheSection,
  CompactionSection,
  CompositionSection,
  MemoryContextSection,
  MetricsSection,
  PressureSection,
  StatusSection,
  ThresholdSection,
  zoneColor,
  zoneEmoji,
  zoneFor,
  zoneLabel,
} from './context-panel-sections.js';
import type { ContextPanelData } from './context-panel-types.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  usePanelInput as useInput,
  useMonitorSize,
  usePanelShortcutsEnabled,
} from './monitor-shell.js';

interface ContextPanelProps {
  data: ContextPanelData;
  onClose: () => void;
}

type TabId = 'overview' | 'composition' | 'thresholds' | 'agents' | 'memory' | 'residency';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'composition', label: 'Composition' },
  { id: 'thresholds', label: 'Thresholds' },
  { id: 'agents', label: 'Agents' },
  { id: 'memory', label: 'Memory' },
  { id: 'residency', label: 'Residency' },
];

// ── Tab bar ───────────────────────────────────────────────────────────────────

/** Group tab labels into rows that fit the panel without shrinking any label. */
function tabRows(width: number): number[][] {
  const numbered = TABS.map((tab, i) => `${i + 1} ${tab.label}`);
  const plain = TABS.map((tab) => tab.label);
  const withNumbers = displayWidth(`‹ ${numbered.join(' ')} ›`) <= width;
  const entries = withNumbers ? numbered : plain;

  const rows: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const candidate = [...current, i];
    const prefix = withNumbers && rows.length === 0 && current.length === 0 ? '‹ ' : '';
    const candidateWidth = displayWidth(
      `${prefix}${candidate.map((index) => entries[index]).join(' ')}`,
    );
    if (candidateWidth <= width) {
      current = candidate;
    } else {
      rows.push(current);
      current = [i];
    }
  }
  if (current.length > 0) rows.push(current);

  // The trailing chevron belongs to the last row; reserve its two columns.
  const last = rows[rows.length - 1];
  if (
    last &&
    displayWidth(`${rows.length === 1 ? '‹ ' : ''}${last.map((i) => entries[i]).join(' ')} ›`) >
      width &&
    last.length > 1
  ) {
    rows.push([last.pop()!]);
  }
  return rows;
}

function TabBar({ active, width }: { active: TabId; width: number }): React.ReactElement {
  const entries = TABS.map((tab, i) => `${i + 1} ${tab.label}`);
  const compact = displayWidth(`‹ ${entries.join(' ')} ›`) > width;
  const rows = tabRows(width);
  return (
    <Box flexDirection="column" marginTop={1} width={width} flexShrink={0}>
      {rows.map((row, rowIndex) => (
        <Box
          key={rowIndex}
          flexDirection="row"
          height={1}
          width={width}
          flexShrink={0}
          overflow="hidden"
        >
          {rowIndex === 0 ? <Text color={theme.textMuted}>‹ </Text> : null}
          {row.map((index, columnIndex) => {
            const tab = TABS[index]!;
            const isActive = tab.id === active;
            return (
              <Text key={tab.id}>
                {columnIndex > 0 ? <Text color={theme.textMuted}> </Text> : null}
                <Text
                  color={isActive ? theme.accent : theme.textMuted}
                  bold={isActive}
                  underline={isActive}
                >
                  {compact ? tab.label : entries[index]}
                </Text>
              </Text>
            );
          })}
          {rowIndex === rows.length - 1 ? <Text color={theme.textMuted}> ›</Text> : null}
        </Box>
      ))}
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
    if (key.meta || (key.ctrl && !/^[1-6]$/.test(input))) return;
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
        kicker="context window"
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
      kicker={`${data.model} · ${data.provider}`}
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

        <TabBar active={tab} width={Math.max(1, contentWidth - 2)} />

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
        {tab === 'residency' ? (
          <ResidencySection
            residency={data.residency}
            retention={data.retention}
            contentWidth={contentWidth}
          />
        ) : null}

        {/* Bottom spacer */}
        <Box height={1} />
      </Box>
    </MonitorShell>
  );
}
export type { ContextPanelData } from './context-panel-types.js';
