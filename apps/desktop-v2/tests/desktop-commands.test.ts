import { describe, expect, it, vi } from 'vitest';
import { type DesktopCommandContext, runDesktopCommand } from '../src/desktop-command-runner';
import {
  DESKTOP_CATEGORY_ORDER,
  desktopCommands,
  matchDesktopCommands,
  parseDesktopCommand,
} from '../src/desktop-commands';

function contextWith(prefs: Record<string, unknown> = {}, reply: Record<string, unknown> = {}) {
  const context = {
    command: vi.fn(async () => reply),
    prefs,
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
  return context;
}

const run = (text: string, context: DesktopCommandContext) => {
  const outcome = runDesktopCommand(text, context);
  if (!outcome) throw new Error(`${text} is not a command`);
  return outcome;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('desktop command catalog', () => {
  it('parses commands and aliases, and leaves literal paths alone', () => {
    expect(parseDesktopCommand('/queue review the API')).toMatchObject({
      command: { action: 'queue' },
      argument: 'review the API',
    });
    expect(parseDesktopCommand('/ABORT')?.command?.name).toBe('/stop');
    expect(parseDesktopCommand('/compact!')?.command?.action).toBe('compact-aggressive');
    expect(parseDesktopCommand('/not-a-command')).toEqual({
      command: undefined,
      name: '/not-a-command',
      argument: '',
    });
    expect(parseDesktopCommand('//help')).toBeNull();
    expect(parseDesktopCommand('/src/main.ts')).toBeNull();
  });

  it('keeps names unique, files every command under a listed category, and matches prefixes', () => {
    const names = desktopCommands.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
    for (const command of desktopCommands) {
      expect(DESKTOP_CATEGORY_ORDER).toContain(command.category);
      expect(command.action !== 'open' || command.opens !== undefined).toBe(true);
    }
    expect(matchDesktopCommands('/sta').map((command) => command.name)).toEqual(['/usage']);
    expect(matchDesktopCommands('/co').map((command) => command.name)).toEqual([
      '/context',
      '/compact',
      '/compact!',
      '/usage',
    ]);
  });
});

describe('running desktop commands', () => {
  it('leaves ordinary text and literal slashes to the composer', () => {
    expect(runDesktopCommand('fix the build', contextWith())).toBeNull();
    expect(runDesktopCommand('//help', contextWith())).toBeNull();
  });

  it('refuses unknown commands and arguments a command does not take, keeping the draft', () => {
    const context = contextWith();
    expect(run('/nope', context)).toMatchObject({ kind: 'refused' });
    expect(run('/compact now', context)).toEqual({
      kind: 'refused',
      message: '/compact takes no arguments. Your draft was not sent.',
    });
    expect(context.openContext).not.toHaveBeenCalled();
  });

  it('opens conversation tabs and project pages', () => {
    const context = contextWith();
    expect(run('/stats', context)).toEqual({ kind: 'handled' });
    expect(run('/dashboard', context)).toEqual({ kind: 'handled' });
    run('/agents', context);
    run('/load', context);
    expect(context.navigate.mock.calls.map(([target]) => target)).toEqual([
      { tab: 'usage' },
      { tab: 'context' },
      { page: 'live-fleet' },
      { page: 'history' },
    ]);
  });

  it('sends queue, BTW and steer text with that delivery, and switches delivery without text', () => {
    const context = contextWith();
    expect(run('/btw also check the docs', context)).toEqual({
      kind: 'submit',
      text: 'also check the docs',
      mode: 'btw',
    });
    expect(run('/steer', context)).toEqual({ kind: 'handled' });
    expect(context.setMode).toHaveBeenCalledWith('steer');
    context.openQueue.mockReturnValue(false);
    run('/queue', context);
    expect(context.notify).toHaveBeenCalledWith('There are no pending queued prompts.');
  });

  it('turns review, fix and suggest into prompts', () => {
    const context = contextWith();
    const review = run('/cr the auth module', context);
    expect(review).toMatchObject({ kind: 'submit' });
    expect(review.kind === 'submit' && review.text).toContain(
      'Focus especially on: the auth module.',
    );
    const fix = run('/fix TypeError: x is undefined', context);
    expect(fix.kind === 'submit' && fix.text).toContain('TypeError: x is undefined');
    expect(run('/suggest', context)).toMatchObject({ kind: 'submit' });
  });

  it('switches the continuation mode only to a known mode', async () => {
    const context = contextWith({ autonomy: 'suggest' });
    run('/autonomy', context);
    expect(context.notify).toHaveBeenLastCalledWith(
      'Continuation mode: suggest. Use /autonomy <off|suggest|auto|eternal|eternal-parallel>.',
    );
    expect(run('/autonomy turbo', context)).toMatchObject({ kind: 'refused' });
    run('/autonomy AUTO', context);
    expect(context.command).toHaveBeenCalledWith('autonomy.switch', { mode: 'auto' }, [
      'key.operation_result',
    ]);
    await settle();
    expect(context.notify).toHaveBeenLastCalledWith('Continuation mode → auto.');
  });

  it('lists agent modes, or switches to one and reports a refusal', async () => {
    const listing = contextWith(
      {},
      { modes: [{ id: 'architect', name: 'Architect' }], activeId: 'architect' },
    );
    run('/mode', listing);
    await settle();
    expect(listing.notify).toHaveBeenCalledWith(
      'Agent modes: default, architect (active). Use /mode <id> to switch.',
    );
    const switching = contextWith();
    switching.command.mockRejectedValueOnce(new Error('Unknown mode "nope".'));
    run('/mode nope', switching);
    expect(switching.command).toHaveBeenCalledWith('mode.switch', { id: 'nope' }, [
      'key.operation_result',
    ]);
    await settle();
    expect(switching.fail).toHaveBeenCalledWith('Unknown mode "nope".');
  });

  it('sets YOLO and next steps through this conversation’s preferences', async () => {
    const context = contextWith({ yolo: true, nextStepsMode: 'optional' });
    run('/yolo', context);
    expect(context.notify).toHaveBeenLastCalledWith(
      'YOLO: on. Use /yolo on, /yolo plus or /yolo off.',
    );
    run('/yolo plus', context);
    expect(context.command).toHaveBeenLastCalledWith(
      'prefs.update',
      { yolo: true, yoloPlus: true },
      ['key.operation_result'],
    );
    expect(run('/yolo maybe', context)).toMatchObject({ kind: 'refused' });
    run('/nextsteps', context);
    expect(context.notify).toHaveBeenLastCalledWith(
      'Next steps: optional · automatic continuation limit: 50 turns.',
    );
    run('/nextsteps required unlimited', context);
    expect(context.command).toHaveBeenLastCalledWith(
      'prefs.update',
      { nextStepsMode: 'required', autoProceedMaxIterations: 0 },
      ['key.operation_result'],
    );
    await settle();
    expect(context.notify).toHaveBeenLastCalledWith(
      'Next steps → required. Automatic continuation limit → unlimited.',
    );
    expect(run('/nextsteps limit lots', context)).toMatchObject({ kind: 'refused' });
    expect(run('/nextsteps sometimes', context)).toMatchObject({ kind: 'refused' });
  });

  it('opens the dialogs and runs the composer actions', () => {
    const context = contextWith();
    run('/help', context);
    run('/prompts', context);
    run('/history', context);
    run('/debug', context);
    run('/clear', context);
    run('/int', context);
    run('/enhance', context);
    run('/auth', context);
    expect(context.openHelp).toHaveBeenCalled();
    expect(context.openPrompts.mock.calls).toEqual([['library'], ['journal']]);
    expect(context.openContext.mock.calls).toEqual([['inspect'], ['clear']]);
    expect(context.stop).toHaveBeenCalled();
    expect(context.toggleEnhance).toHaveBeenCalled();
    expect(context.openSettings).toHaveBeenCalled();
  });
});
