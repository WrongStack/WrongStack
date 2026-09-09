import type React from 'react';
import { Box, Text } from '../../ink.js';
import { displayWidth, sanitizeTerminalText, truncateDisplay } from '../../terminal-width.js';
import { theme } from '../../theme.js';
import type { ToolResultViewMode } from '../../tool-result-view-mode.js';
import { glyphs } from '../../ui-glyphs.js';
import {
  CARD_LEAD_CLOSED,
  CARD_LEAD_OPEN,
  VIEW_CONTROL_LESS,
  VIEW_CONTROL_MORE,
  VIEW_CONTROL_PREFIX,
} from './tool-card-geometry.js';

interface ToolCardProps {
  glyph: string;
  color: string;
  title: string;
  detail?: string | undefined;
  meta?: string | undefined;
  ok: boolean;
  termWidth: number;
  hasBody: boolean;
  children?: React.ReactNode;
  viewMode?: ToolResultViewMode | undefined;
}

/**
 * Shared terminal-native anatomy for committed tool results. The open left
 * rail keeps dense output readable without turning every tiny call into a
 * heavy full-width modal, while the compact header makes tool/state/timing
 * easy to scan in long transcripts.
 */
export function ToolCard({
  glyph,
  color,
  title,
  detail,
  meta,
  ok,
  termWidth,
  hasBody,
  children,
  viewMode,
}: ToolCardProps): React.ReactElement {
  const safeTitle = sanitizeTerminalText(title);
  const safeDetail = detail ? sanitizeTerminalText(detail) : undefined;
  const safeMeta = meta ? sanitizeTerminalText(meta) : undefined;
  const status = ok ? glyphs.success : glyphs.failure;
  const statusColor = ok ? theme.success : theme.error;
  const controlPrefix = viewMode ? VIEW_CONTROL_PREFIX : '';
  const cardLead = hasBody ? CARD_LEAD_OPEN : CARD_LEAD_CLOSED;
  const titleBudget = Math.max(
    1,
    termWidth - displayWidth(`${cardLead}${controlPrefix}${status} ${glyph} `),
  );
  const visibleTitle = truncateDisplay(safeTitle, titleBudget);
  const fixedHeader = `${controlPrefix}${status} ${glyph} ${visibleTitle}`;
  const tailBudget = Math.max(0, termWidth - displayWidth(fixedHeader) - 10);
  const metaBudget = safeMeta ? Math.min(displayWidth(safeMeta), Math.floor(tailBudget * 0.36)) : 0;
  const visibleMeta =
    metaBudget >= 2 && safeMeta ? truncateDisplay(safeMeta, metaBudget) : undefined;
  const detailBudget = Math.max(0, tailBudget - (visibleMeta ? displayWidth(visibleMeta) + 5 : 0));
  const visibleDetail =
    detailBudget >= 2 && safeDetail ? truncateDisplay(safeDetail, detailBudget) : undefined;
  const railColor = ok ? theme.borderSubtle : theme.error;

  return (
    <Box flexDirection="column" marginY={0}>
      <Text>
        <Text color={railColor}>{cardLead}</Text>
        {viewMode ? (
          <>
            <Text color={viewMode === 'minimal' ? theme.borderSubtle : theme.textMuted}>
              {VIEW_CONTROL_LESS}
            </Text>
            <Text color={viewMode === 'full' ? theme.borderSubtle : theme.textMuted}>
              {VIEW_CONTROL_MORE}
            </Text>
          </>
        ) : null}
        <Text bold color={statusColor}>
          {status}
        </Text>
        <Text> </Text>
        <Text color={color}>{glyph}</Text>
        <Text> </Text>
        <Text bold color={theme.textPrimary}>
          {visibleTitle}
        </Text>
        {visibleDetail ? <Text color={theme.textSecondary}>{`  ${visibleDetail}`}</Text> : null}
        {visibleMeta ? <Text color={theme.textMuted}>{`  ·  ${visibleMeta}`}</Text> : null}
      </Text>
      {hasBody ? (
        <>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor={railColor}
            paddingLeft={1}
          >
            {children}
          </Box>
          <Text color={railColor}>{`╰${'─'.repeat(Math.max(2, termWidth - 1))}`}</Text>
        </>
      ) : null}
    </Box>
  );
}
