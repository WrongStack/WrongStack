/**
 * The composer's Subagents control: what it summarises, and what it writes.
 *
 * The write is the part worth freezing — the plan is a session-scoped pref, so
 * every edit has to travel as the WHOLE object (the pref channel replaces, it
 * does not deep-merge) and go out on `prefs.update`, which stamps the calling
 * tab's session. A partial write here would silently drop the sibling lanes.
 *
 * Per-lane selection now opens `SubagentModelPickerDialog` (the same flat
 * searchable picker the main chat's Cmd/Ctrl+M uses). The tests here cover
 * the toolbar surface — the dialog itself is tested in
 * `subagent-model-picker-dialog.test.tsx`.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updatePrefs = vi.fn();

vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ updatePrefs }) }));
vi.mock('@/stores/session-store', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ session: { provider: 'anthropic', model: 'claude-sonnet-5' } }),
}));

// Stub the dialog so the toolbar tests don't pull in Radix/portal machinery.
// The stub exposes `onPick` as a data attribute + an auto-fire button so
// toolbar tests can simulate the dialog committing a pick (this is the
// `onPick → setLane → patch → updatePrefs` write path the chimera-review
// flagged as having zero coverage).
vi.mock('../../../src/components/ChatInput/subagent-model-picker-dialog', () => ({
  SubagentModelPickerDialog: (props: {
    laneIndex: number;
    currentLane: Record<string, string | undefined>;
    onPick: (pick: { provider: string; model: string } | null) => void;
  }) => (
    <div
      data-testid="lane-picker-dialog"
      data-lane-index={props.laneIndex}
      data-current-provider={props.currentLane.provider ?? ''}
      data-current-tier={props.currentLane.tier ?? ''}
      data-current-profile={props.currentLane.fallbackProfile ?? ''}
    >
      <button type="button" data-testid="lane-picker-pick" onClick={() => props.onPick({ provider: 'openai', model: 'gpt-5' })}>
        pick
      </button>
      <button type="button" data-testid="lane-picker-clear" onClick={() => props.onPick(null)}>
        clear
      </button>
    </div>
  ),
}));

const prefsState = {
  subagentModelPlan: { enabled: true, lock: true, followSessionModel: false, slots: [] as never[] },
  set: vi.fn(),
};

vi.mock('@/stores/local-prefs', () => ({
  useLocalPrefs: Object.assign((selector: (state: unknown) => unknown) => selector(prefsState), {
    getState: () => prefsState,
  }),
}));

import { SubagentModelsButton } from '../../../src/components/ChatInput/subagent-models-button';

beforeEach(() => {
  updatePrefs.mockClear();
  prefsState.set.mockClear();
  prefsState.subagentModelPlan = {
    enabled: true,
    lock: true,
    followSessionModel: false,
    slots: [] as never[],
  };
});
afterEach(cleanup);

function openPopover() {
  render(<SubagentModelsButton />);
  fireEvent.click(screen.getByRole('button', { expanded: false }));
}

describe('SubagentModelsButton', () => {
  it('summarises an untouched plan as auto', () => {
    render(<SubagentModelsButton />);
    expect(screen.getByText('auto')).toBeTruthy();
  });

  it('summarises pinned lanes by count', () => {
    prefsState.subagentModelPlan = {
      enabled: true,
      lock: true,
      followSessionModel: false,
      slots: [{ provider: 'openai', model: 'gpt-5' }, {}] as never,
    };
    render(<SubagentModelsButton />);
    expect(screen.getByText('1 lane')).toBeTruthy();
  });

  it('summarises the follow-session switch', () => {
    prefsState.subagentModelPlan = {
      enabled: true,
      lock: true,
      followSessionModel: true,
      slots: [] as never[],
    };
    render(<SubagentModelsButton />);
    expect(screen.getByText('session model')).toBeTruthy();
  });

  it('shows the session model as the switch target', () => {
    openPopover();
    expect(screen.getByText('anthropic/claude-sonnet-5')).toBeTruthy();
  });

  it('writes the whole plan when the switch is flipped', () => {
    openPopover();
    fireEvent.click(screen.getByRole('checkbox', { name: /use my model/i }));

    expect(updatePrefs).toHaveBeenCalledTimes(1);
    const payload = updatePrefs.mock.calls[0]?.[0] as {
      subagentModelPlan: { followSessionModel: boolean; lock: boolean; slots: unknown[] };
    };
    expect(payload.subagentModelPlan.followSessionModel).toBe(true);
    // Siblings travel with it, and the eight default lanes are materialised
    // rather than sent as an empty list.
    expect(payload.subagentModelPlan.lock).toBe(true);
    expect(payload.subagentModelPlan.slots).toHaveLength(8);
    expect(prefsState.set).toHaveBeenCalled();
  });

  it('opens the lane picker dialog with the right lane index', () => {
    openPopover();
    // Lane 2's button now opens the dialog instead of being a <select>.
    fireEvent.click(screen.getByRole('button', { name: /Lane 2 model/i }));
    expect(screen.getByTestId('lane-picker-dialog').getAttribute('data-lane-index')).toBe('1');
  });

  it('writes a lane pin when the dialog commits a pick', () => {
    openPopover();
    // Open lane 2's dialog.
    fireEvent.click(screen.getByRole('button', { name: /Lane 2 model/i }));
    // The stub dialog's "pick" button fires onPick({provider, model}).
    fireEvent.click(screen.getByTestId('lane-picker-pick'));

    expect(updatePrefs).toHaveBeenCalledTimes(1);
    const payload = updatePrefs.mock.calls[0]?.[0] as {
      subagentModelPlan: {
        lock: boolean;
        followSessionModel: boolean;
        slots: Array<Record<string, string>>;
      };
    };
    // The whole plan travels — lock + followSessionModel siblings are intact,
    // and lane #1 (index 1) is the one that was edited.
    expect(payload.subagentModelPlan.lock).toBe(true);
    expect(payload.subagentModelPlan.followSessionModel).toBe(false);
    expect(payload.subagentModelPlan.slots).toHaveLength(8);
    expect(payload.subagentModelPlan.slots[1]).toEqual({ provider: 'openai', model: 'gpt-5' });
    // The other lanes are unchanged.
    expect(payload.subagentModelPlan.slots[0]).toEqual({});
    expect(prefsState.set).toHaveBeenCalled();
    // The dialog closed (stub unmounts because pickerLane is reset to null).
    expect(screen.queryByTestId('lane-picker-dialog')).toBeNull();
  });

  it('clears a lane when the dialog commits null', () => {
    // Start with one lane pinned.
    prefsState.subagentModelPlan = {
      enabled: true,
      lock: true,
      followSessionModel: false,
      slots: [{ provider: 'openai', model: 'gpt-5' }, {}] as never,
    };
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: /Lane 1 model/i }));
    fireEvent.click(screen.getByTestId('lane-picker-clear'));

    const payload = updatePrefs.mock.calls[0]?.[0] as {
      subagentModelPlan: { slots: Array<Record<string, string>> };
    };
    expect(payload.subagentModelPlan.slots[0]).toEqual({});
  });

  it('passes legacy tier/profile pins to the dialog so the banner can surface them', () => {
    prefsState.subagentModelPlan = {
      enabled: true,
      lock: true,
      followSessionModel: false,
      slots: [{ tier: 'budget' }] as never,
    };
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: /Lane 1 model/i }));
    // The stub dialog renders the tier on a data attribute for the test to read.
    expect(screen.getByTestId('lane-picker-dialog').getAttribute('data-current-tier')).toBe('budget');
    expect(screen.getByTestId('lane-picker-dialog').getAttribute('data-current-provider')).toBe('');
  });

  it('closes on Escape', () => {
    openPopover();
    expect(screen.getByText('Subagent models')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Subagent models')).toBeNull();
  });
});
