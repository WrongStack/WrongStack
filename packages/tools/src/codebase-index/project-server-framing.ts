import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  isBinaryFrame,
  MAX_INBOUND_BINARY_FRAME_BYTES,
} from './binary-frame.js';
import {
  encodeProjectServerMessage,
  PROJECT_INDEX_SERVER_MAX_FRAME_CHARS,
  type ProjectServerClientMessage,
  type ProjectServerMessage,
} from './project-server-protocol.js';
import type { ClientState } from './project-server-types.js';

/**
 * Cap on outbound bytes queued for one client before it is dropped. This
 * server pushes index-activity updates to every client, and `socket.write()`
 * buffers without limit when its `false` return is ignored — so one client
 * that stops reading would otherwise grow the owner's heap indefinitely. The
 * index lives in SQLite; a dropped client re-queries on reconnect.
 */
export const MAX_CLIENT_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;

export function sendServerMessage(state: ClientState, message: ProjectServerMessage): void {
  if (state.socket.destroyed) return;
  if (state.socket.writableLength > MAX_CLIENT_WRITE_BUFFER_BYTES) {
    state.socket.destroy(new Error('Index client fell too far behind on reads'));
    return;
  }
  // Reply in the framing this connection negotiated: a client that has sent
  // at least one binary frame gets binary frames back; JSON-only clients
  // (and the pre-first-frame greeting) get newline-delimited JSON.
  state.socket.write(
    state.binary ? encodeBinaryFrame(message) : encodeProjectServerMessage(message),
  );
}

/**
 * Frame reader for one client connection. Each frame is sniffed per first
 * byte: `0x57` ('W') → length-prefixed MessagePack, anything else →
 * newline-delimited JSON text. Bytes stay raw until a complete frame is
 * assembled, so a multibyte UTF-8 sequence split across chunks is only ever
 * decoded as part of a finished line (raw `0x0a` only occurs as the JSON
 * delimiter — inside JSON strings `\n` is escaped — so a complete line is
 * always complete UTF-8).
 *
 * The buffer is consumed with a scan offset rather than re-slicing after
 * every frame: each parsed frame advances `scan` within the same Buffer,
 * and the leftover tail is compacted once at the end of the call. A burst
 * of small frames therefore costs one allocation per chunk, not one
 * per frame (the previous slice-per-frame loop reallocated on every frame
 * while pinning the whole parent buffer).
 */
export function consumeClientChunk(
  state: ClientState,
  chunk: Buffer,
  onMessage: (state: ClientState, message: ProjectServerClientMessage) => void,
): void {
  const buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
  let scan = 0;
  while (true) {
    if (buffer.length - scan === 0) break;
    if (isBinaryFrame(buffer[scan]!)) {
      if (buffer.length - scan < 5) break; // header not fully received yet
      const frameLen = buffer.readUInt32BE(scan + 1);
      // Inbound frames are client requests, checked against the inbound cap
      // the moment the five-byte header completes: the connection is
      // destroyed without waiting for or accumulating the declared payload.
      // This direction is unauthenticated at framing time.
      if (frameLen > MAX_INBOUND_BINARY_FRAME_BYTES) {
        state.buffer = Buffer.alloc(0);
        state.socket.destroy(new Error('codebase-index client binary frame exceeds the IPC limit'));
        return;
      }
      if (buffer.length - scan < 5 + frameLen) break; // payload incomplete
      const payload = buffer.subarray(scan + 5, scan + 5 + frameLen);
      let message: ProjectServerClientMessage;
      try {
        message = decodeBinaryFrame(payload) as ProjectServerClientMessage;
      } catch {
        state.buffer = Buffer.alloc(0);
        state.socket.destroy(new Error('invalid codebase-index client binary frame'));
        return;
      }
      scan += 5 + frameLen;
      state.binary = true;
      state.lastSeenAt = Date.now();
      onMessage(state, message);
      continue;
    }
    const newline = buffer.indexOf(0x0a, scan);
    if (newline < 0) {
      if (buffer.length - scan > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
        state.buffer = Buffer.alloc(0);
        state.socket.destroy(new Error('codebase-index client message exceeds the IPC limit'));
        // Like every other destroy path: return, so the post-loop
        // compaction cannot resurrect bytes from the stale local buffer.
        return;
      }
      break;
    }
    if (newline - scan > PROJECT_INDEX_SERVER_MAX_FRAME_CHARS) {
      state.buffer = Buffer.alloc(0);
      state.socket.destroy(new Error('codebase-index client message exceeds the IPC limit'));
      return;
    }
    const line = buffer.subarray(scan, newline).toString('utf8');
    scan = newline + 1;
    if (!line) continue;
    let message: ProjectServerClientMessage;
    try {
      message = JSON.parse(line) as ProjectServerClientMessage;
    } catch {
      state.buffer = Buffer.alloc(0);
      state.socket.destroy(new Error('invalid codebase-index client message'));
      return;
    }
    state.lastSeenAt = Date.now();
    onMessage(state, message);
  }
  // Compact the parsed prefix once per chunk instead of once per frame.
  // The tail is COPIED into a right-sized buffer: subarray would pin the
  // whole parent allocation, so an unauthenticated client sending a
  // near-64 MiB frame followed by a one-byte partial would hold ~64 MiB
  // per connection until more data arrived or the lease expired.
  state.buffer = scan === 0 ? buffer : Buffer.from(buffer.subarray(scan));
}
