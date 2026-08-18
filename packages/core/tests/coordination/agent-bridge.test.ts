import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryAgentBridge,
  InMemoryBridgeTransport,
  createMessage,
} from '../../src/coordination/agent-bridge.js';

describe('InMemoryBridgeTransport', () => {
  let transport: InMemoryBridgeTransport;

  beforeEach(() => {
    transport = new InMemoryBridgeTransport();
  });

  it('delivers message to subscribed handler', async () => {
    let received: any;
    const unsub = transport.subscribe('agent1', (msg) => {
      received = msg;
    });
    await transport.send(
      {
        id: '1',
        type: 'task',
        from: 'c',
        to: 'agent1',
        payload: {},
        timestamp: Date.now(),
        priority: 'normal',
      },
      'agent1',
    );
    expect(received).toBeDefined();
    expect(received.id).toBe('1');
    unsub();
  });

  it('subscribe returns unsubscribe function', () => {
    let count = 0;
    const unsub = transport.subscribe('agent1', () => {
      count++;
    });
    transport.send(
      {
        id: '1',
        type: 'task',
        from: 'c',
        to: 'agent1',
        payload: {},
        timestamp: Date.now(),
        priority: 'normal',
      },
      'agent1',
    );
    unsub();
    transport.send(
      {
        id: '2',
        type: 'task',
        from: 'c',
        to: 'agent1',
        payload: {},
        timestamp: Date.now(),
        priority: 'normal',
      },
      'agent1',
    );
    expect(count).toBe(1);
  });

  it('close removes subscription', async () => {
    let count = 0;
    transport.subscribe('agent1', () => {
      count++;
    });
    await transport.close('agent1');
    await transport.send(
      {
        id: '1',
        type: 'task',
        from: 'c',
        to: 'agent1',
        payload: {},
        timestamp: Date.now(),
        priority: 'normal',
      },
      'agent1',
    );
    expect(count).toBe(0);
  });

  it('send to unknown agent does not throw', async () => {
    await expect(
      transport.send(
        {
          id: '1',
          type: 'task',
          from: 'c',
          to: 'ghost',
          payload: {},
          timestamp: Date.now(),
          priority: 'normal',
        },
        'ghost',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('InMemoryAgentBridge', () => {
  let transport: InMemoryBridgeTransport;
  let bridge: InMemoryAgentBridge;

  beforeEach(() => {
    transport = new InMemoryBridgeTransport();
    bridge = new InMemoryAgentBridge({ agentId: 'agent1', coordinatorId: 'coord1' }, transport);
  });

  afterEach(async () => {
    await bridge.stop();
  });

  it('has correct properties', () => {
    expect(bridge.agentId).toBe('agent1');
    expect(bridge.coordinatorId).toBe('coord1');
  });

  it('subscribe delivers messages', async () => {
    const messages: any[] = [];
    bridge.subscribe((msg) => {
      messages.push(msg);
    });

    const otherBridge = new InMemoryAgentBridge(
      { agentId: 'agent2', coordinatorId: 'coord1' },
      transport,
    );
    await otherBridge.send(createMessage('task', 'agent2', { data: 'hello' }, 'agent1'));
    await otherBridge.stop();

    expect(messages).toHaveLength(1);
    expect(messages[0].payload.data).toBe('hello');
  });

  it('broadcast reaches every other subscriber but not the sender', async () => {
    const messages: any[] = [];
    bridge.subscribe((msg) => {
      messages.push(msg);
    });

    const otherBridge = new InMemoryAgentBridge(
      { agentId: 'agent2', coordinatorId: 'coord1' },
      transport,
    );
    await otherBridge.broadcast(createMessage('task', 'agent2', { data: 'broadcast' }));
    await otherBridge.stop();

    // L2-E: broadcast delivers to all subscribers except the sender, so
    // agent1 sees agent2's broadcast exactly once.
    expect(messages).toHaveLength(1);
    expect(messages[0].payload.data).toBe('broadcast');
  });

  it('stopped subscriber stops receiving messages', async () => {
    const messages: any[] = [];
    bridge.subscribe((msg) => {
      messages.push(msg);
    });

    // Stop agent1 BEFORE the broadcast — it should not receive any new traffic.
    await bridge.stop();

    const otherBridge = new InMemoryAgentBridge(
      { agentId: 'agent2', coordinatorId: 'coord1' },
      transport,
    );
    await otherBridge.broadcast(createMessage('task', 'agent2', { data: 'test' }));
    await otherBridge.stop();

    expect(messages).toHaveLength(0);
  });

  it('request throws when bridge is stopped', async () => {
    await bridge.stop();
    await expect(
      bridge.request(createMessage('task', 'agent1', { data: 1 }, 'coord1'), 100),
    ).rejects.toThrow();
  });

  it('request throws on duplicate in-flight request id', async () => {
    const msg = createMessage('task', 'agent1', { data: 1 }, 'coord1');
    const p1 = bridge.request(msg, 500);
    // Second concurrent request with the same id is a caller bug — reject loudly.
    await expect(bridge.request(msg, 500)).rejects.toThrow('collides');
    // Resolve the first so we don't leak — send a result with the SAME id.
    transport.send(
      {
        ...msg,
        type: 'result' as const,
        from: 'coord1',
        to: 'agent1',
        payload: {},
        timestamp: Date.now(),
        priority: 'normal' as const,
      },
      'agent1',
    );
    await expect(p1).resolves.toBeDefined();
  });

  it('guard clears after timeout so the id can be reused', async () => {
    const msg = createMessage('task', 'agent1', { data: 1 }, 'coord1');
    // First request times out — guard + pending entry are both removed.
    const p1 = bridge.request(msg, 50);
    await expect(p1).rejects.toThrow('timed out');
    // After the timeout fires, the guard is removed — reuse is now safe.
    // Same id should NOT throw 'collides'.
    await expect(bridge.request(msg, 100)).rejects.toThrow('timed out');
  });

  it('guard clears when send() throws synchronously', async () => {
    // Create a transport whose send always rejects.
    const badTransport = {
      send: () => Promise.reject(new Error('send broken')),
      subscribe: () => () => {},
      close: () => Promise.resolve(),
    };
    const badBridge = new InMemoryAgentBridge(
      { agentId: 'bad', coordinatorId: 'coord1' },
      badTransport,
    );
    await expect(
      badBridge.request(createMessage('task', 'bad', {}, 'coord1'), 100),
    ).rejects.toThrow('send broken');
    // Id is free again — no "collides" error on retry.
    await expect(
      badBridge.request(createMessage('task', 'bad', {}, 'coord1'), 100),
    ).rejects.toThrow('send broken');
    await badBridge.stop();
  });
});

describe('createMessage', () => {
  it('creates a message with required fields', () => {
    const msg = createMessage('task', 'a1', { data: 42 });
    expect(msg.id).toBeDefined();
    expect(msg.type).toBe('task');
    expect(msg.from).toBe('a1');
    expect(msg.payload).toEqual({ data: 42 });
    expect(msg.timestamp).toBeDefined();
    expect(msg.priority).toBe('normal');
  });

  it('sets to field when provided', () => {
    const msg = createMessage('task', 'a1', { data: 1 }, 'a2');
    expect(msg.to).toBe('a2');
  });

  it('omits to when not provided', () => {
    const msg = createMessage('task', 'a1', { data: 1 });
    expect(msg.to).toBeUndefined();
  });
});
