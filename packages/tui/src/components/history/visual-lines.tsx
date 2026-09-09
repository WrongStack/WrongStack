import type React from 'react';
import { Text } from '../../ink.js';
import { sanitizeTerminalText, truncateDisplay } from '../../terminal-width.js';
import { theme } from '../../theme.js';
import { shortenPath } from './basic-format.js';
import type { ToolVisualLine, ToolVisualLineKind } from './tool-visual-types.js';

const VISUAL_TEXT_BUDGET = 92;

export function ToolOutputLines({
  lines,
}: {
  lines: ToolVisualLine[];
  hasFollowingBlock?: boolean | undefined;
}): React.ReactElement {
  return (
    <>
      {lines.map((line, i) => {
        const branch = '  ';
        const color = colorForVisualKind(line.kind);
        return (
          <Text key={`${line.kind}-${i}`}>
            <Text dimColor>{branch}</Text>
            {line.marker ? (
              <Text color={color} bold>
                {line.marker}
              </Text>
            ) : null}
            {line.path ? (
              <>
                <Text color={theme.accent}>{shortenPath(sanitizeTerminalText(line.path), 56)}</Text>
                <Text dimColor>{'  '}</Text>
              </>
            ) : null}
            {line.lineNo ? (
              <>
                <Text color={theme.warn}>{String(line.lineNo).padStart(4, ' ')}</Text>
                <Text dimColor>{' │ '}</Text>
              </>
            ) : null}
            <Text color={color} dimColor={line.kind === 'meta' || line.kind === 'stdout'}>
              {truncateDisplay(sanitizeTerminalText(line.text), VISUAL_TEXT_BUDGET)}
            </Text>
          </Text>
        );
      })}
    </>
  );
}

function colorForVisualKind(kind: ToolVisualLineKind): string | undefined {
  switch (kind) {
    case 'ok':
      return theme.success;
    case 'warn':
      return theme.warn;
    case 'error':
    case 'stderr':
      return theme.error;
    case 'path':
    case 'match':
      return theme.accent;
    case 'code':
      return theme.textPrimary;
    case 'stdout':
    case 'meta':
      return undefined;
  }
}
