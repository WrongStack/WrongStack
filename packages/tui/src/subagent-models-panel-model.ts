/**
 * View model for the `/subagent-models` panel.
 *
 * The TUI never imports the coordination plan type directly: the host (CLI)
 * owns the session-scoped plan and hands the panel plain rows. That keeps this
 * package free of `@wrongstack/core/coordination` runtime imports and lets the
 * WebUI/SimpleUI reuse the same host contract shape over their own transport.
 */

import type { SubagentLaneView, SubagentRoleView } from './ui-contracts.js';

/** One lane's editable target, in the host's terms. */
export interface SubagentLaneTarget {
  provider?: string | undefined;
  model?: string | undefined;
  tier?: string | undefined;
  fallbackProfile?: string | undefined;
  label?: string | undefined;
}

export interface SubagentModelsSnapshot {
  enabled: boolean;
  lock: boolean;
  /** "Run every plain subagent on the session's own model." */
  followSessionModel: boolean;
  /** The session's provider/model, shown as the target of that switch. */
  sessionTarget: string;
  lanes: SubagentLaneView[];
  roles: SubagentRoleView[];
}

/**
 * Host capabilities the panel needs. Every mutation returns an error string
 * (or null on success) rather than throwing, so a rejected write shows up as a
 * panel hint instead of tearing down the TUI.
 */
export interface SubagentModelsPanelHost {
  /** Current plan rendered for display, including live lane occupancy. */
  snapshot(): SubagentModelsSnapshot;
  /** Pin one lane (0-based). */
  setLane(index: number, target: SubagentLaneTarget): Promise<string | null>;
  /** Unpin one lane (0-based). */
  clearLane(index: number): Promise<string | null>;
  /** Flip one of the plan's switches. */
  toggle(field: 'lock' | 'enabled' | 'followSessionModel'): Promise<string | null>;
}
