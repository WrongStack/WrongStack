import { describe, expect, it, vi } from 'vitest';
import { createEventUserInputAwaiter } from '../../src/core/user-input-awaiter.js';
import { createApprovalRegistry } from '../../src/hq/approval-bridge.js';
import { EventBus } from '../../src/kernel/events.js';

const request = {
  id: 'request-1',
  title: 'Decisions',
  tabs: [{ id: 'main', label: 'Main', questions: [] }],
};

describe('structured user input awaiter', () => {
  it('returns undefined without an interactive observer', async () => {
    const events = new EventBus();
    await expect(
      createEventUserInputAwaiter(events)(request, {
        signal: new AbortController().signal,
        sessionId: 's1',
      }),
    ).resolves.toBeUndefined();
  });

  it('does not treat the passive HQ mirror as a local answering surface', async () => {
    const events = new EventBus();
    const registry = createApprovalRegistry(events);
    await expect(
      createEventUserInputAwaiter(events)(request, {
        signal: new AbortController().signal,
        sessionId: 's1',
      }),
    ).resolves.toBeUndefined();
    registry.dispose();
  });

  it('accepts only the matching session and resolves all mirrors once', async () => {
    const events = new EventBus();
    const resolved = vi.fn();
    events.on('user.input_requested', () => undefined);
    events.on('user.input_resolved', resolved);
    const waiting = createEventUserInputAwaiter(events)(request, {
      signal: new AbortController().signal,
      sessionId: 's1',
    });
    events.emit('user.input_submitted', {
      sessionId: 'other',
      response: { requestId: 'request-1', status: 'submitted', answers: [] },
    });
    events.emit('user.input_submitted', {
      sessionId: 's1',
      response: { requestId: 'request-1', status: 'submitted', answers: [] },
    });
    await expect(waiting).resolves.toMatchObject({ status: 'submitted' });
    expect(resolved).toHaveBeenCalledOnce();
  });
});
