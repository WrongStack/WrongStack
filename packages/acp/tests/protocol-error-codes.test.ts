/**
 * Error codes per the ACP v1 error reference
 * (https://agentclientprotocol.com/protocol/v1/error).
 *
 * `-32000` is "authentication required" and nothing else: clients — WrongStack's
 * own ACP client included (`acp-agent-failure.ts`) — read it as "the agent is
 * signed out" and offer a login. Before this contract the agent also used it for
 * unknown sessions, a full session table, a busy session and requests before
 * `initialize`, so an editor could answer a session limit with a login prompt.
 */
import { describe, expect, it, vi } from 'vitest';
import { ACPProtocolHandler, type RunTurn } from '../src/agent/protocol-handler.js';
import { parseMcpServers } from '../src/agent/protocol-session-ops.js';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';

const CWD = process.cwd();

function makeHandler(opts: { maxSessions?: number; runTurn?: RunTurn } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const transport = {
    send: vi.fn(async (m: Record<string, unknown>) => {
      sent.push(m);
    }),
  } as never as AgentServerTransport;
  const handler = new ACPProtocolHandler({
    transport,
    defaultCwd: CWD,
    runTurn: opts.runTurn ?? (async () => ({ stopReason: 'end_turn' })),
    ...(opts.maxSessions ? { maxSessions: opts.maxSessions } : {}),
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await handler.handleMessage({ id, method, params });
    return sent.findLast((m) => m['id'] === id) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string; data?: unknown };
    };
  };
  return { call };
}

describe('ACP error codes', () => {
  it('answers a request before initialize with -32600', async () => {
    const { call } = makeHandler();
    expect((await call(1, 'session/new', { cwd: CWD, mcpServers: [] })).error?.code).toBe(-32600);
  });

  it('answers every request naming an unknown session with -32002 and the id', async () => {
    const { call } = makeHandler();
    await call(1, 'initialize', { protocolVersion: 1 });
    const requests: Array<[string, Record<string, unknown>]> = [
      ['session/prompt', { prompt: [{ type: 'text', text: 'hi' }] }],
      ['session/set_mode', { modeId: 'code' }],
      ['session/set_config_option', { configId: 'x', value: 'y' }],
      ['session/load', { cwd: CWD, mcpServers: [] }],
      ['session/resume', { cwd: CWD, mcpServers: [] }],
      ['session/fork', {}],
    ];
    let id = 10;
    for (const [method, params] of requests) {
      const resp = await call(id++, method, { sessionId: 'sess_gone', ...params });
      expect(resp.error, method).toMatchObject({ code: -32002, data: { sessionId: 'sess_gone' } });
    }
  });

  it('closes an unknown session successfully, but wants a sessionId', async () => {
    const { call } = makeHandler();
    await call(1, 'initialize', { protocolVersion: 1 });
    expect((await call(2, 'session/close', { sessionId: 'sess_gone' })).result).toEqual({});
    expect((await call(3, 'session/close', {})).error?.code).toBe(-32602);
    expect((await call(4, 'session/delete', {})).error?.code).toBe(-32602);
  });

  it('never uses the auth code for a full session table or a busy session', async () => {
    let release!: () => void;
    const { call } = makeHandler({
      maxSessions: 1,
      runTurn: () =>
        new Promise((resolve) => {
          release = () => resolve({ stopReason: 'end_turn' });
        }),
    });
    await call(1, 'initialize', { protocolVersion: 1 });
    const { result } = await call(2, 'session/new', { cwd: CWD, mcpServers: [] });
    const full = await call(3, 'session/new', { cwd: CWD, mcpServers: [] });
    expect(full.error?.code).toBe(-31001);

    const sessionId = result?.['sessionId'];
    const prompt = call(4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'a' }] });
    await new Promise((r) => setImmediate(r));
    const busy = await call(5, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'b' }],
    });
    expect(busy.error?.code).toBe(-31002);
    release();
    await prompt;
  });

  it('answers unadvertised unstable methods with -32601', async () => {
    const { call } = makeHandler();
    await call(1, 'initialize', { protocolVersion: 1 });
    expect((await call(2, 'providers/set', {})).error?.code).toBe(-32601);
    expect((await call(3, 'mcp/message', {})).error?.code).toBe(-32601);
  });

  it('accepts the empty-string session/list cursor and rejects any other', async () => {
    const { call } = makeHandler();
    await call(1, 'initialize', { protocolVersion: 1 });
    expect((await call(2, 'session/list', { cursor: '' })).result).toEqual({ sessions: [] });
    expect((await call(3, 'session/list', { cursor: 'page-2' })).error?.code).toBe(-32602);
  });
});

describe('MCP server env names', () => {
  it('skips a stdio server that names one env var twice, and says why', () => {
    const skipped: string[] = [];
    const servers = parseMcpServers(
      [
        {
          name: 'dup',
          command: 'srv',
          env: [
            { name: 'TOKEN', value: 'a' },
            { name: 'TOKEN', value: 'b' },
          ],
        },
        { name: 'ok', command: 'srv', env: [{ name: 'TOKEN', value: 'a' }] },
      ],
      (reason) => skipped.push(reason),
    );
    expect(servers.map((s) => s.name)).toEqual(['ok']);
    expect(skipped).toEqual(['"dup": env name "TOKEN" is given more than once']);
  });
});
