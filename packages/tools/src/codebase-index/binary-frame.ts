/**
 * Binary frame protocol for the codebase-index IPC server.
 *
 * Replaces newline-delimited JSON with a length-prefixed MessagePack binary
 * format. The first byte of every frame is a magic value that distinguishes
 * binary from JSON — so a mixed-protocol socket is never ambiguous:
 *
 *  - `0x57` ('W') → binary frame: [magic] [uint32 BE length] [MessagePack]
 *  - anything else → the byte is part of a JSON text line terminated by `\n`
 *
 * There is no negotiated mode switch — the receiver sniffs every frame's
 * first byte (see `consume()` in project-server.ts and the client's unified
 * reader), so JSON and binary frames interleave freely on one socket:
 *  - the server's `hello` frame advertises `binarySupported: true` (always
 *    JSON, so any client can read it);
 *  - a client that wants binary simply sends binary frames
 *    (opt-in via WRONGSTACK_INDEX_BINARY=1 — the benchmark showed NDJSON is
 *    faster for this workload, so it stays the default);
 *  - the server answers each request in that request's framing, and latches
 *    outbound to binary once a client has sent any binary frame.
 *
 * Backward compatibility: a JSON-only client never sees a binary byte, and a
 * binary client's frames are self-describing — the protocolVersion + buildId
 * handshake already prevents a binary build from talking to a JSON-only build
 * of a different version (the buildId changes when the compiled artifact
 * changes), so there is no protocol ambiguity in practice.
 */

import { decode, encode } from '@msgpack/msgpack';

/** Magic byte that prefixes every binary frame. 'W' for WrongStack. */
export const BINARY_FRAME_MAGIC = 0x57;

/**
 * Hard cap on one binary frame's declared payload length. A malformed or
 * hostile peer could claim a 4 GiB frame and stall the reader; this bound is
 * far above any legitimate IPC response.
 */
export const MAX_BINARY_FRAME_BYTES = 256 * 1024 * 1024;

/**
 * Cap on one INBOUND (client → server) binary frame. Requests are tiny (an
 * op name plus a few arguments; the largest is an explicit reindex file
 * list), and unlike responses this direction is readable before any auth
 * check — a local client could otherwise declare a huge frame and make the
 * server wait for and accumulate it. The check runs the moment the five-byte
 * header is complete, so the connection is destroyed without ever buffering
 * toward the declared length (bytes already delivered in the current socket
 * chunk are freed with the destroyed connection). Matches the JSON request
 * ceiling (PROJECT_INDEX_SERVER_MAX_FRAME_CHARS, 64 Mi) so neither framing
 * offers a larger unauthenticated write than the other.
 */
export const MAX_INBOUND_BINARY_FRAME_BYTES = 64 * 1024 * 1024;

/** True if a byte stream begins with the binary-frame magic. */
export function isBinaryFrame(firstByte: number): boolean {
  return firstByte === BINARY_FRAME_MAGIC;
}

/**
 * Encode a message as a binary frame: [magic] [uint32 BE length] [MessagePack].
 * Returns a single Buffer ready to write to the socket.
 *
 * `undefined`-valued properties are stripped before encoding: MessagePack
 * would encode them as `nil` (arriving as `null`), while the JSON framing
 * drops them entirely — callers must not observe a different payload shape
 * just because they negotiated binary. Plain objects are normalized
 * recursively; arrays and class instances pass through untouched.
 */
export function encodeBinaryFrame(message: unknown): Buffer {
  const payload = encode(normalizeUndefined(message));
  const header = Buffer.allocUnsafe(5);
  header[0] = BINARY_FRAME_MAGIC;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload], 5 + payload.length);
}

function normalizeUndefined(value: unknown): unknown {
  // Arrays of plain objects are the standard response shape (`SearchResult[]`
  // carries `lspKind: undefined`) — recurse element-wise, preserving the array.
  if (Array.isArray(value)) return value.map((entry) => normalizeUndefined(entry));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = normalizeUndefined(entry);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Decode a MessagePack payload (the bytes after the magic + length header).
 * Throws if the payload is not valid MessagePack.
 */
export function decodeBinaryFrame(payload: Uint8Array): unknown {
  return decode(payload);
}

/**
 * Encode a message as a JSON text frame, terminated by `\n`.
 * This is the original wire format — kept for fallback and handshake.
 */
export function encodeJsonFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
