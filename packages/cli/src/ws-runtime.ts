import type { WebSocketServer as Server, WebSocket as Socket } from 'ws';
import { WebSocketServer as NativeServer, WebSocket as NativeSocket } from 'ws/native';

// Preserve upstream public types while Bun loads the actual npm implementation.
export const WebSocket: typeof Socket = NativeSocket;
export type WebSocket = Socket;
export const WebSocketServer: typeof Server = NativeServer;
export type WebSocketServer = Server;
