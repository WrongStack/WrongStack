import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { TerminalCapability } from '@wrongstack/core/utils';
import { toErrorMessage } from '@wrongstack/core/utils';
import type React from 'react';
import { useEffect, useId, useMemo, useState } from 'react';
import {
  buildHalfBlockGrid,
  computeImageCellBox,
  decodePngToRgbaThumbnail,
  type HalfBlockCell,
  type ImageHeaderInfo,
  inspectImageHeader,
  MAX_TUI_IMAGE_INPUT_BYTES,
} from '../graphics/image-codec.js';
import {
  encodeNativeTerminalImage,
  getRuntimeGraphicsOverride,
  resolveEffectiveGraphicsProtocol,
  subscribeRuntimeGraphicsOverride,
} from '../graphics/image-preview-cache.js';
import { Box, Text, useInput, useStdout } from '../ink.js';
import { sanitizeTerminalText } from '../terminal-width.js';
import { fmtBytes } from './history/basic-format.js';
import { useMonitorSize } from './monitor-shell.js';

export interface ImagePreviewModalProps {
  filePath: string;
  capability?: TerminalCapability | undefined;
  onClose: () => void;
}

interface LoadedImageBuffer {
  bytes: Uint8Array;
  header: ImageHeaderInfo;
}

/**
 * Interactive pinned lightbox modal for `/image <path>`.
 * Uses native Kitty APC or iTerm2 OSC 1337 inside this modal (with deterministic
 * Kitty image-slot cleanup on unmount) and falls back to an enlarged 24-bit
 * Unicode half-block (`▀`) preview on universal terminals.
 */
export function ImagePreviewModal({
  filePath,
  capability,
  onClose,
}: ImagePreviewModalProps): React.ReactElement {
  const size = useMonitorSize();
  const { stdout } = useStdout();
  const reactId = useId();
  const kittyImageId = useMemo(() => {
    let hash = 2166136261;
    for (let i = 0; i < reactId.length; i += 1) {
      hash ^= reactId.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 1_000_000) + 1;
  }, [reactId]);

  const [loaded, setLoaded] = useState<LoadedImageBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    void readFile(filePath)
      .then((buf) => {
        if (cancelled) return;
        if (buf.byteLength > MAX_TUI_IMAGE_INPUT_BYTES) {
          setError(
            `Image exceeds ${fmtBytes(MAX_TUI_IMAGE_INPUT_BYTES)} limit (${fmtBytes(buf.byteLength)}).`,
          );
          return;
        }
        const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const header = inspectImageHeader(bytes);
        if (!header) {
          setError('Unsupported image format (expected PNG, JPEG, GIF, or WebP).');
          return;
        }
        setLoaded({ bytes, header });
      })
      .catch((err) => {
        if (!cancelled) setError(toErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const [graphicsMode, setGraphicsMode] = useState(getRuntimeGraphicsOverride);
  useEffect(() => {
    setGraphicsMode(getRuntimeGraphicsOverride());
    return subscribeRuntimeGraphicsOverride(() => {
      setGraphicsMode(getRuntimeGraphicsOverride());
    });
  }, []);

  const protocol = useMemo(
    () => resolveEffectiveGraphicsProtocol(capability?.graphicsProtocol),
    [capability?.graphicsProtocol, graphicsMode],
  );
  const maxCols = Math.max(16, Math.min(64, size.columns - 6));
  const maxRows = Math.max(6, Math.min(20, Math.floor((size.rows || 24) * 0.6)));
  const fileName = path.basename(filePath);

  const nativePayload = useMemo(() => {
    if (!loaded || (protocol !== 'kitty' && protocol !== 'iterm2')) return null;
    return encodeNativeTerminalImage(loaded.bytes, protocol, {
      maxCols: Math.min(maxCols, 48),
      maxRows,
      fileName,
      imageId: kittyImageId,
    });
  }, [loaded, protocol, maxCols, maxRows, fileName, kittyImageId]);

  useEffect(() => {
    if (!nativePayload) return undefined;
    try {
      stdout.write(nativePayload.sequence);
    } catch {
      // Ignore stdout write errors during teardown.
    }
    return () => {
      if (protocol === 'kitty') {
        try {
          stdout.write(`\x1b_Ga=d,d=i,i=${kittyImageId},q=2\x1b\\`);
        } catch {
          // Best-effort Kitty slot cleanup.
        }
      }
    };
  }, [nativePayload, protocol, kittyImageId, stdout]);

  const halfBlocks = useMemo<HalfBlockCell[][] | null>(() => {
    if (!loaded || nativePayload || protocol === 'none') return null;
    if (loaded.header.format !== 'png') return null;
    const { cols, rows } = computeImageCellBox(
      loaded.header.width,
      loaded.header.height,
      maxCols,
      maxRows,
    );
    const decoded = decodePngToRgbaThumbnail(loaded.bytes, cols, rows * 2);
    if (!decoded) return null;
    return buildHalfBlockGrid(decoded, cols, rows * 2);
  }, [loaded, nativePayload, protocol, maxCols, maxRows]);

  useInput((input, key) => {
    if (key.escape || (!key.ctrl && !key.meta && input === 'q')) {
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={Math.max(36, size.columns - 2)}
    >
      <Text bold color="cyan" wrap="truncate-end">
        ━━ Image Preview · {sanitizeTerminalText(fileName)} ━━
      </Text>
      <Text dimColor wrap="truncate-end">
        {loaded
          ? `${loaded.header.width}×${loaded.header.height} ${loaded.header.format.toUpperCase()} · ${fmtBytes(loaded.header.byteLength)} · protocol: ${protocol} · Esc / q close`
          : 'Esc / q close'}
      </Text>
      {error ? (
        <Text color="red" wrap="truncate-end">
          {error}
        </Text>
      ) : !loaded ? (
        <Text dimColor>Loading image…</Text>
      ) : nativePayload ? (
        <Box height={nativePayload.rows} width={nativePayload.cols} flexDirection="column">
          <Text dimColor>[native {protocol} canvas]</Text>
        </Box>
      ) : halfBlocks && halfBlocks.length > 0 ? (
        <Box flexDirection="column" marginTop={0}>
          {halfBlocks.map((row, rowIdx) => (
            <Text key={rowIdx}>
              {row.map((cell, colIdx) => (
                <Text key={colIdx} color={cell.fg} backgroundColor={cell.bg}>
                  {'▀'}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      ) : (
        <Text dimColor>
          Inline raster preview requires PNG on half-block terminals or a Kitty/iTerm2 terminal.
        </Text>
      )}
    </Box>
  );
}
