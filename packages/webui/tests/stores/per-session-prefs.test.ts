import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectSessionFleetTotals,
  selectSessionLeaderId,
  useFleetStore,
} from '../../src/stores/fleet-store';
import { useLocalPrefs } from '../../src/stores/local-prefs';

/**
 * Four tabs, four sets of settings.
 *
 * `autonomy`, `yolo`, the context strategy, the reasoning knobs and the prompt
 * variant are properties of a SESSION, not of the browser. The store kept one
 * flat copy of each, so tab 2 switching to `eternal` moved tab 1's picker, and
 * the server's echo of tab 2's snapshot overwrote whatever tab 1 had chosen.
 *
 * The shape that fixes it: the flat fields stay the EFFECTIVE view of the tab
 * in front (every existing reader keeps working and now describes the right
 * tab), with `bySession` holding each tab's overrides underneath.
 */

function resetPrefs() {
  useLocalPrefs.setState({
    autonomy: 'off',
    yolo: false,
    contextStrategy: 'hybrid',
    reasoningEffort: 'medium',
    bySession: {},
    sessionDefaults: {},
    activeSessionId: null,
  } as never);
}

describe('per-session preference overrides', () => {
  beforeEach(resetPrefs);

  it('keeps two tabs’ autonomy apart', () => {
    const prefs = useLocalPrefs.getState();

    prefs.bindSession('tab-1');
    useLocalPrefs.getState().set({ autonomy: 'eternal' });
    expect(useLocalPrefs.getState().autonomy).toBe('eternal');

    useLocalPrefs.getState().bindSession('tab-2');
    useLocalPrefs.getState().set({ autonomy: 'suggest' });
    expect(useLocalPrefs.getState().autonomy).toBe('suggest');

    // Back to tab 1: its own choice, not tab 2's.
    useLocalPrefs.getState().bindSession('tab-1');
    expect(useLocalPrefs.getState().autonomy).toBe('eternal');
  });

  it('leaves browser-wide preferences shared across tabs', () => {
    useLocalPrefs.getState().bindSession('tab-1');
    useLocalPrefs.getState().set({ chime: true });
    useLocalPrefs.getState().bindSession('tab-2');
    // `chime` is a property of this browser, not of a session — it must NOT
    // be partitioned, or a setting would appear to revert on every switch.
    expect(useLocalPrefs.getState().chime).toBe(true);
    expect(useLocalPrefs.getState().bySession['tab-1']?.chime).toBeUndefined();
  });

  it('a new tab inherits the last chosen defaults, then diverges', () => {
    useLocalPrefs.getState().bindSession('tab-1');
    useLocalPrefs.getState().set({ yolo: true });

    useLocalPrefs.getState().bindSession('tab-3');
    // Never seen before → starts from the current default, matching what the
    // server hands a freshly created session.
    expect(useLocalPrefs.getState().yolo).toBe(true);

    useLocalPrefs.getState().set({ yolo: false });
    useLocalPrefs.getState().bindSession('tab-1');
    expect(useLocalPrefs.getState().yolo).toBe(true);
  });

  it('a background tab’s server echo does not move the visible pickers', () => {
    useLocalPrefs.getState().bindSession('tab-1');
    useLocalPrefs.getState().set({ autonomy: 'off' });

    // tab-2 is in the background; the server echoes ITS snapshot.
    useLocalPrefs.getState().applyRemote({ autonomy: 'eternal' } as never, 'tab-2');

    expect(useLocalPrefs.getState().autonomy).toBe('off');
    expect(useLocalPrefs.getState().bySession['tab-2']?.autonomy).toBe('eternal');

    // …and it is there waiting when the user switches to it.
    useLocalPrefs.getState().bindSession('tab-2');
    expect(useLocalPrefs.getState().autonomy).toBe('eternal');
  });

  it('a project-wide echo still lands on everyone', () => {
    useLocalPrefs.getState().bindSession('tab-1');
    // The server splits its echo: untagged for project-wide keys.
    useLocalPrefs.getState().applyRemote({ indexOnStart: false } as never, undefined);
    expect(useLocalPrefs.getState().indexOnStart).toBe(false);
  });

  it('an echo addressed at the foreground tab applies to it', () => {
    useLocalPrefs.getState().bindSession('tab-1');
    useLocalPrefs.getState().applyRemote({ contextStrategy: 'selective' } as never, 'tab-1');
    expect(useLocalPrefs.getState().contextStrategy).toBe('selective');
    expect(useLocalPrefs.getState().bySession['tab-1']?.contextStrategy).toBe('selective');
  });

  it('forgets a closed tab so a reused id cannot inherit its settings', () => {
    useLocalPrefs.getState().bindSession('tab-4');
    useLocalPrefs.getState().set({ autonomy: 'auto' });
    expect(useLocalPrefs.getState().bySession['tab-4']).toBeDefined();

    useLocalPrefs.getState().forgetSession('tab-4');
    expect(useLocalPrefs.getState().bySession['tab-4']).toBeUndefined();
  });

  it('parks the foreground tab’s live values on the way out', () => {
    useLocalPrefs.getState().bindSession('tab-1');
    // A direct setState (what a picker bound straight to the flat field does)
    // must not be lost when the user switches away before the server echoes.
    useLocalPrefs.setState({ maxIterations: 7 } as never);
    useLocalPrefs.getState().bindSession('tab-2');
    useLocalPrefs.getState().bindSession('tab-1');
    expect(useLocalPrefs.getState().maxIterations).toBe(7);
  });
});

// ── Fleet accounting ──────────────────────────────────────────────────────

function agent(id: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    sessionId,
    status: 'running',
    startedAt: 0,
    costUsd: 0,
    ctxPct: 0,
    tokensIn: 0,
    tokensOut: 0,
    isLeader: false,
    ...extra,
  } as never;
}

describe('per-session fleet accounting', () => {
  beforeEach(() => {
    useFleetStore.getState().clear();
  });

  it('bills each tab only for its own subagents', () => {
    useFleetStore.setState({
      agents: new Map([
        ['a', agent('a', 'tab-1', { tokensIn: 100, tokensOut: 10, costUsd: 1 })],
        ['b', agent('b', 'tab-2', { tokensIn: 500, tokensOut: 50, costUsd: 5 })],
      ]),
    } as never);

    const s = useFleetStore.getState();
    expect(selectSessionFleetTotals(s, 'tab-1').tokensIn).toBe(100);
    expect(selectSessionFleetTotals(s, 'tab-1').tokensOut).toBe(10);
    expect(selectSessionFleetTotals(s, 'tab-2').tokensIn).toBe(500);
    // The old global counter is the SUM of both — which is what the Inspector
    // used to show as "this session's" fleet cost.
    expect(selectSessionFleetTotals(s, 'tab-1').totalCost).toBe(1);
  });

  it('reports no leader for a tab that has none', () => {
    useFleetStore.setState({
      agents: new Map([['a', agent('a', 'tab-1', { isLeader: true })]]),
      leaderId: 'a',
    } as never);

    const s = useFleetStore.getState();
    expect(selectSessionLeaderId(s, 'tab-1')).toBe('a');
    // The crown belongs to tab 1. Tab 2 asking must not get it.
    expect(selectSessionLeaderId(s, 'tab-2')).toBeUndefined();
  });

  it('promoting a leader in one tab does not demote another tab’s leader', () => {
    const fleet = useFleetStore.getState();
    fleet.applyEvent({ kind: 'leader_updated', subagentId: 'l1', sessionId: 'tab-1' } as never);
    fleet.applyEvent({ kind: 'leader_updated', subagentId: 'l2', sessionId: 'tab-2' } as never);

    const s = useFleetStore.getState();
    expect(selectSessionLeaderId(s, 'tab-1')).toBe('l1');
    expect(selectSessionLeaderId(s, 'tab-2')).toBe('l2');
  });

  it('a session with no agents reports zeroes rather than the fleet total', () => {
    useFleetStore.setState({
      agents: new Map([['a', agent('a', 'tab-1', { tokensIn: 999 })]]),
    } as never);
    const totals = selectSessionFleetTotals(useFleetStore.getState(), 'tab-9');
    expect(totals.tokensIn).toBe(0);
    expect(totals.total).toBe(0);
  });
});
