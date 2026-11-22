/**
 * Agent-side session modes: a host's modes are what a session opens in and
 * reports, a persisted mode the host no longer offers (an older build's
 * `code`) loads as the first offered mode, and a turn reads the session's
 * mode live, so a `session/set_mode` mid-turn reaches the next tool call.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ACPProtocolHandler,
  type RunTurn,
  type RunTurnApi,
} from '../src/agent/protocol-handler.js';
import { offeredModeId } from '../src/agent/protocol-session-ops.js';
import { ACPSessionStore } from '../src/agent/session-store.js';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';

const MODES = [
  { id: 'default', name: 'Default', description: 'asks' },
  { id: 'plan', name: 'Plan', description: 'read-only' },
  { id: 'yolo', name: 'YOLO', description: 'acts' },
];

function harness(opts: { modes?: typeof MODES; storeDir?: string; runTurn?: RunTurn } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const cwd = mkdtempSync(nodePath.join(tmpdir(), 'acp-modes-'));
  const handler = new ACPProtocolHandler({
    transport: {
      send: vi.fn(async (msg: Record<string, unknown>) => {
        sent.push(msg);
      }),
    } as never as AgentServerTransport,
    defaultCwd: cwd,
    runTurn: opts.runTurn ?? (async () => ({ stopReason: 'end_turn' })),
    ...(opts.modes ? { modes: opts.modes } : {}),
    ...(opts.storeDir ? { store: new ACPSessionStore({ dir: opts.storeDir }) } : {}),
  });
  const result = (id: number) =>
    (sent.find((m) => m['id'] === id) as { result?: Record<string, unknown> } | undefined)?.result;
  return { handler, sent, result, cwd };
}

describe('agent session modes', () => {
  it('opens a session in the host mode listed first and reports the list', async () => {
    const { handler, result } = harness({ modes: MODES });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { mcpServers: [] } });
    expect(result(2)?.['modes']).toEqual({ currentModeId: 'default', availableModes: MODES });
  });

  it('gives the turn a live view of the mode', async () => {
    let api: RunTurnApi | undefined;
    const { handler, result, sent } = harness({
      modes: MODES,
      runTurn: async (_input, _emit, turnApi) => {
        api = turnApi;
        return { stopReason: 'end_turn' };
      },
    });
    await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await handler.handleMessage({ id: 2, method: 'session/new', params: { mcpServers: [] } });
    const sessionId = result(2)?.['sessionId'] as string;
    await handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    });
    expect(api?.currentModeId?.()).toBe('default');
    await handler.handleMessage({
      id: 4,
      method: 'session/set_mode',
      params: { sessionId, modeId: 'yolo' },
    });
    expect(api?.currentModeId?.()).toBe('yolo');
    expect(
      sent.some(
        (m) =>
          (m['params'] as { update?: { sessionUpdate?: string; currentModeId?: string } })?.update
            ?.currentModeId === 'yolo',
      ),
    ).toBe(true);
  });

  it('loads a session saved in a mode the host no longer offers in the first offered mode', async () => {
    const storeDir = mkdtempSync(nodePath.join(tmpdir(), 'acp-modes-store-'));
    const old = harness({ storeDir });
    await old.handler.handleMessage({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 },
    });
    await old.handler.handleMessage({ id: 2, method: 'session/new', params: { mcpServers: [] } });
    const sessionId = old.result(2)?.['sessionId'] as string;
    expect(old.result(2)?.['modes']).toMatchObject({ currentModeId: 'code' });
    await old.handler.handleMessage({
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    });

    const fresh = harness({ modes: MODES, storeDir });
    await fresh.handler.handleMessage({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 },
    });
    await fresh.handler.handleMessage({
      id: 2,
      method: 'session/load',
      params: { sessionId, cwd: old.cwd, mcpServers: [] },
    });
    expect(fresh.result(2)?.['modes']).toEqual({ currentModeId: 'default', availableModes: MODES });
  });

  it('offeredModeId keeps an offered mode and replaces anything else', () => {
    expect(offeredModeId(MODES, 'plan')).toBe('plan');
    expect(offeredModeId(MODES, 'code')).toBe('default');
    expect(offeredModeId(MODES, undefined)).toBe('default');
  });
});
