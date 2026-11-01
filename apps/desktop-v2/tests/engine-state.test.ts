import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

const started = () =>
  reduceEngine(emptyEngineState, {
    type: 'session.start',
    payload: { sessionId: 'core-a', provider: 'local', model: 'test' },
  });
describe('native agent session projection', () => {
  it('keeps shared policy and session preferences when the server splits their updates', () => {
    const shared = reduceEngine(started(), {
      type: 'prefs.updated',
      payload: { disabledModels: ['local/off'], favoriteModels: ['local/test'] },
    });
    const scoped = reduceEngine(shared, {
      type: 'prefs.updated',
      payload: { sessionId: 'core-a', reasoningEffort: 'high' },
    });
    expect(scoped.results['prefs.updated']).toMatchObject({
      disabledModels: ['local/off'],
      favoriteModels: ['local/test'],
      reasoningEffort: 'high',
    });
    const foreign = reduceEngine(scoped, {
      type: 'prefs.updated',
      payload: { sessionId: 'other', reasoningEffort: 'low', favoriteModels: [] },
    });
    expect(foreign).toBe(scoped);
  });
  it('replaces the displayed transcript after rewind, including an empty retained history', () => {
    const state = reduceEngine(started(), {
      type: 'provider.text_delta',
      payload: { messageId: 'future', text: 'Discarded future answer' },
    });
    for (const replayMessages of [[], [{ role: 'user', content: 'Retained prompt' }]]) {
      const next = reduceEngine(state, {
        type: 'session.start',
        payload: { sessionId: 'core-a', reset: true, replayMessages },
      });
      expect(next.messages.map((message) => message.text)).toEqual(
        replayMessages.map((message) => message.content),
      );
      expect(next.running).toBe(false);
    }
    expect(
      reduceEngine(state, { type: 'session.start', payload: { sessionId: 'core-a', reset: true } })
        .messages,
    ).toEqual(state.messages);
    expect(
      reduceEngine(state, {
        type: 'session.start',
        payload: { sessionId: 'core-b', reset: true, replayMessages: [] },
      }),
    ).toBe(state);
  });
  it('keeps completed replies separate when the server reuses the current stream ID', () => {
    for (const userTurn of [true, false]) {
      let state = started();
      state = reduceEngine(state, {
        type: 'provider.text_delta',
        payload: { messageId: 'current', text: 'First answer' },
      });
      state = reduceEngine(state, { type: 'run.result', payload: { status: 'done' } });
      if (userTurn)
        state = reduceEngine(state, {
          type: 'desktop.user_message',
          payload: { id: 'next-user', content: 'Next question' },
        });
      state = reduceEngine(state, {
        type: 'provider.text_delta',
        payload: { messageId: 'current', text: 'Next ' },
      });
      state = reduceEngine(state, {
        type: 'provider.text_delta',
        payload: { messageId: 'current', text: 'answer' },
      });
      expect(
        state.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.text),
      ).toEqual(['First answer', 'Next answer']);
    }
  });
  it('publishes acknowledged direct user messages once and keeps refused submissions out of the transcript', () => {
    let state = started();
    state = reduceEngine(state, {
      type: 'desktop.user_message',
      payload: { id: 'pending-a', requestId: 'request-a', content: 'Human instruction' },
    });
    expect(state.messages).toEqual([]);
    expect(state.running).toBe(false);
    state = reduceEngine(state, {
      type: 'key.operation_result',
      payload: { phase: 'user_message', requestId: 'request-a', success: true },
    });
    expect(state.messages).toMatchObject([{ id: 'pending-a', text: 'Human instruction' }]);
    expect(state.running).toBe(true);
    state = reduceEngine(state, { type: 'run.result', payload: { status: 'done' } });
    state = reduceEngine(state, {
      type: 'desktop.user_message',
      payload: { id: 'pending-b', requestId: 'request-b', content: 'Refused draft' },
    });
    state = reduceEngine(state, {
      type: 'error',
      payload: { requestId: 'request-b', message: 'Turn unavailable' },
    });
    expect(state.messages).toHaveLength(1);
    expect(state.pendingUserMessages).toEqual({});
    expect(state.running).toBe(false);
  });
  it('keeps overlapping provider test runs and model results separate during replay', () => {
    let state = started();
    for (const requestId of ['test-a', 'test-b']) {
      state = reduceEngine(state, {
        type: 'provider.test.started',
        payload: { requestId, providerId: requestId, total: 2 },
      });
    }
    state = reduceEngine(state, {
      type: 'provider.test.result',
      payload: { requestId: 'test-a', modelId: 'model-a', status: 'ok' },
    });
    state = reduceEngine(state, {
      type: 'provider.test.result',
      payload: { requestId: 'test-b', modelId: 'model-b', status: 'failed' },
    });
    state = reduceEngine(state, {
      type: 'provider.test.complete',
      payload: { requestId: 'test-a', passed: 1 },
    });
    expect(Object.keys(state.providerTests['test-a']!.results)).toEqual(['model-a']);
    expect(Object.keys(state.providerTests['test-b']!.results)).toEqual(['model-b']);
    expect(state.providerTests['test-a']!.complete).toMatchObject({ passed: 1 });
    expect(state.providerTests['test-b']!.complete).toBeNull();
  });
  it('observes project workflow snapshots owned by another core session without mixing conversations', () => {
    const state = started();
    const projected = reduceEngine(state, {
      type: 'sdd.board.snapshot',
      payload: { sessionId: 'core-worker', runId: 'project-run', status: 'running' },
    });
    expect(projected.results['sdd.board.snapshot']?.['runId']).toBe('project-run');
    expect(projected.messages).toEqual(state.messages);
    expect(
      reduceEngine(state, {
        type: 'provider.text_delta',
        payload: { sessionId: 'core-worker', text: 'Other conversation' },
      }),
    ).toBe(state);
  });
  it('ignores empty transport frames without losing the following model acknowledgement', () => {
    let state = started();
    for (const frame of [{}, null, { type: 7 }, { type: 'provider.notice', payload: null }]) {
      state = reduceEngine(state, frame);
    }
    expect(state.provider).toBe('local');
    state = reduceEngine(state, {
      type: 'model.switch_result',
      payload: { success: true, provider: 'saved', model: 'fixture' },
    });
    expect(state).toMatchObject({ provider: 'saved', model: 'fixture', needsSetup: false });
  });
  it('requires provider setup until a successful model selection is acknowledged', () => {
    const unconfigured = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 'core-a', provider: 'unconfigured', model: '', needsSetup: true },
    });
    expect(unconfigured.needsSetup).toBe(true);
    expect(started().needsSetup).toBe(false);
    const failed = reduceEngine(unconfigured, {
      type: 'model.switch_result',
      payload: { success: false, message: 'Unknown model' },
    });
    expect(failed.needsSetup).toBe(true);
    const configured = reduceEngine(failed, {
      type: 'model.switch_result',
      payload: { success: true, provider: 'local', model: 'fixture' },
    });
    expect(configured).toMatchObject({ needsSetup: false, provider: 'local', model: 'fixture' });
  });
  it('replays a conversation and assembles streamed assistant messages without duplicating sends', () => {
    let state = started();
    const user = {
      type: 'desktop.user_message',
      payload: { sessionId: 'core-a', id: 'u1', content: 'Build it' },
    };
    state = reduceEngine(reduceEngine(state, user), user);
    state = reduceEngine(state, {
      type: 'provider.text_delta',
      payload: { sessionId: 'core-a', messageId: 'a1', text: 'Hello ' },
    });
    state = reduceEngine(state, {
      type: 'provider.text_delta',
      payload: { sessionId: 'core-a', messageId: 'a1', text: 'world' },
    });
    expect(state.messages.map((m) => m.text)).toEqual(['Build it', 'Hello world']);
    expect(
      reduceEngine(state, { type: 'run.result', payload: { sessionId: 'core-a', status: 'done' } })
        .running,
    ).toBe(false);
  });
  it('keeps other sessions and their approval requests out of the selected session', () => {
    const state = started();
    expect(
      reduceEngine(state, {
        type: 'provider.text_delta',
        payload: { sessionId: 'core-b', messageId: 'b1', text: 'Wrong project' },
      }),
    ).toBe(state);
    expect(reduceEngine(state, { type: 'session.start', payload: { sessionId: 'core-b' } })).toBe(
      state,
    );
    expect(
      reduceEngine(state, {
        type: 'tool.confirm_needed',
        payload: { sessionId: 'core-b', id: 'c1' },
      }),
    ).toBe(state);
  });
  it('retains pending approvals until the engine resolves them and reports a disconnected host', () => {
    let state = reduceEngine(started(), {
      type: 'tool.confirm_needed',
      payload: { sessionId: 'core-a', id: 'c1', toolName: 'terminal' },
    });
    expect(state.approvals).toHaveLength(1);
    state = reduceEngine(state, {
      type: 'tool.confirm_resolved',
      payload: { sessionId: 'core-a', id: 'c1' },
    });
    expect(state.approvals).toEqual([]);
    state = reduceEngine(state, {
      type: 'desktop.disconnected',
      payload: { message: 'Engine stopped' },
    });
    expect(state.connected).toBe(false);
    expect(state.error).toBe('Engine stopped');
  });
});

describe('user-run MCP tool', () => {
  it('shows the result the engine added to the conversation, once, and nothing it did not add', () => {
    const result = (payload: Record<string, unknown>) => ({
      type: 'mcp.tool.result',
      payload: { sessionId: 'core-a', requestId: 'r1', tool: 'echo', success: true, ...payload },
    });
    const added = reduceEngine(
      started(),
      result({ addedToConversation: true, note: '[User-run MCP tool] echo said pong' }),
    );
    expect(added.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', '[User-run MCP tool] echo said pong'],
    ]);
    const again = reduceEngine(
      added,
      result({ addedToConversation: true, note: '[User-run MCP tool] echo said pong' }),
    );
    expect(again.messages).toHaveLength(1);
    expect(reduceEngine(started(), result({ addedToConversation: false })).messages).toEqual([]);
  });
});
