import { ToolError } from '@wrongstack/contracts/types';

/**
 * Hard cap on a buffered HTTP response body, matching the stdio transport's
 * 16 MiB rx cap. The stdio path and the SSE stream reader are both bounded, but
 * the streamable-http / SSE request-response paths buffered the whole body with
 * `res.text()` / `res.json()`. A malicious or buggy server (or a MITM when
 * `WRONGSTACK_UNSAFE_MCP_TLS=1` disables cert checks) could return a multi-GB
 * body and OOM-crash the host.
 */
export const MAX_MCP_HTTP_BODY_BYTES = 16 * 1024 * 1024;

interface ReadableResponse {
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/**
 * Read a response body to text, refusing to buffer more than `maxBytes`. Falls
 * back to `res.text()` when the body is not a web stream (empty bodies, test
 * fakes) — those paths are small and controlled.
 */
export async function readBodyCapped(
  res: ReadableResponse,
  maxBytes: number = MAX_MCP_HTTP_BODY_BYTES,
): Promise<string> {
  const safeCap =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes >= 0
      ? maxBytes
      : MAX_MCP_HTTP_BODY_BYTES;
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    const received = Buffer.byteLength(text, 'utf8');
    if (received > safeCap) {
      throw new ToolError({
        message: `MCP response body exceeded ${safeCap} bytes — refusing to buffer`,
        code: 'TOOL_EXECUTION_FAILED',
        toolName: 'mcp_transport',
        context: { maxBytes: safeCap, received },
      });
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > safeCap) {
        void reader.cancel().catch(() => undefined);
        throw new ToolError({
          message: `MCP response body exceeded ${safeCap} bytes — refusing to buffer`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: 'mcp_transport',
          context: { maxBytes: safeCap, received: total },
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  // Decode exactly as `res.text()` does (WHATWG UTF-8, which drops a leading
  // BOM): this replaces `res.text()`/`res.json()` on every capped path, and
  // `Buffer#toString` kept the BOM, so a BOM-prefixed JSON reply stopped
  // parsing.
  return new TextDecoder().decode(Buffer.concat(chunks));
}
