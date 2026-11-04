// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { type DesktopCommandContext, runDesktopCommand } from '../src/desktop-command-runner';
import { parseDesktopCommand } from '../src/desktop-commands';
import { type EngineState, emptyEngineState } from '../src/engine-state';
import {
  requestSettingsSection,
  type SettingsTarget,
  useRequestedSettingsSection,
} from '../src/settings-section-request';
import { transcriptFileName, transcriptMarkdown } from '../src/transcript-export';

const download = vi.hoisted(() => vi.fn());
vi.mock('../src/skill-model', async (original) => ({
  ...(await original<typeof import('../src/skill-model')>()),
  downloadSkillFile: download,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function contextWith(state: Partial<EngineState> = {}, reply: Record<string, unknown> = {}) {
  return {
    command: vi.fn(async () => reply),
    send: vi.fn(async () => undefined),
    state: { ...emptyEngineState, ...state },
    stopHunt: vi.fn((): string | null => null),
    openHelp: vi.fn(),
    openPrompts: vi.fn(),
    openContext: vi.fn(),
    stop: vi.fn(),
    toggleEnhance: vi.fn(),
    openSettings: vi.fn(),
    openQueue: vi.fn(() => true),
    setMode: vi.fn(),
    navigate: vi.fn(),
    notify: vi.fn(),
    fail: vi.fn(),
  } satisfies DesktopCommandContext;
}
const run = (text: string, context: DesktopCommandContext) => runDesktopCommand(text, context);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('WebUI slash commands in the desktop composer', () => {
  it('knows every command and alias the WebUI routes', () => {
    for (const name of [
      '/new',
      '/terminal',
      '/term',
      '/mcp',
      '/doctor',
      '/tools',
      '/brain',
      '/goal',
      '/goal-state',
      '/browser',
      '/network',
      '/working-dir',
      '/cwd',
      '/save',
      '/todos',
      '/next',
      '/enxt',
      '/export',
    ])
      expect(parseDesktopCommand(name)?.command, name).toBeDefined();
  });

  it('opens a new conversation, a terminal, or the settings section a command names', () => {
    const context = contextWith();
    for (const name of ['/new', '/terminal', '/tools', '/mcp', '/doctor', '/brain', '/browser'])
      expect(run(name, context)).toEqual({ kind: 'handled' });
    expect(context.navigate.mock.calls.map(([target]) => target)).toEqual([
      { start: 'agent' },
      { start: 'terminal' },
      { settings: 'tool-access' },
      { settings: 'integrations' },
      { settings: 'health' },
      { settings: 'brain' },
      { settings: 'tool-access' },
    ]);
  });

  it('repairs the configuration and says what changed', async () => {
    const context = contextWith(
      {},
      { applied: true, changes: [{ path: 'a' }, { path: 'b' }], backupPath: 'C:/cfg.bak' },
    );
    run('/doctor fix', context);
    await settle();
    expect(context.command).toHaveBeenCalledWith('config.doctor', { apply: true }, [
      'config.doctor.result',
    ]);
    expect(context.notify).toHaveBeenCalledWith(
      'Repaired 2 settings in the profile configuration. The old file is at C:/cfg.bak.',
    );
    expect(run('/doctor now', contextWith())).toMatchObject({ kind: 'refused' });
  });

  it('sets the Brain risk ceiling and refuses an unknown level', async () => {
    const context = contextWith();
    run('/brain risk HIGH', context);
    await settle();
    expect(context.command).toHaveBeenCalledWith('brain.risk', { level: 'high' }, [
      'brain.status',
      'key.operation_result',
    ]);
    expect(context.notify).toHaveBeenCalledWith('Brain risk ceiling → high.');
    expect(run('/brain risk extreme', context)).toMatchObject({ kind: 'refused' });
    const asking = contextWith({}, { decision: { type: 'answer', text: 'Yes' } });
    run('/brain ask ship it?', asking);
    await settle();
    expect(asking.command).toHaveBeenCalledWith('brain.ask', { question: 'ship it?' }, [
      'brain.answer',
      'key.operation_result',
    ]);
    expect(asking.notify).toHaveBeenCalledWith('Brain · Answer: Yes');
  });

  it('lists one MCP server’s tools', async () => {
    const context = contextWith({}, { tools: [{ name: 'search' }, { name: 'fetch' }] });
    run('/mcp tools github', context);
    await settle();
    expect(context.command).toHaveBeenCalledWith('mcp.tools', { name: 'github' }, [
      'mcp.tools',
      'mcp.content.error',
    ]);
    expect(context.notify).toHaveBeenCalledWith('github offers 2 tools: search, fetch.');
    expect(run('/mcp call github x', context)).toMatchObject({ kind: 'refused' });
  });

  it('runs the browser policy, the working directory and save against the engine', async () => {
    const context = contextWith(
      { results: { 'session.start': { cwd: 'D:/repo', projectRoot: 'D:/repo' } } },
      { message: 'Allowed private origins: http://localhost:3000' },
    );
    run('/browser allow http://localhost:3000', context);
    run('/cwd', context);
    run('/working-dir packages/core', context);
    run('/save', context);
    await settle();
    expect(context.command.mock.calls.map(([type, payload]) => [type, payload])).toEqual([
      ['browser.policy', { args: 'allow http://localhost:3000' }],
      ['working_dir.set', { path: 'packages/core' }],
      ['session.save', {}],
    ]);
    expect(context.notify).toHaveBeenCalledWith(
      'Working directory: D:/repo. Use /working-dir <path> to change it.',
    );
    expect(context.notify).toHaveBeenCalledWith('Allowed private origins: http://localhost:3000');
  });

  it('shows the todo list or clears it', async () => {
    const todos = [
      { id: '1', content: 'Write tests', status: 'completed' },
      { id: '2', content: 'Ship', activeForm: 'Shipping', status: 'in_progress' },
    ];
    const context = contextWith({ results: { 'todos.updated': { todos } } });
    run('/todos', context);
    expect(context.notify).toHaveBeenCalledWith('Todo list: 1 of 2 done · Shipping.');
    run('/todos clear', context);
    await settle();
    expect(context.command).toHaveBeenCalledWith('todos.clear', {}, ['key.operation_result']);
    expect(run('/todos all', context)).toMatchObject({ kind: 'refused' });
  });

  it('lists the suggested next steps and sends the numbered ones', () => {
    const nextSteps = [
      { index: 1, text: 'Add tests' },
      { index: 2, text: 'Update docs' },
      { index: 3, text: 'Release' },
    ];
    const context = contextWith({ nextSteps });
    expect(run('/next', context)).toEqual({ kind: 'handled' });
    expect(context.notify).toHaveBeenCalledWith(
      'Suggested next steps: 1. Add tests · 2. Update docs · 3. Release. Use /next <n> to send one.',
    );
    expect(run('/next 3,1', context)).toEqual({ kind: 'submit', text: 'Release\nAdd tests' });
    expect(run('/enxt 2', context)).toEqual({ kind: 'submit', text: 'Update docs' });
    expect(run('/next 4', context)).toMatchObject({ kind: 'refused' });
    expect(run('/next first', context)).toMatchObject({ kind: 'refused' });
    const none = contextWith();
    expect(run('/next 1', none)).toEqual({ kind: 'handled' });
    expect(none.notify).toHaveBeenCalledWith(
      'No suggested next steps. Use /suggest to ask for some.',
    );
  });

  it('downloads the conversation as Markdown', () => {
    download.mockClear();
    const messages = [
      { id: 'u', role: 'user' as const, text: 'Hello' },
      { id: 'a', role: 'assistant' as const, text: 'Hi **there**' },
    ];
    const context = contextWith({
      messages,
      results: { 'session.start': { projectRoot: 'D:\\work\\My App' } },
    });
    run('/export', context);
    const [content, name, type] = download.mock.calls[0] as [string, string, string];
    expect(name).toMatch(/^My-App-chat-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.md$/);
    expect(type).toBe('text/markdown');
    expect(content).toContain('# My App — chat export');
    expect(content).toContain('## 👤 User\n\nHello');
    expect(content).toContain('## 🤖 Assistant\n\nHi **there**');
    run('/export', contextWith());
    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe('/goal', () => {
  it('starts a goal and steers the mission, opening the goals page', async () => {
    const context = contextWith();
    run('/goal start Ship the API', context);
    run('/goal set Keep the build green', context);
    run('/goal pause', context);
    run('/goal load nightly --resume', context);
    run('/goal make docs friendlier', context);
    await settle();
    const sent = context.send.mock.calls.map(([type, payload]) => [type, payload]);
    expect(sent[0]).toEqual([
      'goal.start',
      { goalId: expect.any(String), title: 'Ship the API', autonomous: true },
    ]);
    expect(sent.slice(1)).toEqual([
      ['goal-state.set', { goal: 'Keep the build green' }],
      ['goal-state.pause', {}],
      ['goal.load', { query: 'nightly', resume: true }],
      ['goal-state.set', { goal: 'make docs friendlier' }],
    ]);
    expect(context.navigate).toHaveBeenCalledWith({ page: 'goals' });
  });

  it('acts on the running goal when there is one', () => {
    const context = contextWith({
      goalStates: { old: { status: 'completed' }, live: { status: 'running' } },
    });
    run('/goal pause', context);
    run('/goal stop', context);
    expect(context.send.mock.calls).toEqual([
      ['goal.pause', { goalId: 'live' }],
      ['goal.stop', { goalId: 'live' }],
    ]);
    expect(run('/goal stop', contextWith())).toMatchObject({ kind: 'refused' });
    expect(run('/goal pasue', contextWith())).toMatchObject({ kind: 'refused' });
    expect(run('/goal start', contextWith())).toMatchObject({ kind: 'refused' });
  });
});

describe('opening a settings section from a command', () => {
  function Probe({ open }: { open: (section: SettingsTarget) => void }) {
    useRequestedSettingsSection(open);
    return null;
  }

  it('hands the requested section to the settings page once', () => {
    const open = vi.fn();
    requestSettingsSection('brain');
    const first = createRoot(document.createElement('div'));
    act(() => first.render(createElement(Probe, { open })));
    act(() => first.unmount());
    const second = createRoot(document.createElement('div'));
    act(() => second.render(createElement(Probe, { open })));
    expect(open.mock.calls).toEqual([['brain']]);
  });

  it('names an exported file after the project folder', () => {
    expect(transcriptFileName('', '2026-11-04T10:30:00.000Z')).toBe(
      'conversation-chat-2026-11-04-10-30-00.md',
    );
    expect(transcriptMarkdown('x', [], 'now')).toBe('# x — chat export\n*Exported: now*\n');
  });
});
