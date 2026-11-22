import type * as net from 'node:net';
import { decodeBinaryFrame, isBinaryFrame, MAX_BINARY_FRAME_BYTES } from './binary-frame.js';
import {
  connectionStates,
  projectIndexServerExpectedBuildId,
  remoteError,
  shouldReplaceProjectIndexServer,
} from './project-server-client-state.js';
import { PROJECT_INDEX_SERVER_PROTOCOL_VERSION } from './project-server-endpoint.js';
import {
  PROJECT_INDEX_SERVER_MAX_FRAME_CHARS,
  type ProjectServerMessage,
} from './project-server-protocol.js';

export interface ProjectServerFramesHost {
  ensureHeartbeatLoop: () => void;
  socket: import('node:net').Socket | null;
  readBuffer: Buffer<ArrayBufferLike>;
  useBinary: boolean;
  transition: (
    status: import('./project-server-client-state.js').ProjectIndexServerConnectionStatus,
    options?: { pid?: number | undefined; error?: unknown },
  ) => void;
  onMessage: (message: import('./project-server-protocol.js').ProjectServerMessage) => void;
  rejectStaleServer: (
    message: import('./project-server-protocol.js').ProjectIndexServerInfo,
    reason: string,
  ) => void;
  info: import('./project-server-protocol.js').ProjectIndexServerInfo | null;
  markResponsive: () => void;
  connectResolve: (() => void) | null;
  activity: import('./project-server-protocol.js').ProjectIndexServerActivity | null;
  pending: Map<number, import('./project-server-client-state.js').PendingRequest>;
  endpoint: string;
  cleanupPending: (entry: import('./project-server-client-state.js').PendingRequest) => void;
  authToken: string | undefined;
}

export function onData(this: ProjectServerFramesHost, socket: net.Socket, chunk: Buffer): void {
  if (socket !== this.socket) return;
  this.readBuffer = this.readBuffer.length === 0 ? chunk : Buffer.concat([this.readBuffer, chunk]);
  while (true) {
    if (this.readBuffer.length === 0) return;
    if (this.useBinary && isBinaryFrame(this.readBuffer[0]!)) {
      if (this.readBuffer.length < 5) return; // header not fully received yet
      const frameLen = this.readBuffer.readUInt32BE(1);
      // Reject implausible frame lengths — a malicious or buggy server
      // could claim a 4 GiB payload and hang the client waiting for it.
      if (frameLen > MAX_BINARY_FRAME_BYTES) {
        socket.destroy();
        this.transition('offline', { error: 'binary frame length exceeds the IPC limit' });
        return;
      }
      if (this.readBuffer.length < 5 + frameLen) return; // payload incomplete
      const payload = this.readBuffer.subarray(5, 5 + frameLen);
      this.readBuffer = this.readBuffer.subarray(5 + frameLen);
      let decoded: unknown;
      try {
        decoded = decodeBinaryFrame(payload);
      } catch {
        socket.destroy(new Error('invalid binary codebase-index server response'));
        return;
      }
      if (!isServerMessage(decoded)) {
        socket.destroy(new Error('invalid binary codebase-index server response'));
        return;
      }
      this.onMessage(decoded);
      continue;
    }
    const newline = this.readBuffer.indexOf(0x0a);
    if (newline < 0) {
      if (this.readBuffer.length > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
        socket.destroy(new Error('codebase-index server response exceeds the IPC limit'));
      }
      return;
    }
    if (newline > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
      socket.destroy(new Error('codebase-index server response exceeds the IPC limit'));
      return;
    }
    const line = this.readBuffer.subarray(0, newline).toString('utf8');
    this.readBuffer = this.readBuffer.subarray(newline + 1);
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      socket.destroy(new Error('invalid codebase-index server response'));
      return;
    }
    // `onMessage` reads `message.type` inside a socket 'data' handler: a
    // `null` frame threw there as an uncaught exception in THIS process.
    if (!isServerMessage(parsed)) {
      socket.destroy(new Error('invalid codebase-index server response'));
      return;
    }
    this.onMessage(parsed);
  }
}

export function onMessage(this: ProjectServerFramesHost, message: ProjectServerMessage): void {
  if (message.type === 'hello') {
    if (message.protocolVersion !== PROJECT_INDEX_SERVER_PROTOCOL_VERSION) {
      this.rejectStaleServer(
        message,
        `codebase-index protocol mismatch: client=${PROJECT_INDEX_SERVER_PROTOCOL_VERSION}, server=${message.protocolVersion}`,
      );
      return;
    }
    const expectedBuildId = projectIndexServerExpectedBuildId();
    if (
      expectedBuildId &&
      message.buildId !== expectedBuildId &&
      shouldReplaceProjectIndexServer(message.builtAt)
    ) {
      this.rejectStaleServer(
        message,
        `codebase-index build mismatch: client=${expectedBuildId}, server=${message.buildId ?? 'legacy'}`,
      );
      return;
    }
    this.info = message;
    this.markResponsive();
    // P6: binary framing is opt-in (WRONGSTACK_INDEX_BINARY=1). The server
    // advertises the capability, but benchmarks (2026-08, Windows named
    // pipe, 100-result search) show MessagePack round-trips ~1.9× slower
    // than NDJSON — V8's native JSON beats the pure-JS msgpack codec — for
    // only 8.3% wire savings. Default traffic stays NDJSON; the env var
    // flips this socket to binary on the next write.
    if (message.binarySupported && binaryFramingEnabled()) this.useBinary = true;
    this.transition('connected', { pid: message.pid });
    this.ensureHeartbeatLoop();
    this.connectResolve?.();
    return;
  }
  if (message.type === 'index-state') {
    this.activity = message.state;
    this.markResponsive();
    this.transition('connected', { pid: this.info?.pid });
    return;
  }

  const entry = this.pending.get(message.id);
  if (!entry) return;
  this.markResponsive();
  const status = connectionStates.get(this.endpoint)?.status;
  if (status === 'degraded' || status === 'unresponsive') {
    this.transition('connected', { pid: this.info?.pid });
  }
  if (message.type === 'progress') {
    entry.onProgress?.(message.current, message.total);
    return;
  }
  this.pending.delete(message.id);
  this.cleanupPending(entry);
  if (message.ok) entry.resolve(message.result);
  else {
    // Re-read the token on the next attempt: the file may name another daemon.
    if (message.errorName === 'UnauthorizedIndexRequest') this.authToken = undefined;
    entry.reject(remoteError(message.error, message.errorName));
  }
}

/**
 * Binary IPC framing is opt-in: `WRONGSTACK_INDEX_BINARY=1` makes the client
 * adopt MessagePack frames when the server advertises `binarySupported`.
 * Default is NDJSON — see the hello handler for the benchmark rationale.
 */
/** A decoded server frame is only handled when it is an object with a string `type`. */
export function isServerMessage(value: unknown): value is ProjectServerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

export function binaryFramingEnabled(): boolean {
  const flag = process.env['WRONGSTACK_INDEX_BINARY'];
  return flag === '1' || flag === 'true';
}
