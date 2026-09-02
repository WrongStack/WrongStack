import {
  applyTokenOverrides,
  clearActiveKit,
  clearPersistedActiveKit,
  getDesignKitLoader,
  isDesignStack,
  loadActiveKit,
  materializeTokens,
  recordOverrides,
  resolveSemanticTune,
  setActiveKit,
  setDesignOverrides,
} from '@wrongstack/core/design';
import { SKILL_LIMITS, stripFrontmatter } from '@wrongstack/core/skills';
import {
  areSubagentsAllowed,
  isSubagentPolicyLocked,
  setSessionSubagentsAllowed,
} from '@wrongstack/core/coordination';
import { toErrorMessage } from '@wrongstack/core/utils';
import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import type { Settings, State } from '../app-state.js';
import { AUTONOMY_OPTIONS } from '../components/autonomy-picker.js';
import { registerSlashCommandLifecycle } from '../slash-command-lifecycle.js';
import {
  formatAllSettingsSummary,
  getSettingsFieldValue,
  resetSettingsFieldValue,
  resolveSettingsFieldValue,
  settingsPickerJumpByName,
  settingsPickerJumpNames,
} from '../components/settings-picker.js';
import { STATUSLINE_ITEMS, type StatuslineItem } from '../components/statusline-picker.js';
import { THEME_OPTIONS } from '../theme.js';

/**
 * Sessions `/resume` asks the host for.
 *
 * It used to ask for 20 — a page size, on a picker that has been fully
 * windowed and scrollable the whole time (`ResumePicker` → `useWindowedPicker`,
 * rowSpan 3). So the scrolling worked and there was simply nothing under it:
 * everything older than the last twenty sessions was unreachable, with no
 * indication that a list had been cut.
 *
 * A ceiling rather than "everything" because the picker is a list the user
 * arrows through, and the host still enriches crashed-session stubs behind it.
 * It is sized to cover a real history instead of a page of one: measured on
 * this corpus, the whole catalog is 219 sessions and listing all of it costs
 * 2 ms.
 */
const RESUME_PICKER_SESSIONS = 500;

interface TuiSlashCommandOptions {
  slashRegistry: AppProps['slashRegistry'];
  skillLoader: AppProps['skillLoader'];
  getResourceMenu: AppProps['getResourceMenu'];
  getPickableProviders: AppProps['getPickableProviders'];
  switchProviderAndModel: AppProps['switchProviderAndModel'];
  openModelPicker: () => Promise<void>;
  openFKeyPicker: () => void;
  projectRoot: string;
  agent: AppProps['agent'];
  dispatch: Dispatch<Action>;
  getSettings: AppProps['getSettings'];
  saveSettings: AppProps['saveSettings'];
  openSettings: () => void;
  state: State;
  openStatuslinePicker: () => void;
  setHiddenItems: (items: StatuslineItem[]) => void;
  hiddenItemsRef: MutableRefObject<StatuslineItem[]>;
  setMailboxPanelOpen: Dispatch<SetStateAction<boolean>>;
  switchAutonomy: AppProps['switchAutonomy'];
  listSessions: AppProps['listSessions'];
  openPromptPicker: () => Promise<void>;
}

/** Registers TUI-owned slash commands and releases them on dependency changes. */
export function useTuiSlashCommands({
  slashRegistry,
  skillLoader,
  getResourceMenu,
  getPickableProviders,
  switchProviderAndModel,
  openModelPicker,
  openFKeyPicker,
  projectRoot,
  agent,
  dispatch,
  getSettings,
  saveSettings,
  openSettings,
  state,
  openStatuslinePicker,
  setHiddenItems,
  hiddenItemsRef,
  setMailboxPanelOpen,
  switchAutonomy,
  listSessions,
  openPromptPicker,
}: TuiSlashCommandOptions): void {
  useEffect(() => {
    const cmd = {
      name: 'solo',
      description: 'Control session-only subagents before the first message: /solo on|off|status.',
      async run(args: string) {
        const action = (args ?? '').trim().toLowerCase() || 'status';
        const allowed = areSubagentsAllowed(agent.ctx);
        if (action === 'status') {
          return {
            message: `Solo session is ${allowed ? 'off' : 'on'}${isSubagentPolicyLocked(agent.ctx) ? ' (locked)' : ''}.`,
          };
        }
        if (action !== 'on' && action !== 'off') {
          return { message: 'Usage: /solo on|off|status' };
        }
        try {
          await setSessionSubagentsAllowed(agent.ctx, action === 'off');
          return {
            message:
              action === 'on'
                ? 'Solo session enabled. Chimera, delegation, and background subagents are blocked.'
                : 'Solo session disabled. Subagents are allowed for this session.',
          };
        } catch (err) {
          return { message: toErrorMessage(err) };
        }
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [agent, slashRegistry]);

  // Register the TUI-only `/model` command — opens a two-step picker
  // (provider → model). All work is local state mutation; the actual
  // switch fires only after the user confirms a model in step 2.
  useEffect(() => {
    if (!getPickableProviders || !switchProviderAndModel) return;
    const cmd = {
      name: 'model',
      aliases: ['provider', 'switch'],
      description: 'Pick a provider + model interactively (two-step).',
      async run() {
        await openModelPicker();
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it can override a CLI built-in
    // of the same name (owner='tui' + official=true → claims the bare name).
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry, getPickableProviders, switchProviderAndModel, openModelPicker]);

  // Register the TUI-only `/f` command — opens the keyboard-navigable F-key panel picker.
  useEffect(() => {
    const cmd = {
      name: 'f',
      description: 'Open F-key panel picker. Arrow keys to navigate, Enter to open, Esc to close.',
      async run() {
        openFKeyPicker();
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /f command. Without this, only /f 1..12 would work.
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry, openFKeyPicker]);

  // Register the TUI-only `/design` command. With no args it opens the visual
  // kit picker; with args it pins/clears like the CLI command. The picker's
  // Enter routes back through `/design <id> <stack>`, so this one handler
  // serves both the visual and typed paths.
  useEffect(() => {
    const cmd = {
      name: 'design',
      description:
        'Design Studio: /design (picker) | <kit> [stack] | off | foundations | set <k=v> | tune <k=v> | swap <kit> | materialize [stack] [path] | verify.',
      async run(args: string) {
        const loader = getDesignKitLoader(projectRoot);
        const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
        const sub = tokens[0]?.toLowerCase();
        if (!sub) {
          const kits = await loader.listEntries();
          dispatch({ type: 'designPickerOpen', kits });
          return { message: undefined };
        }
        if (sub === 'off') {
          clearActiveKit(agent.ctx);
          await clearPersistedActiveKit(projectRoot);
          return { message: 'Cleared the active design kit.' };
        }
        if (sub === 'foundations') {
          return { runText: 'design foundations' };
        }
        if (sub === 'verify') {
          return { runText: 'design verify' };
        }
        if (sub === 'set') {
          const patch: Record<string, string> = {};
          for (const t of tokens.slice(1)) {
            const eq = t.indexOf('=');
            if (eq > 0) patch[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
          }
          if (Object.keys(patch).length === 0) {
            return { message: 'Usage: /design set primary=oklch(…) dark.bg=#111' };
          }
          const merged = await recordOverrides(projectRoot, patch, new Date().toISOString());
          if (!merged) return { message: 'No active kit. Pin one first: /design <kit-id>.' };
          setDesignOverrides(agent.ctx, merged);
          return {
            message: `Overrides set: ${Object.entries(merged)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}`,
          };
        }
        if (sub === 'tune') {
          const pairs: Record<string, string> = {};
          for (const t of tokens.slice(1)) {
            const eq = t.indexOf('=');
            if (eq > 0) pairs[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
          }
          const patch = resolveSemanticTune({
            radius: pairs['radius'],
            density: pairs['density'],
            font: pairs['font'],
            motion: pairs['motion'],
          });
          if (Object.keys(patch).length === 0) {
            return {
              message: 'Usage: /design tune radius=lg density=compact font="…" motion=snappy',
            };
          }
          const merged = await recordOverrides(projectRoot, patch, new Date().toISOString());
          if (!merged) return { message: 'No active kit. Pin one first: /design <kit-id>.' };
          setDesignOverrides(agent.ctx, merged);
          return {
            message: `Tuned (${Object.keys(patch).length} tokens): ${Object.entries(patch)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}`,
          };
        }
        if (sub === 'swap') {
          const target = tokens[1]?.toLowerCase();
          if (!target) return { message: 'Usage: /design swap <kit-id> [stack]' };
          const swapKit = await loader.find(target);
          if (!swapKit) {
            const menu = await loader.menuText();
            return { message: `Unknown kit "${target}".\n\n${menu}` };
          }
          const swapStackArg = tokens[2]?.toLowerCase();
          const swapStack = swapStackArg && isDesignStack(swapStackArg) ? swapStackArg : undefined;
          await clearPersistedActiveKit(projectRoot);
          setActiveKit(agent.ctx, swapKit.id, swapStack, {});
          return {
            message: `Swapped to "${swapKit.name}" (${swapKit.id}). Old overrides dropped.`,
            runText: `design use ${swapKit.id}${swapStack ? ` --stack ${swapStack}` : ''}`,
          };
        }
        if (sub === 'materialize') {
          const active = await loadActiveKit(projectRoot);
          if (!active) return { message: 'No active kit. Pin one first: /design <kit-id>.' };
          const stackArg2 = tokens[1]?.toLowerCase();
          const matStack =
            stackArg2 && isDesignStack(stackArg2)
              ? stackArg2
              : active.stack && isDesignStack(active.stack)
                ? active.stack
                : 'web';
          const outPath = stackArg2 && !isDesignStack(stackArg2) ? tokens[1] : tokens[2];
          const raw = await loader.readTokens(active.kit);
          if (!raw) return { message: `Kit "${active.kit}" has no tokens.json.` };
          const result = materializeTokens({
            tokens: applyTokenOverrides(raw, active.overrides),
            stack: matStack,
            kitId: active.kit,
            outPath,
          });
          const fsp = await import('node:fs/promises');
          const nodePath = await import('node:path');
          // WS-052: share the containment resolver with the tool and WS paths.
          const { resolveMaterializeTarget } = await import('@wrongstack/core/design');
          let abs: string;
          try {
            abs = await resolveMaterializeTarget(result.path, projectRoot);
          } catch (e) {
            return { message: (e as Error).message };
          }
          try {
            await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
            await fsp.writeFile(abs, result.content);
          } catch (e) {
            return { message: `Failed to write ${result.path}: ${(e as Error).message}` };
          }
          return { message: `Wrote ${result.format} → ${result.path}` };
        }
        const kit = await loader.find(sub);
        if (!kit) {
          const menu = await loader.menuText();
          return { message: `Unknown kit "${sub}".\n\n${menu}` };
        }
        const stackArg = tokens[1]?.toLowerCase();
        const stack = stackArg && isDesignStack(stackArg) ? stackArg : undefined;
        setActiveKit(agent.ctx, kit.id, stack);
        return { runText: `design use ${kit.id}${stack ? ` --stack ${stack}` : ''}` };
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry, projectRoot, agent]);

  // Register the TUI-only `/settings` command — opens the interactive
  // SettingsPicker immediately, same as Ctrl+S. Accepts an optional
  // row-name argument that jumps the picker to that row on open
  // (e.g. `/settings multi-diff` → opens the picker on the multi-diff
  // summary row). Gated on the settings accessors being wired by the
  // host (CLI passes them in).
  useEffect(() => {
    if (!getSettings || !saveSettings) return;
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
        '  /settings reset <chord> Reset <chord> to its factory default\n\n' +
        'Examples:\n' +
        '  /settings yolo on      Enable YOLO mode\n' +
        '  /settings multi-diff 8  Set multi-diff threshold to 8\n' +
        '  /settings thinking-word pondering  Set the working-state word\n\n' +
        'Available chords:\n  ' +
        settingsPickerJumpNames().join('\n  '),
      async run(args: string) {
        const query = args.trim();
        if (query === '') {
          openSettings();
          return { message: undefined };
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
          const cur = getSettings ? getSettings() : undefined;
          if (cur && saveSettings) {
            const { tokenSavingTier, ...rest } = result.patch;
            Promise.resolve(
              saveSettings({
                ...cur,
                ...rest,
                ...(tokenSavingTier !== undefined ? { featureTokenSaving: tokenSavingTier } : {}),
              }),
            )
              .then((err: string | null) => {
                if (err) dispatch({ type: 'settingsHint', text: err });
              })
              // The `.then` arm only handles the resolved-with-error-string
              // contract; a REJECTION (Windows EBUSY when a second wstack in
              // the same project holds the config, or the credential
              // hot-reload watcher mid-write) escaped and killed the TUI.
              // Siblings guard: submit-controller.ts:317, use-queue-manager.ts:130.
              .catch(() => {
                dispatch({ type: 'settingsHint', text: 'Could not save settings.' });
              });
          }
          return { message: `↺ ${result.label} reset to ${result.displayValue}` };
        }

        // Check for `<chord> <value>` syntax — a space separates the
        // row name from the value. Everything after the first space is
        // the value (allows multi-word values like "thinking-word").
        const spaceIdx = query.indexOf(' ');
        if (spaceIdx > 0) {
          const rowName = query.slice(0, spaceIdx);
          const valueStr = query.slice(spaceIdx + 1).trim();
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
            dispatch({ type: 'settingsFieldSet', field });
            openSettings();
            return { message: undefined };
          }

          const result = resolveSettingsFieldValue(field, valueStr);
          if (!result.ok) {
            return { message: result.error };
          }

          // 1. Update runtime state so the picker (if opened later)
          //    reflects the change immediately.
          dispatch({ type: 'settingsValueSet', patch: result.patch });

          // 2. Persist to the canonical Settings shape. The auto-save
          //    effect only fires while the picker is open, so we do it
          //    manually here. The only key mapping is tokenSavingTier →
          //    featureTokenSaving; all others are identical.
          const cur = getSettings ? getSettings() : undefined;
          if (cur && saveSettings) {
            const { tokenSavingTier, ...rest } = result.patch;
            const updated: Settings = {
              ...cur,
              ...rest,
              ...(tokenSavingTier !== undefined ? { featureTokenSaving: tokenSavingTier } : {}),
            };
            Promise.resolve(saveSettings(updated))
              .then((err: string | null) => {
                if (err) dispatch({ type: 'settingsHint', text: err });
              })
              .catch(() => {
                dispatch({ type: 'settingsHint', text: 'Could not save settings.' });
              });
          }

          return { message: `✓ ${result.label} → ${result.displayValue}` };
        }

        // Single token: navigation mode (open picker on that row).
        const field = settingsPickerJumpByName(query);
        if (field === undefined) {
          return {
            message:
              `Unknown settings row "${query}".\n` +
              `Available chords:\n  ${settingsPickerJumpNames().join('\n  ')}`,
          };
        }
        dispatch({ type: 'settingsFieldSet', field });
        openSettings();
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /settings command. Without this, only Ctrl+S could open the picker.
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry, getSettings, saveSettings, openSettings, dispatch]);

  // Register the TUI-only `/settings-get` command — reads a setting's
  // current value and displays it as a chat message without opening the
  // picker. Counterpart to `/settings <chord> <value>`.
  useEffect(() => {
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
        if (query === '') {
          // No argument: show all settings as a compact grouped summary.
          return { message: formatAllSettingsSummary(state.settingsPicker) };
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
  }, [slashRegistry, state.settingsPicker]);

  // Register the TUI-only `/statusline` command — opens the interactive
  // StatuslinePicker overlay. Arguments (item, on|off) are handled here too
  // because official TUI commands do not fall through to the CLI builtin.
  useEffect(() => {
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
  }, [slashRegistry, openStatuslinePicker, setHiddenItems]);

  // Register the TUI-only `/lite` and `/full` commands — one-key layout
  // presets. `/lite` collapses the chrome (statusline density 'minimum' +
  // right sidebar hidden) so chat history takes the full terminal width;
  // `/full` restores it (statusline 'detailed' + sidebar visible). Both
  // persist through the same dispatch + saveSettings path as
  // `/settings <chord> <value>`, so the change survives restarts and the
  // open settings picker tracks it live.
  useEffect(() => {
    if (!getSettings || !saveSettings) return;
    const applyLayoutPreset = async (
      statuslineMode: 'minimum' | 'detailed',
      showSidebar: boolean,
    ): Promise<string> => {
      const patch = { statuslineMode, showSidebar };
      dispatch({ type: 'settingsValueSet', patch });
      const cur = getSettings();
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
      return showSidebar
        ? `✓ Full layout: statusline detailed, sidebar on.`
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
  }, [slashRegistry, getSettings, saveSettings, dispatch]);

  // Register the TUI-only `/mailbox` command — toggles the mailbox panel.
  useEffect(() => {
    const cmd = {
      name: 'mailbox',
      aliases: ['inbox', 'mail'],
      description: 'Toggle the inter-agent mailbox panel — messages, read receipts, online agents.',
      async run() {
        setMailboxPanelOpen((prev) => !prev);
        return { message: undefined };
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry]);

  // Register the TUI-only `/autonomy` command — opens a single-step picker.
  // When the user types `/autonomy` with no arg, the picker appears.
  // If they type `/autonomy off` etc. with an arg, the CLI builtin handles it.
  useEffect(() => {
    if (!switchAutonomy) return;
    const cmd = {
      name: 'autonomy',
      aliases: ['auto'],
      description: 'Pick an autonomy mode interactively (picker).',
      async run() {
        dispatch({ type: 'autonomyPickerOpen', options: AUTONOMY_OPTIONS });
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /autonomy command. Opens the interactive picker instead.
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry, switchAutonomy]);

  // Bare `/skill` is a visual browser in the TUI. The named form keeps the
  // established behavior and opens the selected skill's capped instructions.
  useEffect(() => {
    if (!skillLoader) return;
    const cmd = {
      name: 'skill',
      aliases: ['skills'],
      description: 'Browse available skills and inspect the selected skill.',
      argsHint: '[name]',
      async run(args: string) {
        const name = (args ?? '').trim();
        if (name) {
          const skill = await skillLoader.find(name);
          if (!skill) return { message: `Skill "${name}" not found.` };
          const body = stripFrontmatter(await skillLoader.readBody(skill.name));
          const capped = body.slice(0, SKILL_LIMITS.MAX_SKILL_BODY_CHARS);
          return {
            message:
              capped.length < body.length
                ? `${capped}\n\n[Skill instructions truncated at ${SKILL_LIMITS.MAX_SKILL_BODY_CHARS.toLocaleString()} characters.]`
                : capped,
          };
        }

        try {
          const entries = await skillLoader.listEntries();
          dispatch({ type: 'skillPickerOpen', entries });
          return { message: undefined };
        } catch (err) {
          return { message: `Could not load skills: ${toErrorMessage(err)}` };
        }
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry, skillLoader, dispatch]);

  // Operational commands keep their typed CLI forms, while the bare form
  // opens a shared two-pane browser backed by live host state.
  useEffect(() => {
    if (!getResourceMenu) return;
    const names = [
      'fallback',
      'tier',
      'profile',
      'provider-status',
      'memory',
      'worktree',
      'git',
    ] as const;
    const cleanups: Array<() => void> = [];
    for (const name of names) {
      const original = slashRegistry.get(name);
      cleanups.push(
        registerSlashCommandLifecycle(
          slashRegistry,
          {
            name,
            description: original?.description ?? `Browse ${name} state interactively.`,
            argsHint: original?.argsHint,
            help: original?.help,
            async run(args: string, ctx) {
              if (args.trim())
                return original?.run(args, ctx) ?? { message: `/${name} is unavailable.` };
              try {
                const snapshot = await getResourceMenu(name);
                dispatch({ type: 'resourceMenuOpen', snapshot });
                return { message: undefined };
              } catch (err) {
                return { message: `Could not load ${name}: ${toErrorMessage(err)}` };
              }
            },
          },
          { owner: 'tui', official: true },
        ),
      );
    }
    return () => {
      for (const cleanup of [...cleanups].reverse()) cleanup();
    };
  }, [slashRegistry, getResourceMenu, dispatch]);

  // Existing live monitors are the richer UI for these resources. Typed
  // subcommands still flow to their canonical CLI handlers.
  useEffect(() => {
    const definitions = [
      { name: 'cron', open: () => dispatch({ type: 'toggleCronMonitor' as const }) },
      { name: 'prompts', open: () => void openPromptPicker() },
    ] as const;
    const cleanups: Array<() => void> = [];
    for (const definition of definitions) {
      const original = slashRegistry.get(definition.name);
      cleanups.push(
        registerSlashCommandLifecycle(
          slashRegistry,
          {
            name: definition.name,
            description: original?.description ?? `Open the ${definition.name} browser.`,
            argsHint: original?.argsHint,
            help: original?.help,
            async run(args: string, ctx) {
              if (args.trim()) {
                return (
                  original?.run(args, ctx) ?? { message: `/${definition.name} is unavailable.` }
                );
              }
              definition.open();
              return { message: undefined };
            },
          },
          { owner: 'tui', official: true },
        ),
      );
    }
    return () => {
      for (const cleanup of [...cleanups].reverse()) cleanup();
    };
  }, [slashRegistry, dispatch, openPromptPicker]);

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
  useEffect(() => {
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
          // Direct apply path — open the picker on the matching row so the
          // user sees the [active] marker land on their pick. The picker
          // closes on Enter (`onThemePickerEnter`), which also persists to
          // disk via `saveThemePreset`.
          dispatch({
            type: 'themePickerOpen',
            selected: presetIdx,
          });
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
  }, [slashRegistry, dispatch]);

  // Register the TUI-only `/resume` command — opens the session resume picker.
  // Selecting one triggers onResumeSession to load and replay the full
  // conversation history.
  useEffect(() => {
    const cmd = {
      name: 'resume',
      aliases: ['load'],
      description: 'Resume a previous session — pick from your session history.',
      async run() {
        if (!listSessions) {
          return { message: 'Session listing not available.' };
        }
        try {
          const sessions = await listSessions(RESUME_PICKER_SESSIONS);
          if (sessions.length === 0) {
            return { message: 'No saved sessions.' };
          }
          dispatch({ type: 'resumePickerOpen', sessions });
        } catch (err) {
          return {
            message: toErrorMessage(err),
          };
        }
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /resume command (which is an alias on /sessions).
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry, listSessions]);
}
