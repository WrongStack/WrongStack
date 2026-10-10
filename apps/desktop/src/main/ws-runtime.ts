import type { WebSocket as Socket } from 'ws';
import { WebSocket as NativeSocket } from 'ws/native';

export const WebSocket: typeof Socket = NativeSocket;
export type WebSocket = Socket;
