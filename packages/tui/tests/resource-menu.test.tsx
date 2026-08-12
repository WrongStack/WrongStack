import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { isPickerOverlayOpen } from '../src/app-ui-state.js';
import { ResourceMenu } from '../src/components/resource-menu.js';
import type { ResourceMenuSnapshot } from '../src/ui-contracts.js';
import { createAppJourney, waitForJourney } from './helpers/app-journey-harness.js';
import { createTestState } from './helpers/create-test-state.js';

const SNAPSHOT: ResourceMenuSnapshot = {
  id: 'provider-status',
  title: 'Provider health',
  subtitle: '1 healthy · 1 blocked',
  items: [
    {
      id: 'openai/gpt-test',
      label: 'openai/gpt-test',
      status: 'good',
      summary: 'healthy',
      details: [
        { label: 'successes', value: '12' },
        { label: 'failures', value: '0' },
      ],
    },
    {
      id: 'anthropic/claude-test',
      label: 'anthropic/claude-test',
      status: 'bad',
      summary: 'blocked',
      details: [
        { label: 'failures', value: '3' },
        { label: 'cooldown', value: '2 minutes' },
      ],
      body: 'Rate limited by provider.',
      actions: [
        { key: 'r', label: 'retry now', command: '/provider-status retry anthropic claude-test' },
        {
          key: 'x',
          label: 'clear history',
          command: '/provider-status clear anthropic claude-test',
          confirm: true,
        },
      ],
    },
  ],
};

describe('ResourceMenu', () => {
  it('renders list, focused detail, status, body, and actions in two panes', () => {
    const view = render(
      React.createElement(ResourceMenu, {
        snapshot: SNAPSHOT,
        selected: 1,
        columns: 110,
        maxRows: 16,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Provider health');
    expect(frame.match(/anthropic\/claude-test/g)).toHaveLength(2);
    expect(frame).toContain('cooldown: 2 minutes');
    expect(frame).toContain('Rate limited by provider.');
    expect(frame).toContain('r retry now · x clear history');
    view.unmount();
  });

  it('wraps reducer navigation and tracks confirmation state', () => {
    let state = reducer(createTestState(), { type: 'resourceMenuOpen', snapshot: SNAPSHOT });
    expect(isPickerOverlayOpen(state)).toBe(true);
    state = reducer(state, { type: 'resourceMenuMove', delta: -1 });
    expect(state.resourceMenu.selected).toBe(1);
    const action = SNAPSHOT.items[1]?.actions?.[1];
    state = reducer(state, { type: 'resourceMenuConfirm', action });
    expect(state.resourceMenu.pendingAction?.confirm).toBe(true);
    state = reducer(state, { type: 'resourceMenuClose' });
    expect(state.resourceMenu).toMatchObject({ open: false, snapshot: null, selected: 0 });
  });

  it('filters across labels and detail values', () => {
    const view = render(
      React.createElement(ResourceMenu, {
        snapshot: SNAPSHOT,
        selected: 0,
        filter: 'cooldown',
        filtering: true,
        columns: 110,
        maxRows: 16,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('1/2');
    expect(frame).toContain('anthropic/claude-test');
    expect(frame).not.toContain('openai/gpt-test');
    view.unmount();
  });

  it('opens the host snapshot for a bare operational command', async () => {
    const journey = createAppJourney();
    const view = journey.mount({ getResourceMenu: async () => SNAPSHOT });
    await waitForJourney(() => journey.props.slashRegistry.ownerOf('provider-status') === 'tui');
    const result = await journey.props.slashRegistry.dispatch('/provider-status', {} as never);
    expect(result?.message).toBeUndefined();
    await waitForJourney(() => (view.lastFrame() ?? '').includes('anthropic/claude-test'));
    expect(view.lastFrame() ?? '').toContain('Provider health');
    view.unmount();
  });

  it('delegates typed operational subcommands to the canonical handler', async () => {
    const journey = createAppJourney();
    const run = vi.fn().mockResolvedValue({ message: 'canonical git status' });
    journey.props.slashRegistry.register({ name: 'git', description: 'Git', run });
    const view = journey.mount({ getResourceMenu: async () => SNAPSHOT });
    await waitForJourney(() => journey.props.slashRegistry.ownerOf('git') === 'tui');

    const result = await journey.props.slashRegistry.dispatch('/git status', {} as never);
    expect(run).toHaveBeenCalledWith('status', expect.anything());
    expect(result?.message).toBe('canonical git status');
    view.unmount();
  });
});
