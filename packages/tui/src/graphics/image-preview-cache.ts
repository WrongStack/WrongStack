import { readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isFrugalPerf, type TerminalGraphicsProtocol } from '@wrongstack/core/utils';
import {
  buildHalfBlockGrid,
  computeImageCellBox,
  decodePngToRgbaThumbnail,
  encodeIterm2Graphics,
  encodeKittyGraphics,
  type HalfBlockCell,
  type ImageHeaderInfo,
  inspectImageHeader,
  MAX_TUI_IMAGE_INPUT_BYTES,
} from './image-codec.js';

const IMAGE_TOOL_NAMES = new Set(['browser_screenshot', 'image_generate', 'present_artifact']);

const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** Maximum cached decoded previews retained in TUI heap (`bench:tui-heap` guard). */
export const MAX_IMAGE_PREVIEW_CACHE_ENTRIES = 8;

export interface CachedImagePreview {
  path: string;
  fileName: string;
  header: ImageHeaderInfo;
  cols: number;
  rows: number;
  halfBlocks: HalfBlockCell[][] | null;
}

export type RuntimeGraphicsMode = 'auto' | 'kitty' | 'iterm2' | 'halfblock' | 'off';

const previewCache = new Map<string, CachedImagePreview | null>();
let lastPreviewedImagePath: string | null = null;
let runtimeGraphicsOverride: RuntimeGraphicsMode = 'auto';
const graphicsOverrideListeners = new Set<() => void>();

export function clearImagePreviewCache(): void {
  previewCache.clear();
  lastPreviewedImagePath = null;
}

export function getLastPreviewedImagePath(): string | null {
  return lastPreviewedImagePath;
}

export function getImagePreviewCacheSize(): number {
  return previewCache.size;
}

export function getRuntimeGraphicsOverride(): RuntimeGraphicsMode {
  return runtimeGraphicsOverride;
}

export function setRuntimeGraphicsOverride(mode: RuntimeGraphicsMode): void {
  if (runtimeGraphicsOverride === mode) return;
  runtimeGraphicsOverride = mode;
  if (mode === 'off') {
    clearImagePreviewCache();
  }
  for (const listener of graphicsOverrideListeners) {
    try {
      listener();
    } catch {
      // Never allow observer errors to disrupt settings updates.
    }
  }
}

export function subscribeRuntimeGraphicsOverride(listener: () => void): () => void {
  graphicsOverrideListeners.add(listener);
  return () => {
    graphicsOverrideListeners.delete(listener);
  };
}

export function parseRuntimeGraphicsMode(raw: string): RuntimeGraphicsMode | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'on' || normalized === 'default') return 'auto';
  if (normalized === 'off' || normalized === 'none' || normalized === 'false' || normalized === '0')
    return 'off';
  if (normalized === 'kitty' || normalized === 'iterm2' || normalized === 'halfblock') {
    return normalized;
  }
  return null;
}

export function resolveEffectiveGraphicsProtocol(
  capabilityProtocol?: TerminalGraphicsProtocol | undefined,
): TerminalGraphicsProtocol {
  if (runtimeGraphicsOverride === 'off') return 'none';
  if (runtimeGraphicsOverride !== 'auto') return runtimeGraphicsOverride;
  const envVal = process.env.WRONGSTACK_TUI_GRAPHICS?.trim().toLowerCase();
  if (envVal === 'off' || envVal === 'none' || envVal === '0' || envVal === 'false') {
    return 'none';
  }
  if (envVal === 'kitty' || envVal === 'iterm2' || envVal === 'halfblock') {
    return envVal;
  }
  return capabilityProtocol ?? 'halfblock';
}

function isImagePathCandidate(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string') return false;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > 1024 || trimmed.includes('\0')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false; // Never fetch remote URLs
  const ext = extname(trimmed).toLowerCase();
  return ALLOWED_IMAGE_EXTS.has(ext);
}

/**
 * Extract a local image artifact path from image-producing tool outputs/inputs.
 * Never resolves URLs or untrusted arbitrary tool names.
 */
export function extractToolImageArtifactPath(
  toolName: string,
  output: string | undefined,
  input?: unknown,
): string | null {
  if (!IMAGE_TOOL_NAMES.has(toolName)) return null;

  if (output) {
    const trimmed = output.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          toolName === 'present_artifact' &&
          typeof parsed['kind'] === 'string' &&
          parsed['kind'] !== 'image'
        ) {
          return null;
        }
        for (const key of ['path', 'filePath', 'outputPath', 'imagePath', 'artifactPath']) {
          const val = parsed[key];
          if (isImagePathCandidate(val)) return val.trim();
        }
        const files = parsed['files'];
        if (Array.isArray(files)) {
          for (const entry of files) {
            if (entry && typeof entry === 'object') {
              const fileVal = (entry as Record<string, unknown>)['path'];
              if (isImagePathCandidate(fileVal)) return fileVal.trim();
            }
          }
        }
      } catch {
        // Fall through to compact serializer line scan.
      }
    }
    for (const line of trimmed.split(/\r?\n/u)) {
      const m = /^\s*(?:path|file|saved(?:\s+(?:to|as))?|artifact)\s*:\s*(.+?)\s*$/iu.exec(line);
      if (m && isImagePathCandidate(m[1])) {
        return m[1].trim();
      }
    }
  }

  if (
    (toolName === 'present_artifact' || toolName === 'image_generate') &&
    input &&
    typeof input === 'object'
  ) {
    const rec = input as Record<string, unknown>;
    for (const key of ['path', 'filePath']) {
      if (isImagePathCandidate(rec[key])) return rec[key].trim();
    }
  }

  return null;
}

function resolveContainedImagePath(rawPath: string, projectRoot?: string): string | null {
  if (!isImagePathCandidate(rawPath)) return null;
  if (isAbsolute(rawPath)) return rawPath;
  const root = resolve(projectRoot ?? process.cwd());
  const target = resolve(root, rawPath);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return target;
}

/**
 * Load, validate, and decode a bounded terminal preview for a local image file.
 * Uses an 8-slot LRU cache keyed by `(absolutePath, mtimeMs, maxCols, maxRows)`.
 */
export function loadCachedImagePreview(
  filePath: string,
  opts: {
    maxCols?: number | undefined;
    maxRows?: number | undefined;
    projectRoot?: string | undefined;
  } = {},
): CachedImagePreview | null {
  if (isFrugalPerf() || resolveEffectiveGraphicsProtocol() === 'none') return null;
  const resolvedPath = resolveContainedImagePath(filePath, opts.projectRoot);
  if (!resolvedPath) return null;
  const maxCols = Math.max(8, Math.min(72, Math.floor(opts.maxCols ?? 44)));
  const maxRows = Math.max(2, Math.min(16, Math.floor(opts.maxRows ?? 10)));

  let mtimeMs = 0;
  let byteSize = 0;
  try {
    const st = statSync(resolvedPath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_TUI_IMAGE_INPUT_BYTES) return null;
    mtimeMs = st.mtimeMs;
    byteSize = st.size;
  } catch {
    return null;
  }

  const cacheKey = `${resolvedPath}|${mtimeMs}|${byteSize}|${maxCols}x${maxRows}`;
  if (previewCache.has(cacheKey)) {
    const hit = previewCache.get(cacheKey) ?? null;
    // Refresh LRU order
    previewCache.delete(cacheKey);
    previewCache.set(cacheKey, hit);
    if (hit) lastPreviewedImagePath = hit.path;
    return hit;
  }

  let preview: CachedImagePreview | null = null;
  try {
    const raw = readFileSync(resolvedPath);
    const header = inspectImageHeader(raw);
    if (header) {
      const box = computeImageCellBox(header.width, header.height, maxCols, maxRows);
      let halfBlocks: HalfBlockCell[][] | null = null;
      if (header.format === 'png') {
        const rgba = decodePngToRgbaThumbnail(raw, box.cols, box.rows * 2);
        if (rgba) {
          halfBlocks = buildHalfBlockGrid(rgba, box.cols, box.rows * 2);
        }
      }
      preview = {
        path: resolvedPath,
        fileName: basename(resolvedPath),
        header,
        cols: box.cols,
        rows: box.rows,
        halfBlocks,
      };
    }
  } catch {
    preview = null;
  }

  if (previewCache.size >= MAX_IMAGE_PREVIEW_CACHE_ENTRIES) {
    const oldestKey = previewCache.keys().next().value;
    if (oldestKey !== undefined) previewCache.delete(oldestKey);
  }
  previewCache.set(cacheKey, preview);
  if (preview) lastPreviewedImagePath = preview.path;
  return preview;
}

/**
 * Encode a verified local image buffer for native pixel-protocol display
 * (Kitty `APC G` or iTerm2 `OSC 1337`), returning `null` when unsupported.
 */
export function encodeNativeTerminalImage(
  raw: Uint8Array,
  protocol: TerminalGraphicsProtocol,
  opts: {
    maxCols: number;
    maxRows: number;
    fileName?: string | undefined;
    imageId?: number | undefined;
  },
): { sequence: string; header: ImageHeaderInfo; cols: number; rows: number } | null {
  const header = inspectImageHeader(raw);
  if (!header) return null;
  const { cols, rows } = computeImageCellBox(
    header.width,
    header.height,
    opts.maxCols,
    opts.maxRows,
  );
  if (protocol === 'kitty' && header.format === 'png') {
    return {
      sequence: encodeKittyGraphics(raw, {
        cols,
        rows,
        format: 100,
        imageId: opts.imageId,
      }),
      header,
      cols,
      rows,
    };
  }
  if (protocol === 'iterm2') {
    return {
      sequence: encodeIterm2Graphics(raw, {
        cols,
        rows,
        fileName: opts.fileName,
      }),
      header,
      cols,
      rows,
    };
  }
  return null;
}
