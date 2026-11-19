/**
 * @vitest-environment jsdom
 *
 * Requests are answered concurrently and the server echoes a request's requestId on
 * git.* replies, so the Changes list keeps the answer to the newest request.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Frame = { type: string; payload?: Record<string, unknown> };
let transport: { onMessage: (f: Frame) => void; onState: (s: string) => void } | null = null;
const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
vi.mock('../src/lib/transport.js', () => ({
  VibeTransport: class {
    constructor(opts: typeof transport) {
      transport = opts;
    }
    async connect() {}
    send(type: string, payload: Record<string, unknown> = {}) {
      sent.push({ type, payload });
      return true;
    }
    close() {}
  },
  TOKEN_KEY: 'k',
  STABLE_CONNECTION_MS: 10_000,
}));

const { useSession } = await import('../src/lib/use-session.js');

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  sent.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** A git.changes reply as the server builds it: the request's requestId echoed iff present. */
async function serverReply(request: Record<string, unknown>, files: string[]): Promise<Frame> {
  return {
    type: 'git.changes',
    payload: {
      files: files.map((path) => ({ path, status: 'M', added: 1, deleted: 0 })),
      ...(typeof request.requestId === 'string' ? { requestId: request.requestId } : {}),
    },
  };
}

async function mountSession() {
  let api!: ReturnType<typeof useSession>;
  function Harness() {
    api = useSession();
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => {
    transport!.onState('open');
    transport!.onMessage({
      type: 'session.start',
      payload: { id: 's1', sessionId: 's1', provider: 'p', model: 'm', running: false },
    });
  });
  sent.length = 0;
  return () => api;
}
const changeRequests = () => sent.filter((m) => m.type === 'git.changes');
async function deliver(
  request: { payload: Record<string, unknown> } | null,
  files: string[],
  extra: Record<string, unknown> = {},
) {
  const r = await serverReply(request?.payload ?? {}, files);
  await act(async () =>
    transport!.onMessage({ ...r, payload: { ...r.payload, sessionId: 's1', ...extra } }),
  );
}
const paths = (api: () => ReturnType<typeof useSession>) => api().state.files.map((f) => f.path);

describe('git.changes replies', () => {
  it('drop an older snapshot answered after the newest one', async () => {
    const api = await mountSession();
    await act(async () => api().refreshWorkspace());
    await act(async () => api().refreshWorkspace());
    const [a, b] = changeRequests();
    await deliver(b!, ['new.ts']);
    await deliver(a!, ['old.ts']);
    expect(paths(api)).toEqual(['new.ts']);
  });
  it('a reply without requestId (unsolicited refresh / older engine) applies', async () => {
    const api = await mountSession();
    await act(async () => api().refreshWorkspace());
    await deliver(null, ['pushed.ts']);
    expect(paths(api)).toEqual(['pushed.ts']);
  });
  it('after a reconnect, the new request is answered', async () => {
    const api = await mountSession();
    await act(async () => api().refreshWorkspace());
    const [lost] = changeRequests();
    await act(async () => transport!.onState('closed'));
    await act(async () => transport!.onState('open'));
    await act(async () =>
      transport!.onMessage({
        type: 'session.start',
        payload: { id: 's1', sessionId: 's1', provider: 'p', model: 'm', running: false },
      }),
    );
    const fresh = changeRequests().at(-1)!;
    expect(fresh.payload.requestId).not.toBe(lost!.payload.requestId);
    await deliver(fresh, ['after.ts']);
    await deliver(lost!, ['before.ts']);
    expect(paths(api)).toEqual(['after.ts']);
  });
});
