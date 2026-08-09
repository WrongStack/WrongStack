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
 * Negotiation happens during the existing handshake:
 *  1. The server's `hello` frame includes `binarySupported: true` (always JSON)
 *  2. If the client supports binary, it sends `acceptsBinary: true` in its
 *     first authenticated request (still JSON, so the server can read it)
 *  3. Both sides switch to binary framing for all subsequent frames on that
 *     socket
 *
 * Backward compatibility: if either side does not advertise binary support,
 * the connection stays on newline-delimited JSON. The protocolVersion + buildId
 * handshake already prevents a binary build from talking to a JSON-only build
 * of a different version (the buildId changes when the compiled artifact
 * changes), so there is no protocol ambiguity in practice.
 */

import { decode, encode } from '@msgpack/msgpack';

/** Magic byte that prefixes every binary frame. 'W' for WrongStack. */
export const BINARY_FRAME_MAGIC = 0x57;

/** True if a byte stream begins with the binary-frame magic. */
export function isBinaryFrame(firstByte: number): boolean {
  return firstByte === BINARY_FRAME_MAGIC;
}

/**
 * Encode a message as a binary frame: [magic] [uint32 BE length] [MessagePack].
 * Returns a single Buffer ready to write to the socket.
 */
export function encodeBinaryFrame(message: unknown): Buffer {
  const payload = encode(message);
  const header = Buffer.allocUnsafe(5);
  header[0] = BINARY_FRAME_MAGIC;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload], 5 + payload.length);
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
