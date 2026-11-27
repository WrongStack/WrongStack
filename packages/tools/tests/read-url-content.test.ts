import { describe, expect, it, vi } from 'vitest';
import * as fetchGuard from '../src/_fetch-guard.js';
import { readUrlContentTool } from '../src/index.js';
import { MAX_READ_URL_BYTES } from '../src/read-url-content.js';

const makeOpts = () => ({ signal: new AbortController().signal });

describe('read_url_content tool', () => {
  it('converts HTML content to clean markdown and strips boilerplate elements', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Docs</title><style>.hidden { display: none; }</style></head>
        <body>
          <header><nav><a href="/">Home</a><a href="/docs">Docs</a></nav></header>
          <main>
            <h1>Installation Guide</h1>
            <p>Run the following command to install:</p>
            <pre><code>pnpm install @wrongstack/core</code></pre>
          </main>
          <footer><p>&copy; 2026 WrongStack</p></footer>
          <script>console.log("analytics");</script>
        </body>
      </html>
    `;

    vi.spyOn(fetchGuard, 'guardedFetch').mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://docs.example.com/install',
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => html,
    } as unknown as Response);

    const output = await readUrlContentTool.execute(
      { url: 'https://docs.example.com/install' },
      {} as never,
      makeOpts(),
    );

    expect(output.status).toBe(200);
    expect(output.url).toBe('https://docs.example.com/install');
    expect(output.content).toContain('# Installation Guide');
    expect(output.content).toContain('pnpm install @wrongstack/core');
    // Verify scripts, styles, header/nav, and footer were stripped
    expect(output.content).not.toContain('analytics');
    expect(output.content).not.toContain('display: none');
    expect(output.content).not.toContain('Home');
    expect(output.content).not.toContain('&copy;');
  });

  it('handles case-tolerant Url alias', async () => {
    vi.spyOn(fetchGuard, 'guardedFetch').mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://api.example.com/data.json',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ hello: 'world' }),
    } as unknown as Response);

    const output = await readUrlContentTool.execute(
      { Url: 'https://api.example.com/data.json' },
      {} as never,
      makeOpts(),
    );

    expect(output.status).toBe(200);
    expect(output.content).toContain('"hello": "world"');
  });

  it('rejects missing url', async () => {
    await expect(readUrlContentTool.execute({}, {} as never, makeOpts())).rejects.toThrow(
      'read_url_content requires a valid `url` parameter.',
    );
  });

  // WS-2026-09-17-02. `maxBytes` is model-supplied; without a ceiling it set the
  // read limit (`maxBytes * 4`) and so the only bound on the buffered chunks.
  // Asserted on the real execute path, which is also the path a direct (non
  // executor-validated) caller takes — the schema `maximum` cannot cover that.
  it('clamps an oversized maxBytes so the buffered read stays bounded', async () => {
    const CHUNK = 256 * 1024;
    // More available than the memory guard, so only the clamp can stop the read.
    const TOTAL_CHUNKS = Math.ceil(MAX_READ_URL_BYTES / CHUNK) + 8;
    const chunk = new Uint8Array(CHUNK).fill(0x61); // 'a'
    let pulled = 0;
    let served = 0;
    let cancelled = false;

    const reader = {
      read: async () => {
        if (served >= TOTAL_CHUNKS) return { value: undefined, done: true };
        served++;
        pulled += CHUNK;
        return { value: chunk, done: false };
      },
      cancel: async () => {
        cancelled = true;
      },
      releaseLock: () => {},
    };

    vi.spyOn(fetchGuard, 'guardedFetch').mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://example.com/huge.txt',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: { getReader: () => reader },
    } as unknown as Response);

    const output = await readUrlContentTool.execute(
      { url: 'https://example.com/huge.txt', maxBytes: 50_000_000 },
      {} as never,
      makeOpts(),
    );

    // The read limit is clamped to the memory guard; the loop stops on the
    // first chunk that crosses it, so allow one chunk of overshoot and no more.
    expect(pulled).toBeLessThanOrEqual(MAX_READ_URL_BYTES + CHUNK);
    // Proves the stream was torn down rather than drained to completion.
    expect(cancelled).toBe(true);
    expect(served).toBeLessThan(TOTAL_CHUNKS);
    // Returned content still honours the clamped byte budget.
    expect(output.content).toContain('[Content truncated at');
  });

  it('blames maxBytes, not the memory guard, when a small maxBytes stopped the read', async () => {
    // Markup-heavy HTML: 4x maxBytes of raw body converts to under maxBytes of
    // markdown, so only the read-limit note can explain the cut.
    const html = `<html><body><p>start</p>${'<div><span></span></div>'.repeat(200)}<p>end</p></body></html>`;
    const encoder = new TextEncoder();
    vi.spyOn(fetchGuard, 'guardedFetch').mockResolvedValue(
      new Response(encoder.encode(html), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const output = await readUrlContentTool.execute(
      { url: 'https://docs.example.com/x', maxBytes: 100 },
      {} as never,
      makeOpts(),
    );
    expect(output.content).toContain('maxBytes=100 read only the first 400 bytes');
    expect(output.content).not.toContain('memory guard');
  });
});
