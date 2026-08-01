/**
 * Tests for the v1 ACPProtocolHandler.
 *
 * Uses a fake transport (records every `send`) and a fake `runTurn`
 * (canned stopReason + optional stream of updates) so the handler can
 * be exercised without spawning any real agent or subprocess.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import {
  ACPProtocolHandler,
  protocolHandlerCoverage,
  type RunTurn,
  type RunTurnResult,
  WRONGSTACK_VERSION,
} from '../src/agent/protocol-handler.js';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';

/**
 * WS-015: `session/new` / `session/fork` / `session/load` now require a
 * client-supplied `cwd` to be an absolute path to an existing directory. These
 * fixtures were fictional absolute paths — placeholders that only
 * ever needed to be *some* cwd, never asserted as non-existent. They are real
 * temp directories now so the tests exercise the handler rather than the new
 * rejection path; the distinct names are preserved because a few assertions
 * compare one session's cwd against another's.
 */
const CWD_ROOT = mkdtempSync(nodePath.join(tmpdir(), 'acp-cwd-'));
function cwdFor(name: string): string {
  const dir = nodePath.join(CWD_ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const CWD_X = cwdFor('x');
const CWD_TEST = cwdFor('test');
const CWD_PROJ = cwdFor('proj');
const CWD_FORK = cwdFor('fork');
const CWD_FORKED = cwdFor('forked');
const CWD_LOAD = cwdFor('load');
const CWD_SAVED = cwdFor('saved');
const CWD_SOURCE = cwdFor('source');
const CWD_WORK = cwdFor('work');

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

function makeHandler(opts: { runTurn?: RunTurn; defaultCwd?: string } = {}): {
  handler: ACPProtocolHandler;
  transport: FakeTransport;
} {
  const transport = fakeTransport();
  const handler = new ACPProtocolHandler({
    transport: transport as never as AgentServerTransport,
    defaultCwd: opts.defaultCwd ?? CWD_TEST,
    runTurn: opts.runTurn ?? PASSON_RUN_TURN,
  });
  return { handler, transport };
}

describe('ACPProtocolHandler', () => {
  it('rejects session creation after the active-session cap', async () => {
    const transport = fakeTransport();
    const handler = new ACPProtocolHandler({
      transport: transport as never as AgentServerTransport,
      defaultCwd: CWD_TEST,
      runTurn: PASSON_RUN_TURN,
      maxSessions: 1,
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: {} });
    await handler.handleMessage({ id: 3, method: 'session/new', params: {} });
    expect(transport.sent.at(-1)).toMatchObject({
      id: 3,
      error: { message: 'active session limit reached (1)' },
    });
  });

  it('reports the package version instead of a hand-maintained protocol constant', () => {
    expect(WRONGSTACK_VERSION).toBe(packageJson.version);
  });
  describe('initialization', () => {
    it('returns v1 capabilities with full session and auth support', async () => {
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
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { close: {}, list: {}, delete: {}, resume: {} },
          auth: { logout: {} },
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

    it('negotiates down to its supported version when the client requests a newer one', async () => {
      // Per spec the agent must NOT error on a version mismatch — it replies
      // with the version it speaks and lets the client decide whether to
      // proceed. Erroring would break a forward-compatible client.
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 99 } });
      const resp = transport.sent[0] as { result?: { protocolVersion?: number }; error?: unknown };
      expect(resp.error).toBeUndefined();
      expect(resp.result?.protocolVersion).toBe(1);
    });

    it('rejects non-initialize requests before initialization', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'session/new', params: { cwd: CWD_X } });
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

      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_PROJ } });

      expect(transport.sent.length).toBe(2);
      const note = transport.sent[0] as {
        method?: string;
        params?: { update?: { sessionUpdate?: string; modeId?: string } };
      };
      expect(note.method).toBe('session/update');
      expect(note.params?.update?.sessionUpdate).toBe('current_mode_update');
      expect(note.params?.update?.modeId).toBe('code');

      const resp = transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } };
      expect(resp.result?.sessionId).toMatch(/^sess_/);
    });
  });

  describe('session/fork', () => {
    it('creates a distinct session and seeds it with the source history', async () => {
      const transport = fakeTransport();
      const histories = new Map<string, Array<{ sessionUpdate: string; content: unknown }>>();
      const seedFor = vi.fn(
        (sessionId: string, history: Array<{ sessionUpdate: string; content: unknown }>) => {
          histories.set(sessionId, history);
        },
      );
      const save = vi.fn().mockResolvedValue(undefined);
      const handler = new ACPProtocolHandler({
        transport: transport as never as AgentServerTransport,
        defaultCwd: CWD_TEST,
        runTurn: PASSON_RUN_TURN,
        replayFor: (sessionId) => histories.get(sessionId) ?? [],
        seedFor,
        store: { save, load: vi.fn().mockResolvedValue(null) },
      });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_SOURCE } });
      const sourceId = (transport.sent.at(-1) as { result?: { sessionId?: string } }).result
        ?.sessionId!;
      histories.set(sourceId, [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
      ]);
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/fork',
        params: { sessionId: sourceId, cwd: CWD_FORK },
      });

      const result = (transport.sent.at(-1) as { result?: { sessionId?: string } }).result;
      expect(result?.sessionId).toMatch(/^sess_/);
      expect(result?.sessionId).not.toBe(sourceId);
      expect(seedFor).toHaveBeenCalledWith(result?.sessionId, histories.get(sourceId));
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: result?.sessionId, cwd: CWD_FORK }),
        histories.get(sourceId),
      );
    });

    it('rejects a missing fork source', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({
        id: 2,
        method: 'session/fork',
        params: { sessionId: 'missing' },
      });
      expect((transport.sent.at(-1) as { error?: { code?: number } }).error?.code).toBe(-32000);
    });
  });

  describe('session/load', () => {
    it('loads an existing session from memory', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/load',
        params: { sessionId, cwd: CWD_X },
      });
      expect(transport.sent.length).toBeGreaterThanOrEqual(1);
      const resp = transport.sent[transport.sent.length - 1] as {
        result?: { initialMode?: { currentModeId?: string } };
      };
      expect(resp.result?.initialMode?.currentModeId).toBe('code');
    });

    it('returns error for a non-existent session', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({
        id: 2,
        method: 'session/load',
        params: { sessionId: 'sess_nonexist', cwd: CWD_X },
      });
      const resp = transport.sent[0] as { error?: { code: number } };
      expect(resp.error?.code).toBe(-32000);
    });
  });

  describe('session/resume', () => {
    it('resumes an existing session without history replay', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/resume',
        params: { sessionId, cwd: CWD_X },
      });
      const resp = transport.sent[transport.sent.length - 1] as {
        result?: { initialMode?: { currentModeId?: string } };
      };
      expect(resp.result?.initialMode?.currentModeId).toBe('code');
    });

    it('returns error for a non-existent session', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({
        id: 2,
        method: 'session/resume',
        params: { sessionId: 'sess_nonexist', cwd: CWD_X },
      });
      const resp = transport.sent[0] as { error?: { code: number } };
      expect(resp.error?.code).toBe(-32000);
    });
  });

  describe('session/close', () => {
    it('closes an active session gracefully', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({ id: 3, method: 'session/close', params: { sessionId } });
      const resp = transport.sent[transport.sent.length - 1] as { result?: {} };
      expect(resp.result).toEqual({});

      // Session should be removed from list
      transport.sent.length = 0;
      await handler.handleMessage({ id: 4, method: 'session/list' });
      const listResp = transport.sent[0] as { result?: { sessions: unknown[] } };
      expect(listResp.result?.sessions).toHaveLength(0);
    });

    it('returns error for a non-existent session', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({
        id: 2,
        method: 'session/close',
        params: { sessionId: 'sess_nonexist' },
      });
      const resp = transport.sent[0] as { error?: { code: number } };
      expect(resp.error?.code).toBe(-32000);
    });
  });

  describe('session/delete', () => {
    it('deletes a session from the list', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({ id: 3, method: 'session/delete', params: { sessionId } });
      const resp = transport.sent[transport.sent.length - 1] as { result?: {} };
      expect(resp.result).toEqual({});

      transport.sent.length = 0;
      await handler.handleMessage({ id: 4, method: 'session/list' });
      const listResp = transport.sent[0] as { result?: { sessions: unknown[] } };
      expect(listResp.result?.sessions).toHaveLength(0);
    });
  });

  describe('logout', () => {
    it('returns empty result', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'logout', params: {} });
      const resp = transport.sent[0] as { result?: {} };
      expect(resp.result).toEqual({});
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
      await handler.handleMessage({ id: 3, method: 'session/new', params: { cwd: CWD_X } });
      const newResp = transport.sent[transport.sent.length - 1] as {
        result?: { sessionId?: string };
      };
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
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
      });
      const resp = transport.sent[transport.sent.length - 1] as {
        result?: { stopReason?: string };
      };
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
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
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
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
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
      const resp = transport.sent[transport.sent.length - 1] as {
        result?: { stopReason?: string };
      };
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
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
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
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
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

  describe('notifications', () => {
    it('handles session/cancel for an active session without error', async () => {
      const { handler, transport } = makeHandler({ runTurn: ABORTING_RUN_TURN });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
      transport.sent.length = 0;

      // Send session/cancel notification
      const result = await handler.handleMessage({
        method: 'session/cancel',
        params: { sessionId },
      });
      expect(result).toBe(false);
    });

    it('handles session/cancel for a non-existent session without error', async () => {
      const { handler } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      const result = await handler.handleMessage({
        method: 'session/cancel',
        params: { sessionId: 'nonexistent' },
      });
      expect(result).toBe(false);
    });

    it('handles $/cancel_request notification', async () => {
      const { handler } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      const result = await handler.handleMessage({ method: '$/cancel_request' });
      expect(result).toBe(false);
    });

    it('handles exit notification and returns true', async () => {
      const { handler } = makeHandler();
      const result = await handler.handleMessage({ method: 'exit' });
      expect(result).toBe(true);
    });

    it('handles unknown notification without error', async () => {
      const { handler } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      const result = await handler.handleMessage({ method: 'some/unknown_notification' });
      expect(result).toBe(false);
    });

    it('ignores inbound JSON-RPC responses (id + result/error)', async () => {
      const { handler } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      const result = await handler.handleMessage({ id: 99, result: { done: true } });
      expect(result).toBe(false);
    });

    it('returns false for non-object messages', async () => {
      const { handler } = makeHandler();
      const result = await handler.handleMessage('not an object');
      expect(result).toBe(false);
    });

    it('returns false for null messages', async () => {
      const { handler } = makeHandler();
      const result = await handler.handleMessage(null);
      expect(result).toBe(false);
    });
  });

  describe('errorToJsonRpc', () => {
    it('maps a thrown object with code+message properties to a structured error response', async () => {
      const throwRunTurn: RunTurn = async () => {
        throw { code: -32001, message: 'structured error', data: { detail: 'extra' } };
      };
      const ft = fakeTransport();
      const handler = new ACPProtocolHandler({
        transport: ft as never as AgentServerTransport,
        defaultCwd: CWD_TEST,
        runTurn: throwRunTurn,
      });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_TEST } });
      const sid = (ft.sent[ft.sent.length - 1] as { result?: { sessionId?: string } }).result
        ?.sessionId!;
      ft.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] },
      });

      // The handler catches the throw and sends a JSON-RPC error response
      const errorResp = ft.sent.find((m) => (m as { id?: number }).id === 3) as
        | { error?: { code?: number; message?: string; data?: unknown } }
        | undefined;
      // The runTurn throw hits the catch in handleRequest → errorToJsonRpc extracts
      // the code+message+data from the thrown object (line 1048 path)
      expect(errorResp?.error?.code).toBe(-32001);
      expect(errorResp?.error?.message).toBe('structured error');
      expect(errorResp?.error?.data).toEqual({ detail: 'extra' });
    });

    it('maps a plain Error to a -32603 internal error response', async () => {
      const throwRunTurn: RunTurn = async () => {
        throw new Error('generic failure');
      };
      const ft = fakeTransport();
      const handler = new ACPProtocolHandler({
        transport: ft as never as AgentServerTransport,
        defaultCwd: CWD_TEST,
        runTurn: throwRunTurn,
      });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_TEST } });
      const sid = (ft.sent[ft.sent.length - 1] as { result?: { sessionId?: string } }).result
        ?.sessionId!;
      ft.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] },
      });

      // Plain Error has no code property → maps to -32603 (line 1056 path)
      const errorResp = ft.sent.find((m) => (m as { id?: number }).id === 3) as
        | { error?: { code?: number; message?: string } }
        | undefined;
      expect(errorResp?.error?.code).toBe(-32603);
      expect(errorResp?.error?.message).toBe('generic failure');
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
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_X } });
      const sessionId = (
        transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }
      ).result?.sessionId!;
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

  describe('client permission requests', () => {
    it('round-trips session/request_permission to the client and returns the outcome', async () => {
      // Transport that also captures the onMessage handler so we can push
      // a simulated client response back into the handler.
      let onMsg: ((m: unknown) => void) | undefined;
      const sent: unknown[] = [];
      const transport = {
        sent,
        send: vi.fn(async (m: unknown) => {
          sent.push(m);
        }),
        onMessage: (h: (m: unknown) => void) => {
          onMsg = h;
          return () => {};
        },
      };

      let observedOutcome: unknown;
      const runTurn: RunTurn = async (_input, _emit, api) => {
        const outcome = await api!.requestPermission({
          toolCall: { toolCallId: 'tc1', title: 'write a.ts', kind: 'edit' },
          options: [
            { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        });
        observedOutcome = outcome;
        return { stopReason: 'end_turn' };
      };

      const handler = new ACPProtocolHandler({
        transport: transport as never as AgentServerTransport,
        defaultCwd: CWD_TEST,
        runTurn,
      });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_TEST } });
      const sessionId = (sent[sent.length - 1] as { result?: { sessionId?: string } }).result
        ?.sessionId!;
      sent.length = 0;

      // Kick off the turn without awaiting — it parks on requestPermission.
      const turnDone = handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'edit' }] },
      });
      await new Promise((r) => setImmediate(r));

      // The handler should have sent a session/request_permission REQUEST.
      const req = sent.find(
        (m) => (m as { method?: string }).method === 'session/request_permission',
      ) as { id: string; params?: { toolCall?: unknown; options?: unknown } } | undefined;
      expect(req).toBeDefined();
      expect(req?.params?.toolCall).toMatchObject({ toolCallId: 'tc1' });

      // Simulate the client's response, routed via onMessage.
      onMsg?.({
        id: req!.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      });
      await turnDone;

      expect(observedOutcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    });

    it('exposes client fs/terminal via api and round-trips fs/read_text_file', async () => {
      let onMsg: ((m: unknown) => void) | undefined;
      const sent: unknown[] = [];
      const transport = {
        sent,
        send: vi.fn(async (m: unknown) => {
          sent.push(m);
        }),
        onMessage: (h: (m: unknown) => void) => {
          onMsg = h;
          return () => {};
        },
      };

      let content: string | undefined;
      let caps: unknown;
      const runTurn: RunTurn = async (_input, _emit, api) => {
        caps = api!.clientCapabilities;
        content = await api!.readTextFile({ path: '/abs/a.ts' });
        return { stopReason: 'end_turn' };
      };

      const handler = new ACPProtocolHandler({
        transport: transport as never as AgentServerTransport,
        defaultCwd: CWD_TEST,
        runTurn,
      });
      await handler.handleMessage({
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true }, terminal: true },
        },
      });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: CWD_TEST } });
      const sessionId = (sent[sent.length - 1] as { result?: { sessionId?: string } }).result
        ?.sessionId!;
      sent.length = 0;

      const turnDone = handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'read it' }] },
      });
      await new Promise((r) => setImmediate(r));

      const req = sent.find((m) => (m as { method?: string }).method === 'fs/read_text_file') as
        | { id: string; params?: { path?: string } }
        | undefined;
      expect(req).toBeDefined();
      expect(req?.params?.path).toBe('/abs/a.ts');
      onMsg?.({ id: req!.id, result: { content: 'file body' } });
      await turnDone;

      expect(content).toBe('file body');
      expect(caps).toMatchObject({ fs: { readTextFile: true }, terminal: true });
    });

    it('exercises every client callback and its defensive fallbacks', async () => {
      let onMsg: ((message: unknown) => void) | undefined;
      const sent: unknown[] = [];
      let terminalCreates = 0;
      let terminalWaits = 0;
      const transport = {
        sent,
        onMessage: (handler: (message: unknown) => void) => {
          onMsg = handler;
          return () => {};
        },
        send: vi.fn(async (message: unknown) => {
          sent.push(message);
          const request = message as { id?: string; method?: string };
          if (typeof request.id !== 'string') return;
          let result: unknown = {};
          if (request.method === 'terminal/create') {
            terminalCreates++;
            result = terminalCreates === 1 ? {} : { terminalId: 'term_1' };
          } else if (request.method === 'terminal/wait_for_exit') {
            terminalWaits++;
            result = { exitCode: terminalWaits === 1 ? 'not-a-number' : 0 };
          } else if (request.method === 'terminal/output') {
            result = {};
          }
          queueMicrotask(() => {
            if (request.method === 'terminal/release') {
              onMsg?.({ id: request.id, error: {} });
            } else {
              onMsg?.({ id: request.id, result });
            }
          });
        }),
      };
      const observed: unknown[] = [];
      const runTurn: RunTurn = async (_input, _emit, api) => {
        observed.push(await api!.requestPermission({ toolCall: {} as never, options: [] }));
        observed.push(await api!.readTextFile({ path: '/missing' }));
        await api!.writeTextFile({ path: '/file', content: 'x' });
        observed.push(await api!.runTerminal({ command: 'first' }));
        observed.push(await api!.runTerminal({
          command: 'second',
          args: [],
          cwd: CWD_WORK,
        }));
        observed.push(await api!.runTerminal({ command: 'third' }));
        return { stopReason: 'end_turn' };
      };
      const handler = new ACPProtocolHandler({
        transport: transport as never,
        defaultCwd: CWD_TEST,
        runTurn,
      });
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({ id: 2, method: 'session/new' });
      const sessionId = (sent.at(-1) as { result: { sessionId: string } }).result.sessionId;
      await handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [] },
      });
      expect(observed).toEqual([
        { outcome: 'cancelled' },
        '',
        { output: '', exitCode: null },
        { output: '', exitCode: null },
        { output: '', exitCode: 0 },
      ]);
    });
  });

  describe('remaining v1 request surfaces', () => {
    it('uses the default mode when an explicitly empty mode list is configured', async () => {
      const transport = fakeTransport();
      const handler = new ACPProtocolHandler({
        transport: transport as never,
        defaultCwd: CWD_TEST,
        runTurn: PASSON_RUN_TURN,
        modes: [],
      });
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({ id: 2, method: 'session/new' });
      expect(transport.sent).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: 'session/update',
          params: expect.objectContaining({
            update: { sessionUpdate: 'current_mode_update', modeId: 'code' },
          }),
        }),
      ]));
    });

    it('handles null params across session request and notification surfaces', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize' });
      for (const method of [
        'session/load',
        'session/resume',
        'session/close',
        'session/delete',
        'session/fork',
        'session/set_mode',
        'session/set_config_option',
      ]) {
        await handler.handleMessage({ id: 2, method, params: null });
        expect(transport.sent.at(-1)).toHaveProperty('error');
      }
      await expect(
        handler.handleMessage({ method: 'session/cancel', params: null }),
      ).resolves.toBe(false);
      await handler.handleMessage({ id: 3, method: 'session/prompt', params: null });
      expect(transport.sent.at(-1)).toHaveProperty('error');
    });

    it('maps exceptions thrown by request handlers through the outer guard', async () => {
      const transport = fakeTransport();
      const handler = new ACPProtocolHandler({
        transport: transport as never,
        defaultCwd: CWD_TEST,
        runTurn: PASSON_RUN_TURN,
        onSessionNew: () => {
          throw { code: -32042, message: 'hook failed', data: 'detail' };
        },
      });
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({ id: 2, method: 'session/new' });
      expect(transport.sent.at(-1)).toMatchObject({
        id: 2,
        error: { code: -32042, message: 'hook failed', data: 'detail' },
      });
    });

    it('cold-loads persisted history, seeds the turn engine, and lists its title', async () => {
      const transport = fakeTransport();
      const seedFor = vi.fn();
      const history = [{
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'remember' },
      }];
      const store = {
        load: vi.fn(async () => ({
          id: 'persisted',
          cwd: CWD_SAVED,
          modeId: 'code',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
          title: 'Saved session',
          history,
        })),
        save: vi.fn(async () => {}),
      };
      const handler = new ACPProtocolHandler({
        transport: transport as never,
        defaultCwd: CWD_TEST,
        runTurn: PASSON_RUN_TURN,
        store: store as never,
        seedFor,
      });
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({
        id: 2,
        method: 'session/load',
        params: { sessionId: 'persisted' },
      });
      expect(seedFor).toHaveBeenCalledWith('persisted', history);
      expect(transport.sent).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'session/update' }),
        expect.objectContaining({ id: 2, result: expect.any(Object) }),
      ]));
      await handler.handleMessage({ id: 3, method: 'session/list' });
      expect(transport.sent.at(-1)).toMatchObject({
        result: {
          sessions: [expect.objectContaining({ title: 'Saved session' })],
        },
      });
      await handler.handleMessage({
        id: 4,
        method: 'session/fork',
        params: { sessionId: 'persisted', cwd: CWD_FORKED },
      });
      expect(transport.sent.at(-1)).toMatchObject({
        result: { sessionId: expect.any(String) },
      });
    });

    it('enforces the cap while cold-loading persisted sessions', async () => {
      const transport = fakeTransport();
      const handler = new ACPProtocolHandler({
        transport: transport as never,
        defaultCwd: CWD_TEST,
        runTurn: PASSON_RUN_TURN,
        maxSessions: 1,
        store: {
          load: vi.fn(async () => ({ id: 'cold', history: [] })),
          save: vi.fn(async () => {}),
        } as never,
      });
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({ id: 2, method: 'session/new' });
      await handler.handleMessage({
        id: 3,
        method: 'session/load',
        params: { sessionId: 'cold' },
      });
      expect(transport.sent.at(-1)).toHaveProperty('error');
    });

    it('uses load-time/default fallbacks for sparse persisted records', async () => {
      for (const [id, params, expectedCwd] of [
        ['with-load-cwd', { sessionId: 'with-load-cwd', cwd: CWD_LOAD }, CWD_LOAD],
        ['with-default', { sessionId: 'with-default' }, CWD_TEST],
      ] as const) {
        const transport = fakeTransport();
        const seedFor = vi.fn();
        const handler = new ACPProtocolHandler({
          transport: transport as never,
          defaultCwd: CWD_TEST,
          runTurn: PASSON_RUN_TURN,
          seedFor,
          store: {
            load: vi.fn(async () => ({ id })),
            save: vi.fn(async () => {}),
          } as never,
        });
        await handler.handleMessage({ id: 1, method: 'initialize' });
        await handler.handleMessage({ id: 2, method: 'session/load', params });
        await handler.handleMessage({ id: 3, method: 'session/list' });
        expect(transport.sent.at(-1)).toMatchObject({
          result: { sessions: [expect.objectContaining({ cwd: expectedCwd })] },
        });
        expect(seedFor).toHaveBeenCalledWith(id, []);
      }
    });

    it('falls through when a persistence store has no requested session', async () => {
      const transport = fakeTransport();
      const handler = new ACPProtocolHandler({
        transport: transport as never,
        defaultCwd: CWD_TEST,
        runTurn: PASSON_RUN_TURN,
        store: {
          load: vi.fn(async () => null),
          save: vi.fn(async () => {}),
        } as never,
      });
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({
        id: 2,
        method: 'session/load',
        params: { sessionId: 'absent' },
      });
      expect(transport.sent.at(-1)).toHaveProperty('error');
    });

    it('replays in-memory history during load', async () => {
      const transport = fakeTransport();
      const replay = [{
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'answer' },
      }];
      const handler = new ACPProtocolHandler({
        transport: transport as never,
        defaultCwd: CWD_TEST,
        runTurn: PASSON_RUN_TURN,
        replayFor: () => replay,
      });
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({ id: 2, method: 'session/new' });
      const sessionId = (transport.sent.at(-1) as { result: { sessionId: string } }).result.sessionId;
      transport.sent.length = 0;
      await handler.handleMessage({
        id: 3,
        method: 'session/load',
        params: { sessionId },
      });
      expect(transport.sent).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: 'session/update',
          params: expect.objectContaining({ update: replay[0] }),
        }),
      ]));
    });

    it('handles provider and MCP methods', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize' });
      for (const [id, method] of [
        [2, 'providers/list'],
        [3, 'providers/set'],
        [4, 'providers/disable'],
        [5, 'mcp/message'],
      ] as const) {
        await handler.handleMessage({ id, method, params: {} });
      }
      expect(transport.sent.find((m) => (m as { id?: number }).id === 2)).toMatchObject({
        result: { providers: [], currentProviderId: null },
      });
      expect(transport.sent.find((m) => (m as { id?: number }).id === 3)).toHaveProperty('error');
      expect(transport.sent.find((m) => (m as { id?: number }).id === 4)).toMatchObject({
        result: {},
      });
      expect(transport.sent.find((m) => (m as { id?: number }).id === 5)).toHaveProperty('error');
    });

    it('validates and updates config options', async () => {
      const transport = fakeTransport();
      const handler = new ACPProtocolHandler({
        transport: transport as never,
        defaultCwd: CWD_TEST,
        runTurn: PASSON_RUN_TURN,
        configOptions: [{
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'small',
          options: [
            { value: 'small', name: 'Small' },
            { value: 'large', name: 'Large' },
          ],
        }],
      });
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({ id: 2, method: 'session/new' });
      const sessionId = (transport.sent.at(-1) as { result: { sessionId: string } }).result.sessionId;
      await handler.handleMessage({
        id: 3,
        method: 'session/set_config_option',
        params: { sessionId, configId: 'model', value: 'large' },
      });
      expect(transport.sent.at(-1)).toMatchObject({
        result: { configOptions: [expect.objectContaining({ currentValue: 'large' })] },
      });
      for (const params of [
        {},
        { sessionId, value: 'large' },
        { sessionId, configId: 'missing', value: 'large' },
        { sessionId, configId: 'model', value: 1 },
        { sessionId, configId: 'model', value: 'missing' },
      ]) {
        await handler.handleMessage({
          id: 4,
          method: 'session/set_config_option',
          params,
        });
        expect(transport.sent.at(-1)).toHaveProperty('error');
      }
    });

    it('validates prompt and delete requests and recreates a cancelled session signal', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({ id: 2, method: 'session/new' });
      const sessionId = (transport.sent.at(-1) as { result: { sessionId: string } }).result.sessionId;
      await handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: 'invalid' },
      });
      expect(transport.sent.at(-1)).toHaveProperty('error');
      await handler.handleMessage({ method: 'session/cancel', params: { sessionId } });
      await handler.handleMessage({
        id: 4,
        method: 'session/prompt',
        params: { sessionId, prompt: [] },
      });
      await handler.handleMessage({ id: 5, method: 'session/delete', params: {} });
      expect(transport.sent.at(-1)).toHaveProperty('error');
      await handler.handleMessage({
        id: 6,
        method: 'session/delete',
        params: { sessionId: 'absent' },
      });
      expect(transport.sent.at(-1)).toMatchObject({ result: { configOptions: [] } });
      expect(await handler.handleMessage({})).toBe(false);
    });

    it('rejects a fork when the active-session cap is reached', async () => {
      const transport = fakeTransport();
      const handler = new ACPProtocolHandler({
        transport: transport as never,
        defaultCwd: CWD_TEST,
        runTurn: PASSON_RUN_TURN,
        maxSessions: 1,
      });
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({ id: 2, method: 'session/new' });
      const sessionId = (transport.sent.at(-1) as { result: { sessionId: string } }).result.sessionId;
      await handler.handleMessage({
        id: 3,
        method: 'session/fork',
        params: { sessionId },
      });
      expect(transport.sent.at(-1)).toHaveProperty('error');
    });

    it('forks with the source cwd when no override is supplied', async () => {
      const { handler, transport } = makeHandler({ defaultCwd: CWD_SOURCE });
      await handler.handleMessage({ id: 1, method: 'initialize' });
      await handler.handleMessage({ id: 2, method: 'session/new' });
      const sessionId = (transport.sent.at(-1) as { result: { sessionId: string } }).result.sessionId;
      await handler.handleMessage({
        id: 3,
        method: 'session/fork',
        params: { sessionId },
      });
      await handler.handleMessage({ id: 4, method: 'session/list' });
      expect(transport.sent.at(-1)).toMatchObject({
        result: {
          sessions: expect.arrayContaining([
            expect.objectContaining({ cwd: CWD_SOURCE }),
          ]),
        },
      });
    });

    it.each([new Error('send failed'), 'non-error send failure'])(
      'maps outbound transport failures: %s',
      async (failure) => {
        let onMsg: ((message: unknown) => void) | undefined;
        const transport = {
          onMessage: (handler: (message: unknown) => void) => {
            onMsg = handler;
            return () => {};
          },
          send: vi.fn(async (message: unknown) => {
            if ((message as { method?: string }).method === 'session/request_permission') {
              throw failure;
            }
          }),
        };
        const handler = new ACPProtocolHandler({
          transport: transport as never,
          defaultCwd: CWD_TEST,
          runTurn: async (_input, _emit, api) => {
            await api!.requestPermission({ toolCall: {} as never, options: [] });
            return { stopReason: 'end_turn' };
          },
        });
        expect(onMsg).toBeTypeOf('function');
        await handler.handleMessage({ id: 1, method: 'initialize' });
        await handler.handleMessage({ id: 2, method: 'session/new' });
        const newResponse = transport.send.mock.calls
          .map((call) => call[0] as { result?: { sessionId?: string } })
          .find((message) => message.result?.sessionId);
        await handler.handleMessage({
          id: 3,
          method: 'session/prompt',
          params: { sessionId: newResponse!.result!.sessionId, prompt: [] },
        });
        expect(transport.send.mock.calls.at(-1)?.[0]).toHaveProperty('error');
      },
    );

    it('times out and closes pending client requests', async () => {
      vi.useFakeTimers();
      try {
        let onMsg: ((message: unknown) => void) | undefined;
        const sent: unknown[] = [];
        const transport = {
          sent,
          onMessage: (handler: (message: unknown) => void) => {
            onMsg = handler;
            return () => {};
          },
          send: vi.fn(async (message: unknown) => {
            sent.push(message);
          }),
        };
        const handler = new ACPProtocolHandler({
          transport: transport as never,
          defaultCwd: CWD_TEST,
          runTurn: async (_input, _emit, api) => {
            await api!.requestPermission({ toolCall: {} as never, options: [] });
            return { stopReason: 'end_turn' };
          },
        });
        await handler.handleMessage({ id: 1, method: 'initialize' });
        await handler.handleMessage({ id: 2, method: 'session/new' });
        const sessionId = (sent.at(-1) as { result: { sessionId: string } }).result.sessionId;
        const timedOut = handler.handleMessage({
          id: 3,
          method: 'session/prompt',
          params: { sessionId, prompt: [] },
        });
        await vi.advanceTimersByTimeAsync(60_000);
        await timedOut;

        const pending = handler.handleMessage({
          id: 4,
          method: 'session/prompt',
          params: { sessionId, prompt: [] },
        });
        await vi.advanceTimersByTimeAsync(0);
        handler.close();
        await pending;
        onMsg?.({ id: 42, result: {} });
        onMsg?.({ id: 'missing', result: {} });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('protocol helper coverage', () => {
    it('maps every JSON-RPC error shape', () => {
      const map = protocolHandlerCoverage.errorToJsonRpc;
      expect(map(null)).toEqual({ code: -32603, message: 'null' });
      expect(map({})).toEqual({ code: -32603, message: '[object Object]' });
      expect(map({ code: 'bad', message: 'x' })).toEqual({
        code: -32603,
        message: '[object Object]',
      });
      expect(map({ code: 1, message: 2 })).toEqual({
        code: -32603,
        message: '[object Object]',
      });
      expect(map({ code: 1, message: 'x' })).toEqual({ code: 1, message: 'x' });
      expect(map({ code: 1, message: 'x', data: 0 })).toEqual({
        code: 1,
        message: 'x',
        data: 0,
      });
      expect(map(new Error('boom'))).toEqual({ code: -32603, message: 'boom' });
      expect(map('boom')).toEqual({ code: -32603, message: 'boom' });
    });
  });
});
