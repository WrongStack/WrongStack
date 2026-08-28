import { describe, expect, it } from 'vitest';
import { useFleetStore } from '../../src/stores/index.js';

describe('AgentDetailSection data paths', () => {
  beforeEach(() => {
    useFleetStore.setState({
      agents: new Map(),
      agentTranscripts: new Map(),
    });
  });

  it('stores and retrieves agent transcript entries', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'AgentOne',
    });

    useFleetStore.getState().pushAgentTimelineEntry({
      subagentId: 'a1',
      agentName: 'AgentOne',
      content: 'Hello from agent',
      kind: 'text',
      iteration: 1,
      ts: new Date().toISOString(),
    });

    useFleetStore.getState().pushAgentTimelineEntry({
      subagentId: 'a1',
      agentName: 'AgentOne',
      content: 'Thinking about solution',
      kind: 'thinking',
      iteration: 1,
      ts: new Date().toISOString(),
    });

    const transcript = useFleetStore.getState().getAgentTranscript('a1');
    expect(transcript.length).toBe(2);
    expect(transcript[0].content).toBe('Hello from agent');
    expect(transcript[0].kind).toBe('text');
    expect(transcript[1].kind).toBe('thinking');
  });

  it('transcript returns empty array for unknown agent', () => {
    expect(useFleetStore.getState().getAgentTranscript('nonexistent')).toEqual([]);
  });

  it('records tool execution in toolLog', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Worker',
    });
    useFleetStore.getState().applyEvent({
      kind: 'tool_executed',
      subagentId: 'a1',
      toolName: 'read_file',
      ok: true,
    });
    useFleetStore.getState().applyEvent({
      kind: 'tool_executed',
      subagentId: 'a1',
      toolName: 'bash',
      ok: false,
    });

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.toolLog.length).toBe(2);
    expect(agent?.toolLog[0].name).toBe('bash'); // most recent first
    expect(agent?.toolLog[0].ok).toBe(false);
    expect(agent?.toolLog[1].name).toBe('read_file');
    expect(agent?.toolLog[1].ok).toBe(true);
  });

  it('records partialText from iteration_summary', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Writer',
    });
    useFleetStore.getState().applyEvent({
      kind: 'iteration_summary',
      subagentId: 'a1',
      partialText: 'Working on task...',
    });
    useFleetStore.getState().applyEvent({
      kind: 'iteration_summary',
      subagentId: 'a1',
      partialText: 'Almost done...',
    });

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.partialText).toBe('Almost done...');
  });

  it('records failureReason on task_completed with failed status', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'FailingAgent',
    });
    useFleetStore.getState().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'failed',
      failureReason: 'provider_auth',
      error: { kind: 'auth_error', message: 'Invalid API key' },
    });

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.status).toBe('failed');
    expect(agent?.failureReason).toBe('provider_auth');
    expect(agent?.error?.kind).toBe('auth_error');
    expect(agent?.error?.message).toBe('Invalid API key');
  });

  it('records description and taskId for config display', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'ConfiguredAgent',
      description: 'Audits auth layer',
      taskId: 'task_42',
    });

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.description).toBe('Audits auth layer');
    expect(agent?.taskId).toBe('task_42');
  });

  it('toolLog is capped and most-recent-first', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'BusyAgent',
    });
    // Push 55 tool calls (toolLog is capped at 50)
    for (let i = 0; i < 55; i++) {
      useFleetStore.getState().applyEvent({
        kind: 'tool_executed',
        subagentId: 'a1',
        toolName: `tool_${i}`,
        ok: true,
      });
    }

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.toolLog.length).toBeLessThanOrEqual(50);
    // Most recent tool first
    expect(agent?.toolLog[0].name).toBe('tool_54');
  });

  it('agent has provider and model from spawned event', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'ModelAgent',
      provider: 'anthropic',
      model: 'claude-opus-4',
    });

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.provider).toBe('anthropic');
    expect(agent?.model).toBe('claude-opus-4');
  });

  it('spawned event records costUsd via iteration_summary', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Costly',
    });
    useFleetStore.getState().applyEvent({
      kind: 'iteration_summary',
      subagentId: 'a1',
      costUsd: 0.042,
    });

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.costUsd).toBeCloseTo(0.042);
  });

  it('expand/collapse clears via clearFinishedAgents and pushAgentTimelineEntry', () => {
    // Simulate: agent runs, has transcript, gets finished, then cleared
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Temp',
      sessionId: 'sess-a',
    });
    useFleetStore.getState().pushAgentTimelineEntry({
      subagentId: 'a1',
      agentName: 'Temp',
      content: 'work',
      kind: 'text',
      iteration: 1,
      ts: new Date().toISOString(),
    });
    useFleetStore.getState().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'success',
    });

    expect(useFleetStore.getState().agents.get('a1')).toBeDefined();
    expect(useFleetStore.getState().getAgentTranscript('a1').length).toBeGreaterThan(0);

    useFleetStore.getState().clearFinishedAgents('sess-a');

    expect(useFleetStore.getState().agents.get('a1')).toBeUndefined();
    expect(useFleetStore.getState().getAgentTranscript('a1')).toEqual([]);
  });
});
