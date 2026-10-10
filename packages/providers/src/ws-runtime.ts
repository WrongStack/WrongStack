import type Socket from 'ws';
import NativeSocket from 'ws/native';

const WebSocket: typeof Socket = NativeSocket;
export default WebSocket;
