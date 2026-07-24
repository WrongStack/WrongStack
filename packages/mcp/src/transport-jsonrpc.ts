import { ToolError } from '@wrongstack/core/types';

export type JsonRpcResult = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown | undefined;
  error?: { code: number | undefined; message: string; data?: unknown | undefined } | undefined;
};

type JsonRpcMethodEnvelope = {
  jsonrpc: '2.0';
  id?: number | string | undefined;
  method: string;
  params?: unknown | undefined;
};

type JsonRpcEnvelope = JsonRpcResult | JsonRpcMethodEnvelope;

export function isJsonRpcResult(v: unknown): v is JsonRpcResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r['jsonrpc'] !== '2.0' || typeof r['id'] !== 'number') return false;
  if (Object.hasOwn(r, 'method')) return false;

  const hasResult = Object.hasOwn(r, 'result');
  const hasError = Object.hasOwn(r, 'error');
  if (hasResult === hasError) return false;
  if (hasError) {
    const error = r['error'];
    return (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as Record<string, unknown>)['code'] === 'number' &&
      typeof (error as Record<string, unknown>)['message'] === 'string'
    );
  }
  return true;
}

function isJsonRpcMethodEnvelope(v: unknown): v is JsonRpcMethodEnvelope {
  if (typeof v !== 'object' || v === null) return false;
  const envelope = v as Record<string, unknown>;
  if (envelope['jsonrpc'] !== '2.0' || typeof envelope['method'] !== 'string') return false;
  const id = envelope['id'];
  return id === undefined || typeof id === 'number' || typeof id === 'string';
}

/**
 * Extract JSON-RPC envelopes from a streamable-http response body. Handles BOTH
 * plain NDJSON (one JSON object per line) AND SSE framing
 * (`event: message\ndata: {...}` blocks) — modern MCP servers (e.g. Context7)
 * reply with `text/event-stream` even on a single POST, so the data must be
 * un-prefixed before parsing. Multi-line `data:` values within one event are
 * joined per the SSE spec.
 */
export function extractJsonRpcEnvelopes(text: string): JsonRpcEnvelope[] {
  const out: JsonRpcEnvelope[] = [];
  let dataBuf: string[] = [];
  const flush = () => {
    if (dataBuf.length === 0) return;
    const joined = dataBuf.join('\n').trim();
    dataBuf = [];
    if (!joined) return;
    try {
      const parsed = JSON.parse(joined);
      if (isJsonRpcResult(parsed) || isJsonRpcMethodEnvelope(parsed)) out.push(parsed);
    } catch {
      /* ignore non-JSON event data */
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      flush(); // blank line ends an SSE event
      continue;
    }
    if (line.startsWith(':')) continue; // SSE comment
    if (line.startsWith('data:')) {
      let v = line.slice(5);
      if (v.startsWith(' ')) v = v.slice(1);
      dataBuf.push(v);
      continue;
    }
    if (line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) {
      continue; // other SSE fields
    }
    // Plain NDJSON line (no SSE framing).
    const trimmed = line.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isJsonRpcResult(parsed) || isJsonRpcMethodEnvelope(parsed)) out.push(parsed);
      } catch {
        /* ignore */
      }
    }
  }
  flush();
  return out;
}

/** Extract only response envelopes; notifications and server requests are not responses. */
export function extractJsonRpcResults(text: string): JsonRpcResult[] {
  return extractJsonRpcEnvelopes(text).filter(isJsonRpcResult);
}

export function assertMatchingJsonRpcResult(
  data: unknown,
  expectedId: number,
  method: string,
): JsonRpcResult {
  if (!isJsonRpcResult(data)) {
    throw new ToolError({
      message: 'Invalid JSON-RPC response: not a JSON-RPC 2.0 envelope',
      code: 'TOOL_EXECUTION_FAILED',
      toolName: 'mcp_transport_jsonrpc',
      context: { method, expectedId, reason: 'not-jsonrpc-envelope' },
    });
  }
  if (data.id !== expectedId) {
    throw new ToolError({
      message: `Invalid JSON-RPC response: id mismatch for ${method} (expected ${expectedId}, got ${data.id})`,
      code: 'TOOL_EXECUTION_FAILED',
      toolName: 'mcp_transport_jsonrpc',
      context: { method, expectedId, actualId: data.id, reason: 'id-mismatch' },
    });
  }
  return data;
}
