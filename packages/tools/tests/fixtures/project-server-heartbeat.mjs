import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { encodeProjectServerMessage } from '../../src/codebase-index/project-server-protocol.ts';

// Keep heartbeats independent of the Vitest worker's synchronous transforms.
const endpoint = process.argv[2];
const deadline = Date.now() + 5_000;
let socket;
let heartbeat;
let stopCheck;
let requestId = 1;
let ready = false;
process.stdout.write('WAITING\n');

function connect() {
  if (!existsSync(process.argv[3])) {
    if (Date.now() >= deadline) throw new Error('daemon metadata did not appear');
    setTimeout(connect, 20);
    return;
  }
  socket = createConnection(endpoint);
  let connected = false;
  let buffer = '';
  let authToken;
  socket.on('connect', () => {
    connected = true;
    const ping = () =>
      socket.write(encodeProjectServerMessage({ type: 'ping', id: requestId++, authToken }));
    ping();
    heartbeat = setInterval(ping, 40);
    stopCheck = setInterval(() => {
      if (existsSync(process.argv[4])) {
        clearInterval(heartbeat);
        clearInterval(stopCheck);
        // Keep the socket open: the daemon must expire the ghost itself.
      }
    }, 20);
  });
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (frame.type === 'hello') {
        ({ authToken } = JSON.parse(readFileSync(process.argv[3], 'utf8')));
      }
      if (!ready && frame.type === 'response' && frame.ok) {
        ready = true;
        process.stdout.write('READY\n');
      }
      newline = buffer.indexOf('\n');
    }
  });
  socket.on('error', (error) => {
    if (connected) process.stderr.write(`heartbeat socket: ${error.code}: ${error.message}\n`);
  });
  socket.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(stopCheck);
    // A connected pipe is not a completed handshake. Retry startup closes
    // within the original deadline, but never reconnect after a successful ping.
    if (!ready && Date.now() < deadline) {
      setTimeout(connect, 20);
      return;
    }
    process.stdout.write('CLOSED\n');
    if (!ready) process.exitCode = 1;
  });
}

connect();
