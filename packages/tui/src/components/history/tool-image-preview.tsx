import type React from 'react';
import { useMemo } from 'react';
import {
  extractToolImageArtifactPath,
  loadCachedImagePreview,
} from '../../graphics/image-preview-cache.js';
import { Box, Text } from '../../ink.js';
import { sanitizeTerminalText } from '../../terminal-width.js';
import { fmtBytes } from './basic-format.js';

export function ToolImagePreview({
  toolName,
  output,
  input,
  termWidth,
  useTruecolor,
}: {
  toolName: string;
  output: string | undefined;
  input?: unknown;
  termWidth: number;
  useTruecolor: boolean;
}): React.ReactElement | null {
  const preview = useMemo(() => {
    const artifactPath = extractToolImageArtifactPath(toolName, output, input);
    if (!artifactPath) return null;
    const maxCols = Math.max(12, Math.min(48, termWidth - 8));
    return loadCachedImagePreview(artifactPath, { maxCols, maxRows: 10 });
  }, [toolName, output, input, termWidth]);

  if (!preview) return null;

  const metaLabel = `${sanitizeTerminalText(preview.fileName)} · ${preview.header.width}×${preview.header.height} ${preview.header.format.toUpperCase()} · ${fmtBytes(preview.header.byteLength)}`;

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0}>
      <Text dimColor>{`🖼 ${metaLabel}`}</Text>
      {useTruecolor && preview.halfBlocks
        ? preview.halfBlocks.map((row, rowIdx) => (
            <Text key={rowIdx}>
              {row.map((cell, colIdx) => (
                <Text key={colIdx} color={cell.fg} backgroundColor={cell.bg}>
                  {'▀'}
                </Text>
              ))}
            </Text>
          ))
        : null}
    </Box>
  );
}
