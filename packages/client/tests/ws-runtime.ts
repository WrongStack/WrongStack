import type { WebSocketServer as Server, WebSocket as Socket } from 'ws';
import { WebSocketServer as NativeServer, WebSocket as NativeSocket } from 'ws/native';

export const WebSocket: typeof Socket = NativeSocket;
export type WebSocket = Socket;
export const WebSocketServer: typeof Server = NativeServer;
export type WebSocketServer = Server;
