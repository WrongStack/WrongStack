/**
 * Tests for the v1 ACPProtocolHandler.
 *
 * Uses a fake transport (records every `send`) and a fake `runTurn`
 * (canned stopReason + optional stream of updates) so the handler can
 * be exercised without spawning any real agent or subprocess.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';
import {
  ACPProtocolHandler,
  WRONGSTACK_VERSION,
  type RunTurn,
  type RunTurnResult,
} from '../src/agent/protocol-handler.js';

interface FakeTransport {
  sent: unknown[];
  send: ReturnType<typeof vi.fn>;
  sendStartupMarker?: () => void;
  read?: () => Promise<unknown>;
  close?: () => void;
}

function fakeTransport(): FakeTransport {
  const sent: unknown[] = [];
  return {
    sent,
    send: vi.fn(async (msg: unknown) => {
      sent.push(msg);
    }),
  };
}

const PASSON_RUN_TURN: RunTurn = async (_input, _emit) => {
  return { stopReason: 'end_turn' };
};

const ABORTING_RUN_TURN: RunTurn = async (input) => {
  return new Promise<RunTurnResult>((resolve) => {
    input.signal.addEventListener('abort', () => {
      resolve({ stopReason: 'cancelled' });
    });
  });
};

function makeHandler(opts: {
  runTurn?: RunTurn;
  defaultCwd?: string;
} = {}): { handler: ACPProtocolHandler; transport: FakeTransport } {
  const transport = fakeTransport();
  const handler = new ACPProtocolHandler({
    transport: transport as never as AgentServerTransport,
    defaultCwd: opts.defaultCwd ?? '/test',
    runTurn: opts.runTurn ?? PASSON_RUN_TURN,
  });
  return { handler, transport };
}

describe('ACPProtocolHandler', () => {
  describe('initialization', () => {
    it('returns v1 capabilities and marks initialized', async () => {
      const { handler, transport } = makeHandler();
      const terminal = await handler.handleMessage({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      });
      expect(terminal).toBe(false);
      expect(transport.sent).toHaveLength(1);
      const resp = transport.sent[0] as { result?: Record<string, unknown> };
      expect(resp.result).toMatchObject({
        protocolVersion: 1,
        agentInfo: { name: 'wrongstack', title: 'WrongStack', version: WRONGSTACK_VERSION },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        authMethods: [
          {
            id: 'wrongstack-auth',
            name: 'Run wstack auth',
            type: 'terminal',
            args: ['auth'],
          },
        ],
      });
    });

    it('rejects a non-v1 protocol version with -32000', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 99 } });
      const resp = transport.sent[0] as { error?: { code: number; message: string } };
      expect(resp.error?.code).toBe(-32000);
      expect(resp.error?.message).toContain('protocolVersion=1');
    });

    it('rejects non-initialize requests before initialization', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'session/new', params: { cwd: '/x' } });
      const resp = transport.sent[0] as { error?: { code: number; message: string } };
      expect(resp.error?.code).toBe(-32000);
      expect(resp.error?.message).toBe('Not initialized');
    });

    it('accepts a second initialize (idempotent re-init)', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'initialize', params: { protocolVersion: 1 } });
      expect(transport.sent).toHaveLength(2);
    });
  });

  describe('authenticate', () => {
    it('returns the unauthenticated outcome', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0; // clear the initialize response
      await handler.handleMessage({ id: 2, method: 'authenticate', params: {} });
      const resp = transport.sent[0] as { result?: { outcome: string } };
      expect(resp.result).toEqual({ outcome: 'unauthenticated' });
    });
  });

  describe('session/new', () => {
    it('creates a session, emits current_mode_update, returns the id', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;

      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/proj' } });

      // Two new sends: notification + result
      expect(transport.sent.length).toBe(2);
      const note = transport.sent[0] as { method?: string; params?: { update?: { sessionUpdate?: string; modeId?: string } } };
      expect(note.method).toBe('session/update');
      expect(note.params?.update?.sessionUpdate).toBe('current_mode_update');
      expect(note.params?.update?.modeId).toBe('code');

      const resp = transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } };
      expect(resp.result?.sessionId).toMatch(/^sess_/);
    });
  });

  describe('session/list', () => {
    it('returns an empty list initially, then includes created sessions', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/list' });
      const r1 = transport.sent[transport.sent.length - 1] as { result?: { sessions: unknown[] } };
      expect(r1.result?.sessions).toEqual([]);

      transport.sent.length = 0;
      await handler.handleMessage({ id: 3, method: 'session/new', params: { cwd: '/x' } });
      const newResp = transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } };
      const newId = newResp.result?.sessionId;
      transport.sent.length = 0;
      await handler.handleMessage({ id: 4, method: 'session/list' });
      const r2 = transport.sent[0] as { result?: { sessions: { sessionId: string }[] } };
      expect(r2.result?.sessions.map((s) => s.sessionId)).toEqual([newId]);
    });
  });

  describe('session/prompt', () => {
    it('runs the turn and returns the stopReason', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
      });
      const resp = transport.sent[transport.sent.length - 1] as { result?: { stopReason?: string } };
      expect(resp.result?.stopReason).toBe('end_turn');
    });

    it('streams session/update notifications emitted by runTurn', async () => {
      const streamingRunTurn: RunTurn = async (_input, emit) => {
        emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello ' },
        });
        emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
        });
        return { stopReason: 'end_turn' };
      };
      const { handler, transport } = makeHandler({ runTurn: streamingRunTurn });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      });

      // Three sends: 2 chunk notifications + 1 prompt response
      expect(transport.sent.length).toBe(3);
      const note1 = transport.sent[0] as { params?: { update?: { sessionUpdate?: string } } };
      expect(note1.params?.update?.sessionUpdate).toBe('agent_message_chunk');
      const note2 = transport.sent[1] as { params?: { update?: { sessionUpdate?: string } } };
      expect(note2.params?.update?.sessionUpdate).toBe('agent_message_chunk');
      const resp = transport.sent[2] as { result?: { stopReason?: string } };
      expect(resp.result?.stopReason).toBe('end_turn');
    });

    it('cancels the in-flight turn on session/cancel notification', async () => {
      const { handler, transport } = makeHandler({ runTurn: ABORTING_RUN_TURN });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      // Kick off a turn without awaiting
      const turnDone = handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      });
      // Let the turn register its signal listener
      await new Promise((r) => setImmediate(r));
      // Send the cancel
      await handler.handleMessage({ method: 'session/cancel', params: { sessionId } });
      // Now wait for the turn to resolve
      await turnDone;
      const resp = transport.sent[transport.sent.length - 1] as { result?: { stopReason?: string } };
      expect(resp.result?.stopReason).toBe('cancelled');
    });

    it('rejects a prompt with a missing sessionId', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({
        id: 2,
        method: 'session/prompt',
        params: { prompt: [{ type: 'text', text: 'hi' }] },
      });
      const resp = transport.sent[0] as { error?: { code: number; message: string } };
      expect(resp.error?.code).toBe(-32000);
    });
  });

  describe('session/set_mode', () => {
    it('updates the mode and emits current_mode_update', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/set_mode',
        params: { sessionId, modeId: 'code' },
      });
      expect(transport.sent.length).toBe(2); // notification + result
      const note = transport.sent[0] as { params?: { update?: { modeId?: string } } };
      expect(note.params?.update?.modeId).toBe('code');
    });

    it('rejects an unknown modeId', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/set_mode',
        params: { sessionId, modeId: 'bogus' },
      });
      const resp = transport.sent[0] as { error?: { code: number } };
      expect(resp.error?.code).toBe(-32602);
    });
  });

  describe('unknown method', () => {
    it('returns -32601', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'made_up_method' });
      const resp = transport.sent[0] as { error?: { code: number } };
      expect(resp.error?.code).toBe(-32601);
    });
  });

  describe('close', () => {
    it('aborts active turns and clears session state', async () => {
      const { handler, transport } = makeHandler({ runTurn: ABORTING_RUN_TURN });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      // Kick off a turn without awaiting
      const turnDone = handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      });
      await new Promise((r) => setImmediate(r));
      handler.close();
      // The pending turn should resolve because the runTurn's signal fires.
      await turnDone;
    });
  });
});
