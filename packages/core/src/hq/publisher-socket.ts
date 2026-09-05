import type { HqSocketLike } from './publisher-types.js';

export const OPEN_STATE = 1;

export function defaultSocketFactory(url: string): HqSocketLike {
  const WebSocketCtor = globalThis.WebSocket;
  if (WebSocketCtor === undefined) {
    throw new Error(
      'No global WebSocket implementation is available; provide HqPublisherOptions.socketFactory.',
    );
  }
  return new WebSocketCtor(url) as HqSocketLike;
}

export function toClientUrl(baseUrl: string, token: string | undefined): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws/client';
  if (token !== undefined && token.length > 0) url.searchParams.set('token', token);
  return url.toString();
}

export function addSocketListener(
  socket: HqSocketLike,
  type: 'open' | 'close' | 'error' | 'message',
  listener: (event: unknown) => void,
): void {
  if (socket.addEventListener !== undefined) {
    socket.addEventListener(type, listener);
    return;
  }
  socket.on?.(type, listener);
}

export function removeSocketListener(
  socket: HqSocketLike,
  type: 'open' | 'close' | 'error' | 'message',
  listener: (event: unknown) => void,
): void {
  if (socket.removeEventListener !== undefined) {
    socket.removeEventListener(type, listener);
    return;
  }
  socket.off?.(type, listener);
}

export function extractSocketMessageData(event: unknown): string | null {
  const value =
    typeof event === 'object' && event !== null && 'data' in event
      ? (event as { data?: unknown }).data
      : event;
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new TextDecoder().decode(bytes);
  }
  return null;
}
