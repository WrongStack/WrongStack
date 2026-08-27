import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type RunChatSlashCommandOptions,
  runChatSlashCommand,
} from '../../src/components/ChatInput/slash-routing.js';
import { streamCoalescer } from '../../src/lib/stream-coalescer.js';
import { useSystemPromptStore } from '../../src/stores/system-prompt-store.js';

// Mock external store dependencies and downloadChatAsMarkdown
const mocks = vi.hoisted(() => {
  const fns = {
    setAgentsMonitorOpen: vi.fn(),
    setFleetMonitorOpen: vi.fn(),
    setQueuePanelOpen: vi.fn(),
    setProcessMonitorOpen: vi.fn(),
    setDockSection: vi.fn(),
    setWorkDashboardTab: vi.fn(),
    setDockCustomizeOpen: vi.fn(),
    setSidebarOpen: vi.fn(),
    selectActivity: vi.fn(),
    setCurrentViewUI: vi.fn(),
    setTerminalOpen: vi.fn(),
    setPromptLibraryOpen: vi.fn(),
    setChangesPanelTab: vi.fn(),
    setAgentRosterActiveTab: vi.fn(),
  };

  // Shared factory used by both @/stores and @/stores/ui-store mocks so
  // view-navigation.ts (imports from @/stores/ui-store) and slash-routing.ts
  // (imports from @/stores) observe the same store shape.
  const createMockUIStore = () => ({
    currentView: 'chat',
    refineEnabled: false,
    setAgentsMonitorOpen: fns.setAgentsMonitorOpen,
    setFleetMonitorOpen: fns.setFleetMonitorOpen,
    setQueuePanelOpen: fns.setQueuePanelOpen,
    setProcessMonitorOpen: fns.setProcessMonitorOpen,
    setDockSection: fns.setDockSection,
    setWorkDashboardTab: fns.setWorkDashboardTab,
    setDockCustomizeOpen: fns.setDockCustomizeOpen,
    setSidebarOpen: fns.setSidebarOpen,
    selectActivity: fns.selectActivity,
    setCurrentView: fns.setCurrentViewUI,
    setTerminalOpen: fns.setTerminalOpen,
    setPromptLibraryOpen: fns.setPromptLibraryOpen,
    setChangesPanelTab: fns.setChangesPanelTab,
    setAgentRosterActiveTab: fns.setAgentRosterActiveTab,
  });

  return { ...fns, createMockUIStore };
});

vi.mock('@/stores', () => ({
  useSessionStore: {
    getState: () => ({
      cwd: '/work/proj',
      todos: [
        { id: '1', content: 'Write tests', status: 'completed' },
        { id: '2', content: 'Ship feature', status: 'in_progress', activeForm: 'Shipping feature' },
      ],
    }),
  },
  useUIStore: { getState: mocks.createMockUIStore },
}));

vi.mock('@/stores/ui-store', () => ({
  useUIStore: { getState: mocks.createMockUIStore },
}));

vi.mock('../../src/components/CommandPalette/export-utils.js', () => ({
  downloadChatAsMarkdown: vi.fn(),
}));

function makeOptions(
  overrides: Partial<RunChatSlashCommandOptions> = {},
): RunChatSlashCommandOptions {
  return {
    raw: '',
    addMessage: vi.fn(),
    clearMessages: vi.fn(),
    client: {
      send: vi.fn(),
      // Mirrors the real WS client's session-stamping wrapper: every
      // session-sensitive slash command must carry the foreground tab's id.
      withSession: <T extends Record<string, unknown>>(p: T) =>
        ({ ...p, sessionId: 'sess-fg' }) as T,
      clearContext: vi.fn(),
      newSession: vi.fn(),
      compactContext: vi.fn(),
      repairContext: vi.fn(),
      clearTodos: vi.fn(),
    },
    queue: [],
    sendAbort: vi.fn(),
    sendMsg: vi.fn(),
    setLoading: vi.fn(),
    setCurrentView: vi.fn(),
    toggleRefineEnabled: vi.fn(),
    setProcessMonitorOpen: vi.fn(),
    setQueuePanelOpen: vi.fn(),
    ws: {
      listTools: vi.fn(),
      listMemory: vi.fn(),
      listSkills: vi.fn(),
      getDiag: vi.fn(),
      getStats: vi.fn(),
      saveSession: vi.fn(),
      listSessions: vi.fn(),
      getPlan: vi.fn(),
    },
    onOpenBreakdown: vi.fn(),
    handleNextList: vi.fn(() => true),
    handleNextSelect: vi.fn(() => true),
    ...overrides,
  };
}

describe('runChatSlashCommand', () => {
  let options: RunChatSlashCommandOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    streamCoalescer.dropAll();
    options = makeOptions();
  });

  it('returns false for unknown commands', () => {
    expect(runChatSlashCommand({ ...options, raw: '/unknown' })).toBe(false);
  });

  it('returns false for non-slash input', () => {
    expect(runChatSlashCommand({ ...options, raw: 'hello world' })).toBe(false);
  });

  describe('simple routing commands', () => {
    it.each([
      ['/help', 'addMessage'],
      ['/tools', 'listTools'],
      ['/skills', 'listSkills'], // /skill and /skills both call listSkills
      ['/diag', 'getDiag'],
      ['/stats', 'getStats'],
      ['/save', 'saveSession'],
    ] as const)('%s calls the correct handler and returns true', (cmd, handler) => {
      const opts = makeOptions({ raw: cmd });
      expect(runChatSlashCommand(opts)).toBe(true);
      if (handler === 'addMessage') {
        expect(opts.addMessage).toHaveBeenCalledTimes(1);
      } else {
        expect(opts.ws[handler as keyof typeof opts.ws]).toHaveBeenCalledTimes(1);
      }
    });

    it('/memory opens the memory manager view', () => {
      const opts = makeOptions({ raw: '/memory' });
      expect(runChatSlashCommand(opts)).toBe(true);
      expect(mocks.setCurrentViewUI).toHaveBeenCalledWith('memory');
    });
  });

  it('/clear drops pending streams, clears messages, and clears context', () => {
    const pendingFlush = vi.fn();
    streamCoalescer.push('__thinking__', 'stale reasoning', pendingFlush);

    expect(runChatSlashCommand({ ...options, raw: '/clear' })).toBe(true);
    streamCoalescer.flushAll();

    expect(pendingFlush).not.toHaveBeenCalled();
    expect(options.clearMessages).toHaveBeenCalledTimes(1);
    expect(options.client?.clearContext).toHaveBeenCalledTimes(1);
  });

  it('/new opens the system-prompt picker, which owns the session start', () => {
    expect(runChatSlashCommand({ ...options, raw: '/new' })).toBe(true);
    // The picker sends `session.new` on confirm — see SystemPromptDialog. `/new`
    // gets the same hand-off as the New Session button so the two cannot drift.
    expect(useSystemPromptStore.getState().pickerOpen).toBe(true);
    expect(useSystemPromptStore.getState().pickerStartsSession).toBe(true);
    expect(options.client?.newSession).not.toHaveBeenCalled();
  });

  it('/exit sends webui.shutdown', () => {
    expect(runChatSlashCommand({ ...options, raw: '/exit' })).toBe(true);
    expect(options.client?.send).toHaveBeenCalledWith({ type: 'webui.shutdown' });
    expect(options.addMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['/compact', '/compact!'])('%s calls client.compactContext', (cmd) => {
    expect(runChatSlashCommand({ ...options, raw: cmd })).toBe(true);
    expect(options.client?.compactContext).toHaveBeenCalledWith(cmd === '/compact!');
  });

  it('/repair calls client.repairContext', () => {
    expect(runChatSlashCommand({ ...options, raw: '/repair' })).toBe(true);
    expect(options.client?.repairContext).toHaveBeenCalledTimes(1);
  });

  it('/debug and /context call onOpenBreakdown', () => {
    for (const cmd of ['/debug', '/context']) {
      const opts = makeOptions({ raw: cmd });
      expect(runChatSlashCommand(opts)).toBe(true);
      expect(opts.onOpenBreakdown).toHaveBeenCalledTimes(1);
    }
  });

  it('/load calls ws.listSessions and opens the chat panel', () => {
    expect(runChatSlashCommand({ ...options, raw: '/load' })).toBe(true);
    expect(options.ws.listSessions).toHaveBeenCalledWith(50);
    expect(mocks.setSidebarOpen).toHaveBeenCalledWith(true);
    expect(mocks.selectActivity).toHaveBeenCalledWith('chat');
  });

  it.each(['/interrupt', '/abort', '/stop'])('%s calls sendAbort and setLoading(false)', (cmd) => {
    expect(runChatSlashCommand({ ...options, raw: cmd })).toBe(true);
    expect(options.sendAbort).toHaveBeenCalledTimes(1);
    expect(options.setLoading).toHaveBeenCalledWith(false);
  });

  it('/settings switches to settings view', () => {
    expect(runChatSlashCommand({ ...options, raw: '/settings' })).toBe(true);
    expect(mocks.setSidebarOpen).toHaveBeenCalledWith(false);
    expect(mocks.setCurrentViewUI).toHaveBeenCalledWith('settings');
  });

  it('/suggest sends a suggestion prompt', () => {
    expect(runChatSlashCommand({ ...options, raw: '/suggest' })).toBe(true);
    expect(options.sendMsg).toHaveBeenCalledTimes(1);
    expect(options.sendMsg).toHaveBeenCalledWith(expect.stringContaining('prompt messages'));
    expect(options.sendMsg).toHaveBeenCalledWith(expect.stringContaining('perform the work'));
    expect(options.sendMsg).toHaveBeenCalledWith(expect.stringContaining('must not assign'));
  });

  it.each(['/kill', '/ps'])('%s opens process monitor', (cmd) => {
    expect(runChatSlashCommand({ ...options, raw: cmd })).toBe(true);
    expect(options.setProcessMonitorOpen).toHaveBeenCalledWith(true);
  });
});

describe('runChatSlashCommand — /queue', () => {
  it('shows empty queue message', () => {
    const opts = makeOptions({ raw: '/queue', queue: [] });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('empty') }),
    );
  });

  it('shows queued items count and preview', () => {
    const opts = makeOptions({
      raw: '/queue',
      queue: [
        { text: 'first message', mode: 'btw', addedAt: 0 },
        { text: 'second', mode: 'queue', addedAt: 1 },
      ],
    });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('2 queued') }),
    );
  });

  it('opens queue panel on /queue open', () => {
    const opts = makeOptions({ raw: '/queue open', queue: [] });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.setQueuePanelOpen).toHaveBeenCalledWith(true);
  });
});

describe('runChatSlashCommand — /next', () => {
  it('/next list delegates to handleNextList', () => {
    const opts = makeOptions({ raw: '/next list' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.handleNextList).toHaveBeenCalledTimes(1);
  });

  it('/next clear shows suggestion list cleared message', () => {
    const opts = makeOptions({ raw: '/next clear' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('cleared') }),
    );
    expect(opts.handleNextSelect).not.toHaveBeenCalled();
  });

  it('/next 1 delegates to handleNextSelect', () => {
    const opts = makeOptions({ raw: '/next 1' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.handleNextSelect).toHaveBeenCalledWith('1');
  });

  it('/enxt typo alias delegates to /next behavior', () => {
    const opts = makeOptions({ raw: '/enxt 1' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.handleNextSelect).toHaveBeenCalledWith('1');
  });
});

describe('runChatSlashCommand — /f', () => {
  it('/f with no panel shows f-key list', () => {
    const opts = makeOptions({ raw: '/f' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('F-key panels'),
      }),
    );
  });

  it('/f3 opens agents monitor via store', async () => {
    const opts = makeOptions({ raw: '/f3' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setAgentsMonitorOpen).toHaveBeenCalledWith(true);
  });

  it('/f 5 opens the Work dock on the plan tab', () => {
    const opts = makeOptions({ raw: '/f 5' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.ws.getPlan).toHaveBeenCalledTimes(1);
    expect(mocks.setDockSection).toHaveBeenCalledWith('work');
    expect(mocks.setWorkDashboardTab).toHaveBeenCalledWith('plan');
  });

  it('/f6 opens the Work dock on the todos tab', () => {
    const opts = makeOptions({ raw: '/f6' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setDockSection).toHaveBeenCalledWith('work');
    expect(mocks.setWorkDashboardTab).toHaveBeenCalledWith('todos');
  });

  it('/f10 refreshes sessions and opens the chat panel', () => {
    const opts = makeOptions({ raw: '/f10' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.ws.listSessions).toHaveBeenCalledWith(50);
    expect(mocks.setSidebarOpen).toHaveBeenCalledWith(true);
    expect(mocks.selectActivity).toHaveBeenCalledWith('chat');
  });

  it('/f11 opens the coordinator office map surface', () => {
    const opts = makeOptions({ raw: '/f11' });
    expect(runChatSlashCommand(opts)).toBe(true);
    // Office Map now lives as the 'officemap' tab of the Agent Roster view.
    expect(mocks.setAgentRosterActiveTab).toHaveBeenCalledWith('officemap');
    expect(mocks.setCurrentViewUI).toHaveBeenCalledWith('roster');
  });

  it('/f12 opens the dock chip picker', () => {
    const opts = makeOptions({ raw: '/f12' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setDockSection).toHaveBeenCalledWith('work');
    expect(mocks.setDockCustomizeOpen).toHaveBeenCalledWith(true);
  });
});

describe('runChatSlashCommand — agent/autonomy commands', () => {
  beforeEach(() => {
    mocks.setDockSection.mockClear();
    mocks.setWorkDashboardTab.mockClear();
    mocks.setDockCustomizeOpen.mockClear();
    mocks.setSidebarOpen.mockClear();
    mocks.selectActivity.mockClear();
    mocks.setFleetMonitorOpen.mockClear();
    mocks.setCurrentViewUI.mockClear();
  });

  it('/autonomy <mode> sends autonomy.switch stamped with the foreground session', () => {
    const opts = makeOptions({ raw: '/autonomy auto' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'autonomy.switch',
      payload: { mode: 'auto', sessionId: 'sess-fg' },
    });
  });

  it('/autonomy with no arg shows usage and does not send', () => {
    const opts = makeOptions({ raw: '/autonomy' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).not.toHaveBeenCalled();
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Usage') }),
    );
  });

  it('/autonomy with invalid mode is rejected', () => {
    const opts = makeOptions({ raw: '/autonomy turbo' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).not.toHaveBeenCalled();
  });

  it('/goal with no args opens the goal view', () => {
    const opts = makeOptions({ raw: '/goal' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setCurrentViewUI).toHaveBeenCalledWith('goal');
  });

  it('/fleet opens the fleet monitor', () => {
    const opts = makeOptions({ raw: '/fleet' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setFleetMonitorOpen).toHaveBeenCalledWith(true);
  });

  it('/worktree opens the worktrees dock chip', () => {
    const opts = makeOptions({ raw: '/worktree' });
    expect(runChatSlashCommand(opts)).toBe(true);
    // Worktrees panel moved into the Changes side panel as a tab.
    expect(mocks.setChangesPanelTab).toHaveBeenCalledWith('worktrees');
    expect(mocks.selectActivity).toHaveBeenCalledWith('changes');
    expect(mocks.setDockSection).toHaveBeenCalledWith('worktrees');
  });

  it('/mode <name> sends mode.switch stamped with the foreground session', () => {
    const opts = makeOptions({ raw: '/mode plan' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'mode.switch',
      payload: { id: 'plan', sessionId: 'sess-fg' },
    });
  });

  it('/mode with no arg lists modes', () => {
    const opts = makeOptions({ raw: '/mode' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: 'modes.list' });
  });

  it('/mcp lists servers and opens settings', () => {
    const opts = makeOptions({ raw: '/mcp' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: 'mcp.list' });
    expect(mocks.setSidebarOpen).toHaveBeenCalledWith(false);
    expect(mocks.setCurrentViewUI).toHaveBeenCalledWith('settings');
  });

  it.each([
    ['/doctor', false],
    ['/doctor fix', true],
  ] as const)('%s runs Config Doctor with apply=%s', (raw, apply) => {
    const opts = makeOptions({ raw });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'config.doctor',
      payload: { apply },
    });
  });

  it('/doctor rejects unsupported arguments', () => {
    const opts = makeOptions({ raw: '/doctor heal' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).not.toHaveBeenCalled();
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Usage') }),
    );
  });

  it('/mcp resources requests discovery without opening settings', () => {
    const opts = makeOptions({ raw: '/mcp resources docs --refresh' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'mcp.resources',
      payload: { name: 'docs', refresh: true },
    });
    expect(mocks.setCurrentViewUI).not.toHaveBeenCalledWith('settings');
  });

  it('/mcp prompts requests prompt discovery', () => {
    const opts = makeOptions({ raw: '/mcp prompts docs' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'mcp.prompts',
      payload: { name: 'docs', refresh: false },
    });
  });

  it('/mcp read explicitly requests one resource', () => {
    const opts = makeOptions({ raw: '/mcp read docs repo://guide' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'mcp.resource.read',
      payload: { name: 'docs', uri: 'repo://guide' },
    });
  });

  it('/mcp get parses prompt arguments', () => {
    const opts = makeOptions({ raw: '/mcp get docs review target=src/' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'mcp.prompt.get',
      payload: { name: 'docs', prompt: 'review', arguments: { target: 'src/' } },
    });
  });

  it('/mcp get rejects malformed arguments locally', () => {
    const opts = makeOptions({ raw: '/mcp get docs review malformed' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).not.toHaveBeenCalled();
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('key=value') }),
    );
  });

  it('/working-dir <path> sends working_dir.set', () => {
    const opts = makeOptions({ raw: '/working-dir /tmp/x' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'working_dir.set',
      payload: { path: '/tmp/x' },
    });
  });

  it('/working-dir with no arg shows current cwd', () => {
    const opts = makeOptions({ raw: '/working-dir' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).not.toHaveBeenCalled();
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('/work/proj') }),
    );
  });

  it('/goal start <title> sends goal.start and opens the view', () => {
    const opts = makeOptions({ raw: '/goal start Build the thing' });
    runChatSlashCommand(opts);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'goal.start',
      payload: { title: 'Build the thing' },
    });
    expect(mocks.setCurrentViewUI).toHaveBeenCalledWith('goal');
  });

  it.each(['pause', 'resume', 'stop'] as const)('/goal %s sends the matching message', (sub) => {
    const opts = makeOptions({ raw: `/goal ${sub}` });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: `goal.${sub}`, payload: {} });
  });

  it('/review sends a review prompt to the agent', () => {
    const opts = makeOptions({ raw: '/review' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.sendMsg).toHaveBeenCalledWith(expect.stringContaining('git diff'));
  });

  it('/review <focus> includes the focus in the prompt', () => {
    const opts = makeOptions({ raw: '/review security' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.sendMsg).toHaveBeenCalledWith(expect.stringContaining('security'));
  });

  it('/fix <error> sends a diagnose-and-fix prompt', () => {
    const opts = makeOptions({ raw: '/fix TypeError: x is undefined' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.sendMsg).toHaveBeenCalledWith(expect.stringContaining('TypeError: x is undefined'));
  });

  it('/fix accepts multiline arguments such as appended file-reference contracts', () => {
    const opts = makeOptions({
      raw: '/fix\n\n@src/large.ts\n\n[File reference contract]\nRead until EOF.',
    });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.sendMsg).toHaveBeenCalledWith(
      expect.stringContaining('@src/large.ts\n\n[File reference contract]\nRead until EOF.'),
    );
  });

  it('/fix with no arg targets the latest failure', () => {
    const opts = makeOptions({ raw: '/fix' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.sendMsg).toHaveBeenCalledWith(expect.stringContaining('most recent error'));
  });

  it('/terminal opens the integrated terminal', () => {
    const opts = makeOptions({ raw: '/terminal' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setTerminalOpen).toHaveBeenCalledWith(true);
  });
});

describe('runChatSlashCommand — case insensitivity', () => {
  it('treats /CLEAR same as /clear', () => {
    const opts = makeOptions({ raw: '/CLEAR' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.clearMessages).toHaveBeenCalledTimes(1);
  });

  it('treats /Tools same as /tools', () => {
    const opts = makeOptions({ raw: '/Tools' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.ws.listTools).toHaveBeenCalledTimes(1);
  });
});

// ── Coverage completion pass (2026-07-29) ───────────────────────────────────
// The blocks below close the branches `need-tests.md` still listed as
// uncovered: /brain, /autonomy, /goal, /working-dir, /todos, /f<N> panel
// dispatch, and the small view-routing commands.

describe('runChatSlashCommand — /brain', () => {
  it('requests status with no sub-command', () => {
    const opts = makeOptions({ raw: '/brain' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: 'brain.status' });
  });

  it('requests status for an unrecognised sub-command', () => {
    const opts = makeOptions({ raw: '/brain wibble' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: 'brain.status' });
  });

  it.each(['off', 'low', 'medium', 'high', 'all'])('sets the risk ceiling to %s', (level) => {
    const opts = makeOptions({ raw: `/brain risk ${level}` });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: 'brain.risk', payload: { level } });
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining(`**${level}**`) }),
    );
  });

  it('lowercases the level', () => {
    const opts = makeOptions({ raw: '/brain RISK HIGH' });
    runChatSlashCommand(opts);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'brain.risk',
      payload: { level: 'high' },
    });
  });

  it('prints usage when the level is missing', () => {
    const opts = makeOptions({ raw: '/brain risk' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Usage:') }),
    );
    expect(opts.client?.send).not.toHaveBeenCalled();
  });

  it('rejects an unknown level without sending', () => {
    const opts = makeOptions({ raw: '/brain risk extreme' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Unknown risk level') }),
    );
    expect(opts.client?.send).not.toHaveBeenCalled();
  });

  it('forwards a question to the Brain', () => {
    const opts = makeOptions({ raw: '/brain ask should I ship this?' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'brain.ask',
      payload: { question: 'should I ship this?' },
    });
  });

  it('prints usage for an empty question', () => {
    const opts = makeOptions({ raw: '/brain ask' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('/brain ask') }),
    );
    expect(opts.client?.send).not.toHaveBeenCalled();
  });
});

describe('runChatSlashCommand — /autonomy', () => {
  it.each(['off', 'suggest', 'auto', 'eternal', 'eternal-parallel'])('switches to %s', (mode) => {
    const opts = makeOptions({ raw: `/autonomy ${mode}` });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'autonomy.switch',
      payload: { mode, sessionId: 'sess-fg' },
    });
  });

  it('prints usage with no mode', () => {
    const opts = makeOptions({ raw: '/autonomy' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Usage:') }),
    );
    expect(opts.client?.send).not.toHaveBeenCalled();
  });

  it('rejects an unknown mode', () => {
    const opts = makeOptions({ raw: '/autonomy yolo' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Unknown autonomy mode') }),
    );
    expect(opts.client?.send).not.toHaveBeenCalled();
  });

  it('is case-insensitive about the mode', () => {
    const opts = makeOptions({ raw: '/autonomy ETERNAL' });
    runChatSlashCommand(opts);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'autonomy.switch',
      payload: { mode: 'eternal', sessionId: 'sess-fg' },
    });
  });
});

describe('runChatSlashCommand — /goal', () => {
  it('opens the goal view with no sub-command', () => {
    const opts = makeOptions({ raw: '/goal' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).not.toHaveBeenCalled();
  });

  it('starts a goal with a title', () => {
    const opts = makeOptions({ raw: '/goal start Ship the thing' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'goal.start',
      payload: { title: 'Ship the thing' },
    });
  });

  it('prints usage when start has no title', () => {
    const opts = makeOptions({ raw: '/goal start' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('/goal start') }),
    );
    expect(opts.client?.send).not.toHaveBeenCalled();
  });

  it.each([
    ['pause', 'goal.pause'],
    ['resume', 'goal.resume'],
    ['stop', 'goal.stop'],
  ])('%s sends %s', (sub, type) => {
    const opts = makeOptions({ raw: `/goal ${sub}` });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type, payload: {} });
  });

  it('falls through to the goal view for an unknown sub-command', () => {
    const opts = makeOptions({ raw: '/goal wibble' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).not.toHaveBeenCalled();
  });
});

describe('runChatSlashCommand — /working-dir', () => {
  it('reports the current directory with no argument', () => {
    const opts = makeOptions({ raw: '/working-dir' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('/work/proj') }),
    );
    expect(opts.client?.send).not.toHaveBeenCalled();
  });

  it('sets a new directory', () => {
    const opts = makeOptions({ raw: '/working-dir /repo/sub' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'working_dir.set',
      payload: { path: '/repo/sub' },
    });
  });

  it('/cwd is an alias', () => {
    const opts = makeOptions({ raw: '/cwd /other' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'working_dir.set',
      payload: { path: '/other' },
    });
  });
});

describe('runChatSlashCommand — /todos', () => {
  it('renders the live todo list with a done counter', () => {
    const opts = makeOptions({ raw: '/todos' });
    expect(runChatSlashCommand(opts)).toBe(true);
    const calls = (opts.addMessage as ReturnType<typeof vi.fn>).mock.calls;
    const content = String(calls[0]?.[0]?.content ?? '');
    expect(content).toContain('(1/2 done)');
    expect(content).toContain('[x] Write tests');
    // An in-progress todo renders its activeForm, not its content.
    expect(content).toContain('[~] Shipping feature');
  });

  it('opens the work dock on the todos tab', () => {
    runChatSlashCommand(makeOptions({ raw: '/todos' }));
    expect(mocks.setDockSection).toHaveBeenCalledWith('work');
    expect(mocks.setWorkDashboardTab).toHaveBeenCalledWith('todos');
  });

  it('clear wipes the list without rendering it', () => {
    const opts = makeOptions({ raw: '/todos clear' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.clearTodos).toHaveBeenCalled();
    expect(opts.addMessage).not.toHaveBeenCalled();
  });
});

describe('runChatSlashCommand — /f panel dispatch', () => {
  it('lists the panels for a bare /f', () => {
    const opts = makeOptions({ raw: '/f' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('F-key panels') }),
    );
  });

  it('lists the panels for an out-of-range index', () => {
    const opts = makeOptions({ raw: '/f 99' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('F-key panels') }),
    );
  });

  it('accepts the spaced form', () => {
    const opts = makeOptions({ raw: '/f 2' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setFleetMonitorOpen).toHaveBeenCalledWith(true);
  });

  it('accepts the joined form', () => {
    const opts = makeOptions({ raw: '/f3' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setAgentsMonitorOpen).toHaveBeenCalledWith(true);
  });

  it('always closes the dock customizer first', () => {
    runChatSlashCommand(makeOptions({ raw: '/f2' }));
    expect(mocks.setDockCustomizeOpen).toHaveBeenCalledWith(false);
  });

  it('/f4 opens the worktree dock', () => {
    expect(runChatSlashCommand(makeOptions({ raw: '/f4' }))).toBe(true);
    expect(mocks.setChangesPanelTab).toHaveBeenCalledWith('worktrees');
    expect(mocks.selectActivity).toHaveBeenCalledWith('changes');
    expect(mocks.setDockSection).toHaveBeenCalledWith('worktrees');
  });

  it('/f5 requests the plan and focuses its tab', () => {
    const opts = makeOptions({ raw: '/f5' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.ws.getPlan).toHaveBeenCalled();
    expect(mocks.setWorkDashboardTab).toHaveBeenCalledWith('plan');
  });

  it('/f6 focuses the todos tab without a round-trip', () => {
    const opts = makeOptions({ raw: '/f6' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setWorkDashboardTab).toHaveBeenCalledWith('todos');
    expect(opts.ws.getPlan).not.toHaveBeenCalled();
  });

  it('/f7 opens the queue panel', () => {
    expect(runChatSlashCommand(makeOptions({ raw: '/f7' }))).toBe(true);
    expect(mocks.setQueuePanelOpen).toHaveBeenCalledWith(true);
  });

  it('/f8 opens the process list', () => {
    expect(runChatSlashCommand(makeOptions({ raw: '/f8' }))).toBe(true);
    expect(mocks.setProcessMonitorOpen).toHaveBeenCalledWith(true);
  });

  it('/f9 requests the goal state', () => {
    const opts = makeOptions({ raw: '/f9' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: 'goal.get' });
    expect(mocks.setDockSection).toHaveBeenCalledWith('goal-state');
  });

  it('/f10 lists sessions with the documented cap', () => {
    const opts = makeOptions({ raw: '/f10' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.ws.listSessions).toHaveBeenCalledWith(50);
  });

  it('/f1 returns to the session panel', () => {
    expect(runChatSlashCommand(makeOptions({ raw: '/f1' }))).toBe(true);
  });

  it('/f11 and /f12 route to the office map and the statusline picker', () => {
    expect(runChatSlashCommand(makeOptions({ raw: '/f11' }))).toBe(true);
    expect(runChatSlashCommand(makeOptions({ raw: '/f12' }))).toBe(true);
    expect(mocks.setDockCustomizeOpen).toHaveBeenCalledWith(true);
  });
});

describe('runChatSlashCommand — misc view routing', () => {
  it('/collab reveals the collab dock', () => {
    expect(runChatSlashCommand(makeOptions({ raw: '/collab' }))).toBe(true);
    expect(mocks.setDockSection).toHaveBeenCalledWith('collab');
  });

  it.each(['/worktree', '/worktrees'])('%s reveals the worktrees dock', (raw) => {
    expect(runChatSlashCommand(makeOptions({ raw }))).toBe(true);
    expect(mocks.setDockSection).toHaveBeenCalledWith('worktrees');
  });

  it('/fleet opens the fleet monitor', () => {
    expect(runChatSlashCommand(makeOptions({ raw: '/fleet' }))).toBe(true);
    expect(mocks.setFleetMonitorOpen).toHaveBeenCalledWith(true);
  });

  it('/agents opens the agents monitor', () => {
    expect(runChatSlashCommand(makeOptions({ raw: '/agents' }))).toBe(true);
    expect(mocks.setAgentsMonitorOpen).toHaveBeenCalledWith(true);
  });

  it.each(['/load', '/resume'])('%s lists recent sessions', (raw) => {
    const opts = makeOptions({ raw });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.ws.listSessions).toHaveBeenCalledWith(50);
  });

  it.each(['/interrupt', '/abort', '/stop', '/int'])('%s aborts the run', (raw) => {
    const opts = makeOptions({ raw });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.sendAbort).toHaveBeenCalled();
    expect(opts.setLoading).toHaveBeenCalledWith(false);
  });

  it('/plan requests the plan and focuses its tab', () => {
    const opts = makeOptions({ raw: '/plan' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.ws.getPlan).toHaveBeenCalled();
    expect(mocks.setWorkDashboardTab).toHaveBeenCalledWith('plan');
  });

  it('/export downloads the transcript and confirms', () => {
    const opts = makeOptions({ raw: '/export' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('exported') }),
    );
  });

  it('/enhance reports the toggled state', () => {
    const opts = makeOptions({ raw: '/enhance' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.toggleRefineEnabled).toHaveBeenCalled();
    // The mocked store reports refineEnabled: false, so the toggle enables it.
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Prompt refinement enabled.' }),
    );
  });

  it.each(['/suggest', '/next-steps'])('%s asks the agent for follow-ups', (raw) => {
    const opts = makeOptions({ raw });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.sendMsg).toHaveBeenCalledWith(expect.stringContaining('Suggest exact prompt'));
  });

  it.each(['/prompt', '/prompts'])('%s opens the prompt library', (raw) => {
    expect(runChatSlashCommand(makeOptions({ raw }))).toBe(true);
    expect(mocks.setPromptLibraryOpen).toHaveBeenCalledWith(true);
  });
});
