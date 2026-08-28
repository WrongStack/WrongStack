import type React from 'react';
import { Box, Text } from '../../ink.js';
import { displayWidth, sanitizeTerminalText, truncateDisplay } from '../../terminal-width.js';
import { theme } from '../../theme.js';
import { glyphs } from '../../ui-glyphs.js';

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
}: ToolCardProps): React.ReactElement {
  const safeTitle = sanitizeTerminalText(title);
  const safeDetail = detail ? sanitizeTerminalText(detail) : undefined;
  const safeMeta = meta ? sanitizeTerminalText(meta) : undefined;
  const status = ok ? glyphs.success : glyphs.failure;
  const statusColor = ok ? theme.success : theme.error;
  const titleBudget = Math.max(1, termWidth - displayWidth(`╭─ ${status} ${glyph} `));
  const visibleTitle = truncateDisplay(safeTitle, titleBudget);
  const fixedHeader = `${status} ${glyph} ${visibleTitle}`;
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
        <Text color={railColor}>╭─ </Text>
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
