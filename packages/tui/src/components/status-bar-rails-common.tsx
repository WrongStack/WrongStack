import type { StatuslineDensity } from "@wrongstack/core/statusline";
import type React from "react";
import type { AnimationStyle } from "./animation-style.js";
import type { RailSpanEntry } from "./powerline-rail.js";
import type { FleetAgentDetail, MailboxStatus, StatusBarProps } from "./status-bar-types.js";
import type { StatuslineItem } from "./statusline-picker.js";

export interface StatusBarRailBuildParams {
  showChip: (item: StatuslineItem) => boolean;
  /** Resolved density for a chip ('auto' unless the user pinned one). */
  chipDensity: (item: StatuslineItem) => StatuslineDensity;
  isNoColor: boolean;
  model: string;
  provider?: string | undefined;
  version?: string | undefined;
  latestVersion?: string | undefined;
  updateAvailable?: boolean | undefined;
  yolo?: boolean | undefined;
  autonomy?: StatusBarProps['autonomy'];
  processCount?: number | undefined;
  stateStatusChip: React.ReactElement | null;
  fleetWorkingTime?: number | undefined;
  context?: StatusBarProps['context'];
  contextStrategy?: string | undefined;
  showTokenDisplay: boolean;
  displayTokens: { input: number; output: number };
  cost?: { total: number } | undefined;
  cache?:
    | {
        hitRatio: number;
        readTokens: number;
        writeTokens: number;
        savedUsd: number;
      }
    | undefined;
  queueCount?: number | undefined;
  hint?: string | undefined;
  breakerCountdown?: StatusBarProps['breakerCountdown'];
  projectName?: string | undefined;
  workingDir?: string | undefined;
  git?: StatusBarProps['git'];
  modeLabel?: string | undefined;
  themeName?: string | undefined;
  sessionCount?: number | undefined;
  toolCount?: number | undefined;
  tokenSavingMode?: StatusBarProps['tokenSavingMode'];
  sideEffectCount?: number | undefined;
  todos?: StatusBarProps['todos'];
  todosCleared: boolean;
  plan?: StatusBarProps['plan'];
  tasks?: StatusBarProps['tasks'];
  hasTaskActivity: boolean | undefined;
  fleet?: StatusBarProps['fleet'];
  fleetHasActivity: boolean | undefined;
  subagentCount: number;
  showBrain: boolean;
  brain?: StatusBarProps['brain'];
  showDebugStream: boolean;
  debugStreamStats?: StatusBarProps['debugStreamStats'];
  showEnhance: boolean;
  enhanceCountdown?: number | null | undefined;
  hasNextStepsAutoSubmit: boolean;
  nextStepsAutoSubmitCountdown?: number | null | undefined;
  nextStepsAutoSubmitLabel?: string | null | undefined;
  nextStepsColor: string;
  showEternalStage: boolean;
  eternalStage?: StatusBarProps['eternalStage'];
  hasActiveGoal: boolean;
  goalSummary?: StatusBarProps['goalSummary'];
  hasAutoProceed: boolean;
  autoProceedCountdown?: number | null | undefined;
  droppedTools?: number | undefined;
  minimalWorkParts: string[];
  thinking: boolean;
  statePrefix: string;
  stateLabel: string;
  stateColor: string;
  animationStyle: AnimationStyle | 'cycle';
  spinnerIdx: number;
  cycleTick: number;
  memoryContextMonitor?: StatusBarProps['memoryContextMonitor'];
  Sage?: StatusBarProps['Sage'];
  indexState?: StatusBarProps['indexState'];
  /** Mailbox status for the async rail. */
  mailbox?: MailboxStatus | undefined;
  /** Per-agent live detail rows for the async rail. */
  fleetAgents?: FleetAgentDetail[] | undefined;
  /** Whether the mailbox chip is eligible (not hidden + has activity). */
  showMailbox: boolean;
  /** Pre-built memory-context chips for the async rail. */
  memoryDetailChips: RailSpanEntry[];
  /** Active system-prompt variant (Lite / Standard / Pro) — identity chip. */
  promptVariant?: 'lite' | 'default' | 'pro' | undefined;
}

/**
 * Translate a chip's density setting into the level bounds the rail fitter
 * may use. `auto` leaves the full range open; every other value pins one
 * level (clamped to what the chip actually offers, so a two-level chip
 * pinned to `micro` renders its narrowest form rather than nothing).
 */
export function densityBounds(
  density: StatuslineDensity,
  levelCount: number,
): { lo: number; hi: number } {
  const last = Math.max(0, levelCount - 1);
  switch (density) {
    case 'full':
      return { lo: 0, hi: 0 };
    case 'short': {
      const level = Math.min(1, last);
      return { lo: level, hi: level };
    }
    case 'micro':
      return { lo: last, hi: last };
    default:
      return { lo: 0, hi: last };
  }
}

/**
 * Assemble one rail entry from its density levels (widest → narrowest).
 * Nullish levels are dropped, so a chip can declare `[full, short, micro]`
 * and silently degrade to fewer levels when the data for a richer form
 * isn't there. Returns null when the chip has nothing to render at all.
 */
export function entry(
  id: string,
  key: StatuslineItem,
  p: StatusBarRailBuildParams,
  levels: Array<React.ReactElement | null | false | undefined>,
): RailSpanEntry | null {
  const nodes = levels.filter((node): node is React.ReactElement => Boolean(node));
  if (nodes.length === 0) return null;
  const { lo, hi } = densityBounds(p.chipDensity(key), nodes.length);
  return { id, node: nodes[0]!, alt: nodes.slice(1), lo, hi };
}

export function compact(entries: Array<RailSpanEntry | null>): RailSpanEntry[] {
  return entries.filter((item): item is RailSpanEntry => item != null);
}

/** `icon ` prefix, or '' in no-color/ASCII-ish mode. */
export function icon(glyph: string, isNoColor: boolean): string {
  return isNoColor ? '' : `${glyph} `;
}
