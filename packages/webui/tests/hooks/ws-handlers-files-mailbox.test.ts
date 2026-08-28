import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── ws-client stub ──────────────────────────────────────────────────────────

const send = vi.fn();
let clientImpl: () => unknown = () => ({ send });

vi.mock('@/lib/ws-client', () => ({ getWSClient: () => clientImpl() }));

const { useFileStore, useSessionStore } = await import('../../src/stores');
const { useMailboxStore } = await import('../../src/stores/mailbox-store');
const { useVizStore } = await import('../../src/stores/viz-store');
const handlers = await import('../../src/hooks/ws-handlers/files-mailbox-handlers');

const {
  debouncedRefresh,
  filesMailboxHandlerMap,
  handleFilesCreated,
  handleFilesDeleted,
  handleFilesRead,
  handleFilesTree,
  handleFilesTreeChanged,
  handleFilesWritten,
  handleMailboxAgentRegistered,
  handleMailboxAgentDeregistered,
  handleMailboxAgents,
  handleMailboxActionResult,
  handleMailboxCleared,
  handleMailboxCompacted,
  handleMailboxEvent,
  handleMailboxMessages,
  handleMailboxPurged,
  handleMailboxReceived,
  queryMailbox,
} = handlers;

function msg(type: string, payload: unknown) {
  return { type, payload } as never;
}

/** Drain the module-level 300ms debounce timer between tests. */
function drainDebounce() {
  vi.advanceTimersByTime(500);
  send.mockReset();
}

describe('files + mailbox ws-handler map', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset();
    clientImpl = () => ({ send });
    useMailboxStore.setState({ messages: [], agents: [], lastCompaction: null } as never);
    useVizStore.setState({ events: [], isActive: false } as never);
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
    } as never);
  });

  afterEach(() => {
    // Never leave a pending debounce timer for the next test file.
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers a handler for every files/mailbox wire type', () => {
    expect(Object.keys(filesMailboxHandlerMap).sort()).toEqual(
      [
        'files.created',
        'files.deleted',
        'files.moved',
        'files.read',
        'files.renamed',
        'files.tree',
        'files.tree.changed',
        'files.written',
        'mailbox.agent_registered',
        'mailbox.agent_deregistered',
        'mailbox.agents',
        'mailbox.action_result',
        'mailbox.cleared',
        'mailbox.compacted',
        'mailbox.event',
        'mailbox.messages',
        'mailbox.purged',
        'mailbox.received',
      ].sort(),
    );
  });

  it('wires each map entry to its exported handler', () => {
    expect(filesMailboxHandlerMap['files.tree']).toBe(handleFilesTree);
    expect(filesMailboxHandlerMap['files.tree.changed']).toBe(handleFilesTreeChanged);
    expect(filesMailboxHandlerMap['files.read']).toBe(handleFilesRead);
    expect(filesMailboxHandlerMap['files.written']).toBe(handleFilesWritten);
    expect(filesMailboxHandlerMap['files.created']).toBe(handleFilesCreated);
    expect(filesMailboxHandlerMap['files.deleted']).toBe(handleFilesDeleted);
    expect(filesMailboxHandlerMap['mailbox.event']).toBe(handleMailboxEvent);
    expect(filesMailboxHandlerMap['mailbox.messages']).toBe(handleMailboxMessages);
    expect(filesMailboxHandlerMap['mailbox.agents']).toBe(handleMailboxAgents);
    expect(filesMailboxHandlerMap['mailbox.action_result']).toBe(handleMailboxActionResult);
    expect(filesMailboxHandlerMap['mailbox.received']).toBe(handleMailboxReceived);
    expect(filesMailboxHandlerMap['mailbox.agent_registered']).toBe(handleMailboxAgentRegistered);
    expect(filesMailboxHandlerMap['mailbox.agent_deregistered']).toBe(
      handleMailboxAgentDeregistered,
    );
    expect(filesMailboxHandlerMap['mailbox.cleared']).toBe(handleMailboxCleared);
    expect(filesMailboxHandlerMap['mailbox.purged']).toBe(handleMailboxPurged);
    expect(filesMailboxHandlerMap['mailbox.compacted']).toBe(handleMailboxCompacted);
  });

  // ── mailbox.agent_deregistered ────────────────────────────────────────────

  describe('mailbox.agent_deregistered', () => {
    function seedAgents() {
      useMailboxStore.getState().setAgents([
        {
          agentId: 'a1',
          name: 'Alpha',
          sessionId: 's1',
          status: 'idle',
          lastSeenAt: new Date().toISOString(),
          online: true,
        },
        {
          agentId: 'a2',
          name: 'Beta',
          sessionId: 's1',
          status: 'idle',
          lastSeenAt: new Date().toISOString(),
          online: true,
        },
      ]);
    }

    it('removes exactly the deregistered agent from the roster', () => {
      seedAgents();
      handleMailboxAgentDeregistered(msg('mailbox.agent_deregistered', { agentId: 'a1' }));
      expect(useMailboxStore.getState().agents.map((a) => a.agentId)).toEqual(['a2']);
    });

    it('is a no-op when the payload lacks an agentId', () => {
      seedAgents();
      handleMailboxAgentDeregistered(msg('mailbox.agent_deregistered', {}));
      handleMailboxAgentDeregistered(msg('mailbox.agent_deregistered', undefined));
      expect(useMailboxStore.getState().agents).toHaveLength(2);
    });

    it('removing an unknown agent is a safe no-op', () => {
      seedAgents();
      handleMailboxAgentDeregistered(msg('mailbox.agent_deregistered', { agentId: 'ghost' }));
      expect(useMailboxStore.getState().agents).toHaveLength(2);
    });
  });

  // ── queryMailbox ──────────────────────────────────────────────────────────

  describe('queryMailbox', () => {
    it('asks for incomplete messages and the agent roster', () => {
      queryMailbox();
      expect(send).toHaveBeenNthCalledWith(1, {
        type: 'mailbox.messages',
        payload: { limit: 30, incompleteOnly: true },
      });
      expect(send).toHaveBeenNthCalledWith(2, { type: 'mailbox.agents', payload: {} });
    });

    it('is a no-op when the WS client is unavailable', () => {
      clientImpl = () => null;
      expect(() => queryMailbox()).not.toThrow();
      expect(send).not.toHaveBeenCalled();
    });

    it('is a no-op when the client exposes no send()', () => {
      clientImpl = () => ({});
      expect(() => queryMailbox()).not.toThrow();
    });
  });

  // ── debouncedRefresh ──────────────────────────────────────────────────────

  describe('debouncedRefresh', () => {
    it('does not query until the 300ms window elapses', () => {
      debouncedRefresh();
      vi.advanceTimersByTime(299);
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(send).toHaveBeenCalledTimes(2); // messages + agents
    });

    it('collapses a burst into a single query', () => {
      for (let i = 0; i < 5; i++) debouncedRefresh();
      vi.advanceTimersByTime(300);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('restarts the window on each call rather than firing on the first', () => {
      debouncedRefresh();
      vi.advanceTimersByTime(250);
      debouncedRefresh();
      vi.advanceTimersByTime(250);
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('rearms after firing', () => {
      debouncedRefresh();
      vi.advanceTimersByTime(300);
      expect(send).toHaveBeenCalledTimes(2);
      debouncedRefresh();
      vi.advanceTimersByTime(300);
      expect(send).toHaveBeenCalledTimes(4);
    });
  });

  // ── files ─────────────────────────────────────────────────────────────────

  // NOTE: these assert on store *state*, not on spies over the store actions.
  // zustand's `set` swaps the state object, so a `vi.spyOn(store.getState(), …)`
  // survives only until the first mutation — and `vi.spyOn` on an already-mocked
  // method hands back the same mock, so call history bleeds between tests.

  describe('files.tree', () => {
    it('stores the tree and the project root', () => {
      const tree = [{ name: 'src', path: 'src', type: 'dir' }];
      handleFilesTree(msg('files.tree', { root: '/repo', tree }));
      const s = useFileStore.getState();
      expect(s.projectRoot).toBe('/repo');
      expect(s.tree).toEqual(tree);
      expect(s.treeLoading).toBe(false);
    });

    it('clears a previous error on a successful tree', () => {
      useFileStore.setState({ error: 'stale' } as never);
      handleFilesTree(msg('files.tree', { root: '/repo', tree: [] }));
      expect(useFileStore.getState().error).toBeNull();
    });

    it('records the error and leaves the tree untouched', () => {
      const tree = [{ name: 'old', path: 'old', type: 'dir' }];
      useFileStore.setState({ tree, projectRoot: '/old' } as never);
      handleFilesTree(msg('files.tree', { root: '/repo', tree: [], error: 'EACCES' }));
      const s = useFileStore.getState();
      expect(s.error).toBe('EACCES');
      expect(s.tree).toEqual(tree);
      expect(s.projectRoot).toBe('/old');
    });

    it('routes a background session tree into its own file lane', () => {
      const activeTree = [{ name: 'active', path: 'active', type: 'dir' }];
      const backgroundTree = [{ name: 'background', path: 'background', type: 'dir' }];
      useFileStore.getState().bindSessionFiles('sess-a');
      useFileStore.getState().setTree('/repo-a', activeTree as never);

      handleFilesTree(
        msg('files.tree', { root: '/repo-b', tree: backgroundTree, sessionId: 'sess-b' }),
      );

      const s = useFileStore.getState();
      expect(s.fileSessionId).toBe('sess-a');
      expect(s.projectRoot).toBe('/repo-a');
      expect(s.tree).toEqual(activeTree);
      expect(s.filesBySession['sess-b']).toMatchObject({
        projectRoot: '/repo-b',
        tree: backgroundTree,
        treeLoading: false,
      });
    });
  });

  describe('files.read', () => {
    it('opens the file in a tab and makes it active', () => {
      handleFilesRead(msg('files.read', { filePath: 'a.ts', content: 'x' }));
      const s = useFileStore.getState();
      expect(s.activeFilePath).toBe('a.ts');
      expect(s.openFiles).toEqual([
        { path: 'a.ts', content: 'x', dirty: false, savedContent: 'x' },
      ]);
    });

    it('records the error and opens no tab', () => {
      handleFilesRead(msg('files.read', { filePath: 'a.ts', content: '', error: 'ENOENT' }));
      const s = useFileStore.getState();
      expect(s.error).toBe('ENOENT');
      expect(s.openFiles).toEqual([]);
      expect(s.activeFilePath).toBeNull();
    });

    it('opens a background session file without stealing the active tab editor', () => {
      useFileStore.getState().bindSessionFiles('sess-a');
      useFileStore.getState().openFile('a.ts', 'active');

      handleFilesRead(
        msg('files.read', { filePath: 'b.ts', content: 'background', sessionId: 'sess-b' }),
      );

      const s = useFileStore.getState();
      expect(s.fileSessionId).toBe('sess-a');
      expect(s.activeFilePath).toBe('a.ts');
      expect(s.openFiles).toEqual([
        { path: 'a.ts', content: 'active', dirty: false, savedContent: 'active' },
      ]);
      expect(s.filesBySession['sess-b']?.activeFilePath).toBe('b.ts');
      expect(s.filesBySession['sess-b']?.openFiles).toEqual([
        { path: 'b.ts', content: 'background', dirty: false, savedContent: 'background' },
      ]);
    });
  });

  describe('reconcileFileTabsAfterEnvChange', () => {
    it('hydrates background session file stubs without touching the active file lane', () => {
      useFileStore.getState().bindSessionFiles('sess-a');
      useFileStore.getState().openFile('active.ts', 'active');
      useFileStore.getState().bindSessionFiles('sess-b');
      useFileStore.setState({
        openFiles: [{ path: 'background.ts', content: '', dirty: false, savedContent: '' }],
        activeFilePath: 'background.ts',
        projectIdentity: '/repo',
      } as never);
      useFileStore.getState().bindSessionFiles('sess-a');
      send.mockReset();

      handlers.reconcileFileTabsAfterEnvChange('/repo', 'sess-b');

      const s = useFileStore.getState();
      expect(s.fileSessionId).toBe('sess-a');
      expect(s.openFiles).toEqual([
        { path: 'active.ts', content: 'active', dirty: false, savedContent: 'active' },
      ]);
      expect(s.hydratingPaths.size).toBe(0);
      expect(s.filesBySession['sess-b']?.hydratingPaths.has('background.ts')).toBe(true);
      expect(send).toHaveBeenCalledWith({
        type: 'files.read',
        payload: { filePath: 'background.ts', sessionId: 'sess-b' },
      });
    });
  });

  describe('files.written', () => {
    it('marks the open file clean on success', () => {
      handleFilesRead(msg('files.read', { filePath: 'a.ts', content: 'x' }));
      useFileStore.getState().updateContent('a.ts', 'edited');
      expect(useFileStore.getState().openFiles[0]?.dirty).toBe(true);

      handleFilesWritten(msg('files.written', { filePath: 'a.ts', success: true }));
      expect(useFileStore.getState().openFiles[0]).toMatchObject({
        dirty: false,
        savedContent: 'edited',
      });
    });

    it('prefixes the failure reason so it reads as a save failure', () => {
      handleFilesWritten(
        msg('files.written', { filePath: 'a.ts', success: false, error: 'EPERM' }),
      );
      expect(useFileStore.getState().error).toBe('Save failed: EPERM');
    });

    it('stays silent on a failure with no reason', () => {
      handleFilesRead(msg('files.read', { filePath: 'a.ts', content: 'x' }));
      useFileStore.getState().updateContent('a.ts', 'edited');

      handleFilesWritten(msg('files.written', { filePath: 'a.ts', success: false }));
      const s = useFileStore.getState();
      expect(s.error).toBeNull();
      // Neither branch ran, so the file stays dirty.
      expect(s.openFiles[0]?.dirty).toBe(true);
    });
  });

  describe('files.tree.changed', () => {
    it('debounces the tree refresh request by 500ms', () => {
      useSessionStore.setState({ cwd: '/repo' } as never);
      handleFilesTreeChanged(msg('files.tree.changed', {}));
      vi.advanceTimersByTime(499);
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({ type: 'files.tree', payload: { path: '/repo' } });
    });

    it('collapses a burst of change events into a single refresh', () => {
      useSessionStore.setState({ cwd: '/repo' } as never);
      for (let i = 0; i < 6; i++) handleFilesTreeChanged(msg('files.tree.changed', {}));
      vi.advanceTimersByTime(500);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('marks the tree loading only when the debounced refresh fires', () => {
      useSessionStore.setState({ cwd: '/repo' } as never);
      handleFilesTreeChanged(msg('files.tree.changed', {}));
      expect(useFileStore.getState().treeLoading).toBe(false);
      vi.advanceTimersByTime(500);
      expect(useFileStore.getState().treeLoading).toBe(true);
    });
  });

  // ── mailbox ───────────────────────────────────────────────────────────────

  describe('mailbox.messages / mailbox.agents', () => {
    it('stores the message list', () => {
      const messages = [{ id: 'm1', from: 'a', to: 'b', body: 'hi' }];
      handleMailboxMessages(msg('mailbox.messages', { messages }));
      const stored = useMailboxStore.getState().messages;
      expect(stored).toHaveLength(1);
      // setMessages back-fills a `scope` for rows the server did not classify.
      expect(stored[0]).toMatchObject({ id: 'm1', from: 'a', to: 'b', body: 'hi' });
      expect(stored[0]).toHaveProperty('scope');
    });

    it('preserves a server-supplied scope instead of re-classifying', () => {
      handleMailboxMessages(
        msg('mailbox.messages', {
          messages: [{ id: 'm1', from: 'a', to: 'b', body: 'hi', scope: 'broadcast' }],
        }),
      );
      expect(useMailboxStore.getState().messages[0]).toMatchObject({ scope: 'broadcast' });
    });

    it('ignores a reply with no messages array', () => {
      handleMailboxMessages(msg('mailbox.messages', {}));
      handleMailboxMessages(msg('mailbox.messages', undefined));
      expect(useMailboxStore.getState().messages).toEqual([]);
    });

    it('stores the agent roster', () => {
      const agents = [{ id: 'a1', name: 'Alpha' }];
      handleMailboxAgents(msg('mailbox.agents', { agents }));
      expect(useMailboxStore.getState().agents).toEqual(agents);
    });

    it('ignores a roster reply with no agents array', () => {
      handleMailboxAgents(msg('mailbox.agents', {}));
      handleMailboxAgents(msg('mailbox.agents', undefined));
      expect(useMailboxStore.getState().agents).toEqual([]);
    });
  });

  describe('mailbox.event / mailbox.received', () => {
    it('pushes a viz event and activates the graph', () => {
      handleMailboxEvent(
        msg('mailbox.event', { event: 'mailbox.sent', from: 'a1', to: 'b1', subject: 'Result' }),
      );
      const viz = useVizStore.getState();
      expect(viz.isActive).toBe(true);
      expect(viz.events[0]).toMatchObject({
        kind: 'mailbox:send',
        source: 'a1',
        target: 'b1',
        label: 'Result',
      });
    });

    it('renders a delivery event with the receive arrow', () => {
      handleMailboxEvent(
        msg('mailbox.event', { event: 'mailbox.delivered', from: 'a1', to: 'b1' }),
      );
      expect(useVizStore.getState().events[0]).toMatchObject({
        kind: 'mailbox:deliver',
        label: '← a1',
      });
    });

    it('substitutes placeholders for an event with no from/to', () => {
      handleMailboxEvent(msg('mailbox.event', {}));
      expect(useVizStore.getState().events[0]).toMatchObject({ source: '?', target: '?' });
    });

    it('debounces the refresh rather than querying per event', () => {
      handleMailboxEvent(msg('mailbox.event', { event: 'mailbox.sent' }));
      handleMailboxEvent(msg('mailbox.event', { event: 'mailbox.sent' }));
      handleMailboxEvent(msg('mailbox.event', { event: 'mailbox.sent' }));
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('mailbox.received refreshes but produces no viz event', () => {
      // `wsToVizEvent` has no `mailbox.received` case, so it returns null and
      // the graph is left alone — only the debounced refresh runs.
      handleMailboxReceived(msg('mailbox.received', { from: 'a1', to: 'b1', id: 'm1' }));
      expect(useVizStore.getState().events).toHaveLength(0);
      expect(useVizStore.getState().isActive).toBe(false);
      vi.advanceTimersByTime(300);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('mailbox lifecycle events', () => {
    it('refreshes mailbox state after a successful action', () => {
      handleMailboxActionResult(
        msg('mailbox.action_result', {
          requestId: 'req-1',
          success: true,
          action: 'mark-read',
          mailId: 'm1',
        }),
      );
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('agent_registered only schedules a debounced refresh', () => {
      handleMailboxAgentRegistered(msg('mailbox.agent_registered', { agentId: 'a1' }));
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('purged only schedules a debounced refresh', () => {
      handleMailboxPurged(msg('mailbox.purged', {}));
      vi.advanceTimersByTime(300);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('cleared empties the list and re-queries immediately', () => {
      useMailboxStore.setState({ messages: [{ id: 'm1' }] } as never);
      handleMailboxCleared(msg('mailbox.cleared', {}));
      expect(useMailboxStore.getState().messages).toEqual([]);
      // Immediate, not debounced — the panel must not show stale rows.
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('mailbox.compacted', () => {
    it('records the compaction summary', () => {
      handleMailboxCompacted(
        msg('mailbox.compacted', {
          readByAllRemoved: 3,
          expiredRemoved: 2,
          stalePurged: 1,
          totalRemoved: 6,
          remaining: 10,
        }),
      );
      expect(useMailboxStore.getState().lastCompaction).toEqual({
        readByAllRemoved: 3,
        expiredRemoved: 2,
        stalePurged: 1,
        totalRemoved: 6,
        remaining: 10,
      });
    });

    it('defaults the per-bucket counts when only a total is reported', () => {
      handleMailboxCompacted(msg('mailbox.compacted', { totalRemoved: 4 }));
      expect(useMailboxStore.getState().lastCompaction).toEqual({
        readByAllRemoved: 0,
        expiredRemoved: 0,
        stalePurged: 0,
        totalRemoved: 4,
        remaining: 0,
      });
    });

    it('accepts a zero-removal compaction', () => {
      handleMailboxCompacted(msg('mailbox.compacted', { totalRemoved: 0, remaining: 12 }));
      expect(useMailboxStore.getState().lastCompaction).toMatchObject({
        totalRemoved: 0,
        remaining: 12,
      });
    });

    it('skips the summary when totalRemoved is missing or not a number', () => {
      handleMailboxCompacted(msg('mailbox.compacted', {}));
      expect(useMailboxStore.getState().lastCompaction).toBeNull();
      handleMailboxCompacted(msg('mailbox.compacted', { totalRemoved: '4' }));
      expect(useMailboxStore.getState().lastCompaction).toBeNull();
      handleMailboxCompacted(msg('mailbox.compacted', undefined));
      expect(useMailboxStore.getState().lastCompaction).toBeNull();
    });

    it('always schedules a refresh, even without a summary', () => {
      handleMailboxCompacted(msg('mailbox.compacted', undefined));
      vi.advanceTimersByTime(300);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it('leaves no pending timer behind after a drain', () => {
    debouncedRefresh();
    drainDebounce();
    vi.advanceTimersByTime(5_000);
    expect(send).not.toHaveBeenCalled();
  });
});
