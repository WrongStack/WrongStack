// @vitest-environment jsdom
import { CollabPanel } from '@wrongstack/project-surfaces/collab/CollabPanel';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../src/engine-state';
import { collabClient, pendingToolCalls } from '../src/session-collab-model';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeStream() {
  const listeners = new Set<(event: EngineEvent) => void>();
  const sent: Array<[string, Record<string, unknown>]> = [];
  let fail: Error | null = null;
  return {
    sent,
    failNext: (error: Error) => {
      fail = error;
    },
    emit: (event: EngineEvent) => {
      for (const listener of listeners) listener(event);
    },
    stream: {
      listen(listener: (event: EngineEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async send(type: string, payload: Record<string, unknown>) {
        sent.push([type, payload]);
        if (fail) {
          const error = fail;
          fail = null;
          throw error;
        }
      },
    },
  };
}

describe('conversation collaboration', () => {
  it('hands the panel only frames stamped after it opened, and refusals as errors', async () => {
    const fake = fakeStream();
    const client = collabClient(fake.stream, 10_000);
    const states = vi.fn();
    const errors = vi.fn();
    client.on('collab.state', states);
    client.on('error', errors);
    fake.emit({ type: 'collab.state', payload: { participants: ['old'] }, at: 5_000 });
    fake.emit({ type: 'collab.state', payload: { participants: ['new'] }, at: 10_500 });
    fake.emit({ type: 'collab.event', payload: {}, at: 10_500 });
    expect(states.mock.calls.map(([message]) => message.payload)).toEqual([
      { participants: ['new'] },
    ]);
    fake.failNext(new Error('Invalid message'));
    client.send('collab.join', { sessionId: 's1', role: 'observer' });
    await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
    expect(errors.mock.calls[0]?.[0]).toEqual({
      type: 'error',
      payload: { phase: 'collab', message: 'Invalid message' },
    });
  });

  it('offers the calls still running as injection targets', () => {
    expect(
      pendingToolCalls([
        { type: 'tool.started', payload: { id: 'a', name: 'read', input: { path: 'x' } } },
        { type: 'tool.started', payload: { id: 'b', name: 'bash' } },
        { type: 'tool.executed', payload: { id: 'a', ok: true } },
      ]),
    ).toEqual([{ toolUseId: 'b', toolName: 'bash', toolInput: undefined }]);
  });

  it('joins as an observer and shows who is watching, in the display language', async () => {
    const fake = fakeStream();
    const client = collabClient(fake.stream, 0);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await surfaceI18n.changeLanguage('en');
    await act(async () => {
      root.render(
        createElement(
          I18nextProvider,
          { i18n: surfaceI18n },
          createElement(CollabPanel, { sessionId: 's1', client, pendingTools: [] }),
        ),
      );
    });
    expect(host.textContent).toContain('No live observers');
    const join = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('observer'),
    );
    await act(async () => join?.click());
    expect(fake.sent[0]).toEqual(['collab.join', { sessionId: 's1', role: 'observer' }]);
    await act(async () =>
      fake.emit({
        type: 'collab.state',
        payload: {
          sessionId: 's1',
          participants: [
            { participantId: 'p1', role: 'observer', joinedAt: '2026-11-04T10:00:00Z' },
          ],
        },
        at: 1,
      }),
    );
    expect(host.textContent).toContain('1 observer');
    expect(host.textContent).toContain('Leave');
    await act(async () => root.unmount());
    host.remove();
  });
});
