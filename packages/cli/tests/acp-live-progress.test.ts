/**
 * `publishAcpLiveProgress` — the ACP live-view bridge.
 *
 * An external ACP agent (Claude Code, Gemini CLI, …) never runs an in-process
 * Agent with its own EventBus, so its progress cannot flow through
 * `installSubagentEventBridge` like a native subagent's does. This module is
 * the ACP counterpart: it maps ACP progress events onto the same two buses —
 * the fleet bus (TUI fleet chat, agent monitor, WebUI timeline) and the host
 * bus (subagent tool events, file activity) — so background ACP subagents are
 * watched exactly like native workers.
 */
import { describe, expect, it } from 'vitest';
import type { ACPProgressEvent } from '@wrongstack/acp';
import { publishAcpLiveProgress } from '../src/fleet/acp-live-progress.js';

interface CapturedBus {
  events: Array<{ subagentId: string; taskId?: string; ts: number; type: string; payload: unknown }>;
  emit: (e: {
    subagentId: string;
    taskId?: string;
    ts: number;
    type: string;
    payload: unknown;
  }) => void;
}

function fakeFleet(): CapturedBus {
  const events: CapturedBus['events'] = [];
  return {
    events,
    emit: (e) => {
      events.push(e);
    },
  };
}

function fakeHostEvents(): { emits: Array<{ event: string; payload: Record<string, unknown> }>; emit: (event: string, payload: unknown) => void } {
  const emits: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    emits,
    emit: (event: string, payload: unknown) => {
      emits.push({ event, payload: payload as Record<string, unknown> });
    },
  };
}

const BASE = {
  subagentId: 'sub-acp-1',
  agentName: 'claude-code',
  sessionId: 'sess-owner',
  taskId: 'task-9',
};

function publish(
  event: ACPProgressEvent,
  buses: { fleet?: CapturedBus; hostEvents?: ReturnType<typeof fakeHostEvents> } = {},
): { fleet: CapturedBus; hostEvents: ReturnType<typeof fakeHostEvents> } {
  const fleet = buses.fleet ?? fakeFleet();
  const hostEvents = buses.hostEvents ?? fakeHostEvents();
  publishAcpLiveProgress({
    event,
    subagentId: BASE.subagentId,
    agentName: BASE.agentName,
    sessionId: BASE.sessionId,
    taskId: BASE.taskId,
    fleet: fleet as never,
    hostEvents: hostEvents as never,
  });
  return { fleet, hostEvents };
}

describe('publishAcpLiveProgress', () => {
  it('maps assistant message text onto provider.text_delta', () => {
    const { fleet } = publish({ type: 'message', text: 'refactoring…' });
    expect(fleet.events).toHaveLength(1);
    expect(fleet.events[0]).toMatchObject({
      subagentId: BASE.subagentId,
      taskId: BASE.taskId,
      type: 'provider.text_delta',
      payload: { text: 'refactoring…' },
    });
  });

  it('maps thoughts onto provider.thinking_delta and drops empty text', () => {
    const { fleet } = publish({ type: 'thought', text: 'hmm' });
    expect(fleet.events[0]?.type).toBe('provider.thinking_delta');
    expect(fleet.events[0]?.payload).toEqual({ text: 'hmm' });

    const empty = publish({ type: 'message', text: '' }).fleet;
    expect(empty.events).toHaveLength(0);
  });

  it('emits a tool start on both buses with a compacted input', () => {
    const huge = 'x'.repeat(50_000);
    const { fleet, hostEvents } = publish({
      type: 'tool_call',
      toolCall: {
        toolCallId: 'tu-1',
        title: 'Write src/app.ts',
        kind: 'edit',
        status: 'in_progress',
        rawInput: { file_path: 'src/app.ts', content: huge },
      },
    });
    expect(fleet.events[0]).toMatchObject({
      type: 'tool.started',
      payload: { id: 'tu-1', name: 'Write src/app.ts' },
    });
    const input = fleet.events[0]!.payload as { input: Record<string, unknown> };
    expect(input.input['file_path']).toBe('src/app.ts');
    expect(input.input['content']).toBeUndefined();
    expect(JSON.stringify(input.input)).not.toContain(huge);

    const started = hostEvents.emits.find((e) => e.event === 'subagent.tool_started');
    expect(started?.payload).toMatchObject({
      sessionId: BASE.sessionId,
      subagentId: BASE.subagentId,
      agentName: BASE.agentName,
      taskId: BASE.taskId,
      id: 'tu-1',
      name: 'Write src/app.ts',
    });
  });

  it('falls back to the tool kind when the title is empty', () => {
    const { fleet } = publish({
      type: 'tool_call',
      toolCall: { toolCallId: 'tu-2', title: '', kind: 'execute', status: 'in_progress' },
    });
    expect((fleet.events[0]!.payload as { name: string }).name).toBe('execute');
  });

  it('maps a completed tool call update onto tool.executed and subagent.tool_executed', () => {
    const { fleet, hostEvents } = publish({
      type: 'tool_call_update',
      toolCall: {
        toolCallId: 'tu-1',
        title: 'run tests',
        kind: 'execute',
        status: 'completed',
        rawOutput: { exitCode: 0 },
      },
    });
    expect(fleet.events[0]).toMatchObject({
      type: 'tool.executed',
      payload: { id: 'tu-1', name: 'run tests', ok: true, output: '{"exitCode":0}' },
    });
    const executed = hostEvents.emits.find((e) => e.event === 'subagent.tool_executed');
    expect(executed?.payload).toMatchObject({
      sessionId: BASE.sessionId,
      subagentId: BASE.subagentId,
      agentName: BASE.agentName,
      taskId: BASE.taskId,
      id: 'tu-1',
      ok: true,
    });
  });

  it('marks a failed update as ok:false and ignores in-flight statuses', () => {
    const { fleet } = publish({
      type: 'tool_call_update',
      toolCall: { toolCallId: 'tu-3', title: 'deploy', status: 'failed', kind: 'execute' },
    });
    expect((fleet.events[0]!.payload as { ok: boolean }).ok).toBe(false);

    const inFlight = publish({
      type: 'tool_call_update',
      toolCall: { toolCallId: 'tu-3', title: 'deploy', status: 'in_progress' },
    }).fleet;
    expect(inFlight.events).toHaveLength(0);
  });

  it('caps oversized tool outputs instead of bridging megabytes', () => {
    const huge = 'y'.repeat(10_000);
    const { fleet } = publish({
      type: 'tool_call_update',
      toolCall: {
        toolCallId: 'tu-4',
        title: 'write',
        status: 'completed',
        rawOutput: { body: huge },
      },
    });
    const output = (fleet.events[0]!.payload as { output: string }).output;
    expect(output.length).toBeLessThan(4_100);
    expect(output.endsWith('…')).toBe(true);
  });

  it('maps a new-file diff onto file.activity write and an edit onto edit', () => {
    const created = publish({ type: 'diff', diff: { path: 'src/new.ts', oldText: null, newText: 'x' } })
      .hostEvents.emits.find((e) => e.event === 'file.activity');
    expect(created?.payload).toMatchObject({
      filePath: 'src/new.ts',
      operation: 'write',
      phase: 'changed',
      source: 'deterministic',
      sessionId: BASE.sessionId,
      agentId: BASE.subagentId,
      agentName: BASE.agentName,
    });

    const edited = publish({
      type: 'diff',
      diff: { path: 'src/a.ts', oldText: 'old', newText: 'new' },
    }).hostEvents.emits.find((e) => e.event === 'file.activity');
    expect(edited?.payload.operation).toBe('edit');
  });

  it('drops diffs without a path and plan/usage events entirely', () => {
    const noPath = publish({ type: 'diff', diff: { path: '', oldText: null, newText: '' } }).hostEvents;
    expect(noPath.emits).toHaveLength(0);

    const { fleet, hostEvents } = publish({
      type: 'plan',
      entries: [{ id: '1', description: 'step' }] as never,
    });
    expect(fleet.events).toHaveLength(0);
    expect(hostEvents.emits).toHaveLength(0);
  });
});
