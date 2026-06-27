import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ACPMessage } from '../src/types/acp-messages.js';

// Mock the transport (so no process.stdin is touched) and the protocol handler
// (so we fully control the server's read→dispatch loop).
const h = vi.hoisted(() => ({
  transports: [] as MockTransport[],
  handlers: [] as MockHandler[],
}));

interface MockTransport {
  sendStartupMarker: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
}
interface MockHandler {
  handleMessage: ReturnType<typeof vi.fn>;
}

vi.mock('../src/agent/stdio-transport.js', () => {
  class StdioTransport {
    sendStartupMarker = vi.fn();
    close = vi.fn();
    read = vi.fn(async () => null);
    constructor() {
      h.transports.push(this as never as MockTransport);
    }
  }
  return { StdioTransport };
});

vi.mock('../src/agent/protocol-handler.js', () => {
  class ACPProtocolHandler {
    handleMessage = vi.fn(async () => false);
    constructor() {
      h.handlers.push(this as never as MockHandler);
    }
  }
  return { ACPProtocolHandler };
});

import { WrongStackACPServer } from '../src/agent/wrongstack-acp-agent.js';

const lastTransport = () => h.transports[h.transports.length - 1]!;
const lastHandler = () => h.handlers[h.handlers.length - 1]!;

beforeEach(() => {
  h.transports.length = 0;
  h.handlers.length = 0;
});

describe('WrongStackACPServer', () => {
  it('constructs a transport and a protocol handler', () => {
    new WrongStackACPServer();
    expect(h.transports).toHaveLength(1);
    expect(h.handlers).toHaveLength(1);
  });

  it('accepts a custom agent name without error', () => {
    expect(() => new WrongStackACPServer({ agentName: 'acme' })).not.toThrow();
  });

  it('start dispatches messages and stops at EOF without non-JSON stdout by default', async () => {
    const server = new WrongStackACPServer();
    const t = lastTransport();
    const handler = lastHandler();
    t.read
      .mockResolvedValueOnce({ method: 'initialize', id: 1 } as ACPMessage)
      .mockResolvedValueOnce({ method: 'ping', id: 2 } as ACPMessage)
      .mockResolvedValueOnce(null);

    await server.start();

    expect(t.sendStartupMarker).not.toHaveBeenCalled();
    expect(handler.handleMessage).toHaveBeenCalledTimes(2);
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it('can emit the legacy startup marker when explicitly requested', async () => {
    const server = new WrongStackACPServer({ legacyStartupMarker: true });
    const t = lastTransport();
    t.read.mockResolvedValueOnce(null);

    await server.start();

    expect(t.sendStartupMarker).toHaveBeenCalledTimes(1);
  });

  it('start stops when the handler reports a terminal message', async () => {
    const server = new WrongStackACPServer();
    const t = lastTransport();
    const handler = lastHandler();
    // read always yields a message; only the terminal handler result breaks the loop.
    t.read.mockResolvedValue({ method: 'bye', id: 1 } as ACPMessage);
    handler.handleMessage.mockResolvedValueOnce(true);

    await server.start();

    expect(handler.handleMessage).toHaveBeenCalledTimes(1);
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it('stop closes the transport', () => {
    const server = new WrongStackACPServer();
    const t = lastTransport();
    server.stop();
    expect(t.close).toHaveBeenCalled();
  });
});
