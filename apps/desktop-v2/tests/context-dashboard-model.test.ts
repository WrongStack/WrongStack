import { describe, expect, it } from 'vitest';
import { contextBreakdown, contextSession } from '../src/context-dashboard-model';
import { emptyContextUsage } from '../src/context-usage';
import type { EngineState } from '../src/engine-state';

function stateWith(
  results: Record<string, Record<string, unknown>>,
  extra: Partial<EngineState> = {},
): EngineState {
  return {
    results,
    running: false,
    model: 'glm-5',
    provider: 'zai',
    context: { ...emptyContextUsage, tokens: 50_000, max: 200_000 },
    ...extra,
  } as EngineState;
}

describe('context dashboard session', () => {
  it("reads the conversation's tokens, model, modes, start and project", () => {
    const session = contextSession(
      stateWith({
        'session.start': {
          mode: 'yolo',
          contextMode: 'balanced',
          startedAt: '2026-11-03T12:00:00.000Z',
        },
      }),
      'D:\\Codebox\\PROJECTS\\WrongMemory\\',
    );
    expect(session).toEqual({
      lastInputTokens: 50_000,
      maxContext: 200_000,
      model: 'glm-5',
      provider: 'zai',
      mode: 'yolo',
      contextMode: 'balanced',
      startTime: Date.parse('2026-11-03T12:00:00.000Z'),
      iteration: null,
      projectName: 'WrongMemory',
      cwd: 'D:\\Codebox\\PROJECTS\\WrongMemory\\',
    });
  });

  it('takes the newest word on the context mode, and says when none came', () => {
    const start = { contextMode: 'balanced' };
    const listed = { modes: [{ id: 'lean', isActive: true }, { id: 'balanced' }] };
    expect(contextSession(stateWith({ 'session.start': start }), '').contextMode).toBe('balanced');
    expect(
      contextSession(stateWith({ 'session.start': start, 'context.modes.list': listed }), '')
        .contextMode,
    ).toBe('lean');
    expect(
      contextSession(
        stateWith({
          'session.start': start,
          'context.modes.list': listed,
          'context.mode.changed': { id: 'deep' },
        }),
        '',
      ).contextMode,
    ).toBe('deep');
    expect(contextSession(stateWith({}), '').contextMode).toBe('—');
    expect(contextSession(stateWith({}), '').mode).toBe('default');
    expect(contextSession(stateWith({}), '').startTime).toBeNull();
  });

  it("shows the leader's iteration only while a turn runs", () => {
    const leader = { 'iteration.started': { index: 3, maxIterations: 40 } };
    expect(contextSession(stateWith(leader, { running: true }), '').iteration).toEqual({
      index: 3,
      max: 40,
    });
    expect(contextSession(stateWith(leader), '').iteration).toBeNull();
    const worker = { 'iteration.started': { index: 2, maxIterations: 10, agentId: 'w-1' } };
    expect(contextSession(stateWith(worker, { running: true }), '').iteration).toBeNull();
  });
});

describe('context breakdown reply', () => {
  it('passes a breakdown through and turns anything else into its message', () => {
    const breakdown = {
      total: 3,
      systemPrompt: 1,
      tools: { total: 1, count: 1, breakdown: [] },
      messages: { total: 1, count: 1, breakdown: [] },
    };
    expect(contextBreakdown(breakdown)).toBe(breakdown);
    expect(() => contextBreakdown({ message: 'No active session.' })).toThrow('No active session.');
    expect(() => contextBreakdown({ total: 3, tools: {}, messages: {} })).toThrow(
      'The engine did not report how the context is made up.',
    );
  });
});
