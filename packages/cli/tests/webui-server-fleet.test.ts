import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWebUI } from '../src/webui-server.js';
import { openWs } from './_ws-client.js';

type SubagentEventPayload = {
  kind: 'spawned' | 'iteration_summary' | 'task_completed';
  subagentId: string;
  taskId?: string;
  name?: string;
  provider?: string;
  model?: string;
  description?: string;
  iteration?: number;
  toolCalls?: number;
  costUsd?: number;
  currentTool?: string;
  status?: string;
  error?: { kind: string; message: string };
};

function payloadOf(msg: { [key: string]: unknown }): SubagentEventPayload {
  return (msg.payload ?? msg) as SubagentEventPayload;
}

const ports = { next: 45_640 };
const nextPort = (): number => ports.next++;

describe('runWebUI subagent fleet bridge', () => {
  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('flattens subagent.* host events into a kind-tagged subagent.event stream', async () => {
    const port = nextPort();
    const httpPort = port; // single-port design: HTTP and WS share one listener
    const events = new EventBus();
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => {
      signalReady = r;
    });
    const serverDone = runWebUI({
      port,
      httpPort,
      profileConfigPath: '/tmp/test-profile.json',
      onListening: () => signalReady?.(),
      events,
      session: { id: 'test-session' } as any,
      agent: {
        ctx: { model: 'test-model', provider: { id: 'test-provider' } },
        run: vi.fn(),
      } as any,
    });

    await listening;
    const { ws, waitForMessage } = await openWs(`ws://127.0.0.1:${port}`);
    await waitForMessage('session.start');

    // spawn → expect a 'spawned' subagent.event carrying the nickname/model.
    events.emit('subagent.spawned', {
      subagentId: 'sub-1',
      taskId: 'task-1',
      name: 'Von Neumann',
      provider: 'anthropic',
      model: 'claude-x',
      description: 'analyze the kernel',
    });
    const spawned = await waitForMessage('subagent.event', (m) => payloadOf(m).kind === 'spawned');
    const spawnedPayload = payloadOf(spawned);
    expect(spawnedPayload.subagentId).toBe('sub-1');
    expect(spawnedPayload.name).toBe('Von Neumann');
    expect(spawnedPayload.model).toBe('claude-x');

    // periodic summary → counters forwarded verbatim.
    events.emit('subagent.iteration_summary', {
      subagentId: 'sub-1',
      iteration: 25,
      toolCalls: 47,
      costUsd: 0.023,
      currentTool: 'grep',
    });
    const summary = await waitForMessage(
      'subagent.event',
      (m) => payloadOf(m).kind === 'iteration_summary',
    );
    const summaryPayload = payloadOf(summary);
    expect(summaryPayload.iteration).toBe(25);
    expect(summaryPayload.toolCalls).toBe(47);
    expect(summaryPayload.currentTool).toBe('grep');

    events.emit('subagent.tool_started', {
      sessionId: 'test-session',
      agentSessionId: 'sub-session-1',
      subagentId: 'sub-1',
      agentName: 'Von Neumann',
      traceId: 'trace-1',
      id: 'toolu-sub-1',
      name: 'read',
      input: { path: 'packages/core/src/index.ts', offset: 10, limit: 5 },
    });
    const toolStarted = await waitForMessage('codemap.tool_started');
    expect(toolStarted.payload).toMatchObject({
      sessionId: 'sub-session-1',
      parentSessionId: 'test-session',
      agentId: 'sub-1',
      agentName: 'Von Neumann',
      traceId: 'trace-1',
      id: 'toolu-sub-1',
      name: 'read',
    });
    expect((toolStarted.payload as { fileTargets: unknown[] }).fileTargets).toHaveLength(1);

    events.emit('subagent.tool_executed', {
      sessionId: 'test-session',
      agentSessionId: 'sub-session-1',
      subagentId: 'sub-1',
      agentName: 'Von Neumann',
      traceId: 'trace-1',
      id: 'toolu-sub-1',
      name: 'read',
      durationMs: 18,
      ok: true,
      input: { path: 'packages/core/src/index.ts', offset: 10, limit: 5 },
      output: '10: export * from ./kernel\n11: export * from ./tools',
      outputBytes: 2048,
      outputTokens: 585,
      outputLines: 5,
    });
    const toolExecuted = await waitForMessage('codemap.tool_executed');
    expect(toolExecuted.payload).toMatchObject({
      sessionId: 'sub-session-1',
      agentId: 'sub-1',
      id: 'toolu-sub-1',
      durationMs: 18,
      ok: true,
      outputBytes: 2048,
      outputTokens: 585,
      outputLines: 5,
    });

    // completion → status + structured error flattened to {kind,message}.
    events.emit('subagent.task_completed', {
      subagentId: 'sub-1',
      taskId: 'task-1',
      status: 'failed',
      iterations: 30,
      toolCalls: 50,
      durationMs: 1000,
      error: { kind: 'rate_limit', message: '429 slow down', retryable: true },
    });
    const done = await waitForMessage(
      'subagent.event',
      (m) => payloadOf(m).kind === 'task_completed',
    );
    const donePayload = payloadOf(done);
    expect(donePayload.status).toBe('failed');
    expect(donePayload.error).toEqual({ kind: 'rate_limit', message: '429 slow down' });
    // retryable/durationMs are intentionally not forwarded — keep the wire lean.
    expect((donePayload.error as { retryable?: boolean } | undefined)?.retryable).toBeUndefined();

    ws.close();
    process.emit('SIGTERM');
    await serverDone;
  });
});
