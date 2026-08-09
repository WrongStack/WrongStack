/**
 * wiring/controllers — Factory functions for shared mutable controller objects.
 *
 * Extracted from cli-main.ts so each controller is testable in isolation
 * and the wiring phase in main() doesn't need to inline them.
 *
 * Step 2 of the cli-main/ExecutionDeps refactor plan:
 *   docs/plans/cli-main-executiondeps-refactor.md
 */

import type { Config, FleetChatVerbosity } from '@wrongstack/core/types';
import type { StatuslineConfigKey } from '../services/statusline-config.js';
import {
  DEFAULTS,
  ensureStatuslineConfig,
  loadStatuslineConfig,
  STATUSLINE_CONFIG_KEYS,
  type StatuslineConfig,
  saveStatuslineConfig,
} from '../services/statusline-config.js';

// ─── Fleet stream controller ───────────────────────────────────────

export interface FleetStreamController {
  /** Fleet-chat verbosity streamed into the main chat: off | full. */
  mode: FleetChatVerbosity;
  setMode(mode: FleetChatVerbosity): void;
}

export function createFleetStreamController(
  initialMode: FleetChatVerbosity = 'off',
): FleetStreamController {
  return {
    mode: initialMode,
    setMode(this: FleetStreamController, mode: FleetChatVerbosity) {
      this.mode = mode;
    },
  };
}

// ─── Interrupt controller ──────────────────────────────────────────

export interface InterruptController {
  abortLeader: () => boolean;
  /** Installed by the TUI to render `/clear` confirmation inside Ink. */
  confirmClear?:
    | ((info: { leaderActive: boolean; subagentCount: number }) => Promise<boolean>)
    | undefined;
  /** Installed by the TUI for all non-clear slash-command confirmations. */
  confirmSlash?: ((question: string, defaultYes: boolean) => Promise<boolean | null>) | undefined;
  /** Invalidate output buffers before a destructive session reset. */
  resetSession: () => void;
  /** Resolve after the currently aborted leader turn has fully unwound. */
  waitForIdle: () => Promise<void>;
}

export function createInterruptController(): InterruptController {
  return {
    abortLeader: (): boolean => false,
    resetSession: (): void => {},
    waitForIdle: async (): Promise<void> => {},
  };
}

// ─── Enhance controller ────────────────────────────────────────────

export interface EnhanceController {
  enabled: boolean;
  setEnabled(enabled: boolean): void;
}

export function createEnhanceController(config: Config): EnhanceController {
  return {
    enabled:
      ((config.autonomy as Record<string, unknown> | undefined)?.['enhance'] as boolean) ?? true,
    setEnabled(this: EnhanceController, enabled: boolean) {
      this.enabled = enabled;
    },
  };
}

// ─── Agents monitor controller ─────────────────────────────────────

export interface AgentsMonitorController {
  visible: boolean;
  setVisible(visible: boolean): void;
}

export function createAgentsMonitorController(): AgentsMonitorController {
  return {
    visible: false,
    setVisible(this: AgentsMonitorController, visible: boolean) {
      this.visible = visible;
    },
  };
}

// ─── Statusline config helper ──────────────────────────────────────

export interface StatuslineConfigDeps {
  get: () => Promise<StatuslineConfig>;
  set: (cfg: StatuslineConfig) => Promise<void>;
}

export function createStatuslineConfigDeps(): StatuslineConfigDeps {
  return {
    get: () => loadStatuslineConfig(),
    set: (cfg: StatuslineConfig) => saveStatuslineConfig(cfg),
  };
}

/**
 * Load statusline hidden items from config. Returns the items list and
 * mutation helpers that keep memory and disk in sync.
 */
export async function loadStatuslineHiddenItems(): Promise<{
  hiddenItems: StatuslineConfigKey[];
  setHiddenItems: (items: StatuslineConfigKey[]) => void;
  saveHiddenItems: (items: StatuslineConfigKey[]) => Promise<void>;
}> {
  const hiddenItemsFromConfig = await ensureStatuslineConfig();
  const hiddenItemsList: StatuslineConfigKey[] = [];
  for (const k of STATUSLINE_CONFIG_KEYS) {
    if (!hiddenItemsFromConfig[k]) hiddenItemsList.push(k);
  }
  const setHiddenItems = (_items: StatuslineConfigKey[]) => {
    hiddenItemsList.splice(0, hiddenItemsList.length, ..._items);
  };
  const saveHiddenItems = async (items: StatuslineConfigKey[]): Promise<void> => {
    setHiddenItems(items);
    const cfg: StatuslineConfig = { ...DEFAULTS };
    for (const k of STATUSLINE_CONFIG_KEYS) {
      cfg[k] = !items.includes(k);
    }
    await saveStatuslineConfig(cfg);
  };
  return { hiddenItems: hiddenItemsList, setHiddenItems, saveHiddenItems };
}
