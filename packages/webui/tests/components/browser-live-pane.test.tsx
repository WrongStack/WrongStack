import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Message = { type: string; payload?: unknown };
type Handler = (message: Message) => void;

const handlers = new Map<string, Set<Handler>>();
const sends: Message[] = [];
const client = {
  isConnected: true,
  on(type: string, handler: Handler) {
    const registered = handlers.get(type) ?? new Set();
    registered.add(handler);
    handlers.set(type, registered);
    return () => registered.delete(handler);
  },
  send(message: Message) {
    sends.push(message);
  },
  withSession: (payload: Record<string, unknown>) => ({ ...payload, sessionId: 's1' }),
};

vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ client }) }));
vi.mock('@/stores', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores')>()),
  useActiveSessionId: () => 's1',
}));

const { useConfigStore } = await import('@/stores');
const { useUIStore } = await import('@/stores');
const { BrowserLivePane } = await import('../../src/components/BrowserLivePane.js');

function emit(type: string, payload: unknown) {
  act(() => {
    for (const handler of handlers.get(type) ?? []) handler({ type, payload });
  });
}
const sent = (type: string) => sends.filter((m) => m.type === type);

const shop = { id: 'b1', url: 'https://shop.test/', title: 'Shop' };
const docs = { id: 'b2', url: 'https://docs.test/', title: 'Docs' };

beforeEach(() => {
  client.isConnected = true;
  handlers.clear();
  sends.length = 0;
  useConfigStore.setState({ wsConnected: true });
});

describe('BrowserLivePane', () => {
  it('restarts its watch after reconnect and discards the old frame', () => {
    render(<BrowserLivePane />);
    emit('browser.live.list', { sessionId: 's1', sessions: [shop] });
    emit('browser.live.frame', {
      sessionId: 's1',
      id: 'b1',
      data: 'AAAA',
      width: 1280,
      height: 800,
    });
    expect(screen.getByRole('img')).toBeTruthy();
    client.isConnected = false;
    act(() => useConfigStore.setState({ wsConnected: false }));
    expect(screen.queryByRole('img')).toBeNull();
    client.isConnected = true;
    act(() => useConfigStore.setState({ wsConnected: true }));
    // Reconnect asks the server for a fresh inventory before remounting the viewer.
    emit('browser.live.list', { sessionId: 's1', sessions: [shop] });
    expect(sent('browser.live.watch')).toHaveLength(2);
    expect(screen.getByText('Waiting for the first frame…')).toBeTruthy();
  });
  it('selects context without clicking the page and queues text plus an image for review', () => {
    render(<BrowserLivePane />);
    emit('browser.live.list', { sessionId: 's1', sessions: [shop] });
    emit('browser.live.frame', {
      sessionId: 's1',
      id: 'b1',
      data: 'AAAA',
      width: 1280,
      height: 800,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pick element' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Pick element' }), { key: 'Escape' });
    expect(
      screen.queryByRole('button', { name: 'Select an element in the browser preview' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pick element' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Select an element in the browser preview' }),
    );
    const request = sent('browser.live.pick').at(-1)!.payload as { requestId: string };
    expect(request).toMatchObject({ id: 'b1', x: 0.5, y: 0.5, sessionId: 's1', url: shop.url });
    const selection = {
      url: shop.url,
      title: 'Shop',
      capturedAt: 'now',
      selector: '#buy',
      tag: 'button',
      role: '',
      text: 'Buy',
      styles: { color: 'red' },
      bounds: { x: 1, y: 1, width: 20, height: 10 },
      viewport: { width: 1280, height: 800 },
      image: { mimeType: 'image/jpeg', data: 'AAAA', width: 20, height: 10 },
    };
    emit('browser.live.selection', {
      sessionId: 's2',
      id: 'b1',
      requestId: request.requestId,
      selection,
    });
    expect(screen.queryByText('#buy')).toBeNull();
    emit('browser.live.selection', { sessionId: 's1', id: 'b1', requestId: 'stale', selection });
    expect(screen.queryByText('#buy')).toBeNull();
    emit('browser.live.selection', {
      sessionId: 's1',
      id: 'b1',
      requestId: request.requestId,
      selection,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
    expect(useUIStore.getState().promptInsertRequest).toContain('untrusted context');
    expect(useUIStore.getState().promptInsertRequest).toContain('#buy');
    expect(useUIStore.getState().promptInsertImages[0]?.dataUrl).toBe(
      'data:image/jpeg;base64,AAAA',
    );
    expect(
      sends.some((message) => ['user_message', 'message', 'user.message'].includes(message.type)),
    ).toBe(false);
    useUIStore.getState().clearPromptInsert();
  });
  it('lists the tab’s browsers, and says so when there is none', () => {
    render(<BrowserLivePane />);
    expect(sent('browser.live.list')).toEqual([
      { type: 'browser.live.list', payload: { sessionId: 's1' } },
    ]);
    emit('browser.live.list', { sessionId: 's1', sessions: [] });
    expect(screen.getByText('The agent has no browser open.')).toBeTruthy();
  });

  it('asks again after a browser tool call, and only then', () => {
    render(<BrowserLivePane />);
    emit('tool.executed', { sessionId: 's1', name: 'bash' });
    emit('tool.executed', { sessionId: 's1', name: 'browser_open' });
    // The browser tools are off the direct list, so the model reaches them via tool_use.
    emit('tool.executed', { sessionId: 's1', name: 'tool_use' });
    expect(sent('browser.live.list')).toHaveLength(3);
  });

  it('watches the page, shows its frames and details, and stops on unmount', () => {
    const view = render(<BrowserLivePane />);
    emit('browser.live.list', { sessionId: 's1', sessions: [shop] });
    expect(sent('browser.live.watch')).toEqual([
      { type: 'browser.live.watch', payload: { id: 'b1', sessionId: 's1' } },
    ]);
    expect(screen.getByText('Waiting for the first frame…')).toBeTruthy();

    emit('browser.live.frame', {
      sessionId: 's1',
      id: 'b1',
      data: 'AAAA',
      width: 1280,
      height: 800,
    });
    // Another tab's frame for the same id is not shown.
    emit('browser.live.frame', { sessionId: 's2', id: 'b1', data: 'BBBB', width: 1, height: 1 });
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.src).toBe('data:image/jpeg;base64,AAAA');

    emit('browser.live.details', {
      sessionId: 's1',
      id: 'b1',
      url: 'https://shop.test/cart',
      title: 'Cart',
      console: [{ level: 'error', text: 'boom', at: 't' }],
      network: [{ method: 'GET', url: 'https://shop.test/api', status: 500, at: 't' }],
    });
    expect(screen.getByText('https://shop.test/cart')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Network/ }));
    expect(screen.getByText('https://shop.test/api')).toBeTruthy();

    view.unmount();
    expect(sent('browser.live.unwatch')).toHaveLength(1);
  });

  it('switches between browsers, and says when one has closed', () => {
    render(<BrowserLivePane />);
    emit('browser.live.list', { sessionId: 's1', sessions: [shop, docs] });
    fireEvent.click(screen.getByRole('tab', { name: 'Docs' }));
    expect(sent('browser.live.unwatch')).toHaveLength(1);
    expect(sent('browser.live.watch').at(-1)).toEqual({
      type: 'browser.live.watch',
      payload: { id: 'b2', sessionId: 's1' },
    });
    emit('browser.live.details', { sessionId: 's1', id: 'b2', gone: true });
    expect(screen.getByText('The browser was closed.')).toBeTruthy();
  });

  it('moves selection and focus with arrow keys in the browser session tablist', () => {
    render(<BrowserLivePane />);
    emit('browser.live.list', { sessionId: 's1', sessions: [shop, docs] });

    // Control: the real tablist renders both sessions with one selected tab.
    const first = screen.getByRole('tab', { name: 'Shop' });
    const second = screen.getByRole('tab', { name: 'Docs' });
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(second.getAttribute('aria-selected')).toBe('false');
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(second);
    expect(first.tabIndex).toBe(-1);
    expect(second.tabIndex).toBe(0);

    fireEvent.keyDown(second, { key: 'ArrowLeft' });
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(first);
  });

  it('moves selection and focus with arrow keys in the console/network tablist', () => {
    render(<BrowserLivePane />);
    emit('browser.live.list', { sessionId: 's1', sessions: [shop] });
    const consoleTab = screen.getByRole('tab', { name: /Console/ });
    const networkTab = screen.getByRole('tab', { name: /Network/ });
    expect(consoleTab.getAttribute('aria-selected')).toBe('true');
    expect(networkTab.getAttribute('aria-selected')).toBe('false');

    consoleTab.focus();
    fireEvent.keyDown(consoleTab, { key: 'ArrowRight' });
    expect(networkTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(networkTab);

    fireEvent.keyDown(networkTab, { key: 'ArrowLeft' });
    expect(consoleTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(consoleTab);
  });
});
