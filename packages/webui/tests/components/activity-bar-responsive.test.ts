import { beforeEach, describe, expect, it } from 'vitest';
import {
  calculateDesktopActivityCapacity,
  PANEL_ORDER,
  splitDesktopActivityBarItems,
} from '@/components/activity-bar';
import {
  ACTIVITY_SHORTCUT_BY_KEY,
  ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY,
  navigateToView,
  openMainView,
  openPanel,
  pairedViewForActivity,
  showPanel,
} from '@/components/activity-bar/nav';
import { useUIStore } from '@/stores';

beforeEach(() => {
  const ui = useUIStore.getState();
  ui.selectActivity('chat');
  ui.setSidebarOpen(false);
  ui.setCurrentView('chat');
});

describe('ActivityBar desktop responsive overflow (compact / desktop shell)', () => {
  it('keeps core project workflow icons visible on very short desktop shells', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(320, true));

    // agents and history were removed from the icon bar; core is now 4 panels
    expect(split.visiblePanelIds).toEqual(['chat', 'files', 'changes', 'mailbox']);
    expect(split.overflowPanelIds).toContain('skills');
    expect(split.overflowViewIds).toContain('roster');
  });

  it('shows registered panels directly before hiding secondary views', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(520, true));

    expect(split.overflowPanelIds).toEqual([]);
    // At 520px compact: 10 slots → 6 panels + 4 views fit (roster…goal)
    expect(split.visibleViewIds).toContain('roster');
    expect(split.visibleViewIds).toContain('goal');
    expect(split.overflowViewIds).toContain('codemap');
  });

  it('promotes hidden panels and views when the desktop shell is tall enough', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(860, true));

    expect(split.overflowPanelIds).toEqual([]);
    expect(split.visibleViewIds).toContain('memory');
  });

  it('caps capacity at the total number of activity bar items', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(5000, true));

    expect(split.overflowPanelIds).toEqual([]);
    expect(split.overflowViewIds).toEqual([]);
  });
});

describe('ActivityBar responsive overflow (full / browser WebUI)', () => {
  it('keeps core panels visible on short browser viewports', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(400, false));

    // agents and history removed from icon bar; full-mode slot constants
    // allow 5 panels at 400px (chat, files, changes, mailbox, skills)
    expect(split.visiblePanelIds).toEqual(['chat', 'files', 'changes', 'mailbox', 'skills']);
    expect(split.overflowPanelIds).toContain('design');
    expect(split.overflowViewIds).toContain('memory');
  });

  it('shows all panels plus some views on a typical viewport', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(800, false));

    // 6 panels (worktrees/officemap moved into Changes/Roster; agents and
    // history removed) + remaining slots go to views
    expect(split.overflowPanelIds).toEqual([]);
    expect(split.visibleViewIds.length).toBeGreaterThanOrEqual(2);
    // Agent Roster is a primary surface — it must stay visible, not fall
    // into the "…" overflow menu (regression guard for the VIEWS reorder).
    expect(split.visibleViewIds).toContain('roster');
    expect(split.visibleViewIds).toContain('sddhub');
    expect(split.visibleViewIds).toContain('kanban');
  });

  it('shows all items on a tall viewport', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(1200, false));

    expect(split.overflowPanelIds).toEqual([]);
    expect(split.overflowViewIds).toEqual([]);
  });

  it('caps at total item count even on extremely tall viewports', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(5000, false));

    expect(split.overflowPanelIds).toEqual([]);
    expect(split.overflowViewIds).toEqual([]);
  });

  it('always keeps core panels visible even at very short heights', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(200, false));

    expect(split.visiblePanelIds).toEqual(['chat', 'files', 'changes', 'mailbox']);
    expect(split.overflowPanelIds).toContain('skills');
    expect(split.overflowViewIds.length).toBeGreaterThan(0);
  });
});

describe('ActivityBar navigation coupling', () => {
  it('keeps visible panels in sync with the navigation map', () => {
    // PANEL_ORDER reflects displayed panels only (agents/history elsewhere;
    // worktrees moved into the Changes panel, officemap into Agent Roster)
    expect(PANEL_ORDER).toEqual(['chat', 'files', 'changes', 'mailbox', 'skills', 'design']);
  });

  it('keeps panel shortcut labels and key routing in sync', () => {
    expect(ACTIVITY_SHORTCUT_BY_KEY).toEqual({
      '0': 'design',
      '1': 'chat',
      '2': 'files',
      '3': 'changes',
      '4': 'mailbox',
      '5': 'skills',
    });
    for (const activity of PANEL_ORDER) {
      expect(ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY[activity]).toBeTruthy();
    }
  });

  it.each([
    ['chat', 'chat'],
    ['agents', 'chat'],
    ['files', 'files'],
    ['changes', 'changes'],
    ['mailbox', 'mailbox'],
    ['skills', 'skill'],
    ['design', 'design-gallery'],
  ] as const)('pairs %s panel with %s main view', (activity, expectedView) => {
    expect(pairedViewForActivity(activity)).toBe(expectedView);
  });

  it('opens the matching main view when a panel is shown', () => {
    const ui = useUIStore.getState();
    ui.setCurrentView('settings');

    // history is now routed to chat
    showPanel('chat');

    expect(useUIStore.getState().activeActivity).toBe('chat');
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().currentView).toBe('chat');
  });

  it('returns no-wide-view panels to chat instead of leaving stale content open', () => {
    const ui = useUIStore.getState();
    ui.setCurrentView('skill');

    openPanel('chat');

    expect(useUIStore.getState().activeActivity).toBe('chat');
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().currentView).toBe('chat');
  });

  it('collapses stale side-panel content while opening standalone views', () => {
    showPanel('files');

    openMainView('settings');

    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(useUIStore.getState().currentView).toBe('settings');
  });

  it('returns from a standalone view to the chat panel on repeat click', () => {
    openMainView('settings');

    openMainView('settings');

    expect(useUIStore.getState().activeActivity).toBe('chat');
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().currentView).toBe('chat');
  });

  it('routes paired main views through their owning panel', () => {
    navigateToView('mailbox');

    expect(useUIStore.getState().activeActivity).toBe('mailbox');
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().currentView).toBe('mailbox');
  });

  it('closes the side-panel for unpaired utility views', () => {
    showPanel('files');

    navigateToView('debug');

    expect(useUIStore.getState().activeActivity).toBe('files');
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(useUIStore.getState().currentView).toBe('debug');
  });
});
