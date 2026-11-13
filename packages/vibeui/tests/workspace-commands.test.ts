import { describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceCommands,
  type WorkspaceCommandActions,
} from '../src/lib/workspace-commands';

function actions(): WorkspaceCommandActions {
  return {
    openGuide: vi.fn(),
    focusMessage: vi.fn(),
    newSession: vi.fn(),
    openHistory: vi.fn(),
    searchConversation: vi.fn(),
    openFiles: vi.fn(),
    openPanel: vi.fn(),
    openResources: vi.fn(),
    openProviders: vi.fn(),
    openContext: vi.fn(),
    openInstructions: vi.fn(),
    openSettings: vi.fn(),
    toggleTheme: vi.fn(),
    requestStop: vi.fn(),
    switchSession: vi.fn(),
  };
}

const sessions = [
  { id: 'one', title: 'Current work' },
  { id: 'two', title: 'Older work' },
];

function build(overrides: { locked?: boolean; canStop?: boolean } = {}) {
  const handlers = actions();
  const commands = buildWorkspaceCommands({
    locked: overrides.locked ?? false,
    canStop: overrides.canStop ?? true,
    activeSessionId: 'one',
    sessions,
    actions: handlers,
  });
  const byId = (id: string) => {
    const command = commands.find((item) => item.id === id);
    if (!command) throw new Error(`missing command ${id}`);
    return command;
  };
  return { commands, handlers, byId };
}

describe('buildWorkspaceCommands', () => {
  it('lists the palette entries in display order, sessions last', () => {
    expect(build().commands.map((command) => command.id)).toEqual([
      'guide',
      'chat',
      'new',
      'history',
      'find',
      'files',
      'changes',
      'tasks',
      'agents',
      'prompts',
      'skills',
      'tools',
      'mcp',
      'memory',
      'providers',
      'context',
      'instructions',
      'settings',
      'theme',
      'stop',
      'session-one',
      'session-two',
    ]);
  });

  it('keeps titles and searchable shortcut hints stable', () => {
    const { byId } = build();
    expect(byId('changes').title).toBe('Changes');
    expect(byId('mcp').title).toBe('MCP connections');
    expect(byId('memory').title).toBe('Memory');
    expect(byId('stop').title).toBe('Stop all tasks');
    expect(byId('find').detail).toContain('Ctrl/Cmd+Shift+F');
    expect(byId('settings').detail).toContain('Ctrl/Cmd+,');
    expect(byId('session-two')).toMatchObject({ title: 'Older work', detail: 'Resume session' });
  });

  it('disables only session creation and switching while locked', () => {
    const disabled = (locked: boolean) =>
      build({ locked })
        .commands.filter((command) => command.disabled)
        .map((command) => command.id);
    expect(disabled(true)).toEqual(['new', 'session-one', 'session-two']);
    expect(disabled(false)).toEqual([]);
  });

  it('gates Stop all on canStop independently of the lock', () => {
    expect(build({ canStop: false }).byId('stop').disabled).toBe(true);
    expect(build({ canStop: true, locked: true }).byId('stop').disabled).toBe(false);
  });

  it('routes panel and resource entries to their tab', () => {
    const { byId, handlers } = build();
    byId('tasks').run();
    byId('agents').run();
    byId('mcp').run();
    byId('prompts').run();
    expect(handlers.openPanel).toHaveBeenNthCalledWith(1, 'tasks');
    expect(handlers.openPanel).toHaveBeenNthCalledWith(2, 'agents');
    expect(handlers.openResources).toHaveBeenNthCalledWith(1, 'mcp');
    expect(handlers.openResources).toHaveBeenNthCalledWith(2, 'prompts');
  });

  it('wires every fixed entry to its own action', () => {
    const { byId, handlers } = build();
    const pairs: [string, keyof WorkspaceCommandActions][] = [
      ['guide', 'openGuide'],
      ['chat', 'focusMessage'],
      ['new', 'newSession'],
      ['history', 'openHistory'],
      ['find', 'searchConversation'],
      ['files', 'openFiles'],
      ['providers', 'openProviders'],
      ['context', 'openContext'],
      ['instructions', 'openInstructions'],
      ['settings', 'openSettings'],
      ['theme', 'toggleTheme'],
      ['stop', 'requestStop'],
    ];
    for (const [id, action] of pairs) {
      byId(id).run();
      expect(handlers[action], id).toHaveBeenCalledTimes(1);
    }
  });

  it('switches only to a different session', () => {
    const { byId, handlers } = build();
    byId('session-one').run();
    expect(handlers.switchSession).not.toHaveBeenCalled();
    byId('session-two').run();
    expect(handlers.switchSession).toHaveBeenCalledWith('two');
  });
});
