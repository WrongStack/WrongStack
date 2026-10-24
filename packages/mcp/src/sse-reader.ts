import { ToolError } from '@wrongstack/contracts/types';
import { MAX_MCP_HTTP_BODY_BYTES } from './read-body.js';

/**
 * SSE-based MCP transport using native fetch.
 *
 * Communication pattern:
 * - Client connects to SSE endpoint to receive server messages (JSON-RPC events)
 * - Client sends JSON-RPC requests via HTTP POST to the same or separate endpoint
 * - Server sends results/errors via the SSE stream
 *
 * The SSE reader parses the SSE protocol (event:, data:, blank line to dispatch).
 */
/**
 * Cap on the pending-line buffer and on one event's data. The legacy SSE
 * transport receives EVERY JSON-RPC response over this stream, so the cap is
 * the same 16 MiB response cap every other MCP path enforces — 256 KiB (the
 * provider token-delta parser's cap) threw on a 300 KB tool result and tore
 * the connection down. Still bounded: a malicious stream cannot pin more.
 */
const SSE_READER_MAX_BUFFER = MAX_MCP_HTTP_BODY_BYTES;
/** Max data lines buffered per event before flush. Prevents a malicious
 *  server from accumulating unbounded data: lines without a blank-line
 *  delimiter would grow this array indefinitely. */
const SSE_READER_MAX_DATA_LINES = 1024;

export class SSEReader {
  private pending: string[] = [];
  private pendingLength = 0;
  private skipLeadingLF = false;
  private dataLines: string[] = [];
  private dataLength = 0;
  private eventName = '';
  private endpointListeners: Array<(endpoint: string) => void> = [];

  /**
   * Legacy HTTP+SSE transport: the server's first event is
   * `event: endpoint` whose data is the (relative) URL to POST requests to.
   * Its payload is a URL, not JSON, so it is dispatched separately.
   */
  onEndpoint(cb: (endpoint: string) => void): () => void {
    this.endpointListeners.push(cb);
    return () => {
      const idx = this.endpointListeners.indexOf(cb);
      if (idx >= 0) this.endpointListeners.splice(idx, 1);
    };
  }
  private listeners: Array<
    (event: {
      jsonrpc?: string | undefined;
      method?: string | undefined;
      params?: unknown | undefined;
      id?: number | undefined;
    }) => void
  > = [];

  onMessage(
    cb: (data: {
      jsonrpc?: string | undefined;
      method?: string | undefined;
      params?: unknown | undefined;
      id?: number | undefined;
    }) => void,
  ): () => void {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  feed(chunk: string): void {
    const carried = this.pendingLength;
    // A CRLF pair may straddle chunks; the CR already ended the line.
    if (this.skipLeadingLF && chunk.length > 0) {
      this.skipLeadingLF = false;
      if (chunk.startsWith('\n')) chunk = chunk.slice(1);
    }
    // The carried pieces hold no line terminator (every one was consumed), so
    // only the new chunk is scanned, and the pieces are joined once when their
    // line completes. Appending to one string and rescanning it on every read
    // was O(n²) for a large event split over many reads.
    let start = 0;
    for (let idx = 0; idx < chunk.length; idx++) {
      const code = chunk.charCodeAt(idx);
      if (code !== 10 && code !== 13) continue;
      const head = chunk.slice(start, idx);
      if (this.pending.length > 0) {
        this.pending.push(head);
        const line = this.pending.join('');
        this.pending = [];
        this.pendingLength = 0;
        this.processLine(line);
      } else {
        this.processLine(head);
      }
      if (code === 13) {
        if (chunk.charCodeAt(idx + 1) === 10) idx++;
        else if (idx + 1 === chunk.length) this.skipLeadingLF = true;
      }
      start = idx + 1;
    }
    if (start < chunk.length) {
      this.pending.push(start > 0 ? chunk.slice(start) : chunk);
      this.pendingLength += chunk.length - start;
    }
    // The cap bounds an UNTERMINATED line, so it is checked after complete
    // lines are consumed. Checked before, one read carrying many small,
    // complete events (> cap in total) threw, and the transport dropped the
    // connection over events it could have delivered.
    if (this.pendingLength <= SSE_READER_MAX_BUFFER) return;
    if (start > 0 || carried === 0) {
      // The unterminated tail lies wholly inside this chunk.
      throw new ToolError({
        message: `SSE: chunk size ${chunk.length} exceeds max buffer ${SSE_READER_MAX_BUFFER} — refusing to accumulate`,
        code: 'TOOL_EXECUTION_FAILED',
        toolName: 'mcp_transport_sse_reader',
        context: { phase: 'feed', chunkLength: chunk.length, maxBuffer: SSE_READER_MAX_BUFFER },
      });
    }
    throw new ToolError({
      message: `SSE: pending line exceeds ${SSE_READER_MAX_BUFFER} bytes — upstream is not framing events`,
      code: 'TOOL_EXECUTION_FAILED',
      toolName: 'mcp_transport_sse_reader',
      context: {
        phase: 'feed',
        bufferLength: this.pendingLength,
        maxBuffer: SSE_READER_MAX_BUFFER,
      },
    });
  }

  private processLine(line: string): void {
    if (line.length > SSE_READER_MAX_BUFFER) {
      throw new ToolError({
        message: `SSE: completed line exceeds ${SSE_READER_MAX_BUFFER} characters`,
        code: 'TOOL_EXECUTION_FAILED',
        toolName: 'mcp_transport_sse_reader',
      });
    }
    if (line === '') {
      this.flush();
      return;
    }
    if (line.startsWith(':')) return;

    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      this.eventName = value;
    } else if (field === 'data') {
      const nextLength = this.dataLength + value.length + (this.dataLines.length > 0 ? 1 : 0);
      if (nextLength > SSE_READER_MAX_BUFFER) {
        throw new ToolError({
          message: `SSE: event data exceeds ${SSE_READER_MAX_BUFFER} characters`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: 'mcp_transport_sse_reader',
        });
      }
      if (this.dataLines.length >= SSE_READER_MAX_DATA_LINES) {
        throw new ToolError({
          message: `SSE: exceeded ${SSE_READER_MAX_DATA_LINES} data lines per event — upstream is not sending blank-line delimiters`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: 'mcp_transport_sse_reader',
          context: {
            phase: 'processLine',
            dataLineCount: this.dataLines.length,
            maxDataLines: SSE_READER_MAX_DATA_LINES,
          },
        });
      }
      this.dataLength = nextLength;
      this.dataLines.push(value);
    }
  }

  private flush(): void {
    const eventName = this.eventName;
    this.eventName = '';
    this.dataLength = 0;
    if (this.dataLines.length === 0) {
      return;
    }
    const data = this.dataLines.join('\n').trim();
    this.dataLines = [];
    if (!data) return;
    if (eventName === 'endpoint') {
      const listeners = this.endpointListeners;
      for (const cb of [...listeners]) {
        if (listeners !== this.endpointListeners) break;
        if (!listeners.includes(cb)) continue;
        try {
          cb(data);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    try {
      const parsed = JSON.parse(data) as {
        jsonrpc?: string | undefined;
        method?: string | undefined;
        params?: unknown | undefined;
        id?: number | undefined;
      };
      this.dispatch(parsed);
    } catch {
      // ignore parse errors
    }
  }

  private dispatch(msg: {
    jsonrpc?: string | undefined;
    method?: string | undefined;
    params?: unknown | undefined;
    id?: number | undefined;
  }): void {
    const listeners = this.listeners;
    for (const cb of [...listeners]) {
      if (listeners !== this.listeners) break;
      if (!listeners.includes(cb)) continue;
      try {
        cb(msg);
      } catch {
        /* ignore */
      }
    }
  }

  reset(): void {
    this.pending = [];
    this.pendingLength = 0;
    this.skipLeadingLF = false;
    this.dataLines = [];
    this.eventName = '';
    this.dataLength = 0;
    this.listeners = [];
    this.endpointListeners = [];
  }
}
