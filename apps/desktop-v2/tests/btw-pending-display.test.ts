// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BtwReceipts } from '../src/BtwReceipts';
import { btwReceipts } from '../src/btw-receipts';
import type { EngineCommand } from '../src/engine-operations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounts: Array<{ root: Root; host: HTMLDivElement }> = [];
async function mount(sessionId: string, command: EngineCommand) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounts.push({ root, host });
  await act(async () =>
    root.render(createElement(BtwReceipts, { sessionId, command, mailboxEvent: null })),
  );
  return { host, root };
}
afterEach(async () => {
  for (const { root, host } of mounts.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.useRealTimers();
});

describe('pending-only BTW display', () => {
  it('removes consumed instructions without expanding the panel, and keeps them gone on remount', async () => {
    vi.useFakeTimers();
    const sessionId = 'pending-consumption';
    const id = 'btw:consumption';
    await btwReceipts.record(sessionId, {
      messageId: id,
      text: 'Keep API compatibility',
      sentAt: 1,
    });
    let pending = true;
    const command = vi.fn(async () => ({
      items: pending ? [{ id, text: 'Keep API compatibility' }] : [],
    }));
    const view = await mount(sessionId, command);
    expect(view.host.querySelector('details')?.open).toBe(false);
    expect(view.host.textContent).toContain('Keep API compatibility');
    pending = false;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(view.host.textContent).toBe('');
    const calls = command.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(command.mock.calls).toHaveLength(calls);
    const reopened = await mount(sessionId, command);
    expect(reopened.host.textContent).toBe('');
    expect(btwReceipts.list(sessionId)).toHaveLength(1); // Audit history is not deleted.
  });
  it('clears processed legacy mail while retaining an unread note', async () => {
    const sessionId = 'legacy-pending';
    for (const id of ['read', 'completed', 'unread'])
      await btwReceipts.record(sessionId, { messageId: id, text: `Legacy ${id}`, sentAt: 1 });
    const command = vi.fn(async () => ({
      messages: [
        { id: 'read', readBy: { 'leader@own': 'now' } },
        { id: 'completed', completed: true },
        { id: 'unread', readBy: {} },
      ],
    }));
    const { host } = await mount(sessionId, command);
    expect(host.textContent).not.toContain('Legacy read');
    expect(host.textContent).not.toContain('Legacy completed');
    expect(host.textContent).toContain('Legacy unread');
  });
  it('does not treat a failed status request as consumption', async () => {
    vi.useFakeTimers();
    const sessionId = 'failed-pending';
    await btwReceipts.record(sessionId, {
      messageId: 'btw:failure',
      text: 'Still pending',
      sentAt: 1,
    });
    let fail = false;
    const command = vi.fn(async () => {
      if (fail) throw Error('Disconnected fixture');
      return { items: [{ id: 'btw:failure' }] };
    });
    const { host } = await mount(sessionId, command);
    fail = true;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(host.textContent).toContain('Still pending');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Disconnected fixture');
  });
  it('drops an old session response after switching conversations', async () => {
    const oldSession = 'pending-old';
    await btwReceipts.record(oldSession, { messageId: 'btw:old', text: 'Foreign note', sentAt: 1 });
    let resolve: ((result: Record<string, unknown>) => void) | undefined;
    const command = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((done) => {
          resolve = done;
        }),
    );
    const view = await mount(oldSession, command);
    await act(async () =>
      view.root.render(
        createElement(BtwReceipts, { sessionId: 'pending-new', command, mailboxEvent: null }),
      ),
    );
    if (!resolve) throw Error('The old-session status request did not start.');
    const finish = resolve;
    await act(async () => finish({ items: [{ id: 'btw:old' }] }));
    expect(view.host.textContent).toBe('');
  });
});
