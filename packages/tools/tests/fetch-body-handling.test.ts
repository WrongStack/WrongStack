import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { installLimitsSource } from '@wrongstack/contracts/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The guard reads this once at module load, so it must be set before import.
process.env['WRONGSTACK_FETCH_ALLOW_PRIVATE'] = '1';
const { fetchTool } = await import('../src/fetch.js');
const { readUrlContentTool } = await import('../src/read-url-content.js');
const { mkSandbox, newSignal } = await import('./fixtures.js');

/**
 * Body handling found by the 2026-09-15 tool audit against a real local
 * server (the existing suites mock `guardedFetch`, so none of these were
 * reachable there).
 */
let base = '';
let largeClosedEarly = false;
const closedStreams = new Set<string>();
const server: Server = createServer((req, res) => {
  if (req.url?.startsWith('/stream-')) {
    const route = req.url;
    res.writeHead(200, {
      'content-type': route === '/stream-binary' ? 'application/octet-stream' : 'text/plain',
    });
    res.write('x'.repeat(4096));
    const timer = setInterval(() => res.write('x'.repeat(4096)), 25);
    res.on('close', () => {
      clearInterval(timer);
      closedStreams.add(route);
    });
  } else if (req.url === '/empty') {
    res.writeHead(204);
    res.end();
  } else if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<html><head><title>T</title><style>.x{}</style></head><body><script>evil()</script><h1>Hello</h1><p>A &amp; B</p></body></html>',
    );
  } else if (req.url === '/binary') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([0, 1, 2, 255]));
  } else if (req.url === '/huge') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    let sent = 0;
    const chunk = 'x'.repeat(64 * 1024);
    res.on('close', () => {
      if (sent < 64 * 1024 * 1024) largeClosedEarly = true;
    });
    const pump = () => {
      while (sent < 64 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
      res.end();
    };
    pump();
  } else if (req.url === '/plain-large') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('a'.repeat(8000));
  } else {
    res.writeHead(404);
    res.end();
  }
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('fetch body handling', () => {
  it('closes a rejected binary response without waiting for its body', async () => {
    const sb = await mkSandbox();
    try {
      await expect(
        fetchTool.execute({ url: `${base}/stream-binary` }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow(/binary/);
      await expect.poll(() => closedStreams.has('/stream-binary'), { timeout: 1500 }).toBe(true);
    } finally {
      await sb.cleanup();
    }
  });

  it.each(['headers', 'partial'])('closes the response when abandoned after %s', async (stage) => {
    const sb = await mkSandbox();
    const route = `/stream-${stage}`;
    const stream = fetchTool.executeStream!({ url: `${base}${route}` }, sb.ctx, {
      signal: newSignal(),
    })[Symbol.asyncIterator]();
    try {
      await stream.next(); // GET log, before the request.
      const headers = await stream.next();
      expect(headers.value).toMatchObject({
        type: 'log',
        text: expect.stringContaining('HTTP 200'),
      });
      if (stage === 'partial') {
        expect((await stream.next()).value).toMatchObject({ type: 'partial_output' });
      }
      await stream.return?.();
      await expect.poll(() => closedStreams.has(route), { timeout: 1500 }).toBe(true);
    } finally {
      await stream.return?.();
      await sb.cleanup();
    }
  });

  it('returns empty content for a 204 without a content-type instead of refusing it as binary', async () => {
    const sb = await mkSandbox();
    try {
      const out = await fetchTool.execute({ url: `${base}/empty` }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.status).toBe(204);
      expect(out.content).toBe('');
    } finally {
      await sb.cleanup();
    }
  });

  it('format "text" strips HTML to plain text rather than returning raw markup', async () => {
    const sb = await mkSandbox();
    try {
      const text = await fetchTool.execute({ url: `${base}/page`, format: 'text' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(text.content).toContain('Hello');
      expect(text.content).toContain('A & B');
      expect(text.content).not.toMatch(/<|evil\(\)|\.x\{\}/);
      const raw = await fetchTool.execute({ url: `${base}/page`, format: 'raw' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(raw.content).toContain('<script>evil()</script>');
    } finally {
      await sb.cleanup();
    }
  });
});

describe('read_url_content body handling', () => {
  it('refuses binary content-types like fetch does', async () => {
    await expect(
      readUrlContentTool.execute({ url: `${base}/binary` }, {} as never, { signal: newSignal() }),
    ).rejects.toThrow(/binary/);
  });

  it('stops reading at maxBytes instead of buffering the whole body', async () => {
    const out = await readUrlContentTool.execute(
      { url: `${base}/huge`, maxBytes: 1024 },
      {} as never,
      { signal: newSignal() },
    );
    expect(out.content).toContain('[Content truncated at 1024 bytes]');
    expect(Buffer.byteLength(out.content)).toBeLessThan(2048);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(largeClosedEarly).toBe(true);
  });

  // Regression (bug-hunter r1 2026-09-25): the cut notice was appended OUTSIDE
  // the budget, so a declared cap was always overshot by its own marker (~35
  // bytes) and a byte cut could split a character into U+FFFD. House contract
  // (truncateMiddle/truncateDiffPayload): marker room is reserved from the
  // budget, so the result never exceeds the cap.
  it('never returns more bytes than maxBytes, cut notice included', async () => {
    const out = await readUrlContentTool.execute(
      { url: `${base}/plain-large`, maxBytes: 2048 },
      {} as never,
      { signal: newSignal() },
    );
    expect(out.content).toContain('[Content truncated at 2048 bytes]');
    expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(2048);
  });
});

describe('fetch byte cap', () => {
  it('never returns more bytes than limits.fetchBytes, cut notice included', async () => {
    const sb = await mkSandbox();
    const restore = installLimitsSource(() => ({ fetchBytes: 2048 }));
    try {
      const out = await fetchTool.execute({ url: `${base}/plain-large` }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.content).toContain('[cut at 2048 bytes by limits.fetchBytes]');
      expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(2048);
    } finally {
      restore();
      await sb.cleanup();
    }
  });
});
