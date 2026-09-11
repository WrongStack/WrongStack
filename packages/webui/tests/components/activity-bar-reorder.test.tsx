import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  ActivityBar,
  applyLockedAnchors,
  moveItemId,
  resolveActivityOrder,
  splitDesktopActivityBarItems,
} from '@/components/activity-bar';
import { useUIStore } from '@/stores';
import type { ActivityBarOrder } from '@/stores/ui-store-types';

// Pure helpers ─────────────────────────────────────────────────────────

describe('activity-bar · reorder · pure helpers', () => {
  const defaults = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
  ];

  describe('resolveActivityOrder', () => {
    it('returns defaults when no custom order is provided', () => {
      expect(resolveActivityOrder(defaults, null)).toEqual(defaults);
      expect(resolveActivityOrder(defaults, undefined)).toEqual(defaults);
      expect(resolveActivityOrder(defaults, [])).toEqual(defaults);
    });

    it('reorders defaults to follow a valid custom order', () => {
      expect(resolveActivityOrder(defaults, ['c', 'a', 'b'])).toEqual([
        { id: 'c' },
        { id: 'a' },
        { id: 'b' },
        { id: 'd' },
      ]);
    });

    it('drops unknown ids, dedupes, and appends missing defaults', () => {
      expect(
        resolveActivityOrder(defaults, ['x', 'c', 'a', 'a', 'y', 'c']),
      ).toEqual([
        { id: 'c' },
        { id: 'a' },
        { id: 'b' },
        { id: 'd' },
      ]);
    });
  });

  describe('applyLockedAnchors', () => {
    const locked = new Set(['a', 'b']);

    it('pins locked ids at their default indices', () => {
      // User tries to drag `c` ahead of `a` and `b` — locked anchors
      // must stay first.
      const reordered = applyLockedAnchors(defaults, ['c', 'a', 'b'], locked);
      expect(reordered.map((d) => d.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('permutes only the movable subset', () => {
      // Drop `d` to second slot; locked `a`/`b` keep their positions; `c`
      // moves to the end.
      const reordered = applyLockedAnchors(
        defaults,
        ['b', 'd', 'a'],
        locked,
      );
      expect(reordered.map((d) => d.id)).toEqual(['a', 'b', 'd', 'c']);
    });

    it('filters out unknown ids from the movable subset', () => {
      const reordered = applyLockedAnchors(defaults, ['x', 'd', 'c'], locked);
      expect(reordered.map((d) => d.id)).toEqual(['a', 'b', 'd', 'c']);
    });
  });

  describe('moveItemId', () => {
    it('moves an id into another id slot, shifting intermediates', () => {
      expect(moveItemId(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual([
        'a',
        'd',
        'b',
        'c',
      ]);
    });

    it('is a no-op when from === to or ids are missing', () => {
      expect(moveItemId(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
      expect(moveItemId(['a', 'b', 'c'], 'a', 'z')).toEqual(['a', 'b', 'c']);
    });
  });
});

// splitDesktopActivityBarItems integration ──────────────────────────────

describe('activity-bar · splitDesktopActivityBarItems', () => {
  const PANELS: NonNullable<Parameters<typeof splitDesktopActivityBarItems>[1]> = [
    { id: 'chat', label: 'Session', icon: null! },
    { id: 'files', label: 'Files', icon: null! },
    { id: 'changes', label: 'Changes', icon: null! },
    { id: 'mailbox', label: 'Mailbox', icon: null! },
    { id: 'skills', label: 'Skills', icon: null! },
    { id: 'design', label: 'Design Studio', icon: null! },
  ];
  const VIEWS: NonNullable<Parameters<typeof splitDesktopActivityBarItems>[2]> = [
    { id: 'intake', label: 'Requirements', icon: null! },
    { id: 'sddhub', label: 'SDD', icon: null! },
    { id: 'goal', label: 'Goal', icon: null! },
    { id: 'kanban', label: 'Kanban', icon: null! },
    { id: 'roster', label: 'Agent Roster', icon: null! },
    { id: 'codemap', label: 'CodeMap', icon: null! },
    { id: 'techstack', label: 'TechStack', icon: null! },
    { id: 'history', label: 'Repository History', icon: null! },
    { id: 'chronicle', label: 'Chronicle', icon: null! },
    { id: 'prompts', label: 'Prompt Journal', icon: null! },
    { id: 'chimera', label: 'Chimera Reviews', icon: null! },
    { id: 'memory', label: 'Memory', icon: null! },
  ];

  it('matches the existing default-order behavior when no overrides are passed', () => {
    const split = splitDesktopActivityBarItems(10);
    expect(split.visiblePanelIds).toEqual([
      'chat',
      'files',
      'changes',
      'mailbox',
      'skills',
      'design',
    ]);
    // First four views by default order.
    expect(split.visibleViewIds.slice(0, 4)).toEqual([
      'intake',
      'sddhub',
      'goal',
      'kanban',
    ]);
  });

  it('honors a user-customized panel order with locked anchors', () => {
    // User dragged `design` and `skills` above `chat` — locked anchors
    // (`chat`/`files`/`changes`/`mailbox`) must remain first.
    const customPanels = applyLockedAnchors(
      PANELS,
      ['design', 'skills'],
      new Set(['chat', 'files', 'changes', 'mailbox']),
    );
    const split = splitDesktopActivityBarItems(20, customPanels, VIEWS);
    expect(split.visiblePanelIds.slice(0, 4)).toEqual([
      'chat',
      'files',
      'changes',
      'mailbox',
    ]);
    expect(split.visiblePanelIds).toContain('skills');
    expect(split.visiblePanelIds).toContain('design');
  });

  it('honors a user-customized view order (first-N slices follow custom)', () => {
    // User prioritizes `roster` at the top.
    const customViews = resolveActivityOrder(VIEWS, [
      'roster',
      'goal',
      'intake',
      'sddhub',
      'kanban',
      'codemap',
      'techstack',
      'history',
      'chronicle',
      'prompts',
      'chimera',
      'memory',
    ]);
    // 10 slots → 6 panels + 4 views; first 4 views follow the user-customized
    // order, which now leads with `roster`.
    const split = splitDesktopActivityBarItems(10, PANELS, customViews);
    expect(split.visiblePanelIds.length).toBe(6);
    expect(split.visibleViewIds.slice(0, 4)).toEqual([
      'roster',
      'goal',
      'intake',
      'sddhub',
    ]);
  });
});

// Store wiring ────────────────────────────────────────────────────────

describe('activity-bar · store wiring (setActivityBarOrder + persist v8)', () => {
  beforeEach(() => {
    act(() => {
      useUIStore.setState({ activityBarOrder: null });
    });
  });

  it('exposes a default null order and a setter in the store', () => {
    expect(useUIStore.getState().activityBarOrder).toBeNull();
    expect(typeof useUIStore.getState().setActivityBarOrder).toBe('function');
  });

  it('persists the custom order via setState and clears it on null', () => {
    const order: ActivityBarOrder = {
      panels: ['design', 'skills'],
      views: ['roster', 'goal', 'intake', 'sddhub'],
    };
    act(() => {
      useUIStore.getState().setActivityBarOrder(order);
    });
    expect(useUIStore.getState().activityBarOrder).toEqual(order);
    act(() => {
      useUIStore.getState().setActivityBarOrder(null);
    });
    expect(useUIStore.getState().activityBarOrder).toBeNull();
  });

  it('partialize includes activityBarOrder so it survives localStorage', () => {
    // Use zustand persist's getOptions() instead of importing the
    // persist module directly (which is internal scaffolding).
    const persist = (useUIStore as unknown as {
      persist: { getOptions: () => Record<string, unknown> };
    }).persist;
    const opts = persist.getOptions() as {
      version?: number;
      partialize?: (s: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(opts.version).toBe(8);
    expect(opts.partialize).toBeDefined();
    const partial = opts.partialize!({ activityBarOrder: 'oops' });
    expect(partial).toHaveProperty('activityBarOrder', 'oops');
  });

  it('migrate (v8) defensively coerces a hand-edited order payload', () => {
    const persist = (useUIStore as unknown as {
      persist: {
        getOptions: () => {
          migrate?: (p: Record<string, unknown>, version: number) => Record<string, unknown>;
        };
      };
    }).persist;
    const migrate = persist.getOptions().migrate;
    expect(typeof migrate).toBe('function');
    const out = migrate!(
      { activityBarOrder: { panels: ['invalid'], views: ['chat'] } },
      7,
    );
    // 'invalid' is not in `ACTIVITIES` → dropped; 'chat' is a valid view
    // and survives `coerceView`, so the migrate keeps a valid (though
    // bizarre) user-visible object instead of nulling it outright.
    // Only fully-unknown or unparseable shapes resolve to null:
    expect(out.activityBarOrder).toEqual({ panels: [], views: ['chat'] });
    // Fully-bogus payloads (non-objects) are normalized to null so the
    // component's `customOrder?.[group]` access never reads a string.
    const fullyBogus = migrate!(
      { activityBarOrder: 'not-an-object' },
      7,
    );
    expect(fullyBogus.activityBarOrder).toBeNull();
  });
});

// Component UI smoke ───────────────────────────────────────────────────

describe('activity-bar · reorder · UI mode toggles', () => {
  beforeEach(() => {
    act(() => {
      useUIStore.setState({
        activityBarOrder: null,
        activeActivity: 'chat',
        currentView: 'chat',
        sidebarOpen: true,
      });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the Edit pencil by default and reveals Done/Reset when entered', () => {
    render(<ActivityBar />);
    expect(screen.queryByTestId('activity-bar-reorder-edit')).toBeTruthy();
    expect(screen.queryByTestId('activity-bar-reorder-done')).toBeNull();

    act(() => {
      screen.getByTestId('activity-bar-reorder-edit').click();
    });
    expect(screen.queryByTestId('activity-bar-reorder-edit')).toBeNull();
    expect(screen.queryByTestId('activity-bar-reorder-done')).toBeTruthy();
    expect(screen.queryByTestId('activity-bar-reorder-reset')).toBeTruthy();
  });

  it('Reset writes null to the store and exits reorder mode', () => {
    act(() => {
      useUIStore.getState().setActivityBarOrder({
        panels: ['design'],
        views: [],
      });
    });
    render(<ActivityBar />);
    act(() => {
      screen.getByTestId('activity-bar-reorder-edit').click();
    });
    act(() => {
      screen.getByTestId('activity-bar-reorder-reset').click();
    });
    expect(useUIStore.getState().activityBarOrder).toBeNull();
    expect(screen.queryByTestId('activity-bar-reorder-edit')).toBeTruthy();
  });

  it('exits reorder mode on Done and preserves the user order', () => {
    const order: ActivityBarOrder = {
      panels: ['design', 'skills'],
      views: ['goal', 'intake', 'roster', 'kanban'],
    };
    act(() => {
      useUIStore.getState().setActivityBarOrder(order);
    });
    render(<ActivityBar />);
    act(() => {
      screen.getByTestId('activity-bar-reorder-edit').click();
    });
    // jsdom does not implement HTML5 DnD (no usable DataTransfer), so we
    // exercise Done — the on-screen reset+drag path is exercised in the
    // other helpers/store tests above.
    act(() => {
      screen.getByTestId('activity-bar-reorder-done').click();
    });
    expect(screen.queryByTestId('activity-bar-reorder-edit')).toBeTruthy();
    expect(useUIStore.getState().activityBarOrder).toEqual(order);
  });
});
