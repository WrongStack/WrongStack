// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useTabTitle } from '../src/hooks/use-tab-title.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Behavior coverage for the `useTabTitle` hook: the tab strip must show the
 * unread mailbox count and running presence, recompute on prop changes, and
 * restore the exact base title when idle or unmounted.
 *
 * Harness mirrors the sibling hook tests: jsdom + real `createRoot` + `act`,
 * no testing-library dependency.
 */

const BASE_TITLE = 'WrongStack SimpleUI';

interface TabTitleProps {
  running: boolean;
  unreadCount: number;
}

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  document.title = '';
});

function mountHook(initial: TabTitleProps): { root: Root; set: (next: TabTitleProps) => void } {
  let current = initial;
  function Probe(): null {
    useTabTitle(current);
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  roots.push(root);
  return {
    root,
    set(next: TabTitleProps): void {
      current = next;
      act(() => {
        root.render(<Probe />);
      });
    },
  };
}

describe('useTabTitle', () => {
  it('shows the exact base title when idle and caught up', () => {
    mountHook({ running: false, unreadCount: 0 });
    expect(document.title).toBe(BASE_TITLE);
  });

  it('marks a running session with the ● marker', () => {
    mountHook({ running: true, unreadCount: 0 });
    expect(document.title).toBe(`● ${BASE_TITLE}`);
  });

  it('prefixes the unread mailbox count', () => {
    mountHook({ running: false, unreadCount: 3 });
    expect(document.title).toBe(`(3) ${BASE_TITLE}`);
  });

  it('combines unread count and running marker', () => {
    mountHook({ running: true, unreadCount: 3 });
    expect(document.title).toBe(`(3) ● ${BASE_TITLE}`);
  });

  it('never shows a prefix for zero or negative unread counts', () => {
    mountHook({ running: false, unreadCount: -2 });
    expect(document.title).toBe(BASE_TITLE);
  });

  it('recomputes when props change', () => {
    const h = mountHook({ running: true, unreadCount: 1 });
    expect(document.title).toBe(`(1) ● ${BASE_TITLE}`);
    h.set({ running: false, unreadCount: 0 });
    expect(document.title).toBe(BASE_TITLE);
  });

  it('restores the base title on unmount', () => {
    const h = mountHook({ running: true, unreadCount: 5 });
    expect(document.title).toBe(`(5) ● ${BASE_TITLE}`);
    act(() => h.root.unmount());
    expect(document.title).toBe(BASE_TITLE);
  });
});
