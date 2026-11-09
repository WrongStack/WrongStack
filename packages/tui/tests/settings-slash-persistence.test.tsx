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
    registry,
    state: () => state,
    persisted: () => persisted,
    run: (args: string) => registry.get('settings')!.run(args, {} as never),
  };
}

it('/system-prompt opens the prompt row without changing the running prompt', async () => {
  const h = await harness();
  try {
    const command = h.registry.get('system-prompt');
    expect(command).toBeDefined();
    const result = await command?.run('', {} as never);
    expect(h.state().settingsPicker.open).toBe(true);
    expect(h.state().settingsPicker.field).toBe(66);
    expect(h.save).not.toHaveBeenCalled();
    expect(result?.message).toContain('next launch');
    h.view.unmount();
    expect(h.registry.get('system-prompt')).toBeUndefined();
  } finally {
    h.view.unmount();
  }
});

it.each(['lite', 'standard', 'pro', 'scout', 'quick'])(
  '/system-prompt %s saves the next-launch choice',
  async (variant) => {
    const h = await harness();
    try {
      const command = h.registry.get('system-prompt');
      expect(command).toBeDefined();
      const result = await command?.run(variant, {} as never);
      expect(h.persisted().nextSystemPromptVariant).toBe(
        variant === 'standard' ? 'default' : variant,
      );
      expect(result?.message).toContain('next launch');
    } finally {
      h.view.unmount();
    }
  },
);

it('/system-prompt rejects unknown variants and reports save errors', async () => {
  const h = await harness();
  try {
    const command = h.registry.get('system-prompt');
    expect(command).toBeDefined();
    await command?.run('unknown', {} as never);
    expect(h.save).not.toHaveBeenCalled();
    h.save.mockRejectedValueOnce(new Error('Disk unavailable'));
    const result = await command?.run('pro', {} as never);
    expect(result?.message).toContain('Disk unavailable');
    expect(result?.message).not.toContain('Saved for the next launch');
  } finally {
    h.view.unmount();
  }
});

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
