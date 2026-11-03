import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityBar } from '@/components/activity-bar';
import {
  ACTIVITY_BAR_MAX_ICONS,
  createPinDraft,
  defaultPinnedIds,
  draftToOrder,
  isAtBudget,
  movePinned,
  pinnedCount,
  pinnedOrder,
  togglePin,
  unpinnedOrder,
} from '@/components/activity-bar/activity-bar-pins';
import { useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';

// Pure helpers ─────────────────────────────────────────────────────────

describe('activity-bar · pin model', () => {
  it('seeds the default selection inside the icon budget', () => {
    const calm = defaultPinnedIds('calm');
    const full = defaultPinnedIds('full');
    expect(calm.panels).toEqual(['chat', 'files', 'changes', 'mailbox', 'skills', 'design']);
    // Calm keeps the compact default (four views); full fills the budget.
    expect(calm.views).toHaveLength(4);
    expect(full.panels.length + full.views.length).toBe(ACTIVITY_BAR_MAX_ICONS);
    expect(full.panels.length + full.views.length).toBeLessThanOrEqual(ACTIVITY_BAR_MAX_ICONS);
  });

  it('pins and unpins views, but never unpins a fixed panel', () => {
    const draft = createPinDraft(null, defaultPinnedIds('full'));
    const withoutGoal = togglePin(draft, 'views', 'goal');
    expect(pinnedOrder(withoutGoal, 'views')).not.toContain('goal');
    expect(unpinnedOrder(withoutGoal, 'views')).toContain('goal');

    const withGoal = togglePin(withoutGoal, 'views', 'goal');
    expect(pinnedOrder(withGoal, 'views')).toContain('goal');

    // 'chat' is fixed — the toggle is a no-op.
    expect(togglePin(withGoal, 'panels', 'chat')).toBe(withGoal);
  });

  it('refuses to pin beyond the icon budget', () => {
    const draft = createPinDraft(null, defaultPinnedIds('full'));
    expect(isAtBudget(draft)).toBe(true);
    const next = togglePin(draft, 'views', 'chronicle');
    expect(next).toBe(draft);
    expect(pinnedCount(draft)).toBe(ACTIVITY_BAR_MAX_ICONS);
  });

  it('moves a pinned view one slot up or down without touching the others', () => {
    const draft = createPinDraft(null, defaultPinnedIds('full'));
    const views = pinnedOrder(draft, 'views');
    const second = views[1]!;
    const moved = movePinned(draft, 'views', second, -1);
    expect(pinnedOrder(moved, 'views')[0]).toBe(second);
    // The unpinned tail keeps its order.
    expect(unpinnedOrder(moved, 'views')).toEqual(unpinnedOrder(draft, 'views'));
  });

  it('serializes the draft into the persisted store payload', () => {
    const draft = createPinDraft(null, defaultPinnedIds('calm'));
    const order = draftToOrder(draft);
    expect(order.pinned?.panels).toEqual(defaultPinnedIds('calm').panels);
    expect(order.pinned?.views).toEqual(defaultPinnedIds('calm').views);
    // The full order (pinned + unpinned) is preserved so unpinning and
    // re-pinning keeps the user's ordering.
    expect(order.panels.length).toBe(6);
    expect(order.views.length).toBeGreaterThan(order.pinned?.views.length ?? 0);
  });

  it('locks fixed panels at top indices, dedupes seeds, and prevents moving movable panels above fixed panels', () => {
    const draft = createPinDraft(
      { panels: ['design', 'skills'], views: [] },
      { panels: ['skills', 'skills'], views: ['roster', 'roster'] },
    );
    expect(draft.panels).toEqual(['chat', 'files', 'changes', 'mailbox', 'design', 'skills']);
    expect(pinnedOrder(draft, 'panels')).toEqual(['chat', 'files', 'changes', 'mailbox', 'skills']);
    expect(pinnedOrder(draft, 'views')).toEqual(['roster']);
    expect(movePinned(draft, 'panels', 'skills', -1)).toBe(draft);
  });
});

// Component behaviour ─────────────────────────────────────────────────

describe('activity-bar · customize dialog behaviour', () => {
  beforeEach(() => {
    act(() => {
      useUIStore.setState({
        activityBarOrder: null,
        activeActivity: 'chat',
        currentView: 'chat',
        sidebarOpen: true,
      });
    });
    useLocalPrefs.setState({ chromeLevel: 'full' });
  });

  afterEach(() => {
    cleanup();
    useLocalPrefs.setState({ chromeLevel: 'calm' });
  });

  const openDialog = () => {
    render(<ActivityBar />);
    act(() => {
      screen.getByTestId('activity-bar-reorder-edit').click();
    });
  };

  /** The last button of a pinned row is the "remove from the bar" action. */
  const clickUnpin = (id: string) => {
    act(() => {
      const buttons = screen.getByTestId(`customize-pinned-${id}`).querySelectorAll('button');
      buttons[buttons.length - 1]!.click();
    });
  };

  const clickSave = () => {
    act(() => {
      const save = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Save',
      );
      expect(save).toBeTruthy();
      save!.click();
    });
  };

  it('lists the pinned icons on one side and the rest on the other', () => {
    openDialog();
    expect(screen.getByTestId('customize-pinned-roster')).toBeTruthy();
    expect(screen.getByTestId('customize-pinned-chat')).toBeTruthy();
    // A view outside the default selection lands in the "others" column.
    expect(screen.getByTestId('customize-other-chronicle')).toBeTruthy();
  });

  it('moves an icon between the two columns', () => {
    openDialog();
    clickUnpin('roster');
    expect(screen.queryByTestId('customize-pinned-roster')).toBeNull();
    expect(screen.getByTestId('customize-other-roster')).toBeTruthy();
  });

  it('saves the selection and refreshes the rail immediately', () => {
    const { container } = render(<ActivityBar />);
    expect(container.querySelector('button[aria-label="Goal"]')).not.toBeNull();

    act(() => {
      screen.getByTestId('activity-bar-reorder-edit').click();
    });
    clickUnpin('goal');
    clickSave();

    // The store holds the new selection…
    expect(useUIStore.getState().activityBarOrder?.pinned?.views).not.toContain('goal');
    // …and the rail dropped the icon without a reload.
    expect(container.querySelector('button[aria-label="Goal"]')).toBeNull();
    // The dialog closed on save.
    expect(screen.queryByTestId('activity-bar-customize-dialog')).toBeNull();
  });

  it('keeps an unpinned view reachable in the overflow menu', () => {
    const { container } = render(<ActivityBar />);
    act(() => {
      screen.getByTestId('activity-bar-reorder-edit').click();
    });
    clickUnpin('goal');
    clickSave();

    // The rail no longer shows it…
    expect(container.querySelector('button[aria-label="Goal"]')).toBeNull();
    // …but the "…" menu is still there to reach the hidden item.
    expect(container.querySelector('button[aria-label^="More"]')).toBeTruthy();
  });

  it('never offers to unpin a fixed panel', () => {
    openDialog();
    const fixedRow = screen.getByTestId('customize-pinned-chat');
    const enabled = Array.from(fixedRow.querySelectorAll('button')).filter(
      (button) => !(button as HTMLButtonElement).disabled,
    );
    expect(enabled).toHaveLength(0);
  });

  it('renders exactly the pinned icons on the rail', () => {
    act(() => {
      useUIStore.getState().setActivityBarOrder({
        panels: ['chat', 'files', 'changes', 'mailbox'],
        views: ['goal', 'roster'],
        pinned: {
          panels: ['chat', 'files', 'changes', 'mailbox'],
          views: ['goal', 'roster'],
        },
      });
    });
    const { container } = render(<ActivityBar />);
    const labels = Array.from(container.querySelectorAll('.ws-nav-button')).map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(labels).toContain('Goal');
    expect(labels).toContain('Agent Roster');
    // Views outside the selection are gone from the rail…
    expect(labels).not.toContain('Kanban');
    expect(labels).not.toContain('Memory');
    // …and the panels that were not pinned are gone as well.
    expect(labels.some((label) => label?.startsWith('Skills'))).toBe(false);
  });

  it('never shows more icons than the budget allows', () => {
    const { container } = render(<ActivityBar />);
    const labels = Array.from(container.querySelectorAll('.ws-activity-rail .ws-nav-button')).map(
      (el) => el.getAttribute('aria-label'),
    );
    // Panels + views only — the launcher and the "…" button are chrome.
    const contentIcons = labels.filter((label) => label !== null).length;
    expect(contentIcons).toBeLessThanOrEqual(ACTIVITY_BAR_MAX_ICONS + 2);
  });
});
