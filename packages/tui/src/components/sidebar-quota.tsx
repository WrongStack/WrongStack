// PLAN QUOTA sidebar card — renders a {@link QuotaCardModel}.
//
// Pure presentation, like the rest of SidebarContent: the model is built from
// the provider-neutral quota store by `useProviderQuotaCard` and handed in as
// a prop. Every row is a single truncated line, so the row count the scroll
// clamp reserves (header + SIDEBAR_QUOTA_BODY_ROWS + caps) is exact.

import type React from 'react';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { Card } from './sidebar-card.js';
import { SidebarSectionHeader } from './sidebar-panel-frame.js';
import { trunc } from './sidebar-presentation.js';
import type { QuotaCardModel, QuotaCardRow, QuotaSeverity } from './sidebar-quota-model.js';
import { renderMeter } from './status-bar-format.js';

function severityColor(severity: QuotaSeverity): string {
  if (severity === 'critical') return theme.error;
  if (severity === 'warn') return theme.warn;
  return theme.success;
}

function pctText(usedPercent: number): string {
  // As core's formatQuotaPercent: 99.6 on a window with room is 99%, not a cut-off.
  return `${usedPercent >= 100 ? 100 : Math.min(99, Math.round(usedPercent))}%`;
}

/** `5h [000o......]  73% ◷2h59m`, shedding the countdown, then the meter, as the rail narrows. */
function WindowRow({
  row,
  width,
}: {
  row: Extract<QuotaCardRow, { kind: 'window' }>;
  width: number;
}): React.ReactElement {
  const color = severityColor(row.severity);
  const label = trunc(row.label, Math.max(3, Math.floor(width * 0.4))).padEnd(3);
  const pct = (row.reached ? 'MAX' : pctText(row.usedPercent)).padStart(4);
  const fixed = label.length + 1 + 1 + pct.length;
  const reset = row.resetIn ? ` ${glyphs.clock}${row.resetIn}` : '';
  let meterInner = width - fixed - reset.length - 2;
  let showReset = reset.length > 0;
  if (meterInner < 3 && showReset) {
    showReset = false;
    meterInner = width - fixed - 2;
  }
  const meter = meterInner >= 3 ? renderMeter(row.usedPercent / 100, meterInner) : '';
  return (
    <Box width={width} flexDirection="row">
      <Text wrap="truncate">
        <Text color={theme.textSecondary}>{label} </Text>
        {meter ? <Text color={color}>{meter}</Text> : null}
        <Text color={color} bold>
          {` ${pct}`}
        </Text>
        {showReset ? <Text color={theme.textMuted}>{reset}</Text> : null}
      </Text>
    </Box>
  );
}

function QuotaRow({ row, width }: { row: QuotaCardRow; width: number }): React.ReactElement {
  switch (row.kind) {
    case 'provider':
      return (
        <Text wrap="truncate">
          <Text color={theme.textMuted}>{`${glyphs.diamondOpen} `}</Text>
          <Text color={theme.textPrimary} bold>
            {row.providerId}
          </Text>
          {row.planLabel ? (
            <Text color={theme.textMuted}>{` ${glyphs.dividerDot} ${row.planLabel}`}</Text>
          ) : null}
        </Text>
      );
    case 'meter':
      return (
        <Text color={theme.textSecondary} wrap="truncate">
          {`${glyphs.dividerDot} ${row.title}`}
        </Text>
      );
    case 'window':
      return <WindowRow row={row} width={width} />;
    case 'pace':
      return (
        <Text color={theme.warn} wrap="truncate">
          {`${glyphs.treeLast} 100% in ~${row.exhaustsIn}`}
        </Text>
      );
    case 'credits':
      return (
        <Text color={row.empty ? theme.error : theme.textSecondary} wrap="truncate">
          {row.text}
        </Text>
      );
    case 'other': {
      const right = `${row.label} ${row.reached ? 'MAX' : pctText(row.usedPercent)}`;
      return (
        <Box width={width} flexDirection="row" justifyContent="space-between">
          <Text color={theme.textSecondary} wrap="truncate">
            {trunc(row.providerId, Math.max(1, width - right.length - 1))}
          </Text>
          <Text color={severityColor(row.severity)} wrap="truncate">
            {right}
          </Text>
        </Box>
      );
    }
    case 'more':
      return (
        <Text color={theme.textMuted} wrap="truncate">
          {`+${row.count} more ${glyphs.dividerDot} /provider-quota`}
        </Text>
      );
  }
}

function rowKey(row: QuotaCardRow, index: number): string {
  switch (row.kind) {
    case 'provider':
      return `provider:${row.providerId}`;
    case 'other':
      return `other:${row.providerId}`;
    default:
      return `${row.kind}:${index}`;
  }
}

export function QuotaCard({
  quota,
  innerWidth,
}: {
  quota: QuotaCardModel;
  innerWidth: number;
}): React.ReactElement {
  const headline = quota.headline;
  const accent = headline ? severityColor(headline.severity) : undefined;
  const badge = headline
    ? headline.reached
      ? `LIMIT ${headline.label}`
      : `${pctText(headline.usedPercent)} ${headline.label}`
    : undefined;
  return (
    <Card innerWidth={innerWidth} accent={accent}>
      {(bodyWidth) => (
        <>
          <SidebarSectionHeader
            glyph={glyphs.target}
            label="PLAN QUOTA"
            color={theme.accent}
            badge={badge}
            badgeColor={accent}
            innerWidth={bodyWidth}
            pill
          />
          {quota.rows.map((row, index) => (
            <QuotaRow key={rowKey(row, index)} row={row} width={bodyWidth} />
          ))}
        </>
      )}
    </Card>
  );
}
