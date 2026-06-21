import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runChatSlashCommand, type RunChatSlashCommandOptions } from '../../src/components/ChatInput/slash-routing.js';

// Mock external store dependencies and downloadChatAsMarkdown
const mocks = vi.hoisted(() => ({
  setAgentsMonitorOpen: vi.fn(),
  setFleetMonitorOpen: vi.fn(),
  setQueuePanelOpen: vi.fn(),
  setProcessMonitorOpen: vi.fn(),
  setDockSection: vi.fn(),
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
      setCurrentView: mocks.setCurrentViewUI,
      setTerminalOpen: mocks.setTerminalOpen,
    }),
  },
}));

vi.mock('../../src/components/CommandPalette', () => ({
  downloadChatAsMarkdown: vi.fn(),
}));

function makeOptions(overrides: Partial<RunChatSlashCommandOptions> = {}): RunChatSlashCommandOptions {
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
      ['/memory', 'listMemory'],
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
  });

  it('/clear calls clearMessages and client.clearContext', () => {
    expect(runChatSlashCommand({ ...options, raw: '/clear' })).toBe(true);
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

  it('/load calls ws.listSessions and switches to sessions view', () => {
    expect(runChatSlashCommand({ ...options, raw: '/load' })).toBe(true);
    expect(options.ws.listSessions).toHaveBeenCalledWith(50);
    expect(options.setCurrentView).toHaveBeenCalledWith('sessions');
  });

  it.each(['/interrupt', '/abort', '/stop'])('%s calls sendAbort and setLoading(false)', (cmd) => {
    expect(runChatSlashCommand({ ...options, raw: cmd })).toBe(true);
    expect(options.sendAbort).toHaveBeenCalledTimes(1);
    expect(options.setLoading).toHaveBeenCalledWith(false);
  });

  it('/settings switches to settings view', () => {
    expect(runChatSlashCommand({ ...options, raw: '/settings' })).toBe(true);
    expect(options.setCurrentView).toHaveBeenCalledWith('settings');
  });

  it('/suggest sends a suggestion prompt', () => {
    expect(runChatSlashCommand({ ...options, raw: '/suggest' })).toBe(true);
    expect(options.sendMsg).toHaveBeenCalledTimes(1);
    expect(options.sendMsg).toHaveBeenCalledWith(expect.stringContaining('next steps'));
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
    const opts = makeOptions({ raw: '/queue', queue: ['first message', 'second'] });
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
});

describe('runChatSlashCommand — /f', () => {
  it('/f with no panel shows f-key list', () => {
    const opts = makeOptions({ raw: '/f' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('F-key panels') }),
    );
  });

  it('/f3 opens agents monitor via store', async () => {
    const opts = makeOptions({ raw: '/f3' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(mocks.setAgentsMonitorOpen).toHaveBeenCalledWith(true);
  });
});

describe('runChatSlashCommand — agent/autonomy commands', () => {
  beforeEach(() => {
    mocks.setDockSection.mockClear();
    mocks.setFleetMonitorOpen.mockClear();
    mocks.setCurrentViewUI.mockClear();
  });

  it('/autonomy <mode> sends autonomy.switch', () => {
    const opts = makeOptions({ raw: '/autonomy auto' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: 'autonomy.switch', payload: { mode: 'auto' } });
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

  it('/goal requests goal and opens the goal dock chip', () => {
    const opts = makeOptions({ raw: '/goal' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: 'goal.get' });
    expect(mocks.setDockSection).toHaveBeenCalledWith('goal');
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
    expect(opts.client?.send).toHaveBeenCalledWith({ type: 'mode.switch', payload: { id: 'plan' } });
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
    expect(opts.setCurrentView).toHaveBeenCalledWith('settings');
  });

  it('/working-dir <path> sends working_dir.set', () => {
    const opts = makeOptions({ raw: '/working-dir /tmp/x' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: 'working_dir.set', payload: { path: '/tmp/x' } });
  });

  it('/working-dir with no arg shows current cwd', () => {
    const opts = makeOptions({ raw: '/working-dir' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).not.toHaveBeenCalled();
    expect(opts.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('/work/proj') }),
    );
  });

  it('/autophase start <title> sends autophase.start and opens the view', () => {
    const opts = makeOptions({ raw: '/autophase start Build the thing' });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({
      type: 'autophase.start',
      payload: { title: 'Build the thing' },
    });
    expect(mocks.setCurrentViewUI).toHaveBeenCalledWith('autophase');
  });

  it.each(['pause', 'resume', 'stop'] as const)('/autophase %s sends the matching message', (sub) => {
    const opts = makeOptions({ raw: `/autophase ${sub}` });
    expect(runChatSlashCommand(opts)).toBe(true);
    expect(opts.client?.send).toHaveBeenCalledWith({ type: `autophase.${sub}`, payload: {} });
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
