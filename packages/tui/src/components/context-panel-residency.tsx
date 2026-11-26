import {
  CACHE_LANE_LABELS,
  CACHE_LANE_ORDER,
  CACHE_VERDICT_LABELS,
  type CacheLane,
  type CacheVerdict,
  type HistoryRetention,
  RESIDENCY_SEGMENT_LABELS,
  RETENTION_CLASSES,
  RETENTION_LABELS,
  type RequestResidency,
} from '@wrongstack/core/utils';
import type React from 'react';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';

/**
 * Residency tab — answers "what is in the context, what of it is cached, and
 * what will the next compaction keep?" from the core residency/retention
 * snapshots (`getRequestResidency` / `getHistoryRetention`). Every number is
 * measured from the request actually sent; nothing is a fixed proportion.
 */

const LANE_GLYPH: Record<CacheLane, string> = { cached: '█', written: '▓', uncached: '░' };

function laneColor(lane: CacheLane): string {
  return lane === 'cached' ? theme.success : lane === 'written' ? theme.warn : theme.textMuted;
}

function verdictColor(verdict: CacheVerdict): string {
  if (verdict === 'hit') return theme.success;
  if (verdict === 'partial' || verdict === 'cold' || verdict === 'pending') return theme.warn;
  if (verdict === 'miss') return theme.error;
  return theme.textMuted;
}

function fmtTok(value: number): string {
  // Unit from the ROUNDED mantissa: 999_960 is "1.00m", not "1000.0k".
  const k = (value / 1_000).toFixed(1);
  if (value >= 1_000_000 || Number(k) >= 1_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `${k}k`;
  return String(Math.round(value));
}

function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : '0%';
}

/**
 * One stacked bar in wire order: each lane's share of the request, so the
 * reader sees where the cached prefix ends and the fresh tail begins.
 */
function LaneStrip({
  residency,
  width,
}: {
  residency: RequestResidency;
  width: number;
}): React.ReactElement {
  const cells: Array<{ lane: CacheLane; n: number }> = [];
  let used = 0;
  for (const lane of CACHE_LANE_ORDER) {
    const tokens = residency.lanes[lane];
    if (tokens <= 0) continue;
    const n = Math.max(1, Math.round((tokens / Math.max(1, residency.total)) * width));
    cells.push({ lane, n });
    used += n;
  }
  // Rounding can overshoot by a cell or two; trim the widest lane.
  const widest = cells.reduce<{ lane: CacheLane; n: number } | undefined>(
    (best, c) => (!best || c.n > best.n ? c : best),
    undefined,
  );
  if (widest && used > width) widest.n -= used - width;
  return (
    <Text>
      {cells.map((c) => (
        <Text key={c.lane} color={laneColor(c.lane)}>
          {LANE_GLYPH[c.lane].repeat(Math.max(0, c.n))}
        </Text>
      ))}
      {CACHE_LANE_ORDER.filter((lane) => residency.lanes[lane] > 0).map((lane) => (
        <Text key={lane} color={laneColor(lane)}>
          {' '}
          {CACHE_LANE_LABELS[lane]} {pct(residency.lanes[lane], residency.total)}
        </Text>
      ))}
      {residency.actual ? (
        <Text color={theme.textMuted}>
          {' '}
          · actual {pct(residency.actual.cacheRead, residency.actual.total)}
        </Text>
      ) : null}
    </Text>
  );
}

function RequestSection({
  residency: r,
  contentWidth,
}: {
  residency: RequestResidency;
  contentWidth: number;
}): React.ReactElement {
  const labelWidth = Math.max(...r.segments.map((s) => RESIDENCY_SEGMENT_LABELS[s.kind].length));
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.textSecondary} bold>
          LAST REQUEST
        </Text>
        <Text color={theme.textMuted}>
          {' '}
          #{r.seq} · {r.mechanism} cache · {fmtTok(r.total)} est.
          {r.actual
            ? ` · provider read ${fmtTok(r.actual.cacheRead)} / write ${fmtTok(r.actual.cacheWrite)} / fresh ${fmtTok(r.actual.input)}`
            : ''}
        </Text>
      </Text>
      <LaneStrip residency={r} width={Math.max(10, Math.min(30, contentWidth - 64))} />
      {r.segments.map((seg) => (
        <Text key={seg.kind}>
          <Text color={laneColor(seg.lane)}>{LANE_GLYPH[seg.lane]} </Text>
          <Text color={theme.textPrimary}>
            {RESIDENCY_SEGMENT_LABELS[seg.kind].padEnd(labelWidth)}
          </Text>
          <Text color={theme.textSecondary}> {fmtTok(seg.tokens).padStart(7)} </Text>
          <Text color={laneColor(seg.lane)}>{CACHE_LANE_LABELS[seg.lane]}</Text>
          <Text color={theme.textMuted}> ×{seg.count}</Text>
          {seg.parts && seg.parts.length > 0 ? (
            <Text color={theme.textMuted}>
              {' '}
              ({seg.parts.map((p) => `${p.source} ${fmtTok(p.tokens)}`).join(', ')})
            </Text>
          ) : null}
        </Text>
      ))}
      <Text>
        <Text color={verdictColor(r.verdict)} bold>
          {CACHE_VERDICT_LABELS[r.verdict]}
        </Text>
      </Text>
      {r.breakers.map((b) => (
        <Text key={b.kind}>
          <Text color={theme.warn}>↯ {b.kind}</Text>
          <Text color={theme.textMuted}> — {b.detail}</Text>
        </Text>
      ))}
      <Text color={theme.textMuted}>
        next:{' '}
        {r.next.rewritten
          ? 'history rewritten since — the next request re-writes the cache'
          : `+${r.next.pendingMessages} msg (${fmtTok(r.next.pendingTokens)}) will be new`}
      </Text>
    </Box>
  );
}

function RetentionSection({ retention: h }: { retention: HistoryRetention }): React.ReactElement {
  const present = RETENTION_CLASSES.filter((c) => h.classes[c].messages > 0);
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.textSecondary} bold>
          HISTORY RETENTION
        </Text>
        <Text color={theme.textMuted}>
          {' '}
          keep last {h.preserveK} turns · elide tool results &gt;{' '}
          {h.eliseThreshold.toLocaleString('en-US')} tokens
        </Text>
      </Text>
      {present.length === 0 ? (
        <Text color={theme.textMuted}>No conversation yet.</Text>
      ) : (
        <Box flexWrap="wrap">
          {present.map((c, i) => (
            <Text key={c}>
              {i > 0 ? <Text color={theme.textMuted}> · </Text> : null}
              <Text color={c === 'protected' ? theme.success : theme.textPrimary}>
                {RETENTION_LABELS[c]}
              </Text>
              <Text color={theme.textSecondary}> {fmtTok(h.classes[c].tokens)}</Text>
              <Text color={theme.textMuted}>
                {' '}
                ({h.classes[c].messages} msg, {pct(h.classes[c].tokens, h.total)})
              </Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

export function ResidencySection({
  residency,
  retention,
  contentWidth,
}: {
  residency: RequestResidency | undefined;
  retention: HistoryRetention | undefined;
  contentWidth: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {residency ? (
        <RequestSection residency={residency} contentWidth={contentWidth} />
      ) : (
        <Box marginTop={1}>
          <Text color={theme.textMuted}>
            No request sent yet — the cache map appears after the first one.
          </Text>
        </Box>
      )}
      {retention ? <RetentionSection retention={retention} /> : null}
    </Box>
  );
}
