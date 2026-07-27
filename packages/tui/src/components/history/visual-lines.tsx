import type React from 'react';
import { Text } from '../../ink.js';
import { shortenPath, truncMid } from './basic-format.js';
import type { ToolVisualLine, ToolVisualLineKind } from './tool-visual-types.js';

const VISUAL_TEXT_BUDGET = 92;

export function ToolOutputLines({
  lines,
  hasFollowingBlock,
}: {
  lines: ToolVisualLine[];
  hasFollowingBlock?: boolean | undefined;
}): React.ReactElement {
  return (
    <>
      {lines.map((line, i) => {
        const branch = i === lines.length - 1 && !hasFollowingBlock ? '  └─ ' : '  ├─ ';
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
                <Text color="cyan">{shortenPath(line.path, 56)}</Text>
                <Text dimColor>{'  '}</Text>
              </>
            ) : null}
            {line.lineNo ? (
              <>
                <Text color="yellow">{String(line.lineNo).padStart(4, ' ')}</Text>
                <Text dimColor>{' │ '}</Text>
              </>
            ) : null}
            <Text color={color} dimColor={line.kind === 'meta' || line.kind === 'stdout'}>
              {truncMid(line.text, VISUAL_TEXT_BUDGET)}
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
      return 'green';
    case 'warn':
      return 'yellow';
    case 'error':
    case 'stderr':
      return 'red';
    case 'path':
    case 'match':
      return 'cyan';
    case 'code':
      return 'white';
    case 'stdout':
    case 'meta':
      return undefined;
  }
}
