// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/model';

const request = vi.hoisted(() => vi.fn(async () => ({ warming: true })));
vi.mock('../src/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/platform')>()),
  native: true,
  request,
}));

const { ConversationReconnect } = await import('../src/ConversationReconnect');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = (status: Session['status'], kind: Session['kind'] = 'agent'): Session => ({
  id: `desk-${status}-${kind}`,
  projectId: 'p1',
  title: 'Fix it',
  kind,
  workdir: 'D:/repo',
  status,
  createdAt: 1,
  updatedAt: 1,
  exitCode: null,
  error: null,
});

async function render(props: Parameters<typeof ConversationReconnect>[0]) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(ConversationReconnect, props)));
  await act(async () => root.unmount());
}

describe('opening a stopped conversation', () => {
  it('asks the host to warm the engine its reconnect will take, only from its own notice', async () => {
    await render({ session: session('interrupted') });
    expect(request).toHaveBeenCalledWith('session.prewarm', { id: 'desk-interrupted-agent' });
    request.mockClear();
    await render({ session: session('running') });
    await render({ session: session('stopped', 'terminal') });
    await render({ session: session('error'), compact: true });
    expect(request).not.toHaveBeenCalled();
  });
});
