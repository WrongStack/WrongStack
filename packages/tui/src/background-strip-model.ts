/**
 * The background strip above the composer: every running subagent and every
 * background shell, as one row of chips. Alt+B focuses it; ←/→ pick a chip,
 * Enter shows or hides the last lines of its output, `x` stops a shell (after
 * a `y`), Esc leaves.
 *
 * This file is the pure part (items, layout, peek lines) and the strip's own
 * little store. The store lives outside the app reducer on purpose: the strip
 * state is view-only and short-lived, and the key route and the component are
 * its only readers.
 */

import { useSyncExternalStore } from 'react';
import type { FleetEntry } from './app-state-fleet.js';
import { displayWidth, truncateDisplay } from './terminal-width.js';

export interface BackgroundItem {
  /** `agent:<id>` or `shell:<pid>`. */
  id: string;
  kind: 'agent' | 'shell';
  label: string;
  startedAt: number;
  agentId?: string | undefined;
  pid?: number | undefined;
  logFile?: string | undefined;
}

export interface BackgroundProcessLike {
  pid: number;
  command: string;
  startedAt: number;
  background: boolean;
  killed: boolean;
  logFile?: string | undefined;
}

/** Running subagents (oldest first), then background shells (oldest first). */
export function buildBackgroundItems(
  fleet: Readonly<Record<string, FleetEntry>>,
  processes: readonly BackgroundProcessLike[],
): BackgroundItem[] {
  const agents = Object.values(fleet)
    .filter((e) => e.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(
      (e): BackgroundItem => ({
        id: `agent:${e.id}`,
        kind: 'agent',
        label: e.name || e.id,
        startedAt: e.startedAt,
        agentId: e.id,
      }),
    );
  const shells = processes
    .filter((p) => p.background && !p.killed)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(
      (p): BackgroundItem => ({
        id: `shell:${p.pid}`,
        kind: 'shell',
        label: p.command.replace(/\s+/g, ' ').trim(),
        startedAt: p.startedAt,
        pid: p.pid,
        ...(p.logFile ? { logFile: p.logFile } : {}),
      }),
    );
  return [...agents, ...shells];
}

/** `12s`, `3m`, `1h4m`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return '0s';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

const LABEL_MAX = 28;

export interface StripChip {
  item: BackgroundItem;
  text: string;
  selected: boolean;
}

/**
 * The chips that fit in `width` columns (after the `prefix` and before the
 * `suffix`), always including the selected one; `hidden` counts the rest.
 */
export function layoutStripChips(
  items: readonly BackgroundItem[],
  selected: number,
  width: number,
  now: number,
  spinner: string,
): { chips: StripChip[]; hidden: number } {
  const all = items.map((item, i) => ({
    item,
    selected: i === selected,
    text: `${item.kind === 'shell' ? '$' : spinner} ${truncateDisplay(item.label, LABEL_MAX)} ${formatElapsed(now - item.startedAt)}`,
  }));
  // Start the window at the selected chip when it would not fit from the left.
  const fits = (from: number): StripChip[] => {
    const out: StripChip[] = [];
    let used = 0;
    for (const chip of all.slice(from)) {
      const w = displayWidth(chip.text) + 3; // " [" … "]"
      if (used + w > width && out.length > 0) break;
      out.push(chip);
      used += w;
    }
    return out;
  };
  let start = 0;
  let chips = fits(0);
  while (selected >= start + chips.length && start < all.length - 1) {
    start += 1;
    chips = fits(start);
  }
  return { chips, hidden: all.length - chips.length };
}

/** What a subagent is doing, newest last. */
export function agentPeekLines(entry: FleetEntry | undefined, max: number): string[] {
  if (!entry) return [];
  const lines: string[] = [];
  for (const m of entry.recentMessages) lines.push(...m.text.split('\n'));
  const streaming = entry.streamingText.trim();
  if (streaming) lines.push(...streaming.split('\n').slice(-max));
  if (entry.currentTool) lines.push(`▸ ${entry.currentTool.name}`);
  return lines
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(-max);
}

// ── store ────────────────────────────────────────────────────────────────

export interface BackgroundStripState {
  focused: boolean;
  /** By id, so a chip that appears before it does not move the selection. */
  selectedId: string | undefined;
  peek: boolean;
  confirmStop: boolean;
  items: readonly BackgroundItem[];
}

let stripState: BackgroundStripState = {
  focused: false,
  selectedId: undefined,
  peek: false,
  confirmStop: false,
  items: [],
};
const listeners = new Set<() => void>();

export function getBackgroundStrip(): BackgroundStripState {
  return stripState;
}

export function updateBackgroundStrip(patch: Partial<BackgroundStripState>): void {
  const next = { ...stripState, ...patch };
  // Items come and go: keep the selection on a real chip, and leave the strip
  // when nothing is left in it.
  if (!next.items.some((item) => item.id === next.selectedId)) {
    next.selectedId = next.items[0]?.id;
  }
  if (next.items.length === 0) {
    next.focused = false;
    next.peek = false;
    next.confirmStop = false;
  }
  if (
    next.focused === stripState.focused &&
    next.selectedId === stripState.selectedId &&
    next.peek === stripState.peek &&
    next.confirmStop === stripState.confirmStop &&
    next.items === stripState.items
  ) {
    return;
  }
  stripState = next;
  for (const l of listeners) l();
}

/** Position of the selected chip (0 when nothing is selected). */
export function selectedIndex(state: BackgroundStripState): number {
  return Math.max(
    0,
    state.items.findIndex((item) => item.id === state.selectedId),
  );
}

/** Same ids in the same order: the strip keeps its item list (and render). */
export function sameItems(a: readonly BackgroundItem[], b: readonly BackgroundItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item.id === b[i]?.id);
}

export function useBackgroundStrip(): BackgroundStripState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getBackgroundStrip,
    getBackgroundStrip,
  );
}
