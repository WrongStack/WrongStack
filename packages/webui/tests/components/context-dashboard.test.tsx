import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  ContextDebugPayload,
  ContextFeed,
  ContextSession,
} from '@wrongstack/project-surfaces/context/context-host';
import { type SurfaceHost, SurfaceHostProvider } from '@wrongstack/project-surfaces/host';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The dashboard lives in the shared package and translates with the app's i18next instance.
import '../../src/i18n';
import { ContextDashboard } from '../../src/components/ContextDashboard';
import { webuiContextFeed } from '../../src/components/MemoryManager/webui-context-feed';

afterEach(cleanup);

const session: ContextSession = {
  lastInputTokens: 50_000,
  maxContext: 200_000,
  model: 'glm-5',
  provider: 'zai',
  mode: 'default',
  contextMode: 'balanced',
  startTime: null,
  iteration: null,
  projectName: 'wrongstack',
  cwd: '/work/wrongstack',
};

const breakdown = (systemPrompt: number): ContextDebugPayload => ({
  total: systemPrompt + 3_000,
  systemPrompt,
  tools: { total: 2_000, count: 1, breakdown: [{ name: 'read_file', tokens: 2_000 }] },
  messages: { total: 1_000, count: 2, breakdown: [] },
});

/** A feed whose `context.debug` requests the test answers one by one. */
function fakeFeed(sessionId: { current: string }) {
  const requests: Array<{
    signal: AbortSignal;
    resolve: (payload: ContextDebugPayload) => void;
    reject: (error: Error) => void;
  }> = [];
  const feed: ContextFeed = {
    useSessionId: () => sessionId.current,
    useSession: () => session,
    useAgents: () => [],
    requestDebug: (signal) =>
      new Promise((resolve, reject) => requests.push({ signal, resolve, reject })),
  };
  return { feed, requests };
}

/** Only what the dashboard reads from its host. */
const hostFor = (feed: ContextFeed) =>
  ({ useScrollRestore: () => ({ current: null }), context: feed }) as unknown as SurfaceHost;

function renderDashboard(feed: ContextFeed) {
  return render(
    <SurfaceHostProvider host={hostFor(feed)}>
      <ContextDashboard />
    </SurfaceHostProvider>,
  );
}

describe('ContextDashboard', () => {
  it("shows the conversation's pressure and the engine's breakdown", async () => {
    const { feed, requests } = fakeFeed({ current: 'tab-a' });
    renderDashboard(feed);
    expect(screen.getAllByText('glm-5').length).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    await act(async () => requests[0]?.resolve(breakdown(4_000)));
    expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.getByText('4.0k (57.1%)')).toBeTruthy();
  });

  it('drops the previous conversation’s late reply and reads the new one', async () => {
    const sessionId = { current: 'tab-a' };
    const { feed, requests } = fakeFeed(sessionId);
    const view = renderDashboard(feed);
    sessionId.current = 'tab-b';
    view.rerender(
      <SurfaceHostProvider host={hostFor(feed)}>
        <ContextDashboard />
      </SurfaceHostProvider>,
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.signal.aborted).toBe(true);
    await act(async () => requests[0]?.resolve(breakdown(9_000)));
    expect(screen.queryByText('9.0k (75.0%)')).toBeNull();
    await act(async () => requests[1]?.resolve(breakdown(4_000)));
    expect(screen.getByText('4.0k (57.1%)')).toBeTruthy();
  });

  it('shows why the breakdown could not be read, and reads again on refresh', async () => {
    const { feed, requests } = fakeFeed({ current: 'tab-a' });
    renderDashboard(feed);
    await act(async () => requests[0]?.reject(new Error('No response from server')));
    expect(screen.getByText('No response from server')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(requests).toHaveLength(2);
    await act(async () => requests[1]?.resolve(breakdown(4_000)));
    expect(screen.queryByText('No response from server')).toBeNull();
  });
});

describe('the WebUI context feed', () => {
  it('asks for the foreground tab and ignores replies addressed to another tab', async () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const send = vi.fn();
    const ws = await import('../../src/lib/ws-client');
    const client = ws.getWSClient();
    const spies = [
      vi.spyOn(client, 'withSession').mockImplementation((payload) => ({
        ...payload,
        sessionId: 'tab-a',
      })),
      vi.spyOn(client, 'send').mockImplementation(send),
      vi.spyOn(client, 'on').mockImplementation(((
        type: string,
        handler: (message: unknown) => void,
      ) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      }) as typeof client.on),
    ];
    try {
      const reply = webuiContextFeed.requestDebug(new AbortController().signal);
      expect(send).toHaveBeenCalledWith(
        { type: 'context.debug', payload: { sessionId: 'tab-a' } },
        { echoToChat: false },
      );
      handlers.get('context.debug')?.({
        type: 'context.debug',
        payload: { ...breakdown(1), sessionId: 'tab-b' },
      });
      handlers.get('context.debug')?.({
        type: 'context.debug',
        payload: { ...breakdown(2), sessionId: 'tab-a' },
      });
      await expect(reply).resolves.toMatchObject({ systemPrompt: 2 });
      expect(handlers.has('context.debug')).toBe(false);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
