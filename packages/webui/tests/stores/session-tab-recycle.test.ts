import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * restored_empty_tab recycling — the full-strip escape hatch.
 *
 * Chimera reported the old `replaced_empty_tab` path missing: with all four
 * slots taken, opening a new session bounced off a "slots full" toast even
 * when one slot held a session that never started. These tests pin the
 * restored rule in `openTab`:
 *
 *   - exactly ONE empty background slot is recycled per open;
 *   - a busy slot (live run or running subagent — `isTabBusy`) is never
 *     recycled;
 *   - the tab in front is never recycled, even when it is empty;
 *   - the busy-foreground toast fires ONCE per open, not once per internal
 *     recycle hop.
 */

const toasts = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../src/components/Toaster', () => ({ toast: toasts }));

import { useFleetStore } from '../../src/stores/fleet-store.js';
import { useHistoryStore } from '../../src/stores/history-store.js';
import { useSessionLanes } from '../../src/stores/session-lanes.js';
import {
  useSessionTabStore,
  type OpenTabResult,
} from '../../src/stores/session-tab-store.js';
import type { SubagentView } from '../../src/stores/types.js';

/** A live subagent owned by `sessionId` — makes that slot busy for isTabBusy. */
function runningAgent(sessionId: string): SubagentView {
  return {
    id: `agent-${sessionId}`,
    sessionId,
    name: sessionId,
    status: 'running',
    isLeader: false,
    iteration: 0,
    toolCalls: 0,
    costUsd: 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
  } as unknown as SubagentView;
}

/** Mark every id in `busy` as owning a running subagent. */
function seedBusySlots(busy: string[]): void {
  const agents = new Map(busy.map((id) => [`agent-${id}`, runningAgent(id)]));
  useFleetStore.setState({ agents });
}

function setForeground(id: string | null): void {
  useSessionLanes.setState({ activeSessionId: id });
}

function strip(): string[] {
  return [...useSessionTabStore.getState().openTabIds];
}

/** A persisted history record for `id` — the boot-restore emptiness signal. */
function seedHistory(id: string, tokenTotal: number, messageCount: number): void {
  useHistoryStore.setState((s) => ({
    entries: [
      ...s.entries,
      {
        id,
        title: id,
        startedAt: '2026-01-01T00:00:00Z',
        model: 'm',
        provider: 'p',
        tokenTotal,
        messageCount,
        isCurrent: false,
      },
    ],
  }));
}

describe('openTab recycles one empty slot when the strip is full', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
    useFleetStore.setState({ agents: new Map(), leaderId: undefined });
    useHistoryStore.setState({ entries: [] });
    useSessionLanes.setState({ activeSessionId: null });
  });

  it('replaces an empty background slot with the new session', () => {
    seedBusySlots(['busy-a', 'busy-b', 'busy-c']);
    useSessionTabStore.setState({ openTabIds: ['busy-a', 'empty-one', 'busy-b', 'busy-c'] });
    setForeground('busy-a');

    const result: OpenTabResult = useSessionTabStore.getState().openTab('brand-new');

    expect(result).toEqual({ success: true, reason: 'replaced_empty_tab' });
    expect(strip()).toEqual(['busy-a', 'busy-b', 'busy-c', 'brand-new']);
    expect(useSessionLanes.getState().activeSessionId).toBe('brand-new');
    // The busy foreground keeps running behind — reported once, not once per
    // internal recycle hop.
    expect(toasts.warn).toHaveBeenCalledTimes(1);
  });

  it('never recycles a busy slot — all-busy strip still refuses', () => {
    seedBusySlots(['busy-a', 'busy-b', 'busy-c', 'busy-d']);
    useSessionTabStore.setState({
      openTabIds: ['busy-a', 'busy-b', 'busy-c', 'busy-d'],
    });
    setForeground('busy-a');

    const result = useSessionTabStore.getState().openTab('brand-new');

    expect(result).toEqual({ success: false, reason: 'tabs_full' });
    expect(strip()).toEqual(['busy-a', 'busy-b', 'busy-c', 'busy-d']);
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });

  it('never recycles the tab in front, even when it is empty', () => {
    // Every OTHER slot is busy, so the only content-empty slot is the
    // foreground itself — recycling must skip it and refuse instead.
    seedBusySlots(['busy-a', 'busy-b', 'busy-c']);
    useSessionTabStore.setState({ openTabIds: ['fg-empty', 'busy-a', 'busy-b', 'busy-c'] });
    setForeground('fg-empty');

    const result = useSessionTabStore.getState().openTab('brand-new');

    expect(result).toEqual({ success: false, reason: 'tabs_full' });
    expect(strip()).toEqual(['fg-empty', 'busy-a', 'busy-b', 'busy-c']);
    expect(useSessionLanes.getState().activeSessionId).toBe('fg-empty');
  });

  it('prefers the first empty slot in strip order', () => {
    seedBusySlots(['busy-a', 'busy-b']);
    // Four slots, two busy: both empties qualify, the first in strip order
    // wins the recycle and the new session is appended at the strip's end.
    useSessionTabStore.setState({ openTabIds: ['busy-a', 'empty-one', 'empty-two', 'busy-b'] });
    setForeground('busy-a');

    const result = useSessionTabStore.getState().openTab('brand-new');

    expect(result).toEqual({ success: true, reason: 'replaced_empty_tab' });
    expect(strip()).toEqual(['busy-a', 'empty-two', 'busy-b', 'brand-new']);
  });

  it('never recycles a restored slot whose history record has content', () => {
    // Boot-restore rehydrates a strip with EMPTY lanes (no transcript
    // replay) — in-memory emptiness alone must not read as recyclable when
    // the persisted record carries real history.
    seedBusySlots(['busy-a', 'busy-b', 'busy-c']);
    seedHistory('restored-rich', 4_200, 6);
    useSessionTabStore.setState({ openTabIds: ['busy-a', 'restored-rich', 'busy-b', 'busy-c'] });
    setForeground('busy-a');

    const result = useSessionTabStore.getState().openTab('brand-new');

    expect(result).toEqual({ success: false, reason: 'tabs_full' });
    expect(strip()).toEqual(['busy-a', 'restored-rich', 'busy-b', 'busy-c']);
  });

  it('recycles a restored slot whose history record is content-free', () => {
    seedBusySlots(['busy-a', 'busy-b']);
    seedHistory('restored-empty', 0, 0);
    useSessionTabStore.setState({ openTabIds: ['busy-a', 'restored-empty', 'busy-b', 'busy-c'] });
    setForeground('busy-a');

    const result = useSessionTabStore.getState().openTab('brand-new');

    expect(result).toEqual({ success: true, reason: 'replaced_empty_tab' });
    expect(strip()).toEqual(['busy-a', 'busy-b', 'busy-c', 'brand-new']);
  });
});
