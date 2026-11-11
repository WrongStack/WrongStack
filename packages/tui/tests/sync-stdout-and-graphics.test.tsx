import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolImagePreview } from '../src/components/history/tool-image-preview.js';
import {
  buildHalfBlockGrid,
  computeImageCellBox,
  decodePngToRgbaThumbnail,
  encodeIterm2Graphics,
  encodeKittyGraphics,
  inspectImageHeader,
  KITTY_BASE64_CHUNK_SIZE,
} from '../src/graphics/image-codec.js';
import {
  clearImagePreviewCache,
  encodeNativeTerminalImage,
  extractToolImageArtifactPath,
  getImagePreviewCacheSize,
  loadCachedImagePreview,
  MAX_IMAGE_PREVIEW_CACHE_ENTRIES,
} from '../src/graphics/image-preview-cache.js';
import { createSynchronizedStdout, stripTerminalGraphicsResponses } from '../src/sync-stdout.js';
import { SYNC_OUTPUT_OFF, SYNC_OUTPUT_ON } from '../src/terminal-modes.js';

function makePngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.byteLength, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); // CRC is not required by header/zlib decoder
  return Buffer.concat([len, typeBuf, Buffer.from(data), crc]);
}

function createSolidRgbaPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const rawScanlines = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const base = y * (1 + stride);
    rawScanlines[base] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const px = base + 1 + x * 4;
      rawScanlines[px] = rgba[0];
      rawScanlines[px + 1] = rgba[1];
      rawScanlines[px + 2] = rgba[2];
      rawScanlines[px + 3] = rgba[3];
    }
  }
  const compressed = deflateSync(rawScanlines);
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', new Uint8Array(0)),
  ]);
}

describe('Synchronized output stream (DECSET 2026)', () => {
  it('coalesces multiple synchronous writes into one BSU/ESU frame per microtask', async () => {
    const chunks: Buffer[] = [];
    const target = {
      columns: 120,
      rows: 40,
      isTTY: true,
      write: vi.fn((chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return true;
      }),
    } as unknown as NodeJS.WriteStream;

    const sync = createSynchronizedStdout(target, { enabled: true });
    expect(sync.stream.columns).toBe(120);

    sync.stream.write('\x1b[J');
    sync.stream.write('frame-line-1\n');
    sync.stream.write('frame-line-2\n');

    // Still buffered prior to microtask drain
    expect(chunks).toHaveLength(0);

    await Promise.resolve();

    expect(chunks).toHaveLength(1);
    const wire = chunks[0]?.toString('utf8') ?? '';
    expect(wire.startsWith(SYNC_OUTPUT_ON)).toBe(true);
    expect(wire.endsWith(SYNC_OUTPUT_OFF)).toBe(true);
    expect(wire).toBe(`${SYNC_OUTPUT_ON}\x1b[Jframe-line-1\nframe-line-2\n${SYNC_OUTPUT_OFF}`);
  });

  it('flushes immediately when batch exceeds maxBatchBytes and flushes remaining on dispose', () => {
    const chunks: string[] = [];
    const target = {
      write: vi.fn((chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
        return true;
      }),
    } as unknown as NodeJS.WriteStream;

    const sync = createSynchronizedStdout(target, { enabled: true, maxBatchBytes: 4096 });
    const bigPayload = 'x'.repeat(4100);
    sync.stream.write(bigPayload);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(`${SYNC_OUTPUT_ON}${bigPayload}${SYNC_OUTPUT_OFF}`);

    sync.stream.write('tail');
    expect(chunks).toHaveLength(1);
    sync.dispose();
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe(`${SYNC_OUTPUT_ON}tail${SYNC_OUTPUT_OFF}`);
  });

  it('strips stray Kitty APC replies from stdin without altering normal input', () => {
    expect(stripTerminalGraphicsResponses('hello\x03')).toBe('hello\x03');
    expect(stripTerminalGraphicsResponses('ab\x1b_Gi=12;OK\x1b\\cd')).toBe('abcd');
    const bufRes = stripTerminalGraphicsResponses(Buffer.from('\x1b_Gi=1;ENOENT:missing\x1b\\y'));
    expect(Buffer.isBuffer(bufRes) ? bufRes.toString('utf8') : bufRes).toBe('y');
  });
});

describe('Inline terminal graphics codec & bounded ToolImagePreview', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    clearImagePreviewCache();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inspects PNG, GIF, JPEG, and WebP headers and rejects SVG/polyglot inputs', () => {
    const png = createSolidRgbaPng(320, 180, [255, 64, 32, 255]);
    expect(inspectImageHeader(png)).toEqual({
      format: 'png',
      width: 320,
      height: 180,
      byteLength: png.byteLength,
    });

    const gif = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00, 0x00, 0x00,
    ]);
    expect(inspectImageHeader(gif)).toEqual({
      format: 'gif',
      width: 320,
      height: 240,
      byteLength: gif.byteLength,
    });

    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xd0,
      0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
    ]);
    expect(inspectImageHeader(jpeg)).toEqual({
      format: 'jpeg',
      width: 1280,
      height: 720,
      byteLength: jpeg.byteLength,
    });

    expect(inspectImageHeader(Buffer.from('<svg width="100" height="100"></svg>'))).toBeNull();
    expect(inspectImageHeader(png, 16)).toBeNull();
  });

  it('encodes Kitty graphics with mandatory q=2 and C=1 across 4096-byte chunks and OSC 1337 for iTerm2', () => {
    const payload = Buffer.alloc(4200, 0xab);
    const kitty = encodeKittyGraphics(payload, { cols: 40, rows: 12, imageId: 7 });
    const frames = kitty.split('\x1b\\').filter(Boolean);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[0]).toContain('\x1b_Ga=T,f=100,c=40,r=12,C=1,q=2,i=7,m=1;');
    const firstB64 = frames[0]?.split(';')[1] ?? '';
    expect(firstB64.length).toBe(KITTY_BASE64_CHUNK_SIZE);
    expect(frames.at(-1)).toMatch(/^\x1b_Gm=0;[A-Za-z0-9+/=]+$/);

    const iterm = encodeIterm2Graphics(Buffer.from('pngdata'), {
      cols: 30,
      rows: 10,
      fileName: 'shot.png',
    });
    expect(iterm.startsWith('\x1b]1337;File=')).toBe(true);
    expect(iterm).toContain('width=30;height=10;preserveAspectRatio=1;inline=1:');
    expect(iterm.endsWith('\x07')).toBe(true);
  });

  it('decodes 8-bit RGBA PNG into half-block truecolor cells, caps LRU cache, and renders ToolImagePreview', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wstack-tui-img-'));
    tempDirs.push(dir);
    const png = createSolidRgbaPng(16, 8, [18, 52, 86, 255]);

    const rgba = decodePngToRgbaThumbnail(png, 4, 4);
    expect(rgba).not.toBeNull();
    const grid = buildHalfBlockGrid(rgba!, 4, 4);
    expect(grid).toHaveLength(2);
    expect(grid[0]?.[0]).toEqual({ fg: '#123456', bg: '#123456' });

    const nativeKitty = encodeNativeTerminalImage(png, 'kitty', {
      maxCols: 32,
      maxRows: 10,
      imageId: 3,
    });
    expect(nativeKitty?.sequence).toContain('q=2');

    // Verify LRU cap on loadCachedImagePreview
    for (let i = 0; i < MAX_IMAGE_PREVIEW_CACHE_ENTRIES + 4; i++) {
      const p = join(dir, `shot-${i}.png`);
      writeFileSync(p, png);
      expect(loadCachedImagePreview(p, { maxCols: 20, maxRows: 6 })).not.toBeNull();
    }
    expect(getImagePreviewCacheSize()).toBeLessThanOrEqual(MAX_IMAGE_PREVIEW_CACHE_ENTRIES);

    const shotPath = join(dir, 'shot-0.png');
    const outputJson = JSON.stringify({ path: shotPath, mimeType: 'image/png' });
    expect(extractToolImageArtifactPath('browser_screenshot', outputJson)).toBe(shotPath);
    expect(extractToolImageArtifactPath('bash', outputJson)).toBeNull();
    expect(
      extractToolImageArtifactPath(
        'browser_screenshot',
        JSON.stringify({ path: 'https://evil.example/a.png' }),
      ),
    ).toBeNull();

    const { lastFrame } = render(
      React.createElement(ToolImagePreview, {
        toolName: 'browser_screenshot',
        output: outputJson,
        termWidth: 80,
        useTruecolor: true,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('shot-0.png');
    expect(frame).toContain('16×8 PNG');
    expect(frame).toContain('▀');

    const box = computeImageCellBox(1920, 1080, 60, 12);
    expect(box.cols).toBeLessThanOrEqual(60);
    expect(box.rows).toBeLessThanOrEqual(12);
  });

  it('extracts image_generate and present_artifact paths and enforces projectRoot containment on relative paths', () => {
    const projDir = mkdtempSync(join(tmpdir(), 'wstack-tui-proj-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'wstack-tui-outside-'));
    tempDirs.push(projDir, outsideDir);

    const png = createSolidRgbaPng(12, 8, [64, 128, 255, 255]);
    writeFileSync(join(projDir, 'generated.png'), png);
    writeFileSync(join(outsideDir, 'secret.png'), png);

    expect(
      extractToolImageArtifactPath(
        'image_generate',
        JSON.stringify({ ok: true, files: [{ path: 'generated.png', bytes: png.byteLength }] }),
      ),
    ).toBe('generated.png');

    expect(
      extractToolImageArtifactPath(
        'present_artifact',
        JSON.stringify({ kind: 'markdown', path: 'README.md' }),
      ),
    ).toBeNull();

    expect(
      extractToolImageArtifactPath(
        'present_artifact',
        JSON.stringify({ kind: 'image', path: 'generated.png' }),
      ),
    ).toBe('generated.png');

    const resolvedInside = loadCachedImagePreview('generated.png', { projectRoot: projDir });
    expect(resolvedInside).not.toBeNull();
    expect(resolvedInside?.header.width).toBe(12);

    // Path traversal escaping projectRoot MUST be rejected
    const escapedRel = join('..', outsideDir.split(/[\\/]/).pop()!, 'secret.png');
    expect(loadCachedImagePreview(escapedRel, { projectRoot: projDir })).toBeNull();
  });
});
