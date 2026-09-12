/**
 * The composer's Subagents control: what it summarises, and what it writes.
 *
 * The write is the part worth freezing — the plan is a session-scoped pref, so
 * every edit has to travel as the WHOLE object (the pref channel replaces, it
 * does not deep-merge) and go out on `prefs.update`, which stamps the calling
 * tab's session. A partial write here would silently drop the sibling lanes.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updatePrefs = vi.fn();

vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ updatePrefs }) }));
vi.mock('@/hooks/useProviderModels', () => ({
  useProviderModels: () => [
    { provider: 'anthropic', model: 'claude-opus-5', label: 'Opus' },
    { provider: 'openai', model: 'gpt-5', label: 'GPT-5' },
  ],
}));
vi.mock('@/stores/session-store', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ session: { provider: 'anthropic', model: 'claude-sonnet-5' } }),
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

  it('writes a lane pin without disturbing the other lanes', () => {
    openPopover();
    fireEvent.change(screen.getByLabelText('Lane 2 model'), {
      target: { value: 'openai/gpt-5' },
    });

    const payload = updatePrefs.mock.calls[0]?.[0] as {
      subagentModelPlan: { slots: Array<Record<string, string>> };
    };
    expect(payload.subagentModelPlan.slots[1]).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(payload.subagentModelPlan.slots[0]).toEqual({});
    expect(payload.subagentModelPlan.slots).toHaveLength(8);
  });

  it('round-trips a lane pinned to a tier elsewhere', () => {
    // The passthrough <option> re-offers a value another surface set. Parsing
    // it as a bare model id would rewrite `tier:budget` into a model name.
    prefsState.subagentModelPlan = {
      enabled: true,
      lock: true,
      followSessionModel: false,
      slots: [{ tier: 'budget' }] as never,
    };
    openPopover();
    fireEvent.change(screen.getByLabelText('Lane 1 model'), {
      target: { value: 'tier:budget' },
    });

    const payload = updatePrefs.mock.calls[0]?.[0] as {
      subagentModelPlan: { slots: Array<Record<string, string>> };
    };
    expect(payload.subagentModelPlan.slots[0]).toEqual({ tier: 'budget' });
  });

  it('closes on Escape', () => {
    openPopover();
    expect(screen.getByText('Subagent models')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Subagent models')).toBeNull();
  });
});
