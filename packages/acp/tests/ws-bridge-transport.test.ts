/**
 * Tests for the WebSocket server bridge transport and its integration with
 * `ACPProtocolHandler` — including a live permission round-trip (the thing a
 * full-duplex WS connection enables that HTTP cannot).
 */
import { describe, expect, it } from 'vitest';
import { ACPProtocolHandler, type RunTurn } from '../src/agent/protocol-handler.js';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';
import { WsBridgeTransport } from '../src/agent/ws-bridge-transport.js';
import type { ACPMessage } from '../src/types/acp-messages.js';

describe('WsBridgeTransport', () => {
  it('writes outbound to the sink and routes inbound to onMessage handlers', async () => {
    const sink: ACPMessage[] = [];
    const t = new WsBridgeTransport((m) => sink.push(m));
    const seen: ACPMessage[] = [];
    t.onMessage((m) => seen.push(m));

    await t.send({ jsonrpc: '2.0', id: 1, result: {} } as never as ACPMessage);
    expect(sink).toHaveLength(1);

    t.receive({ jsonrpc: '2.0', id: 2, method: 'ping' } as never as ACPMessage);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: 2, method: 'ping' });

    t.close();
    t.receive({ jsonrpc: '2.0', id: 3 } as never as ACPMessage);
    expect(seen).toHaveLength(1); // no dispatch after close
  });

  it('read() always resolves to null (no read-loop model for WS transport)', async () => {
    const t = new WsBridgeTransport(() => {});
    expect(await t.read()).toBeNull();
  });

  it('sendRaw() does nothing for WS transport', () => {
    const sink: ACPMessage[] = [];
    const t = new WsBridgeTransport((m) => sink.push(m));
    t.sendRaw();
    expect(sink).toHaveLength(0);
  });

  it('ignores closed sends, sink failures, faulty consumers, and unsubscriptions', async () => {
    const broken = new WsBridgeTransport(() => {
      throw new Error('socket closed');
    });
    await expect(broken.send({ id: 1 } as ACPMessage)).resolves.toBeUndefined();

    const seen: ACPMessage[] = [];
    const transport = new WsBridgeTransport(() => {});
    transport.onMessage(() => {
      throw new Error('consumer failed');
    });
    const unsubscribe = transport.onMessage((message) => seen.push(message));
    unsubscribe();
    transport.receive({ id: 2 } as ACPMessage);
    expect(seen).toEqual([]);

    transport.close();
    await expect(transport.send({ id: 3 } as ACPMessage)).resolves.toBeUndefined();
  });

  it('drives a full prompt turn with a live permission round-trip over the bridge', async () => {
    const sink: ACPMessage[] = [];
    const t = new WsBridgeTransport((m) => sink.push(m));

    let outcome: unknown;
    const runTurn: RunTurn = async (_input, _emit, api) => {
      outcome = await api!.requestPermission({
        toolCall: { toolCallId: 'tc1', title: 'write x', kind: 'edit' },
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
      });
      return { stopReason: 'end_turn' };
    };
    const handler = new ACPProtocolHandler({
      transport: t as never as AgentServerTransport,
      defaultCwd: '/test',
      runTurn,
    });

    // Mirror the WS glue: each inbound message is fed to receive() + handleMessage().
    const feed = async (msg: unknown): Promise<void> => {
      t.receive(msg as never as ACPMessage);
      await handler.handleMessage(msg);
    };

    await feed({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await feed({ id: 2, method: 'session/new', params: { cwd: '/test' } });
    const sessionId = (sink[sink.length - 1] as { result?: { sessionId?: string } }).result
      ?.sessionId!;
    sink.length = 0;

    // Start the turn without awaiting — it parks on requestPermission.
    const turnDone = feed({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'edit' }] },
    });
    await new Promise((r) => setImmediate(r));

    const req = sink.find(
      (m) => (m as { method?: string }).method === 'session/request_permission',
    ) as { id: string } | undefined;
    expect(req).toBeDefined();

    // Client answers over the same socket (full-duplex).
    await feed({
      id: req!.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    });
    await turnDone;

    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
  });
});
