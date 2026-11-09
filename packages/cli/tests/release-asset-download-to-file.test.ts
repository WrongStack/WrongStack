/**
 * Chunked-write pin for `downloadReleaseAssetToFile` — the background
 * self-update streams 100+ MB assets one network chunk at a time and calls
 * `FileHandle#writeFile` once per chunk.
 *
 * Regression guard (chimera adjudication 2026-10-04): a review claimed
 * `FileHandle#writeFile` "rewrites from offset 0 on every call", which would
 * persist only the final chunk while the SHA-256 — computed over the network
 * stream — still verifies (corrupt asset, green receipt). Refuted on node
 * v24.13.0 (writes at the current position and advances it — see the on-disk
 * assertion below), but the property is load-bearing and unpinned: a refactor
 * to path-based `fsPromises.writeFile` (which truncates) or a Node behavior
 * change would silently corrupt self-update executables. This test fails the
 * moment per-chunk writes stop concatenating.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadReleaseAsset, downloadReleaseAssetToFile } from '../src/release-asset-download.js';

const CHUNKS = ['AAAA', 'BBBB', 'CCCC'];
const BODY = CHUNKS.join('');

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function droppedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('AAAA'));
      controller.error(new Error('connection dropped'));
    },
  });
}

describe('downloadReleaseAssetToFile', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'release-asset-'));
    file = path.join(dir, 'asset.bin');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams every chunk into the exclusively-created file — writes append, never overwrite', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(streamOf(CHUNKS), { status: 200 })),
    );

    const sha = await downloadReleaseAssetToFile('https://example.test/asset', file, {
      timeoutMs: 1000,
      maxBytes: 1024,
    });

    // Hash covers the whole network stream…
    expect(sha).toBe(createHash('sha256').update(BODY).digest('hex'));
    // …so the on-disk artifact is only correct if per-chunk writes append.
    // With a rewrite-from-offset-0 regression this file would hold 'CCCC'.
    expect(readFileSync(file, 'utf8')).toBe(BODY);
  });

  it('removes the target file when the stream fails mid-download', async () => {
    const fetchMock = vi.fn(async () => new Response(droppedStream(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadReleaseAssetToFile('https://example.test/asset', file, {
        timeoutMs: 1000,
        maxBytes: 1024,
        retryDelaysMs: [0, 0],
      }),
    ).rejects.toThrow('connection dropped');
    // A dropped connection is retried, and still fails as the drop it was.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // No partial asset may survive a failed self-update download.
    expect(existsSync(file)).toBe(false);
  });

  // #438 / #439: GitHub's release CDN answers a passing 504 for a large asset.
  it('retries a 5xx reply and writes the whole body into a fresh file', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }))
      .mockResolvedValueOnce(new Response(droppedStream(), { status: 200 }))
      .mockResolvedValueOnce(new Response(streamOf(CHUNKS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const sha = await downloadReleaseAssetToFile('https://example.test/asset', file, {
      timeoutMs: 1000,
      maxBytes: 1024,
      retryDelaysMs: [0, 0, 0],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sha).toBe(createHash('sha256').update(BODY).digest('hex'));
    // The partial file of the dropped attempt is gone, so `wx` reopened cleanly.
    expect(readFileSync(file, 'utf8')).toBe(BODY);
  });

  it('stops at once when the caller aborts', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort(new Error('session closed'));
      throw new Error('aborted');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadReleaseAssetToFile('https://example.test/asset', file, {
        timeoutMs: 1000,
        maxBytes: 1024,
        signal: controller.signal,
        retryDelaysMs: [0, 0, 0],
      }),
    ).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // A cancellation that lands during the retry backoff is the caller's
  // decision, not a network hiccup: reporting the 5xx hides the reason the
  // update was actually stopped.
  it('reports the caller cancellation, not the transient failure, when aborted during the backoff', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway timeout', { status: 504 })),
    );

    const pending = downloadReleaseAssetToFile('https://example.test/asset', file, {
      timeoutMs: 5_000,
      maxBytes: 1024,
      signal: controller.signal,
      retryDelaysMs: [1_000],
    });
    // Cancel while the retry backoff is running.
    setTimeout(() => controller.abort(new Error('cancelled by user')), 20);

    await expect(pending).rejects.toThrow('cancelled by user');
    expect(existsSync(file)).toBe(false);
  });

  it('cancels the response body when the declared size exceeds the ceiling', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(BODY));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { 'content-length': String(BODY.length + 1) },
          }),
      ),
    );

    await expect(
      downloadReleaseAssetToFile('https://example.test/asset', file, {
        timeoutMs: 1000,
        maxBytes: 4,
        retryDelaysMs: [0, 0],
      }),
    ).rejects.toThrow('is too large');
    expect(cancelled).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});

describe('downloadReleaseAsset retries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries 5xx and 429 replies until the asset arrives', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 504 }))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(BODY, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const bytes = await downloadReleaseAsset('https://example.test/SUMS', 1000, 1024, {
      retryDelaysMs: [0, 0, 0],
    });

    expect(bytes.toString('utf8')).toBe(BODY);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reports the last status after the retries run out', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 504 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadReleaseAsset('https://example.test/SUMS', 1000, 1024, { retryDelaysMs: [0, 0] }),
    ).rejects.toThrow('download https://example.test/SUMS responded 504');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadReleaseAsset('https://example.test/SUMS', 1000, 1024, { retryDelaysMs: [0, 0] }),
    ).rejects.toThrow('responded 404');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry an oversized asset', async () => {
    const fetchMock = vi.fn(async () => new Response(BODY, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadReleaseAsset('https://example.test/SUMS', 1000, 4, { retryDelaysMs: [0, 0] }),
    ).rejects.toThrow('is too large');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
