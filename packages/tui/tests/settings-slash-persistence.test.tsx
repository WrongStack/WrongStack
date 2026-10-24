import type { SlashCommand } from '@wrongstack/contracts/types';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { render } from 'ink-testing-library';
import { expect, it, vi } from 'vitest';
import type { Action } from '../src/app-action-type.js';
import { reducer } from '../src/app-reducer.js';
import type { Settings } from '../src/app-state.js';
import type { TuiSlashCommandOptions } from '../src/hooks/tui-slash-command-options.js';
import { useSettingsSlashCommands } from '../src/hooks/use-settings-slash-commands.js';
import { DEFAULT_PANEL_POSITIONS } from '../src/ui-contracts.js';
import { createTestState } from './helpers/create-test-state.js';
import { settle } from './helpers/real-tty.js';

async function harness(hostSettings?: SlashCommand) {
  const registry = new SlashCommandRegistry();
  // The CLI registers its text /settings first; the TUI command displaces it.
  if (hostSettings) registry.register(hostSettings);
  let state = createTestState();
  let persisted = {
    ...state.settingsPicker,
    fleetChatVerbosity: 'off',
    featureTokenSaving: 'off',
    lastSettingsField: 30,
    panelPositions: { ...DEFAULT_PANEL_POSITIONS, fleet: 'sidebar', agents: 'sidebar' },
  } as Settings;
  const save = vi.fn(async (next: Settings) => {
    persisted = next;
    return null as string | null;
  });
  const dispatch = (action: Action) => {
    state = reducer(state, action);
  };
  function Harness() {
    useSettingsSlashCommands(
      {
        slashRegistry: registry,
        state,
        getSettings: () => persisted,
        saveSettings: save,
        dispatch,
        openSettings: () =>
          dispatch({
            ...state.settingsPicker,
            type: 'settingsOpen',
            lastSettingsField: 30,
          } as Action),
      } as unknown as TuiSlashCommandOptions,
      'core',
    );
    return null;
  }
  const view = render(<Harness />);
  await settle();
  return {
    view,
    save,
    state: () => state,
    persisted: () => persisted,
    run: (args: string) => registry.get('settings')!.run(args, {} as never),
  };
}

it('explicit row navigation wins over a persisted last-visited row', async () => {
  const h = await harness();
  try {
    await h.run('yolo');
    expect(h.state().settingsPicker.field).toBe(3);
  } finally {
    h.view.unmount();
  }
});

it.each(['connections-placement sidebar', 'reset connections-placement'])(
  'preserves other panel positions while applying %s',
  async (args) => {
    const h = await harness();
    try {
      await h.run(args);
      await settle();
      expect(h.persisted().panelPositions?.fleet).toBe('sidebar');
      expect(h.persisted().panelPositions?.agents).toBe('sidebar');
    } finally {
      h.view.unmount();
    }
  },
);

it('persists Fleet chat under the canonical Settings key', async () => {
  const h = await harness();
  try {
    await h.run('fleet-chat full');
    await settle();
    expect(h.persisted().fleetChatVerbosity).toBe('full');
  } finally {
    h.view.unmount();
  }
});

it('reports an inline persistence failure in the command result', async () => {
  const h = await harness();
  try {
    h.save.mockRejectedValueOnce(new Error('Disk unavailable'));
    const result = await h.run('yolo on');
    expect(result?.message).toContain('Disk unavailable');
  } finally {
    h.view.unmount();
  }
});

it('delegates /settings limits to the host command it displaced', async () => {
  const hostRun = vi.fn(async (args: string) => ({ message: `host:${args}` }));
  const h = await harness({ name: 'settings', description: 'host settings', run: hostRun });
  try {
    await expect(h.run('limits')).resolves.toEqual({ message: 'host:limits' });
    await expect(h.run('limits history-messages 400')).resolves.toEqual({
      message: 'host:limits history-messages 400',
    });
    expect(h.save).not.toHaveBeenCalled();
  } finally {
    h.view.unmount();
  }
});
