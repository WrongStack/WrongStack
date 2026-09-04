import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_MCP_HTTP_BODY_BYTES } from '../src/read-body.js';
import { StreamableHTTPTransport } from '../src/transport-streamable.js';

const CHUNK = 64 * 1024;

interface BodyTally {
  delivered: number;
  cancelled: boolean;
}

function makeCountingBody(totalBytes: number, tally: BodyTally): ReadableStream<Uint8Array> {
  let sent = 0;
  const chunk = new Uint8Array(CHUNK).fill(0x61);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += CHUNK;
      tally.delivered = sent;
    },
    cancel() {
      tally.cancelled = true;
    },
  });
}

function overCapBody(tally: BodyTally): ReadableStream<Uint8Array> {
  return makeCountingBody(MAX_MCP_HTTP_BODY_BYTES + 1024 * 1024, tally);
}

function jsonResponse(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function oversizedResponse(
  tally: BodyTally,
  contentType?: string,
): Response {
  return new Response(overCapBody(tally), {
    status: 200,
    ...(contentType ? { headers: { 'content-type': contentType } } : {}),
  });
}

function expectCapped(message: string, tally: BodyTally): void {
  expect(message).toContain('refusing to buffer');
  // The capped path cancels the stream; the old full-drain path never did.
  expect(tally.cancelled).toBe(true);
  // Delivered must stop at the cap (stream read-ahead may overshoot by a
  // couple of 64 KiB chunks, but draining the whole 17 MiB body is the bug).
  expect(tally.delivered).toBeLessThanOrEqual(MAX_MCP_HTTP_BODY_BYTES + 4 * CHUNK);
}

describe('StreamableHTTPTransport — response bodies honor MAX_MCP_HTTP_BODY_BYTES', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connect() refuses to buffer an over-cap application/json initialize body', async () => {
    const tally: BodyTally = { delivered: 0, cancelled: false };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => oversizedResponse(tally, 'application/json')),
    );

    const transport = new StreamableHTTPTransport({
      name: 'cap-json',
      url: 'https://mcp.example.com',
    });
    let message = '';
    try {
      await transport.connect();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expectCapped(message, tally);
  });

  it('connect() refuses to buffer an over-cap text/event-stream initialize body', async () => {
    const tally: BodyTally = { delivered: 0, cancelled: false };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => oversizedResponse(tally, 'text/event-stream')),
    );

    const transport = new StreamableHTTPTransport({
      name: 'cap-sse',
      url: 'https://mcp.example.com',
    });
    let message = '';
    try {
      await transport.connect();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expectCapped(message, tally);
  });

  it('drains an over-cap notifications body through the cap and completes connect', async () => {
    const tally: BodyTally = { delivered: 0, cancelled: false };
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(1, {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'proof', version: '1' },
          });
        }
        if (call === 2) return oversizedResponse(tally);
        return jsonResponse(3, { tools: [] });
      }),
    );

    const transport = new StreamableHTTPTransport({
      name: 'cap-notify',
      url: 'https://mcp.example.com',
    });
    await expect(transport.connect()).resolves.toBeUndefined();

    // The notifications body was cut off at the cap, not drained.
    expect(tally.cancelled).toBe(true);
    expect(tally.delivered).toBeLessThanOrEqual(MAX_MCP_HTTP_BODY_BYTES + 4 * CHUNK);
    expect(transport.listTools()).toEqual([]);
  });
});
