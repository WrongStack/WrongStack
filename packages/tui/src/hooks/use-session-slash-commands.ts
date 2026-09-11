import {
  areSubagentsAllowed,
  isSubagentPolicyLocked,
  setSessionSubagentsAllowed,
} from '@wrongstack/core/coordination';
import type { SlashCommand } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { useEffect } from 'react';
import { AUTONOMY_OPTIONS } from '../components/autonomy-picker.js';
import { registerSlashCommandLifecycle } from '../slash-command-lifecycle.js';
import type { TuiSlashCommandOptions } from './tui-slash-command-options.js';

/** Which slice of the session-domain commands this call registers. */
export type SessionSlashPart = 'head' | 'mid' | 'tail';

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

/**
 * Session-domain slash commands (/solo, /mailbox, /autonomy, /resume),
 * moved verbatim from useTuiSlashCommands (decomposition Phase 2 —
 * docs/decomposition-plan.md).
 *
 * `part` selects which slice of the domain registers at this call site, so
 * the parent can interleave the domains and preserve the pinned 23-command
 * registration order (tests/slash-registration-enumeration.test.ts):
 * 'head' → /solo (position 1), 'mid' → /mailbox + /autonomy (10–11),
 * 'tail' → /resume (23). `part` is a constant literal per call site, so
 * hook order is stable; non-selected parts return early without registering.
 */
export function useSessionSlashCommands(
  deps: TuiSlashCommandOptions,
  part: SessionSlashPart,
): void {
  const { agent, slashRegistry, dispatch, setMailboxPanelOpen, switchAutonomy, listSessions } =
    deps;

  useEffect(() => {
    if (part !== 'head') return;
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
  }, [part, agent, slashRegistry]);

  useEffect(() => {
    if (part !== 'mid') return;
    // Register the TUI-only `/mailbox` command — toggles the mailbox panel.
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
  }, [part, slashRegistry]);

  useEffect(() => {
    if (part !== 'mid') return;
    // Register the TUI-only `/autonomy` command — opens a single-step picker.
    // When the user types `/autonomy` with no arg, the picker appears.
    // If they type `/autonomy off` etc. with an arg, the CLI builtin handles it.
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
  }, [part, slashRegistry, switchAutonomy]);

  useEffect(() => {
    if (part !== 'tail') return;
    // Captured BEFORE the override displaces it. `/sessions status|kill|
    // rename|archive|delete|rehydrate|--incomplete|--recover` are text
    // subcommands only the host command implements; the picker claims the
    // bare key, so without this hand-back the TUI would swallow all of them.
    const hostSessions = slashRegistry.get('sessions');
    const cmd: SlashCommand = {
      // `sessions`, NOT `resume`, and the aliases are inverted to match.
      //
      // The host registers `/sessions` with aliases `resume` and `load`. A
      // command named `resume` therefore collides with a CORE-OWNED ALIAS,
      // which the registry reserves for the built-in family (it is what keeps
      // a plugin's literal `stop` from stealing `/stop` out of `/interrupt`).
      // The bare write was refused and the whole registration fell back to
      // `/tui:resume` — so `/resume`, `/sessions` and `/load` all kept
      // printing the host's ten-session text list and this picker was
      // unreachable by every key a user would type.
      //
      // Sharing the host's canonical NAME takes the registry's documented
      // escape hatch instead: a command may always rebind its own aliases,
      // so all three keys land on the picker.
      name: 'sessions',
      aliases: ['resume', 'load'],
      description: 'Resume a previous session — pick from your session history.',
      async run(args: string, ctx) {
        const rest = (args ?? '').trim();
        if (rest.length > 0 && hostSessions !== undefined && hostSessions !== cmd) {
          return hostSessions.run(rest, ctx);
        }
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
    // /sessions command and every alias it carries (/resume, /load).
    // Lifecycle teardown restores the CLI command on unmount.
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [part, slashRegistry, listSessions]);
}
