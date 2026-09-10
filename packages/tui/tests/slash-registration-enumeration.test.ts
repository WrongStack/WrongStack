// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { State } from '../src/app-state.js';
import { useTuiSlashCommands } from '../src/hooks/use-tui-slash-commands.js';

/**
 * TUI decomposition Phase 0.4 (docs/decomposition-plan.md, decision D3):
 * pins the exact set and ORDER of slash commands `useTuiSlashCommands`
 * registers (owner 'tui', official), and that unmount tears every one of
 * them down. Phase 2 splits this hook into 5 slice hooks; the slices must
 * register in exactly this order under the same-signature parent.
 *
 * Order verified against the hook body on 2026-09-10 (L103–933): one
 * useEffect per concern; /lite+/full share one effect; the resource-menu
 * effect registers 7 wrapper commands in a loop; cron/prompts in another.
 */

/** Records bare command names in exact registration call order. */
function makeRecordingRegistry() {
  const registered: string[] = [];
  const unregisterCalls: string[] = [];
  const owners: Array<{ name: string; owner: string; official: boolean }> = [];
  const cmds = new Map<string, { name: string }>();
  const registry = {
    register(
      cmd: { name: string; aliases?: string[] },
      owner: string,
      opts?: { official?: boolean },
    ) {
      registered.push(cmd.name);
      owners.push({ name: cmd.name, owner, official: opts?.official ?? false });
      cmds.set(cmd.name, cmd);
      for (const alias of cmd.aliases ?? []) cmds.set(alias, cmd);
    },
    unregister(name: string) {
      unregisterCalls.push(name);
      return cmds.delete(name);
    },
    get(name: string) {
      return cmds.get(name);
    },
    ownerOf(name: string) {
      return cmds.has(name) ? 'tui' : undefined;
    },
    list() {
      return [...cmds.values()];
    },
  };
  return {
    registry: registry as never as SlashCommandRegistry,
    registered,
    unregisterCalls,
    owners,
  };
}

/** Stub options, type-loose by design (cast at the hook boundary): the contract under test is runtime registration order/teardown, not stub typing. */
function makeOptions(registry: SlashCommandRegistry) {
  return {
    slashRegistry: registry,
    skillLoader: {
      find: vi.fn(),
      readBody: vi.fn(),
      listEntries: vi.fn(async () => []),
      list: vi.fn(async () => []),
      manifestText: vi.fn(async () => ''),
      readSaveBody: vi.fn(async () => ''),
      invalidateCache: vi.fn(),
    },
    getResourceMenu: vi.fn(async () => null),
    getPickableProviders: vi.fn(() => []),
    switchProviderAndModel: vi.fn(),
    openModelPicker: vi.fn(async () => {}),
    openFKeyPicker: vi.fn(),
    projectRoot: '/proj',
    agent: { ctx: {} } as never,
    dispatch: vi.fn(),
    // Registration gates only check truthiness of these accessors; vi.fn()
    // instances are truthy, which is what mounts every gated effect.
    getSettings: vi.fn(() => undefined),
    saveSettings: vi.fn(async () => null),
    openSettings: vi.fn(),
    state: { settingsPicker: {} } as never as State,
    openStatuslinePicker: vi.fn(),
    setHiddenItems: vi.fn(),
    hiddenItemsRef: { current: [] },
    setMailboxPanelOpen: vi.fn(),
    switchAutonomy: vi.fn(),
    listSessions: vi.fn(async () => []),
    openPromptPicker: vi.fn(async () => {}),
  };
}

const EXPECTED_REGISTRATION_ORDER = [
  'solo',
  'model',
  'f',
  'design',
  'settings',
  'settings-get',
  'statusline',
  'lite',
  'full',
  'mailbox',
  'autonomy',
  'skill',
  'fallback',
  'tier',
  'profile',
  'provider-status',
  'memory',
  'worktree',
  'git',
  'cron',
  'prompts',
  'theme',
  'resume',
];

describe('useTuiSlashCommands registration enumeration (decomposition Phase 0.4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers exactly the TUI-owned commands, in body order, as official tui plugins', () => {
    const { registry, registered, owners } = makeRecordingRegistry();
    const options = makeOptions(registry);

    const { unmount } = renderHook(() => useTuiSlashCommands(options as never));
    expect(registered).toEqual(EXPECTED_REGISTRATION_ORDER);
    for (const entry of owners) {
      expect(entry.owner).toBe('tui');
      expect(entry.official).toBe(true);
    }
    unmount();
  });

  it('tears down every TUI-owned command on unmount', () => {
    const { registry, registered, unregisterCalls } = makeRecordingRegistry();
    const options = makeOptions(registry);

    const { unmount } = renderHook(() => useTuiSlashCommands(options as never));
    expect(registered).toHaveLength(EXPECTED_REGISTRATION_ORDER.length);
    unmount();
    for (const name of EXPECTED_REGISTRATION_ORDER) {
      expect(unregisterCalls).toContain(name);
    }
  });
});
