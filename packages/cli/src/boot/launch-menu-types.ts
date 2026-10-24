import type { LaunchMenuChoice } from '@wrongstack/contracts/types';
import { DEFAULT_PORT as HQ_DEFAULT_PORT } from '../hq-server.js';
import type { ReadlineInputReader } from '../input-reader.js';
import type { TerminalRenderer } from '../renderer.js';

/** Top-level surfaces the user can launch from the menu. */
export type LaunchMenuMode = LaunchMenuChoice['mode'];

// Default ports — keep in sync with the rest of the codebase.
//   WebUI / SimpleUI: packages/webui-server/src/server/port-utils.ts
//   HQ:               packages/cli/src/hq-server.ts (DEFAULT_PORT)
/** Surfaces that bind a TCP listener and therefore need a port/host prompt. */
export type NetworkLaunchMode = Exclude<LaunchMenuMode, 'tui-repl' | 'desktop'>;

export const DEFAULT_PORTS: Record<NetworkLaunchMode, number> = {
  webui: 3456,
  simpleui: 3466,
  vibeui: 3476,
  hq: HQ_DEFAULT_PORT,
};

/** Numbered choices shown to the user. Order MUST match the menu printout. */
export const MODE_OPTIONS: ReadonlyArray<{
  key: number;
  mode: LaunchMenuMode;
  label: string;
  hint: string;
  icon: string;
}> = [
  {
    key: 1,
    mode: 'tui-repl',
    label: 'TUI / REPL',
    hint: 'interactive terminal (default)',
    icon: '⌨',
  },
  {
    key: 2,
    mode: 'webui',
    label: 'WebUI',
    hint: `browser-based project UI (port ${DEFAULT_PORTS.webui})`,
    icon: '🌐',
  },
  {
    key: 3,
    mode: 'simpleui',
    label: 'SimpleUI',
    hint: `lightweight browser UI (port ${DEFAULT_PORTS.simpleui})`,
    icon: '📄',
  },
  {
    key: 4,
    mode: 'hq',
    label: 'HQ',
    hint: `project-independent dashboard (port ${HQ_DEFAULT_PORT})`,
    icon: '📊',
  },
  {
    key: 5,
    mode: 'desktop',
    label: 'Desktop',
    hint: 'Electron app (alias: --desktop)',
    icon: '🖥',
  },
  {
    key: 6,
    mode: 'vibeui',
    label: 'VibeUI',
    hint: `focused coding workspace (port ${DEFAULT_PORTS.vibeui})`,
    icon: '✦',
  },
];

export const MENU_TIMEOUT_MS = 8_000;

export interface RunLaunchMenuDeps {
  argv: string[];
  flags: Record<string, string | boolean>;
  positional: string[];
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  /**
   * Last saved menu choice, if any. When provided the menu shows a
   * one-line summary + "Continue? [Y/n/q]" gate before re-asking,
   * matching the `runLaunchPrompts` pattern.
   */
  lastChoice?: LaunchMenuChoice | undefined;
  /**
   * Override the default ports (used by tests). Production callers
   * should leave this unset.
   */
  defaultPorts?: Partial<typeof DEFAULT_PORTS> | undefined;
}
