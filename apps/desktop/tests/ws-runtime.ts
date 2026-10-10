import type { WebSocketServer as Server } from 'ws';
import { WebSocketServer as NativeServer } from 'ws/native';

export { WebSocket } from '../src/main/ws-runtime.js';
export const WebSocketServer: typeof Server = NativeServer;
export type WebSocketServer = Server;
