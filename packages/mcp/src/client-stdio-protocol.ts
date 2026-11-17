import type { JsonRpcServerRequest, MCPClientOptions } from './client-types.js';
import type { JsonRpcResponse } from './contracts.js';
import type { ServerRequestResponder } from './elicitation.js';
import {
  logMessageNotification,
  type MCPLogMessageNotification,
  type MCPProgressNotification,
  progressNotification,
  resourceUpdatedUri,
} from './protocol.js';
import { isJsonRpcResult } from './transport-jsonrpc.js';

/**
 * Maximum bytes the rx buffer may accumulate before the connection is
 * forcefully closed. A well-behaved JSON-RPC server emits newline-delimited
 * messages that are individually much smaller than this; a server that never
 * sends a newline would grow the buffer without limit and OOM the process.
 * 16 MiB is generous for any legitimate single message while bounding the
 * worst-case memory to a predictable cap.
 */

const MAX_RX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface ClientStdioProtocolHost {
  rxBufferBytes: number;
  rxParts: string[];
  failPending(reason: string): void;
  readonly opts: MCPClientOptions;
  close(): Promise<void>;
  onLine(line: string): void;
  handleServerRequest(request: JsonRpcServerRequest): Promise<void>;
  readonly serverRequests: ServerRequestResponder;
  handleToolsListChanged(): Promise<void>;
  emitCapabilityChanged(capability: 'resources' | 'prompts'): void;
  emitResourceUpdated(uri: string): void;
  emitProgress(progress: MCPProgressNotification): void;
  emitLogMessage(log: MCPLogMessageNotification): void;
  readonly pending: Map<
    number,
    { resolve: (res: JsonRpcResponse) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >;
}

export function receiveStdioData(host: ClientStdioProtocolHost, s: string): void {
  // The buffered tail never holds a newline, so only the new chunk is searched.
  let start = 0;
  for (;;) {
    const idx = s.indexOf('\n', start);
    const part = idx === -1 ? s.slice(start) : s.slice(start, idx);
    // Bound each frame, regardless of how stdout fragments or coalesces it.
    host.rxBufferBytes += Buffer.byteLength(part, 'utf8');
    if (host.rxBufferBytes > MAX_RX_BUFFER_BYTES) {
      const truncated = host.rxBufferBytes;
      host.rxParts = [];
      host.rxBufferBytes = 0;
      host.failPending(
        `MCP "${host.opts.name}" rx buffer overflow (${truncated} bytes without a newline) — closing connection`,
      );
      void host.close();
      return;
    }
    if (idx === -1) {
      if (part) host.rxParts.push(part);
      return;
    }
    const head = host.rxParts.length > 0 ? host.rxParts.join('') : '';
    host.rxParts = [];
    host.rxBufferBytes = 0;
    const line = (head + part).trim();
    start = idx + 1;
    if (line) host.onLine(line);
  }
}

export function receiveStdioLine(host: ClientStdioProtocolHost, line: string): void {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof msg !== 'object' || msg === null) return;
  const envelope = msg as Record<string, unknown>;
  if (envelope['jsonrpc'] !== '2.0') return;

  // A server request is never a response, even if its id collides with one
  // of our pending calls. Resolve pending calls only after the envelope has
  // passed the strict response guard below.
  if (typeof envelope['method'] === 'string') {
    const id = envelope['id'];
    if (typeof id === 'number' || typeof id === 'string') {
      void host.handleServerRequest({
        jsonrpc: '2.0',
        id,
        method: envelope['method'],
        params: envelope['params'],
      });
      return;
    }

    // Notifications have a `method` but no `id`. The MCP spec defines
    // list_changed notifications for cache invalidation.
    if (Object.hasOwn(envelope, 'id')) return;
    if (envelope['method'] === 'notifications/cancelled') {
      host.serverRequests.cancel(envelope['params']);
    } else if (envelope['method'] === 'notifications/tools/list_changed') {
      void host.handleToolsListChanged();
    } else if (envelope['method'] === 'notifications/resources/list_changed') {
      host.emitCapabilityChanged('resources');
    } else if (envelope['method'] === 'notifications/prompts/list_changed') {
      host.emitCapabilityChanged('prompts');
    } else if (envelope['method'] === 'notifications/resources/updated') {
      const uri = resourceUpdatedUri(envelope['params']);
      if (uri) host.emitResourceUpdated(uri);
    } else if (envelope['method'] === 'notifications/progress') {
      const progress = progressNotification(envelope['params']);
      if (progress) host.emitProgress(progress);
    } else if (envelope['method'] === 'notifications/message') {
      const log = logMessageNotification(envelope['params']);
      if (log) host.emitLogMessage(log);
    }
    return;
  }

  if (!isJsonRpcResult(msg)) return;
  const response = msg as JsonRpcResponse;
  if (host.pending.has(response.id)) {
    const entry = host.pending.get(response.id);
    host.pending.delete(response.id);
    entry?.resolve(response);
  }
}
