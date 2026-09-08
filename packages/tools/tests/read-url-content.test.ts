import { describe, expect, it, vi } from 'vitest';
import { readUrlContentTool } from '../src/index.js';
import * as fetchGuard from '../src/_fetch-guard.js';

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
});
