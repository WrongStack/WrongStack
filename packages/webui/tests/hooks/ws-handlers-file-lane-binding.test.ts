import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The file store must follow the lane pointer.
 *
 * `files.tree` / `files.read` responses are stamped with the session the
 * request named (`withSession` → `foregroundSessionId()` → the LANE POINTER).
 * `useFileStore` routes those writes by comparing that stamp against its own
 * `fileSessionId`. If a tab switch moves the pointer without re-binding the
 * file store, every stamped write lands in `filesBySession[<new session>]` —
 * parked, invisible — and the explorer shows a stale tree while double-click
 * opens nothing.
 */

const send = vi.fn();
const wsClient = {
  send,
  listSavedProviders: vi.fn(),
  requestedSwitch: null as string | null,
  consumeRequestedSwitch(sessionId: string): boolean {
    if (!sessionId || wsClient.requestedSwitch !== sessionId) return false;
    wsClient.requestedSwitch = null;
    return true;
  },
  withSession(payload: Record<string, unknown>, sessionId?: string) {
    const id = sessionId || foregroundSessionId();
    return id ? { ...payload, sessionId: id } : payload;
  },
};
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => wsClient }));

const toast = { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
vi.mock('@/components/Toaster', () => ({ toast }));
vi.mock('@/lib/view-navigation', () => ({
  navigateToView: vi.fn(),
  showPanel: vi.fn(),
  isRoutePinnedView: () => false,
  resetUiNavigationToHome: vi.fn(),
}));
vi.mock('@/lib/desktop-shell', () => ({ isDesktopShell: () => false }));

const { useFileStore, useSessionTabStore } = await import('../../src/stores');
const { useSessionLanes } = await import('../../src/stores/session-lanes');
const { useChatLanes } = await import('../../src/stores/chat-lanes');
const { foregroundSessionId } = await import('../../src/lib/ws-client-utils');
const { handleSessionStart } = await import('../../src/hooks/ws-handlers/session-handlers');
const { handleFilesRead, handleFilesTree } = await import(
  '../../src/hooks/ws-handlers/files-mailbox-handlers'
);

function start(sessionId: string) {
  wsClient.requestedSwitch = sessionId;
  handleSessionStart({
    type: 'session.start',
    payload: { sessionId, model: 'm', provider: 'p', reset: true },
  } as never);
}

/** What the server sends back for a request this surface stamped itself. */
function serverFilesRead(filePath: string, content: string) {
  const payload = wsClient.withSession({ filePath, content });
  handleFilesRead({ type: 'files.read', payload } as never);
}
function serverFilesTree(root: string, names: string[]) {
  const payload = wsClient.withSession({
    root,
    tree: names.map((n) => ({ name: n, path: n, type: 'file' })),
  });
  handleFilesTree({ type: 'files.tree', payload } as never);
}

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })) as never;
  }
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  useFileStore.setState({
    projectRoot: '',
    tree: [],
    openFiles: [],
    activeFilePath: null,
    treeLoading: false,
    error: null,
    targetLine: null,
    projectIdentity: '',
    hydratingPaths: new Set<string>(),
    fileSessionId: null,
    filesBySession: {},
  });
  send.mockClear();
});

describe('file store follows the lane pointer', () => {
  it('opens a file in the tab that asked for it, after a tab switch', () => {
    start('sess_a');
    start('sess_b');

    // Back to tab A through the tab strip — the pointer moves to sess_a.
    useSessionTabStore.getState().openTab('sess_a');
    expect(foregroundSessionId()).toBe('sess_a');

    serverFilesRead('src/index.ts', 'hello');

    expect(useFileStore.getState().openFiles.map((f) => f.path)).toEqual(['src/index.ts']);
    expect(useFileStore.getState().activeFilePath).toBe('src/index.ts');
  });

  it('refreshes the visible tree after a tab switch', () => {
    start('sess_a');
    start('sess_b');
    useSessionTabStore.getState().openTab('sess_a');

    serverFilesTree('/proj', ['a.ts', 'b.ts']);

    expect(useFileStore.getState().tree.map((n) => n.name)).toEqual(['a.ts', 'b.ts']);
  });
});
