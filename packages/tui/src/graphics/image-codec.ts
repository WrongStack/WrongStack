import { inflateSync } from 'node:zlib';

/** Hard ceiling (4 MiB) for local image files inspected or rendered in TUI. */
export const MAX_TUI_IMAGE_INPUT_BYTES = 4 * 1024 * 1024;
/** Maximum Kitty base64 payload bytes per APC chunk (spec max: 4096). */
export const KITTY_BASE64_CHUNK_SIZE = 4096;

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export interface ImageHeaderInfo {
  format: ImageFormat;
  width: number;
  height: number;
  byteLength: number;
}

export interface ImageCellBox {
  cols: number;
  rows: number;
}

export interface HalfBlockCell {
  fg: string;
  bg: string;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function readU16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0);
}

function readU16LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] ?? 0) | ((buf[offset + 1] ?? 0) << 8);
}

function readU24LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] ?? 0) | ((buf[offset + 1] ?? 0) << 8) | ((buf[offset + 2] ?? 0) << 16);
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    (((buf[offset] ?? 0) << 24) |
      ((buf[offset + 1] ?? 0) << 16) |
      ((buf[offset + 2] ?? 0) << 8) |
      (buf[offset + 3] ?? 0)) >>>
    0
  );
}

/**
 * Pure TypeScript magic-byte & dimension inspector for PNG, JPEG, GIF, and WebP.
 * Rejects SVG, HTML/polyglot headers, truncated buffers, zero dimensions, and
 * inputs exceeding `maxBytes` (default 4 MiB).
 */
export function inspectImageHeader(
  buf: Uint8Array,
  maxBytes: number = MAX_TUI_IMAGE_INPUT_BYTES,
): ImageHeaderInfo | null {
  if (buf.byteLength < 10 || buf.byteLength > maxBytes) return null;

  // 1. PNG (`\x89PNG\r\n\x1a\n` + 4-byte len + `IHDR` + width + height)
  if (
    buf.byteLength >= 24 &&
    PNG_MAGIC.every((byte, idx) => buf[idx] === byte) &&
    buf[12] === 0x49 &&
    buf[13] === 0x48 &&
    buf[14] === 0x44 &&
    buf[15] === 0x52
  ) {
    const width = readU32BE(buf, 16);
    const height = readU32BE(buf, 20);
    if (width > 0 && height > 0 && width <= 32768 && height <= 32768) {
      return { format: 'png', width, height, byteLength: buf.byteLength };
    }
    return null;
  }

  // 2. GIF (`GIF87a` or `GIF89a`)
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    const width = readU16LE(buf, 6);
    const height = readU16LE(buf, 8);
    if (width > 0 && height > 0) {
      return { format: 'gif', width, height, byteLength: buf.byteLength };
    }
    return null;
  }

  // 3. WebP (`RIFF` .... `WEBP`)
  if (
    buf.byteLength >= 30 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    const chunkTag = String.fromCharCode(buf[12] ?? 0, buf[13] ?? 0, buf[14] ?? 0, buf[15] ?? 0);
    if (chunkTag === 'VP8X') {
      const width = 1 + readU24LE(buf, 24);
      const height = 1 + readU24LE(buf, 27);
      return width > 0 && height > 0
        ? { format: 'webp', width, height, byteLength: buf.byteLength }
        : null;
    }
    if (chunkTag === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const width = readU16LE(buf, 26) & 0x3fff;
      const height = readU16LE(buf, 28) & 0x3fff;
      return width > 0 && height > 0
        ? { format: 'webp', width, height, byteLength: buf.byteLength }
        : null;
    }
    if (chunkTag === 'VP8L' && buf[20] === 0x2f) {
      const b0 = buf[21] ?? 0;
      const b1 = buf[22] ?? 0;
      const b2 = buf[23] ?? 0;
      const b3 = buf[24] ?? 0;
      const width = 1 + (b0 | ((b1 & 0x3f) << 8));
      const height = 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
      return width > 0 && height > 0
        ? { format: 'webp', width, height, byteLength: buf.byteLength }
        : null;
    }
    return null;
  }

  // 4. JPEG (`\xff\xd8` SOI followed by marker segments)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < buf.byteLength) {
      if (buf[offset] !== 0xff) return null;
      while (offset < buf.byteLength && buf[offset] === 0xff) offset++;
      const marker = buf[offset];
      offset++;
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buf.byteLength) return null;
      const segLen = readU16BE(buf, offset);
      if (segLen < 2 || offset + segLen > buf.byteLength) return null;
      // Baseline / Extended / Progressive SOF markers
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (segLen < 7 || offset + 7 > buf.byteLength) return null;
        const height = readU16BE(buf, offset + 3);
        const width = readU16BE(buf, offset + 5);
        return width > 0 && height > 0
          ? { format: 'jpeg', width, height, byteLength: buf.byteLength }
          : null;
      }
      offset += segLen;
    }
  }

  return null;
}

/**
 * Compute deterministic `(cols, rows)` terminal cell dimensions preserving
 * aspect ratio assuming standard ~1:2 character cell width:height geometry.
 */
export function computeImageCellBox(
  widthPx: number,
  heightPx: number,
  maxCols: number,
  maxRows: number,
): ImageCellBox {
  const safeMaxCols = Math.max(4, Math.floor(maxCols));
  const safeMaxRows = Math.max(2, Math.floor(maxRows));
  if (widthPx <= 0 || heightPx <= 0) {
    return { cols: Math.min(16, safeMaxCols), rows: Math.min(8, safeMaxRows) };
  }
  // Each terminal cell is ~2x taller than wide, so 1 row covers ~2x the pixel
  // span of 1 column.
  const cellAspect = (widthPx / heightPx) * 2;
  let cols = safeMaxCols;
  let rows = Math.round(cols / cellAspect);
  if (rows > safeMaxRows) {
    rows = safeMaxRows;
    cols = Math.round(rows * cellAspect);
  }
  return {
    cols: Math.max(2, Math.min(safeMaxCols, cols)),
    rows: Math.max(1, Math.min(safeMaxRows, rows)),
  };
}

/**
 * Encode a PNG buffer (or raw RGBA buffer) using the Kitty Graphics Protocol.
 *
 * Enforces two non-negotiable safety invariants:
 *   - `q=2`: suppresses terminal `OK`/error stdin replies so responses never
 *     pollute Ink's raw input stream.
 *   - `C=1`: instructs the terminal not to move the cursor automatically so
 *     WrongStack's cell box reservation owns cursor advancement deterministically.
 */
export function encodeKittyGraphics(
  payload: Uint8Array,
  opts: {
    cols: number;
    rows: number;
    format?: 100 | 32 | undefined;
    pixelWidth?: number | undefined;
    pixelHeight?: number | undefined;
    imageId?: number | undefined;
  },
): string {
  const format = opts.format ?? 100;
  const b64 = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString(
    'base64',
  );
  const cols = Math.max(1, Math.floor(opts.cols));
  const rows = Math.max(1, Math.floor(opts.rows));
  const headerParts = [`a=T`, `f=${format}`, `c=${cols}`, `r=${rows}`, `C=1`, `q=2`];
  if (opts.imageId !== undefined && opts.imageId > 0) {
    headerParts.push(`i=${Math.floor(opts.imageId)}`);
  }
  if (format === 32 && opts.pixelWidth && opts.pixelHeight) {
    headerParts.push(`s=${Math.floor(opts.pixelWidth)}`, `v=${Math.floor(opts.pixelHeight)}`);
  }

  if (b64.length <= KITTY_BASE64_CHUNK_SIZE) {
    return `\x1b_G${headerParts.join(',')},m=0;${b64}\x1b\\`;
  }

  const out: string[] = [];
  for (let offset = 0; offset < b64.length; offset += KITTY_BASE64_CHUNK_SIZE) {
    const slice = b64.slice(offset, offset + KITTY_BASE64_CHUNK_SIZE);
    const hasMore = offset + KITTY_BASE64_CHUNK_SIZE < b64.length ? 1 : 0;
    if (offset === 0) {
      out.push(`\x1b_G${headerParts.join(',')},m=${hasMore};${slice}\x1b\\`);
    } else {
      out.push(`\x1b_Gm=${hasMore};${slice}\x1b\\`);
    }
  }
  return out.join('');
}

/**
 * Encode an image buffer using the iTerm2 `OSC 1337` inline image protocol
 * (supported by iTerm2, WezTerm, Warp, Rio, and Mintty).
 */
export function encodeIterm2Graphics(
  payload: Uint8Array,
  opts: {
    cols: number;
    rows: number;
    fileName?: string | undefined;
  },
): string {
  const b64 = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString(
    'base64',
  );
  const cols = Math.max(1, Math.floor(opts.cols));
  const rows = Math.max(1, Math.floor(opts.rows));
  const params = [
    `size=${payload.byteLength}`,
    `width=${cols}`,
    `height=${rows}`,
    `preserveAspectRatio=1`,
    `inline=1`,
  ];
  if (opts.fileName) {
    const safeName = Buffer.from(opts.fileName, 'utf8').toString('base64');
    params.unshift(`name=${safeName}`);
  }
  return `\x1b]1337;File=${params.join(';')}:${b64}\x07`;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Pure TypeScript + `node:zlib` non-interlaced 8-bit PNG decoder producing a
 * downsampled RGBA grid (`targetWidth × targetHeight × 4`).
 *
 * Supports color types 0 (grayscale), 2 (RGB), 3 (palette + optional tRNS),
 * 4 (grayscale+alpha), and 6 (RGBA). Returns `null` cleanly on interlaced,
 * 16-bit/sub-byte, or malformed inputs so callers fall back to metadata cards
 * without throwing.
 */
export function decodePngToRgbaThumbnail(
  pngBuf: Uint8Array,
  targetWidth: number,
  targetHeight: number,
): Uint8Array | null {
  const header = inspectImageHeader(pngBuf);
  if (header?.format !== 'png') return null;
  // Cap raw inflated scanline allocation (~32 MiB max, e.g. up to ~2800x2800 RGBA)
  if (header.width * header.height > 8_500_000) return null;

  const bitDepth = pngBuf[24] ?? 0;
  const colorType = pngBuf[25] ?? 0;
  const compression = pngBuf[26] ?? 0;
  const filterMethod = pngBuf[27] ?? 0;
  const interlace = pngBuf[28] ?? 0;
  if (bitDepth !== 8 || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    return null;
  }

  const channels =
    colorType === 6
      ? 4
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : colorType === 0 || colorType === 3
            ? 1
            : 0;
  if (channels === 0) return null;

  const idatChunks: Buffer[] = [];
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  let offset = 8;

  while (offset + 8 <= pngBuf.byteLength) {
    const chunkLen = readU32BE(pngBuf, offset);
    const type = String.fromCharCode(
      pngBuf[offset + 4] ?? 0,
      pngBuf[offset + 5] ?? 0,
      pngBuf[offset + 6] ?? 0,
      pngBuf[offset + 7] ?? 0,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLen;
    if (dataEnd + 4 > pngBuf.byteLength) return null;

    if (type === 'PLTE') {
      palette = pngBuf.subarray(dataStart, dataEnd);
    } else if (type === 'tRNS') {
      trns = pngBuf.subarray(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(pngBuf.buffer, pngBuf.byteOffset + dataStart, chunkLen));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (idatChunks.length === 0 || (colorType === 3 && !palette)) return null;

  const stride = header.width * channels;
  const expectedBytes = header.height * (1 + stride);
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedBytes + 64 });
  } catch {
    return null;
  }
  if (inflated.byteLength < expectedBytes) return null;

  const prevRow = new Uint8Array(stride);
  const currRow = new Uint8Array(stride);
  const outW = Math.max(1, Math.floor(targetWidth));
  const outH = Math.max(1, Math.floor(targetHeight));
  const out = new Uint8Array(outW * outH * 4);

  // Precompute nearest-neighbor source Y rows so we only sample needed scanlines
  // while still running the sequential PNG row filter accurately.
  let nextSampleIdx = 0;
  const sampleYs = new Int32Array(outH);
  for (let ty = 0; ty < outH; ty++) {
    sampleYs[ty] = Math.min(header.height - 1, Math.floor(((ty + 0.5) * header.height) / outH));
  }

  for (let y = 0; y < header.height; y++) {
    const rowBase = y * (1 + stride);
    const filterType = inflated[rowBase] ?? 0;
    for (let i = 0; i < stride; i++) {
      const raw = inflated[rowBase + 1 + i] ?? 0;
      const left = i >= channels ? (currRow[i - channels] ?? 0) : 0;
      const up = prevRow[i] ?? 0;
      const upLeft = i >= channels ? (prevRow[i - channels] ?? 0) : 0;
      let val = raw;
      if (filterType === 1) val = (raw + left) & 0xff;
      else if (filterType === 2) val = (raw + up) & 0xff;
      else if (filterType === 3) val = (raw + ((left + up) >>> 1)) & 0xff;
      else if (filterType === 4) val = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      else if (filterType !== 0) return null;
      currRow[i] = val;
    }

    while (nextSampleIdx < outH && sampleYs[nextSampleIdx] === y) {
      const ty = nextSampleIdx;
      for (let tx = 0; tx < outW; tx++) {
        const sx = Math.min(header.width - 1, Math.floor(((tx + 0.5) * header.width) / outW));
        const srcIdx = sx * channels;
        const dstIdx = (ty * outW + tx) * 4;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 255;

        if (colorType === 6) {
          r = currRow[srcIdx] ?? 0;
          g = currRow[srcIdx + 1] ?? 0;
          b = currRow[srcIdx + 2] ?? 0;
          a = currRow[srcIdx + 3] ?? 255;
        } else if (colorType === 2) {
          r = currRow[srcIdx] ?? 0;
          g = currRow[srcIdx + 1] ?? 0;
          b = currRow[srcIdx + 2] ?? 0;
        } else if (colorType === 0) {
          r = g = b = currRow[srcIdx] ?? 0;
        } else if (colorType === 4) {
          r = g = b = currRow[srcIdx] ?? 0;
          a = currRow[srcIdx + 1] ?? 255;
        } else if (colorType === 3 && palette) {
          const pIdx = currRow[srcIdx] ?? 0;
          r = palette[pIdx * 3] ?? 0;
          g = palette[pIdx * 3 + 1] ?? 0;
          b = palette[pIdx * 3 + 2] ?? 0;
          if (trns && pIdx < trns.byteLength) a = trns[pIdx] ?? 255;
        }

        // Composite semi-transparent pixels over dark neutral slate (#1e222a)
        if (a < 255) {
          const inv = 255 - a;
          r = Math.round((r * a + 30 * inv) / 255);
          g = Math.round((g * a + 34 * inv) / 255);
          b = Math.round((b * a + 42 * inv) / 255);
        }

        out[dstIdx] = r;
        out[dstIdx + 1] = g;
        out[dstIdx + 2] = b;
        out[dstIdx + 3] = 255;
      }
      nextSampleIdx++;
    }

    prevRow.set(currRow);
  }

  return out;
}

function rgbHex(r: number, g: number, b: number): string {
  const hex = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/**
 * Convert an RGBA pixel buffer (`width × height`) into rows of Unicode half-block
 * (`▀`) `{ fg, bg }` color pairs. Each terminal row encodes 2 vertical pixel rows.
 */
export function buildHalfBlockGrid(
  rgba: Uint8Array,
  width: number,
  height: number,
): HalfBlockCell[][] {
  const rows: HalfBlockCell[][] = [];
  for (let y = 0; y < height; y += 2) {
    const line: HalfBlockCell[] = [];
    const bottomY = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const topIdx = (y * width + x) * 4;
      const botIdx = (bottomY * width + x) * 4;
      line.push({
        fg: rgbHex(rgba[topIdx] ?? 0, rgba[topIdx + 1] ?? 0, rgba[topIdx + 2] ?? 0),
        bg: rgbHex(rgba[botIdx] ?? 0, rgba[botIdx + 1] ?? 0, rgba[botIdx + 2] ?? 0),
      });
    }
    rows.push(line);
  }
  return rows;
}
