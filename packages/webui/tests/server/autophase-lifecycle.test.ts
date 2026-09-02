import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalWebSocketHandler } from '@wrongstack/webui-server';

/** Minimal fake WS that records every JSON message the handler sends. */
function mockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
    on: vi.fn(),
  } as never as import('ws').WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sentTypes(ws: { send: ReturnType<typeof vi.fn> }): string[] {
  return ws.send.mock.calls.map(([raw]) => (JSON.parse(String(raw)) as { type: string }).type);
}

const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const fakeContext = { cwd: os.tmpdir() } as never;

function makeHandler(agentRun: () => Promise<unknown>) {
  const agent = { run: vi.fn(agentRun) } as never;
  const storeDir = path.join(os.tmpdir(), `ap-lifecycle-${Math.random().toString(36).slice(2)}`);
  // No events / projectRoot → no git worktrees (keeps the test hermetic).
  return new GoalWebSocketHandler(agent, fakeContext, fakeLogger, storeDir);
}

describe('GoalWebSocketHandler lifecycle', () => {
  afterEach(() => vi.clearAllMocks());

  it('stop during planning never launches the orchestrator', async () => {
    // Planning resolves only after we release it — simulating an in-flight LLM
    // turn during which the user hits Stop.
    let release: (v: unknown) => void = () => {};
    const planning = new Promise((r) => {
      release = r;
    });
    const h = makeHandler(async () => {
      await planning;
      return { status: 'done', finalText: 'not parseable json' };
    });
    const ws = mockWs();
    h.addClient(ws);

    // Start (do NOT await — it suspends inside planPhases), then Stop, then let
    // planning resolve and the start settle.
    const startP = h.handleMessage(ws, { type: 'goal.start', payload: { title: 'demo' } });
    await h.handleMessage(ws, { type: 'goal.stop', payload: {} });
    release(undefined);
    await startP;

    const types = sentTypes(ws);
    expect(types).toContain('goal.stopped');
    // The run must NOT have started: no completion and no board state with phases.
    expect(types).not.toContain('goal.completed');
    const startedBoard = ws.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { type: string; payload?: { phases?: unknown[] } })
      .some((m) => m.type === 'goal.state' && (m.payload?.phases?.length ?? 0) > 0);
    expect(startedBoard).toBe(false);
  });

  it('clear broadcasts a cleared event + an empty board state', async () => {
    const h = makeHandler(async () => ({ status: 'done', finalText: '' }));
    const ws = mockWs();
    h.addClient(ws);

    await h.handleMessage(ws, { type: 'goal.clear', payload: {} });

    const types = sentTypes(ws);
    expect(types).toContain('goal.cleared');
    const emptyState = ws.send.mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { type: string; payload?: { phases?: unknown[] } })
      .find((m) => m.type === 'goal.state');
    expect(emptyState?.payload?.phases).toEqual([]);
  });

  it('revert with no captured git baseline reports a reason instead of throwing', async () => {
    const h = makeHandler(async () => ({ status: 'done', finalText: '' }));
    const ws = mockWs();
    h.addClient(ws);

    await h.handleMessage(ws, { type: 'goal.revert', payload: {} });

    const reverted = ws.send.mock.calls
      .map(
        ([raw]) =>
          JSON.parse(String(raw)) as { type: string; payload?: { ok?: boolean; reason?: string } },
      )
      .find((m) => m.type === 'goal.reverted');
    expect(reverted?.payload?.ok).toBe(false);
    expect(reverted?.payload?.reason).toBeTruthy();
  });
});
