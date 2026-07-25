import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type RunChatSlashCommandOptions,
  runChatSlashCommand,
} from '../../src/components/ChatInput/slash-routing.js';
import { streamCoalescer } from '../../src/lib/stream-coalescer.js';

// Mock external store dependencies and downloadChatAsMarkdown
const mocks = vi.hoisted(() => ({
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
}));

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
  useUIStore: {
    getState: () => ({
      refineEnabled: false,
      setAgentsMonitorOpen: mocks.setAgentsMonitorOpen,
      setFleetMonitorOpen: mocks.setFleetMonitorOpen,
      setQueuePanelOpen: mocks.setQueuePanelOpen,
      setProcessMonitorOpen: mocks.setProcessMonitorOpen,
      setDockSection: mocks.setDockSection,
      setWorkDashboardTab: mocks.setWorkDashboardTab,
      setDockCustomizeOpen: mocks.setDockCustomizeOpen,
      setSidebarOpen: mocks.setSidebarOpen,
      selectActivity: mocks.selectActivity,
      setCurrentView: mocks.setCurrentViewUI,
      setTerminalOpen: mocks.setTerminalOpen,
    }),
  },
}));

vi.mock('@/stores/ui-store', () => ({
  useUIStore: {
    getState: () => ({
      currentView: 'files',
      refineEnabled: false,
      setAgentsMonitorOpen: mocks.setAgentsMonitorOpen,
      setFleetMonitorOpen: mocks.setFleetMonitorOpen,
      setQueuePanelOpen: mocks.setQueuePanelOpen,
      setProcessMonitorOpen: mocks.setProcessMonitorOpen,
      setDockSection: mocks.setDockSection,
      setWorkDashboardTab: mocks.setWorkDashboardTab,
      setDockCustomizeOpen: mocks.setDockCustomizeOpen,
      setSidebarOpen: mocks.setSidebarOpen,
      selectActivity: mocks.selectActivity,
      setCurrentView: mocks.setCurrentViewUI,
      setTerminalOpen: mocks.setTerminalOpen,
    }),
  },
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

  it('/new calls client.newSession', () => {
    expect(runChatSlashCommand({ ...options, raw: '/new' })).toBe(true);
    expect(options.client?.newSession).toHaveBeenCalledTimes(1);
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
    expect(mocks.setCurrentViewUI).toHaveBeenCalledWith('chat');
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
    expect(mocks.setCurrentViewUI).toHaveBeenCalledWith('chat');
  });

  it('/f11 opens the coordinator office map surface', () => {
    const opts = makeOptions({ raw: '/f11' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setSidebarOpen).toHaveBeenCalledWith(true);
    expect(mocks.selectActivity).toHaveBeenCalledWith('officemap');
    expect(mocks.setCurrentViewUI).toHaveBeenCalledWith('officemap');
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

  it('/autonomy <mode> sends autonomy.switch', () => {
    const opts = makeOptions({ raw: '/autonomy auto' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'autonomy.switch',
      payload: { mode: 'auto' },
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
    expect(mocks.setDockSection).toHaveBeenCalledWith('worktrees');
  });

  it('/mode <name> sends mode.switch', () => {
    const opts = makeOptions({ raw: '/mode plan' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'mode.switch',
      payload: { id: 'plan' },
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

  it.each([
    'pause',
    'resume',
    'stop',
  ] as const)('/goal %s sends the matching message', (sub) => {
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
