import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';

/**
 * `/mouse` — toggle "full mouse mode" in the TUI: the chat history is rendered
 * into a managed, in-app-scrolled viewport. The wheel always drives that
 * viewport; full mode adds scrollbar drag and clickable UI.
 *
 * The command is intentionally stateless: it doesn't hold the live value (which
 * lives in the App's `mouseMode` state). It emits an intent via `metadata`, and
 * the TUI App resolves it against its own state, persists the setting, and
 * prints the resulting status. Outside the TUI the metadata is simply ignored.
 */
export function buildMouseCommand(_opts: SlashCommandContext): SlashCommand {
  return {
    name: 'mouse',
    category: 'Config',
    description: 'Toggle full mouse mode (in-app scroll + clickable UI).',
    help: [
      'Usage:',
      '  /mouse            Show current mouse-mode status',
      '  /mouse on         Enable full mouse mode',
      '  /mouse off        Disable scrollbar drag and clickable UI',
      '  /mouse toggle     Flip the current state',
      '',
      'The wheel always scrolls virtualized chat history in-app. Full mouse mode',
      'also makes the scrollbar drag-able and status-bar chips / confirm buttons',
      'clickable. Shift+wheel, PgUp/PgDn, and Ctrl+U/D page through history.',
      'The setting persists.',
    ].join('\n'),
    async run(args) {
      const arg = args.trim().toLowerCase();
      let intent: 'on' | 'off' | 'toggle' | 'query';
      if (!arg || arg === 'status') intent = 'query';
      else if (arg === 'on' || arg === 'enable' || arg === 'true' || arg === '1') intent = 'on';
      else if (arg === 'off' || arg === 'disable' || arg === 'false' || arg === '0') intent = 'off';
      else if (arg === 'toggle') intent = 'toggle';
      else {
        return {
          message: `Unknown argument: ${arg}. Use /mouse on, /mouse off, or /mouse toggle.`,
        };
      }
      // The App (TUI) consumes this intent, applies + persists it, and prints
      // the resulting status. No `message` here so it isn't double-printed.
      return { metadata: { mouseToggle: intent } };
    },
  };
}
