import type { Config } from '@wrongstack/contracts/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  menu: vi.fn(),
  prompts: vi.fn(),
  persist: vi.fn(),
  stopAsking: vi.fn(async () => false),
  outside: vi.fn(async () => false),
}));
vi.mock('../src/boot/system-prompt-menu.js', () => ({ maybeRunSystemPromptMenu: mocks.menu }));
vi.mock('../src/pre-launch.js', () => ({
  isOutsideProject: mocks.outside,
  runLaunchPrompts: mocks.prompts,
  persistLaunchChoices: mocks.persist,
  promptStopAskingStartupQuestions: mocks.stopAsking,
  LaunchAbortedError: class extends Error {},
}));

import { applyBootLaunchChoices, type BootLaunchInput } from '../src/boot-launch-choices.js';

function fixture(
  overrides: Omit<Partial<BootLaunchInput>, 'config'> & { config?: Partial<Config> } = {},
): BootLaunchInput {
  return {
    isInteractiveTTY: false,
    simpleUiFullAuto: false,
    flags: {},
    config: { yolo: false, launch: { mode: 'tui', autonomy: 'auto' } },
    renderer: { write: vi.fn(), writeWarning: vi.fn() },
    reader: { close: vi.fn() },
    profileConfigPath: 'profile.json',
    wpaths: { globalInstructions: 'global', inProjectInstructions: 'project' },
    projectRoot: 'project',
    ...overrides,
  } as BootLaunchInput;
}

beforeEach(() => {
  mocks.menu.mockResolvedValue({ aborted: false, changed: false });
  mocks.prompts.mockResolvedValue({ mode: 'repl', yolo: false, autonomy: 'off' });
  mocks.persist.mockResolvedValue(undefined);
});

describe('boot launch choices', () => {
  it('honours non-interactive autonomy opt-out and explicit REPL mode', async () => {
    const input = fixture({ flags: { 'no-autonomy': true, 'no-tui': true } });
    expect(await applyBootLaunchChoices(input)).toEqual({ kind: 'ok', config: input.config });
    expect(input.flags).toMatchObject({ autonomy: 'off', tui: false, 'no-tui': true });
    expect(mocks.prompts).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('uses automatic autonomy for SimpleUI even with an opt-out flag', async () => {
    const input = fixture({ simpleUiFullAuto: true, flags: { 'no-autonomy': true } });
    await applyBootLaunchChoices(input);
    expect(input.flags.autonomy).toBe('auto');
  });

  it('closes the reader when the system-prompt menu is cancelled', async () => {
    mocks.menu.mockResolvedValue({ aborted: true });
    const input = fixture({ isInteractiveTTY: true });
    expect(await applyBootLaunchChoices(input)).toEqual({ kind: 'exit', code: 0 });
    expect(input.reader.close).toHaveBeenCalledOnce();
    expect(mocks.prompts).not.toHaveBeenCalled();
  });

  it('preserves the saved TUI preference when WebUI pins the current launch to REPL', async () => {
    const input = fixture({ isInteractiveTTY: true, flags: { webui: true, 'no-tui': true } });
    await applyBootLaunchChoices(input);
    expect(input.flags).toMatchObject({ tui: false, autonomy: 'off' });
    expect(mocks.persist).toHaveBeenCalledWith(
      'profile.json',
      { mode: 'tui', yolo: false, autonomy: 'off' },
      { rememberStartupChoices: undefined },
    );
  });

  it('forwards launch.rememberStartupChoices (default on) to both startup gates', async () => {
    await applyBootLaunchChoices(fixture({ isInteractiveTTY: true }));
    expect(mocks.menu).toHaveBeenLastCalledWith(expect.objectContaining({ reuseLast: true }));
    expect(mocks.prompts).toHaveBeenLastCalledWith(expect.objectContaining({ reuseLast: true }));

    const off = fixture({
      isInteractiveTTY: true,
      config: {
        yolo: false,
        launch: { mode: 'tui', autonomy: 'auto', rememberStartupChoices: false },
      },
    });
    await applyBootLaunchChoices(off);
    expect(mocks.menu).toHaveBeenLastCalledWith(expect.objectContaining({ reuseLast: false }));
    expect(mocks.prompts).toHaveBeenLastCalledWith(expect.objectContaining({ reuseLast: false }));
  });

  it('offers to stop asking only when reuse is off and a question was asked', async () => {
    const offConfig = () => ({
      yolo: false,
      launch: { mode: 'tui' as const, autonomy: 'auto' as const, rememberStartupChoices: false },
    });

    // Reuse on (default) → never offered.
    mocks.stopAsking.mockClear();
    await applyBootLaunchChoices(fixture({ isInteractiveTTY: true }));
    expect(mocks.stopAsking).not.toHaveBeenCalled();

    // Reuse off, launch gate asked, user says yes → persisted + live config on.
    mocks.stopAsking.mockResolvedValueOnce(true);
    const yes = await applyBootLaunchChoices(
      fixture({ isInteractiveTTY: true, config: offConfig() }),
    );
    expect(mocks.stopAsking).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenLastCalledWith('profile.json', expect.anything(), {
      rememberStartupChoices: true,
    });
    expect(yes).toMatchObject({ config: { launch: { rememberStartupChoices: true } } });

    // Reuse off but every launch field flag-pinned and no prompt menu → nothing asked.
    mocks.stopAsking.mockClear();
    await applyBootLaunchChoices(
      fixture({
        isInteractiveTTY: true,
        config: offConfig(),
        flags: { tui: true, yolo: true, autonomy: 'auto' },
      }),
    );
    expect(mocks.stopAsking).not.toHaveBeenCalled();
  });

  it('continues launching when preference persistence fails', async () => {
    mocks.persist.mockRejectedValue(new Error('read only'));
    expect(await applyBootLaunchChoices(fixture({ isInteractiveTTY: true }))).toMatchObject({
      kind: 'ok',
    });
  });
});
