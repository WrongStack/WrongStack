/**
 * The client's `mcpServers` array must survive the wire boundary.
 *
 * Every ACP session entry point destructured `mcpServers` from its params and
 * then never read the variable, so an editor that handed WrongStack its MCP
 * configuration got a successful `session/new` and no tools — including over
 * stdio, which the spec says an agent may not decline. These tests pin the
 * whole path: parse -> session state -> `RunTurnInput`, plus the capability
 * declaration that tells clients it is worth sending at all.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ACPProtocolHandler,
  type RunTurn,
  type RunTurnInput,
} from '../src/agent/protocol-handler.js';
import { parseMcpServers } from '../src/agent/protocol-session-ops.js';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';

const CWD = mkdtempSync(nodePath.join(tmpdir(), 'acp-mcp-'));
mkdirSync(CWD, { recursive: true });

function harness(): {
  handler: ACPProtocolHandler;
  sent: unknown[];
  turns: RunTurnInput[];
} {
  const sent: unknown[] = [];
  const turns: RunTurnInput[] = [];
  const runTurn: RunTurn = async (input) => {
    turns.push(input);
    return { stopReason: 'end_turn' };
  };
  const transport = {
    send: vi.fn(async (msg: unknown) => {
      sent.push(msg);
    }),
  };
  const handler = new ACPProtocolHandler({
    transport: transport as never as AgentServerTransport,
    defaultCwd: CWD,
    runTurn,
  });
  return { handler, sent, turns };
}

function resultOf(sent: readonly unknown[], id: number): Record<string, unknown> | undefined {
  const msg = sent.find((m) => (m as { id?: unknown }).id === id) as
    | { result?: Record<string, unknown> }
    | undefined;
  return msg?.result;
}

const STDIO = { name: 'files', command: 'node', args: ['server.js'] };
const HTTP = { type: 'http', name: 'remote', url: 'https://example.test/mcp' };

describe('parseMcpServers', () => {
  it('accepts all three transports and defaults a typeless entry to stdio', () => {
    const parsed = parseMcpServers([
      STDIO,
      HTTP,
      { type: 'sse', name: 'events', url: 'https://example.test/sse' },
    ]);
    expect(parsed).toEqual([
      { name: 'files', command: 'node', args: ['server.js'] },
      { type: 'http', name: 'remote', url: 'https://example.test/mcp' },
      { type: 'sse', name: 'events', url: 'https://example.test/sse' },
    ]);
  });

  it('keeps env and headers in the ACP {name,value} wire shape', () => {
    const parsed = parseMcpServers([
      { name: 'gh', command: 'gh-mcp', env: [{ name: 'TOKEN', value: 't' }] },
      { type: 'http', name: 'r', url: 'https://x.test', headers: [{ name: 'A', value: 'b' }] },
    ]);
    expect(parsed[0]).toMatchObject({ env: [{ name: 'TOKEN', value: 't' }] });
    expect(parsed[1]).toMatchObject({ headers: [{ name: 'A', value: 'b' }] });
  });

  it('drops malformed entries and reports each one instead of failing the batch', () => {
    const skipped: string[] = [];
    const parsed = parseMcpServers(
      [
        STDIO,
        { name: 'no-command' },
        { command: 'nameless' },
        { type: 'http', name: 'no-url' },
        { type: 'carrier-pigeon', name: 'exotic' },
        'not-an-object',
      ],
      (reason) => skipped.push(reason),
    );
    expect(parsed).toHaveLength(1);
    expect(skipped).toHaveLength(5);
    expect(skipped.join(' ')).toContain('no-command');
    expect(skipped.join(' ')).toContain('carrier-pigeon');
  });

  it('returns an empty list for a missing or non-array value', () => {
    expect(parseMcpServers(undefined)).toEqual([]);
    expect(parseMcpServers({ files: STDIO })).toEqual([]);
  });
});

describe('ACP session mcpServers passthrough', () => {
  it('declares http and sse support so clients send those servers at all', async () => {
    const { handler, sent } = harness();
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    expect(resultOf(sent, 1)).toMatchObject({
      agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
    });
  });

  it('delivers the servers from session/new to every turn of that session', async () => {
    const { handler, sent, turns } = harness();
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({
      id: 2,
      method: 'session/new',
      params: { cwd: CWD, mcpServers: [STDIO, HTTP] },
    });
    const sessionId = resultOf(sent, 2)?.sessionId as string;
    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.mcpServers).toEqual([
      { name: 'files', command: 'node', args: ['server.js'] },
      { type: 'http', name: 'remote', url: 'https://example.test/mcp' },
    ]);
  });

  it('tells the client which entries it refused rather than dropping them silently', async () => {
    const { handler, sent } = harness();
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({
      id: 2,
      method: 'session/new',
      params: { cwd: CWD, mcpServers: [{ name: 'broken' }] },
    });
    const texts = sent
      .map((m) => (m as { params?: { update?: { content?: { text?: string } } } }).params)
      .map((p) => p?.update?.content?.text)
      .filter((t): t is string => typeof t === 'string');
    expect(texts.some((t) => t.includes('malformed mcpServers'))).toBe(true);
  });

  it('carries the parent session servers into a fork that names none', async () => {
    const { handler, sent, turns } = harness();
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({
      id: 2,
      method: 'session/new',
      params: { cwd: CWD, mcpServers: [STDIO] },
    });
    const parent = resultOf(sent, 2)?.sessionId as string;
    await handler.handleMessage({ id: 3, method: 'session/fork', params: { sessionId: parent } });
    const fork = resultOf(sent, 3)?.sessionId as string;
    expect(fork).not.toBe(parent);
    await handler.handleMessage({
      id: 4,
      method: 'session/prompt',
      params: { sessionId: fork, prompt: [{ type: 'text', text: 'hi' }] },
    });
    expect(turns[0]?.mcpServers).toEqual([{ name: 'files', command: 'node', args: ['server.js'] }]);
  });

  it('lets a fork replace the inherited set with its own', async () => {
    const { handler, sent, turns } = harness();
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({
      id: 2,
      method: 'session/new',
      params: { cwd: CWD, mcpServers: [STDIO] },
    });
    const parent = resultOf(sent, 2)?.sessionId as string;
    await handler.handleMessage({
      id: 3,
      method: 'session/fork',
      params: { sessionId: parent, mcpServers: [HTTP] },
    });
    const fork = resultOf(sent, 3)?.sessionId as string;
    await handler.handleMessage({
      id: 4,
      method: 'session/prompt',
      params: { sessionId: fork, prompt: [{ type: 'text', text: 'hi' }] },
    });
    expect(turns[0]?.mcpServers).toEqual([
      { type: 'http', name: 'remote', url: 'https://example.test/mcp' },
    ]);
  });

  it('adopts a new set on a warm session/load but keeps the old one when none is sent', async () => {
    const { handler, sent, turns } = harness();
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({
      id: 2,
      method: 'session/new',
      params: { cwd: CWD, mcpServers: [STDIO] },
    });
    const sessionId = resultOf(sent, 2)?.sessionId as string;

    await handler.handleMessage({ id: 3, method: 'session/load', params: { sessionId } });
    await handler.handleMessage({
      id: 4,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'a' }] },
    });
    expect(turns.at(-1)?.mcpServers).toEqual([
      { name: 'files', command: 'node', args: ['server.js'] },
    ]);

    await handler.handleMessage({
      id: 5,
      method: 'session/load',
      params: { sessionId, mcpServers: [HTTP] },
    });
    await handler.handleMessage({
      id: 6,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'b' }] },
    });
    expect(turns.at(-1)?.mcpServers).toEqual([
      { type: 'http', name: 'remote', url: 'https://example.test/mcp' },
    ]);
  });
});
