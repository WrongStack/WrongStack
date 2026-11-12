import { toErrorMessage } from '@wrongstack/core/utils';
import { useEffect } from 'react';
import type { Settings } from '../app-state.js';
import {
  formatAllSettingsSummary,
  getSettingsFieldValue,
  resetSettingsFieldValue,
  resolveSettingsFieldValue,
  settingsPickerJumpByName,
  settingsPickerJumpNames,
} from '../components/settings-picker.js';
import { STATUSLINE_ITEMS, type StatuslineItem } from '../components/statusline-picker.js';
import {
  getRuntimeGraphicsOverride,
  parseRuntimeGraphicsMode,
  setRuntimeGraphicsOverride,
} from '../graphics/image-preview-cache.js';
import type { SettingsPickerPatch } from '../settings-contracts.js';
import { registerSlashCommandLifecycle } from '../slash-command-lifecycle.js';
import { THEME_OPTIONS } from '../theme.js';
import { coercePanelPositionMap, hasPanelRoutedToSidebar } from '../ui-contracts.js';
import type { TuiSlashCommandOptions } from './tui-slash-command-options.js';

/** Which slice of the settings-domain commands this call registers. */
export type SettingsSlashPart = 'core' | 'appearance';

function settingsWithPatch(current: Settings, patch: SettingsPickerPatch): Settings {
  const { tokenSavingTier, fleetChat, panelPositions, ...rest } = patch;
  const positions = { ...coercePanelPositionMap(current.panelPositions), ...panelPositions };
  if (rest.showAgentSwarmPanel !== undefined) {
    positions.fleet = rest.showAgentSwarmPanel === 'sidebar' ? 'sidebar' : 'bottom';
  }
  return {
    ...current,
    ...rest,
    panelPositions: positions,
    ...(tokenSavingTier !== undefined ? { featureTokenSaving: tokenSavingTier } : {}),
    ...(fleetChat !== undefined ? { fleetChatVerbosity: fleetChat } : {}),
    ...(hasPanelRoutedToSidebar(positions) ? { showSidebar: true } : {}),
  };
}

/**
 * Settings-domain slash commands (/settings, /settings-get, /statusline,
 * /lite, /full, /theme), moved verbatim from useTuiSlashCommands
 * (decomposition Phase 2 — docs/decomposition-plan.md).
 *
 * `part` selects which slice of the domain registers at this call site, so
 * the parent can interleave the domains and preserve the pinned 23-command
 * registration order (tests/slash-registration-enumeration.test.ts):
 * 'core' → /settings, /settings-get, /statusline, /lite, /full (positions
 * 5–9), 'appearance' → /theme (position 22). `part` is a constant literal
 * per call site, so hook order is stable; non-selected parts return early
 * without registering.
 *
 * Membership delta recorded per decision D2: /theme rides with this slice
 * (settings-adjacent appearance command; position 22 sits inside the
 * resource run, but the resource slice's last member is /prompts at 21).
 */
export function useSettingsSlashCommands(
  deps: TuiSlashCommandOptions,
  part: SettingsSlashPart,
): void {
  const {
    slashRegistry,
    getSettings,
    saveSettings,
    openSettings,
    dispatch,
    state,
    hiddenItemsRef,
    setHiddenItems,
    openStatuslinePicker,
    applyThemePreset,
  } = deps;

  // Register the TUI-only `/settings` command — opens the interactive
  // SettingsPicker immediately, same as Ctrl+S. Accepts an optional
  // row-name argument that jumps the picker to that row on open
  // (e.g. `/settings multi-diff` → opens the picker on the multi-diff
  // summary row). Gated on the settings accessors being wired by the
  // host (CLI passes them in).
  useEffect(() => {
    if (part !== 'core') return;
    if (!getSettings || !saveSettings) return;
    const persist = async (patch: SettingsPickerPatch): Promise<string | null> => {
      try {
        return await saveSettings(settingsWithPatch(getSettings(), patch));
      } catch (error) {
        return `Could not save settings: ${toErrorMessage(error)}`;
      }
    };
    // The host's text `/settings` this command displaces. Settings that have
    // no picker row (the free-form `limits` block) are delegated to it.
    const hostSettings = slashRegistry.get('settings');
    const cmd = {
      name: 'settings',
      aliases: ['config', 'prefs'],
      description:
        'Open the settings editor, or set a value inline: /settings [<chord> [<value>]].',
      argsHint: '[<chord> [<value>]]',
      help:
        'Open the settings editor.\n\n' +
        '  /settings              Open on the last-visited row\n' +
        '  /settings <chord>      Open on that row\n' +
        '  /settings <chord> <v>  Set <chord> to <v> without opening the picker\n' +
        '  /settings reset <chord> Reset <chord> to its factory default\n' +
        '  /settings limits [<name> <n|off>]  View or set your own limits (unset = no limit)\n\n' +
        'Examples:\n' +
        '  /settings yolo on      Enable YOLO mode\n' +
        '  /settings multi-diff 8  Set multi-diff threshold to 8\n' +
        '  /settings thinking-word pondering  Set the working-state word\n\n' +
        'Available chords:\n  ' +
        settingsPickerJumpNames().join('\n  '),
      async run(args: string) {
        const query = args.trim();
        if (query === 'jev' || query.startsWith('jev ')) {
          const jev = slashRegistry.get('jev');
          return jev
            ? await jev.run(query.slice(3).trim())
            : { message: 'Jev settings unavailable on this host.' };
        }
        if (query === '') {
          openSettings();
          return { message: undefined };
        }
        if ((query === 'limits' || query.startsWith('limits ')) && hostSettings) {
          return await hostSettings.run(query);
        }

        // `/settings reset <chord>` — reset a field to its factory default.
        if (query === 'reset' || query.startsWith('reset ')) {
          const subArg = query.slice('reset'.length).trim();
          if (subArg === '') {
            return {
              message:
                'Usage: /settings reset <chord>\nAvailable: ' +
                settingsPickerJumpNames().join(', '),
            };
          }
          if (subArg.toLowerCase() === 'graphics') {
            setRuntimeGraphicsOverride('auto');
            return { message: '↺ Terminal graphics reset to auto' };
          }
          const field = settingsPickerJumpByName(subArg);
          if (field === undefined) {
            return {
              message:
                `Unknown settings row "${subArg}".\n` +
                `Available chords:\n  ${settingsPickerJumpNames().join('\n  ')}`,
            };
          }
          const result = resetSettingsFieldValue(field);
          if (!result.ok) {
            return { message: result.error };
          }
          dispatch({ type: 'settingsValueSet', patch: result.patch });
          const error = await persist(result.patch);
          if (error) return { message: `Applied for this session, but not saved: ${error}` };
          return { message: `↺ ${result.label} reset to ${result.displayValue}` };
        }

        // Check for `<chord> <value>` syntax — a space separates the
        // row name from the value. Everything after the first space is
        // the value (allows multi-word values like "thinking-word").
        const spaceIdx = query.indexOf(' ');
        if (spaceIdx > 0) {
          const rowName = query.slice(0, spaceIdx);
          const valueStr = query.slice(spaceIdx + 1).trim();
          if (rowName.toLowerCase() === 'graphics') {
            const parsed = parseRuntimeGraphicsMode(valueStr);
            if (!parsed) {
              return {
                message: `Invalid graphics mode "${valueStr}". Expected: auto | kitty | iterm2 | halfblock | off`,
              };
            }
            setRuntimeGraphicsOverride(parsed);
            return { message: `✓ Terminal graphics → ${parsed}` };
          }
          const field = settingsPickerJumpByName(rowName);
          if (field === undefined) {
            return {
              message:
                `Unknown settings row "${rowName}".\n` +
                `Available chords:\n  ${settingsPickerJumpNames().join('\n  ')}`,
            };
          }
          if (valueStr === '') {
            // Trailing space but no value — fall back to navigation.
            openSettings();
            dispatch({ type: 'settingsFieldSet', field });
            return { message: undefined };
          }

          const result = resolveSettingsFieldValue(field, valueStr);
          if (!result.ok) {
            return { message: result.error };
          }

          // Pin rule: refuse `sidebar off` while any panel routes to the
          // sidebar — that rail is the panel's only home. The reducer
          // clamps the runtime state too (see `reducers/settings-values.ts`),
          // but this early return also keeps the raw `false` out of the
          // config write below, so a save flight can never persist the
          // orphaning value past the next read-time coercion.
          if (result.patch.showSidebar === false) {
            const curRouting = getSettings ? getSettings() : undefined;
            if (
              hasPanelRoutedToSidebar(
                curRouting?.panelPositions,
                curRouting?.showAgentSwarmPanel === 'sidebar',
              )
            ) {
              return {
                message:
                  '✗ Sidebar pinned on — a panel is routed to the sidebar. Set it to bottom first (/settings fleet bottom).',
              };
            }
          }

          // 1. Update runtime state so the picker (if opened later)
          //    reflects the change immediately.
          dispatch({ type: 'settingsValueSet', patch: result.patch });

          // 2. Persist to the canonical Settings shape. The auto-save
          //    effect only fires while the picker is open, so we do it
          //    manually here, mapping picker aliases and merging panel positions.
          const error = await persist(result.patch);
          if (error) return { message: `Applied for this session, but not saved: ${error}` };

          return { message: `✓ ${result.label} → ${result.displayValue}` };
        }

        // Single token: navigation mode (open picker on that row).
        if (query.toLowerCase() === 'graphics') {
          return { message: `Terminal graphics: ${getRuntimeGraphicsOverride()}` };
        }
        const field = settingsPickerJumpByName(query);
        if (field === undefined) {
          return {
            message:
              `Unknown settings row "${query}".\n` +
              `Available chords:\n  ${settingsPickerJumpNames().join('\n  ')}`,
          };
        }
        openSettings();
        dispatch({ type: 'settingsFieldSet', field });
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /settings command. Without this, only Ctrl+S could open the picker.
    const unregisterSettings = registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
    const unregisterSystemPrompt = registerSlashCommandLifecycle(
      slashRegistry,
      {
        name: 'system-prompt',
        description: 'Choose the system prompt for the next launch (opens the selector).',
        argsHint: '[lite|standard|pro|scout|quick]',
        help:
          '/system-prompt opens Settings on the System prompt row.\n' +
          '/system-prompt <variant> saves a choice directly.\n' +
          'Restart WrongStack to apply it; the status badge shows the running prompt.\n' +
          'Before launching, use wstack --system-prompt <variant> (standard = default).',
        async run(args: string) {
          const field = settingsPickerJumpByName('system-prompt');
          if (field === undefined) return { message: 'System prompt selector unavailable.' };
          if (!args.trim()) {
            openSettings();
            dispatch({ type: 'settingsFieldSet', field });
            return {
              message:
                'Choose the system prompt for the next launch. Restart WrongStack to apply it; the status badge still shows this session’s running prompt.',
            };
          }
          const result = resolveSettingsFieldValue(field, args.trim());
          if (!result.ok) return { message: result.error };
          const error = await persist(result.patch);
          if (error) return { message: `Could not save system prompt: ${error}` };
          dispatch({ type: 'settingsValueSet', patch: result.patch });
          return {
            message: `Saved for the next launch: ${result.displayValue}. Restart WrongStack to apply it; this session’s prompt is unchanged.`,
          };
        },
      },
      { owner: 'tui', official: true },
    );
    return () => {
      unregisterSystemPrompt();
      unregisterSettings();
    };
  }, [part, slashRegistry, getSettings, saveSettings, openSettings, dispatch]);

  // Register the TUI-only `/settings-get` command — reads a setting's
  // current value and displays it as a chat message without opening the
  // picker. Counterpart to `/settings <chord> <value>`.
  useEffect(() => {
    if (part !== 'core') return;
    const cmd = {
      name: 'settings-get',
      aliases: ['config-get', 'get'],
      description: 'Read a setting value without opening the picker.',
      argsHint: '<chord>',
      help:
        'Show the current value of a setting.\n\n' +
        'Examples:\n' +
        '  /settings-get yolo         → "YOLO mode: off"\n' +
        '  /settings-get multi-diff   → "Multi-diff summary: 5"\n' +
        '  /settings-get log-level    → "Log level: info"\n\n' +
        'Available chords:\n  ' +
        settingsPickerJumpNames().join('\n  '),
      async run(args: string) {
        const query = args.trim();
        if (query === 'jev' || query.startsWith('jev ')) {
          const jev = slashRegistry.get('jev');
          return jev
            ? await jev.run(query.slice(3).trim())
            : { message: 'Jev settings unavailable on this host.' };
        }
        if (query === '') {
          // No argument: show all settings as a compact grouped summary.
          return { message: formatAllSettingsSummary(state.settingsPicker) };
        }
        if (query.toLowerCase() === 'graphics') {
          return { message: `Terminal graphics: ${getRuntimeGraphicsOverride()}` };
        }
        const field = settingsPickerJumpByName(query);
        if (field === undefined) {
          return {
            message:
              `Unknown settings row "${query}".\n` +
              `Available chords:\n  ${settingsPickerJumpNames().join('\n  ')}`,
          };
        }
        const result = getSettingsFieldValue(state.settingsPicker, field);
        if (!result.ok) {
          return { message: result.error };
        }
        return { message: `${result.label}: ${result.displayValue}` };
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [part, slashRegistry, state.settingsPicker]);

  // Register the TUI-only `/statusline` command — opens the interactive
  // StatuslinePicker overlay. Arguments (item, on|off) are handled here too
  // because official TUI commands do not fall through to the CLI builtin.
  useEffect(() => {
    if (part !== 'core') return;
    const cmd = {
      name: 'statusline',
      aliases: ['sl'],
      description:
        'Customize status bar chips: /statusline (interactive) or /statusline <item> [on|off]',
      async run(args: string) {
        const trimmed = args.trim();
        if (trimmed) {
          const [rawItem, rawAction] = trimmed.split(/\s+/);
          const item = rawItem as StatuslineItem | 'all' | 'reset' | undefined;
          const action = rawAction?.toLowerCase();
          const applyHidden = (items: StatuslineItem[]) => {
            const deduped = [...new Set(items)];
            hiddenItemsRef.current = deduped;
            setHiddenItems(deduped);
          };

          if (item === 'reset') {
            applyHidden([]);
            return { message: 'StatusBar config reset to defaults.' };
          }

          if (item === 'all') {
            if (action !== 'on' && action !== 'off') {
              return { message: 'Usage: /statusline all on|off' };
            }
            applyHidden(action === 'off' ? [...STATUSLINE_ITEMS] : []);
            return {
              message: `statusline all: ${action === 'on' ? 'showing all chips' : 'hiding all chips'}`,
            };
          }

          if (!item || !STATUSLINE_ITEMS.includes(item as StatuslineItem)) {
            return {
              message: `Unknown item "${rawItem ?? ''}". Run /statusline to see available items.`,
            };
          }

          if (action !== undefined && action !== 'on' && action !== 'off') {
            return { message: `Usage: /statusline ${item} on|off` };
          }

          const hidden = new Set<StatuslineItem>(hiddenItemsRef.current);
          const nextVisible = action ? action === 'on' : hidden.has(item);
          if (nextVisible) hidden.delete(item);
          else hidden.add(item);
          applyHidden([...hidden]);
          return { message: `statusline ${item}: ${nextVisible ? 'on' : 'off'}` };
        }
        openStatuslinePicker();
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /statusline command when called without arguments.
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [part, slashRegistry, openStatuslinePicker, setHiddenItems]);

  // Register the TUI-only `/lite` and `/full` commands — one-key layout
  // presets. `/lite` collapses the chrome (statusline density 'minimum' +
  // right sidebar hidden) so chat history takes the full terminal width;
  // `/full` restores it (statusline 'detailed' + sidebar visible). Both
  // persist through the same dispatch + saveSettings path as
  // `/settings <chord> <value>`, so the change survives restarts and the
  // open settings picker tracks it live.
  useEffect(() => {
    if (part !== 'core') return;
    if (!getSettings || !saveSettings) return;
    const applyLayoutPreset = async (
      statuslineMode: 'minimum' | 'detailed',
      showSidebar: boolean,
    ): Promise<string> => {
      // Pin rule: the sidebar is a routed panel's only home, so /lite's
      // "hide the sidebar" step is clamped to "keep it visible" whenever
      // any panel routes there. The persisted config is the same dual
      // source `resolveAppSidebarLayout` reads while the picker is closed.
      const cur = getSettings();
      const sidebarPinned = hasPanelRoutedToSidebar(
        cur?.panelPositions,
        cur?.showAgentSwarmPanel === 'sidebar',
      );
      const sidebarOn = showSidebar || sidebarPinned;
      const patch = { statuslineMode, showSidebar: sidebarOn };
      dispatch({ type: 'settingsValueSet', patch });
      if (cur) {
        try {
          const err = await saveSettings({ ...cur, ...patch });
          if (err) dispatch({ type: 'settingsHint', text: err });
        } catch {
          // Mirrors the /settings save guard: a rejected persistence
          // (Windows EBUSY when a second wstack holds the config) must
          // not kill the TUI — the runtime state is already updated.
          dispatch({ type: 'settingsHint', text: 'Could not save settings.' });
        }
      }
      if (showSidebar) return `✓ Full layout: statusline detailed, sidebar on.`;
      return sidebarPinned
        ? `✓ Lite layout: statusline minimum, sidebar kept on (a panel is routed to the sidebar).`
        : `✓ Lite layout: statusline minimum, sidebar off.`;
    };
    const liteCmd = {
      name: 'lite',
      description: 'Minimal chrome: statusline density → minimum and the right sidebar hidden.',
      help:
        'Switch to the lite layout.\n\n' +
        '  statusline density → minimum (single rail)\n' +
        '  right sidebar → hidden (full-width history)\n\n' +
        'Reverse with /full.',
      async run() {
        return { message: await applyLayoutPreset('minimum', false) };
      },
    };
    const fullCmd = {
      name: 'full',
      description: 'Full chrome: statusline density → detailed and the right sidebar visible.',
      help:
        'Switch to the full layout.\n\n' +
        '  statusline density → detailed (multi-line bar)\n' +
        '  right sidebar → visible\n\n' +
        'Reverse with /lite.',
      async run() {
        return { message: await applyLayoutPreset('detailed', true) };
      },
    };
    const teardownLite = registerSlashCommandLifecycle(slashRegistry, liteCmd, {
      owner: 'tui',
      official: true,
    });
    const teardownFull = registerSlashCommandLifecycle(slashRegistry, fullCmd, {
      owner: 'tui',
      official: true,
    });
    return () => {
      teardownLite();
      teardownFull();
    };
  }, [part, slashRegistry, getSettings, saveSettings, dispatch]);

  useEffect(() => {
    if (part !== 'appearance') return;
    // Register the TUI-only `/theme` command — opens an interactive theme picker
    // that switches the active palette and persists the choice to configStore.
    //
    // The picker is opened by dispatching `themePickerOpen`. Picking an option
    // and pressing Enter is handled by `use-picker-keys.ts` (Enter on the active
    // row calls `setActiveTheme()` and writes `themePreset` via configStore).
    //
    // Registered as a TUI-owned official command so it overrides the CLI's
    // text-only `/theme <preset>` shortcut — bare `/theme` in the TUI must
    // always open the picker, never echo the option list.
    const cmd = {
      name: 'theme',
      description: 'Pick a TUI color theme preset interactively (picker).',
      argsHint: '[preset]',
      help:
        'Usage:\n' +
        '  /theme                Open the interactive theme picker\n' +
        '  /theme <preset>       Apply a preset directly (e.g. catppuccin, tokyo-night)\n\n' +
        'Available presets: catppuccin, tokyo-night, nord, cyberpunk, dracula',
      async run(args: string) {
        const arg = (args ?? '').trim();
        if (arg) {
          const preset = arg.toLowerCase();
          const presetIdx = THEME_OPTIONS.findIndex((o) => o.id === preset);
          if (presetIdx < 0) {
            const names = THEME_OPTIONS.map((o) => o.id).join(', ');
            return {
              message: `Unknown theme preset "${arg}". Available: ${names}`,
            };
          }
          // Direct apply — a fully-specified argument means the user already
          // knows which preset they want, so honour it immediately instead of
          // making them confirm with Enter. This is what the CLI has always
          // done for the same argument, and the two surfaces diverging on it
          // was a papercut: the TUI's own help text already promised
          // "Apply a preset directly".
          //
          // `applyThemePreset` is absent only when the host wired no theme
          // persistence; fall back to the old preselect behaviour there so the
          // command still does something useful.
          if (applyThemePreset) {
            applyThemePreset(THEME_OPTIONS[presetIdx]!.id);
            return { message: undefined };
          }
          dispatch({ type: 'themePickerOpen', selected: presetIdx });
          return { message: undefined };
        }
        dispatch({ type: 'themePickerOpen' });
        return { message: undefined };
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [part, slashRegistry, dispatch]);
}
