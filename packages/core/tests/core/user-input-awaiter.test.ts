import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it, vi } from 'vitest';
import {
  createEventUserInputAwaiter,
  isUnattendedAutonomy,
} from '../../src/core/user-input-awaiter.js';
import { createApprovalRegistry } from '../../../hq/src/approval-bridge.js';

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

describe('a form nobody answers during eternal / parallel autonomy', () => {
  const unattended = (meta: Readonly<Record<string, unknown>> | undefined) =>
    isUnattendedAutonomy(meta?.['autonomy']);

  it('is given no answer after the wait, and every surface closes it', async () => {
    const events = new EventBus();
    const resolved = vi.fn();
    events.on('user.input_requested', () => undefined);
    events.on('user.input_resolved', resolved);
    const waiting = createEventUserInputAwaiter(events, {
      isUnattended: unattended,
      unattendedWaitMs: 20,
    })(request, {
      signal: new AbortController().signal,
      sessionId: 's1',
      meta: { autonomy: 'eternal' },
    });
    // No answer: `clarify` then takes its recommended answers, an elicitation is cancelled.
    await expect(waiting).resolves.toBeUndefined();
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'request-1', source: 'unattended' }),
    );
  });

  it('keeps waiting in an attended mode, and gives up once the mode turns eternal', async () => {
    const events = new EventBus();
    events.on('user.input_requested', () => undefined);
    const meta: Record<string, unknown> = { autonomy: 'auto' };
    let settled = false;
    const waiting = createEventUserInputAwaiter(events, {
      isUnattended: unattended,
      unattendedWaitMs: 20,
    })(request, { signal: new AbortController().signal, sessionId: 's1', meta });
    void waiting.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);
    meta['autonomy'] = 'eternal-parallel';
    await expect(waiting).resolves.toBeUndefined();
  });

  it('still takes a real answer that arrives in time', async () => {
    const events = new EventBus();
    events.on('user.input_requested', (event) =>
      event.resolve({ requestId: 'request-1', status: 'submitted', answers: [] }),
    );
    await expect(
      createEventUserInputAwaiter(events, { isUnattended: () => true, unattendedWaitMs: 5_000 })(
        request,
        { signal: new AbortController().signal, sessionId: 's1' },
      ),
    ).resolves.toMatchObject({ status: 'submitted' });
  });
});

describe('isUnattendedAutonomy', () => {
  it("prefers the conversation's mode over the process-wide one", () => {
    expect(isUnattendedAutonomy('eternal')).toBe(true);
    expect(isUnattendedAutonomy('eternal-parallel')).toBe(true);
    expect(isUnattendedAutonomy('auto', 'eternal')).toBe(false);
    expect(isUnattendedAutonomy(undefined, 'eternal')).toBe(true);
    expect(isUnattendedAutonomy(undefined, 'auto')).toBe(false);
  });
});
