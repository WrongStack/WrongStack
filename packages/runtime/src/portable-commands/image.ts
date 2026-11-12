import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/contracts/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import type { SessionCommandHost } from './host.js';

export interface ImageCommandHost {
  projectRoot?: string | undefined;
  cwd?: string | undefined;
  onPanelOpen?: SessionCommandHost['onPanelOpen'];
  /** Optional accessor returning the most recently rendered tool image path (e.g. screenshot). */
  getLastImagePath?: (() => string | null | undefined) | undefined;
}

export interface LocalImageInspection {
  resolvedPath: string;
  relativePath: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  byteLength: number;
  width?: number | undefined;
  height?: number | undefined;
}

export const IMAGE_COMMAND_DESCRIPTION =
  'Inspect or preview a workspace image inline in the terminal.';

export const IMAGE_COMMAND_ARGS_HINT = '[<path>] [--info]';

export const IMAGE_COMMAND_HELP = [
  'Usage:',
  '  /image                Re-open the latest tool screenshot/image in the TUI preview modal',
  '  /image <path>         Open an interactive inline image preview modal in the TUI (or inspect metadata)',
  '  /image <path> --info  Print image format, pixel dimensions, and byte size without opening a modal',
].join('\n');

const MAX_INSPECT_IMAGE_BYTES = 20 * 1024 * 1024;

function parseHeaderDimensions(buf: Buffer): {
  mimeType: LocalImageInspection['mimeType'];
  width?: number | undefined;
  height?: number | undefined;
} | null {
  // PNG
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return {
      mimeType: 'image/png',
      ...(width > 0 && height > 0 ? { width, height } : {}),
    };
  }
  // GIF
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return {
      mimeType: 'image/gif',
      ...(width > 0 && height > 0 ? { width, height } : {}),
    };
  }
  // WebP
  if (
    buf.length >= 30 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { mimeType: 'image/webp', width, height };
    }
    return { mimeType: 'image/webp' };
  }
  // JPEG
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1]!;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2 || offset + 2 + segLen > buf.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return {
          mimeType: 'image/jpeg',
          ...(width > 0 && height > 0 ? { width, height } : {}),
        };
      }
      offset += 2 + segLen;
    }
    return { mimeType: 'image/jpeg' };
  }
  return null;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function inspectLocalImageFile(
  rawPath: string,
  opts: { projectRoot: string; cwd?: string | undefined },
): Promise<LocalImageInspection> {
  const trimmed = rawPath.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) {
    throw new Error('Image path is required.');
  }
  const realRoot = await realpath(opts.projectRoot);
  const baseDir = opts.cwd ? await realpath(opts.cwd).catch(() => realRoot) : realRoot;
  const candidate = path.resolve(baseDir, trimmed);
  const realCandidate = await realpath(candidate);
  if (!isWithinRoot(realCandidate, realRoot)) {
    throw new Error(`Refusing to read image outside project root: "${trimmed}"`);
  }

  const info = await stat(realCandidate);
  if (!info.isFile()) {
    throw new Error(`Not a regular file: "${trimmed}"`);
  }
  if (info.size > MAX_INSPECT_IMAGE_BYTES) {
    throw new Error(
      `Image exceeds 20 MiB preview limit (${(info.size / (1024 * 1024)).toFixed(1)} MiB).`,
    );
  }

  const { open } = await import('node:fs/promises');
  const fh = await open(realCandidate, 'r');
  try {
    const headerBuf = Buffer.alloc(Math.min(info.size, 65_536));
    const { bytesRead } = await fh.read(headerBuf, 0, headerBuf.length, 0);
    const parsed = parseHeaderDimensions(headerBuf.subarray(0, bytesRead));
    if (!parsed) {
      throw new Error(
        `Unsupported or unrecognized image header in "${trimmed}" (expected PNG, JPEG, GIF, or WebP).`,
      );
    }
    return {
      resolvedPath: realCandidate,
      relativePath: path.relative(realRoot, realCandidate).replaceAll('\\', '/'),
      mimeType: parsed.mimeType,
      byteLength: info.size,
      width: parsed.width,
      height: parsed.height,
    };
  } finally {
    await fh.close();
  }
}

export function buildImageCommand(host: ImageCommandHost): SlashCommand {
  return {
    name: 'image',
    category: 'Inspect',
    description: IMAGE_COMMAND_DESCRIPTION,
    argsHint: IMAGE_COMMAND_ARGS_HINT,
    help: IMAGE_COMMAND_HELP,
    async run(rawArgs) {
      const trimmed = rawArgs.trim();
      if (trimmed === 'help' || trimmed === '--help' || trimmed === '-h') {
        return { message: IMAGE_COMMAND_HELP };
      }

      const tokens = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
      const infoOnly = tokens.includes('--info');
      const pathArgs = tokens.filter((t) => t !== '--info');
      const targetArg = pathArgs.join(' ') || host.getLastImagePath?.()?.trim() || '';
      if (!targetArg) {
        return { message: IMAGE_COMMAND_HELP };
      }
      const projectRoot = host.projectRoot ?? host.cwd ?? process.cwd();

      try {
        const meta = await inspectLocalImageFile(targetArg, {
          projectRoot,
          cwd: host.cwd,
        });

        if (!infoOnly && host.onPanelOpen?.current?.(`image:${meta.resolvedPath}`)) {
          return {};
        }

        const dims =
          meta.width && meta.height ? `${meta.width}×${meta.height}px` : 'dimensions n/a';
        const kb =
          meta.byteLength >= 1024
            ? `${(meta.byteLength / 1024).toFixed(1)} KiB`
            : `${meta.byteLength} B`;
        return {
          message: [
            `${color.cyan('▣ Image:')} ${color.bold(meta.relativePath || path.basename(meta.resolvedPath))}`,
            `  Format: ${meta.mimeType} · ${dims} · ${kb}`,
          ].join('\n'),
        };
      } catch (err) {
        return {
          message: color.red(`Image preview error: ${toErrorMessage(err)}`),
        };
      }
    },
  };
}
