import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ImageAttachmentError,
  MAX_ATTACHED_IMAGES,
  MAX_PROCESSED_IMAGE_BYTES,
  processImageFile,
  toWireImages,
} from '../../src/components/ChatInput/image-attachments';

/**
 * jsdom has no canvas backend and no `createImageBitmap`, so the encode path
 * is driven through explicit stubs. Each test states the browser behaviour it
 * is modelling (WebP support, alpha fallback, oversized re-encode) rather than
 * relying on a real rasterizer.
 */

// ── canvas + decode stubs ───────────────────────────────────────────────────

/** Base64 payload of the requested decoded byte length. */
function dataUrlOfBytes(mime: string, bytes: number): string {
  // approximateBytes = floor(b64len * 3 / 4) → b64len = ceil(bytes * 4 / 3)
  return `data:${mime};base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`;
}

interface CanvasStub {
  /** Media types the fake browser can encode, in preference order. */
  supports: Set<string>;
  /** Decoded byte size the next toDataURL should report, keyed by call index. */
  sizes: number[];
  drawCalls: Array<{ width: number; height: number }>;
  toDataUrlCalls: Array<{ type: string; quality?: number }>;
}

let canvas: CanvasStub;

function installCanvas(supports: string[] = ['image/webp'], sizes: number[] = [1000]) {
  canvas = { supports: new Set(supports), sizes, drawCalls: [], toDataUrlCalls: [] };

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind !== '2d') return null;
    return {
      drawImage: (_src: unknown, _x: number, _y: number, w: number, h: number) => {
        canvas.drawCalls.push({ width: w, height: h });
      },
    } as unknown as CanvasRenderingContext2D;
  } as never);

  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
    this: HTMLCanvasElement,
    type?: string,
    quality?: number,
  ) {
    const requested = type ?? 'image/png';
    canvas.toDataUrlCalls.push(
      quality === undefined ? { type: requested } : { type: requested, quality },
    );
    // A browser without WebP encoding silently returns PNG — that is exactly
    // what the module detects via the `data:image/webp` prefix check.
    const emitted = canvas.supports.has(requested) ? requested : 'image/png';
    const size = canvas.sizes[Math.min(canvas.toDataUrlCalls.length - 1, canvas.sizes.length - 1)];
    return dataUrlOfBytes(emitted, size ?? 1000);
  } as never);
}

/** A decodable source of the given intrinsic size. */
function installBitmap(width: number, height: number, close = vi.fn()) {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width, height, close })),
  );
  return close;
}

function installUndecodable() {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      throw new Error('unsupported');
    }),
  );
  // The <img> fallback also fails.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:x'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(window, 'Image').mockImplementation(function (this: HTMLImageElement) {
    setTimeout(() => this.onerror?.(new Event('error')), 0);
    return this;
  } as never);
}

function file(name: string, type: string, size: number): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

const SMALL = 1024;
const OVER_RECOMPRESS = 3 * 1024 * 1024;

describe('image attachments', () => {
  beforeEach(() => {
    installCanvas();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exposes the documented caps', () => {
    expect(MAX_ATTACHED_IMAGES).toBe(8);
    expect(MAX_PROCESSED_IMAGE_BYTES).toBe(4 * 1024 * 1024);
  });

  // ── passthrough path ──────────────────────────────────────────────────────

  describe('passthrough', () => {
    it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
      'passes a small %s through untouched',
      async (type) => {
        installBitmap(100, 100);
        const result = await processImageFile(file('a.png', type, SMALL));
        expect(result.mediaType).toBe(type);
        // No canvas work at all — a GIF keeps its animation this way.
        expect(canvas.toDataUrlCalls).toHaveLength(0);
      },
    );

    it('records the intrinsic dimensions and a generated id', async () => {
      installBitmap(120, 80);
      const result = await processImageFile(file('a.png', 'image/png', SMALL));
      expect(result).toMatchObject({ width: 120, height: 80, name: 'a.png' });
      expect(result.id).toMatch(/^img_\d+_\d+$/);
    });

    it('issues a distinct id per attachment', async () => {
      installBitmap(10, 10);
      const a = await processImageFile(file('a.png', 'image/png', SMALL));
      const b = await processImageFile(file('b.png', 'image/png', SMALL));
      expect(a.id).not.toBe(b.id);
    });

    it('omits the name for an unnamed file', async () => {
      installBitmap(10, 10);
      const result = await processImageFile(file('', 'image/png', SMALL));
      expect(result.name).toBeUndefined();
    });

    it('reports an approximate decoded size', async () => {
      installBitmap(10, 10);
      const result = await processImageFile(file('a.png', 'image/png', SMALL));
      expect(result.bytes).toBeGreaterThan(0);
    });
  });

  // ── re-encode path ────────────────────────────────────────────────────────

  describe('re-encoding', () => {
    it('rasterizes an exotic format', async () => {
      installBitmap(100, 100);
      const result = await processImageFile(file('a.svg', 'image/svg+xml', SMALL));
      expect(canvas.toDataUrlCalls[0]?.type).toBe('image/webp');
      expect(result.mediaType).toBe('image/webp');
    });

    it('re-encodes an oversized source even in an accepted format', async () => {
      installBitmap(100, 100);
      await processImageFile(file('a.png', 'image/png', OVER_RECOMPRESS));
      expect(canvas.toDataUrlCalls.length).toBeGreaterThan(0);
    });

    it('downscales the long edge to 2048px, preserving aspect ratio', async () => {
      installBitmap(4096, 2048);
      const result = await processImageFile(file('a.png', 'image/png', OVER_RECOMPRESS));
      expect(canvas.drawCalls[0]).toEqual({ width: 2048, height: 1024 });
      expect(result).toMatchObject({ width: 2048, height: 1024 });
    });

    it('does not upscale a small exotic image', async () => {
      installBitmap(50, 25);
      await processImageFile(file('a.svg', 'image/svg+xml', SMALL));
      expect(canvas.drawCalls[0]).toEqual({ width: 50, height: 25 });
    });

    it('never produces a zero-pixel canvas for an extreme aspect ratio', async () => {
      installBitmap(8192, 1);
      await processImageFile(file('a.png', 'image/png', OVER_RECOMPRESS));
      expect(canvas.drawCalls[0]?.height).toBeGreaterThanOrEqual(1);
    });

    it('prefers WebP at quality 0.85 on the first pass', async () => {
      installBitmap(100, 100);
      await processImageFile(file('a.svg', 'image/svg+xml', SMALL));
      expect(canvas.toDataUrlCalls[0]).toEqual({ type: 'image/webp', quality: 0.85 });
    });

    it('falls back to PNG for an alpha-capable source when WebP is unavailable', async () => {
      installCanvas([], [1000]);
      installBitmap(100, 100);
      const result = await processImageFile(file('a.svg', 'image/svg+xml', SMALL));
      expect(canvas.toDataUrlCalls.map((c) => c.type)).toEqual(['image/webp', 'image/png']);
      expect(result.mediaType).toBe('image/png');
    });

    it('falls back to JPEG for a JPEG source — it has no alpha to preserve', async () => {
      installCanvas(['image/jpeg'], [1000]);
      installBitmap(100, 100);
      const result = await processImageFile(file('a.jpg', 'image/jpeg', OVER_RECOMPRESS));
      expect(canvas.toDataUrlCalls.map((c) => c.type)).toEqual(['image/webp', 'image/jpeg']);
      expect(result.mediaType).toBe('image/jpeg');
    });

    it('makes a second, tighter pass when the first encode is over the cap', async () => {
      installCanvas(['image/webp'], [MAX_PROCESSED_IMAGE_BYTES + 1_000, 1_000]);
      installBitmap(4096, 4096);
      const result = await processImageFile(file('a.png', 'image/png', OVER_RECOMPRESS));
      expect(canvas.toDataUrlCalls).toHaveLength(2);
      expect(canvas.toDataUrlCalls[1]).toEqual({ type: 'image/webp', quality: 0.7 });
      // The retry clamps the long edge to 1280.
      expect(canvas.drawCalls[1]).toEqual({ width: 1280, height: 1280 });
      expect(result.width).toBe(1280);
    });

    it('throws too_large when even the tighter pass exceeds the cap', async () => {
      const tooBig = MAX_PROCESSED_IMAGE_BYTES + 1_000;
      installCanvas(['image/webp'], [tooBig, tooBig]);
      installBitmap(4096, 4096);
      await expect(
        processImageFile(file('huge.png', 'image/png', OVER_RECOMPRESS)),
      ).rejects.toMatchObject({
        name: 'ImageAttachmentError',
        reason: 'too_large',
      });
    });

    it('names the offending file in the too_large message', async () => {
      const tooBig = MAX_PROCESSED_IMAGE_BYTES + 1_000;
      installCanvas(['image/webp'], [tooBig, tooBig]);
      installBitmap(4096, 4096);
      await expect(
        processImageFile(file('huge.png', 'image/png', OVER_RECOMPRESS)),
      ).rejects.toThrow(/huge\.png/);
    });

    it('releases the decoded bitmap', async () => {
      const close = installBitmap(100, 100);
      await processImageFile(file('a.svg', 'image/svg+xml', SMALL));
      expect(close).toHaveBeenCalled();
    });

    it('raises decode_failed when the 2d context is unavailable', async () => {
      installBitmap(100, 100);
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
      await expect(processImageFile(file('a.svg', 'image/svg+xml', SMALL))).rejects.toMatchObject({
        reason: 'decode_failed',
      });
    });
  });

  // ── decode failure ────────────────────────────────────────────────────────

  it('raises decode_failed when neither decoder can read the file', async () => {
    installUndecodable();
    await expect(processImageFile(file('broken.png', 'image/png', SMALL))).rejects.toMatchObject({
      name: 'ImageAttachmentError',
      reason: 'decode_failed',
    });
  });

  it('names the file in the decode_failed message', async () => {
    installUndecodable();
    await expect(processImageFile(file('broken.png', 'image/png', SMALL))).rejects.toThrow(
      /broken\.png/,
    );
  });

  it('ImageAttachmentError carries its reason and name', () => {
    const err = new ImageAttachmentError('nope', 'too_large');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ImageAttachmentError');
    expect(err.reason).toBe('too_large');
    expect(err.message).toBe('nope');
  });
});

// ── wire shape ──────────────────────────────────────────────────────────────

describe('toWireImages', () => {
  const base = { id: 'i1', mediaType: 'image/png', bytes: 10 };

  it('returns an empty array for no attachments', () => {
    expect(toWireImages([])).toEqual([]);
  });

  it('strips the data-URL prefix so the wire carries bare base64', () => {
    expect(toWireImages([{ ...base, dataUrl: 'data:image/png;base64,AAAA' }])).toEqual([
      { data: 'AAAA', mediaType: 'image/png' },
    ]);
  });

  it('passes a prefix-less payload through unchanged', () => {
    expect(toWireImages([{ ...base, dataUrl: 'AAAA' }])[0]?.data).toBe('AAAA');
  });

  it('includes the filename when present', () => {
    expect(
      toWireImages([{ ...base, dataUrl: 'data:image/png;base64,AAAA', name: 'shot.png' }])[0],
    ).toEqual({ data: 'AAAA', mediaType: 'image/png', name: 'shot.png' });
  });

  it('omits the name key entirely when absent or empty', () => {
    expect(toWireImages([{ ...base, dataUrl: 'data:image/png;base64,A' }])[0]).not.toHaveProperty(
      'name',
    );
    expect(
      toWireImages([{ ...base, dataUrl: 'data:image/png;base64,A', name: '' }])[0],
    ).not.toHaveProperty('name');
  });

  it('maps every attachment in order', () => {
    const out = toWireImages([
      { ...base, id: 'a', dataUrl: 'data:image/png;base64,AA' },
      { ...base, id: 'b', mediaType: 'image/webp', dataUrl: 'data:image/webp;base64,BB' },
    ]);
    expect(out).toEqual([
      { data: 'AA', mediaType: 'image/png' },
      { data: 'BB', mediaType: 'image/webp' },
    ]);
  });

  it('keeps the declared mediaType rather than re-parsing the data URL', () => {
    // The attachment's mediaType is authoritative — the encoder already
    // reconciled it against what the canvas actually emitted.
    expect(
      toWireImages([{ ...base, mediaType: 'image/webp', dataUrl: 'data:image/png;base64,AA' }])[0]
        ?.mediaType,
    ).toBe('image/webp');
  });
});
