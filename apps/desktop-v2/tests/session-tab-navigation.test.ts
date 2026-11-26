// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/model';
import { SessionWorkbench } from '../src/SessionWorkbench';
import { nextSessionAfterDetach } from '../src/session-layout';
import { nextRovingIndex } from '../src/session-tab-navigation';
import type { DesktopController } from '../src/useDesktop';

vi.mock('../src/TerminalPane', () => ({ TerminalPane: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessions: Session[] = ['a', 'b', 'c'].map((id, i) => ({
  id,
  projectId: 'p1',
  title: `Session ${id}`,
  kind: 'terminal',
  workdir: '/repo',
  status: 'running',
  createdAt: i,
  updatedAt: i,
  exitCode: null,
  error: null,
}));

// Mutable render state, driven like the app's useDesktop: closeSessionTab removes the
// tab and re-selects the session that takes its place.
const state: { open: string[]; active: string } = { open: ['a', 'b', 'c'], active: 'a' };
const jumps = vi.fn();
const closes = vi.fn();
let host: HTMLElement | undefined;
let root: Root | undefined;

function buildVm(): DesktopController {
  const current = sessions.find((s) => s.id === state.active);
  return {
    snapshot: {
      projects: [{ id: 'p1', name: 'Repo', root: '/repo', createdAt: 1 }],
      sessions,
    },
    currentSession: current,
    openSessionIds: state.open,
    jumpToSession: (s: Session) => {
      jumps(s.id);
      // Mirror useDesktop: opening a session selects it and adds its tab when missing.
      state.open = state.open.includes(s.id) ? state.open : [...state.open, s.id];
      state.active = s.id;
    },
    closeSessionTab: (id: string) => {
      closes(id);
      const next = nextSessionAfterDetach(state.open, state.active, id);
      state.open = state.open.filter((candidate) => candidate !== id);
      state.active = next ?? state.open[0] ?? '';
      // The test re-renders explicitly, the way the real parent does after this update.
    },
    reportError: () => undefined,
    run: () => undefined,
    getDraft: () => '',
    setDraft: () => undefined,
    newSession: () => undefined,
  } as unknown as DesktopController;
}

function renderNow() {
  return act(async () => {
    root?.render(createElement(SessionWorkbench, { vm: buildVm() }));
    // Flush the lazy TerminalPane import inside act so its resolution counts as an event.
    await Promise.resolve();
  });
}

async function mount(open: string[] = state.open, active: string = state.active) {
  state.open = open;
  state.active = active;
  const el = document.createElement('div');
  document.body.append(el);
  host = el;
  await act(async () => {
    root = createRoot(el);
    root.render(createElement(SessionWorkbench, { vm: buildVm() }));
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  jumps.mockClear();
  closes.mockClear();
  state.open = ['a', 'b', 'c'];
  state.active = 'a';
});

const label = (id: string) =>
  host!.querySelector<HTMLButtonElement>(`[data-session-id="${id}"] .session-tab-label`)!;
const tabIndex = (id: string) => label(id).getAttribute('tabindex');
const press = (id: string, key: string) => {
  act(() =>
    label(id).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  );
};
const focused = () => document.activeElement;
const clickClose = (id: string) =>
  act(() =>
    host!
      .querySelector<HTMLButtonElement>(`[data-session-id="${id}"] .session-tab-close`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );

describe('roving tab index math', () => {
  it('moves right and left with wraparound', () => {
    expect(nextRovingIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextRovingIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextRovingIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextRovingIndex('ArrowLeft', 1, 3)).toBe(0);
  });

  it('jumps to the ends, holds a single tab, and ignores other keys', () => {
    expect(nextRovingIndex('Home', 1, 3)).toBe(0);
    expect(nextRovingIndex('End', 1, 3)).toBe(2);
    expect(nextRovingIndex('ArrowRight', 0, 1)).toBe(0);
    expect(nextRovingIndex('ArrowDown', 0, 3)).toBe(-1);
    expect(nextRovingIndex('ArrowRight', 0, 0)).toBe(-1);
  });
});

describe('the session tab strip keyboard model', () => {
  it('makes the active tab the only Tab stop and drops the close buttons', async () => {
    await mount(['a', 'b', 'c'], 'b');
    expect(tabIndex('b')).toBe('0');
    expect(tabIndex('a')).toBe('-1');
    expect(tabIndex('c')).toBe('-1');
    expect(
      [...host!.querySelectorAll<HTMLButtonElement>('.session-tab-close')].map((button) =>
        button.getAttribute('tabindex'),
      ),
    ).toEqual(['-1', '-1', '-1']);
  });

  it('moves focus with arrows without switching sessions, and wraps at the ends', async () => {
    await mount(['a', 'b', 'c'], 'a');
    label('a').focus();
    press('a', 'ArrowRight');
    expect(focused()).toBe(label('b'));
    expect(jumps).not.toHaveBeenCalled();
    // Focus follows the roving tab stop.
    expect(tabIndex('b')).toBe('0');
    expect(tabIndex('a')).toBe('-1');
    press('b', 'ArrowLeft');
    expect(focused()).toBe(label('a'));
    press('a', 'ArrowLeft');
    expect(focused()).toBe(label('c'));
    press('c', 'ArrowRight');
    expect(focused()).toBe(label('a'));
    press('a', 'End');
    expect(focused()).toBe(label('c'));
    press('c', 'Home');
    expect(focused()).toBe(label('a'));
    expect(jumps).not.toHaveBeenCalled();
  });

  it('leaves Enter to the button so activation still opens the session', async () => {
    await mount(['a', 'b', 'c'], 'a');
    label('b').focus();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => label('b').dispatchEvent(event));
    // The strip does not swallow the key; the browser turns it into the button's click.
    expect(event.defaultPrevented).toBe(false);
    act(() => label('b').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await renderNow();
    expect(jumps).toHaveBeenCalledWith('b');
    expect(tabIndex('b')).toBe('0');
    expect(state.active).toBe('b');
  });

  it('keeps aria-selected on the active tab while focus roves, then follows activation', async () => {
    await mount(['a', 'b', 'c'], 'a');
    const panel = host!.querySelector('[role="tabpanel"]')!;
    expect(host!.querySelector('.session-tab-list')!.getAttribute('role')).toBe('tablist');
    expect(label('a').getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(label('a').id);
    expect(label('a').getAttribute('aria-selected')).toBe('true');
    label('b').focus();
    press('b', 'ArrowRight');
    // Focus moved to c without activation: the selection stays on a.
    expect(focused()).toBe(label('c'));
    expect(label('c').getAttribute('aria-selected')).toBe('false');
    expect(label('a').getAttribute('aria-selected')).toBe('true');
    // Activating c moves both the selection and the panel's label.
    act(() => label('c').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await renderNow();
    expect(label('c').getAttribute('aria-selected')).toBe('true');
    expect(label('a').getAttribute('aria-selected')).toBe('false');
    expect(panel.getAttribute('aria-labelledby')).toBe(label('c').id);
  });

  it('detaches the focused tab on Delete and focuses the tab that replaces it', async () => {
    await mount(['a', 'b', 'c'], 'a');
    label('b').focus();
    press('b', 'Delete');
    await renderNow();
    expect(closes).toHaveBeenCalledWith('b');
    expect(jumps).not.toHaveBeenCalled();
    expect(state.open).toEqual(['a', 'c']);
    expect(focused()).toBe(label('c'));
    expect(tabIndex('c')).toBe('0');
  });

  it('moves focus to the neighbouring tab when the strip closes one of its own', async () => {
    await mount(['a', 'b', 'c'], 'a');
    label('b').focus();
    clickClose('b');
    await renderNow();
    expect(closes).toHaveBeenCalledWith('b');
    expect(focused()).toBe(label('c'));
    expect(state.open).toEqual(['a', 'c']);
  });

  it('does not steal focus when a tab closes from outside the strip', async () => {
    await mount(['a', 'b', 'c'], 'a');
    clickClose('a');
    await renderNow();
    expect(closes).toHaveBeenCalledWith('a');
    expect(state.open).toEqual(['b', 'c']);
    expect(host!.contains(focused())).toBe(false);
  });

  it('leaves modified key combos to the window shortcut handler', async () => {
    await mount(['a', 'b', 'c'], 'a');
    label('a').focus();
    const combo = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => label('a').dispatchEvent(combo));
    expect(combo.defaultPrevented).toBe(false);
    expect(focused()).toBe(label('a'));
    expect(jumps).not.toHaveBeenCalled();
  });

  it('lets the rename input keep its own keys while editing', async () => {
    await mount(['a', 'b', 'c'], 'a');
    act(() => label('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
    const input = host!.querySelector<HTMLInputElement>('.session-tab-rename');
    expect(input).not.toBeNull();
    expect(focused()).toBe(input);
    act(() =>
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
    );
    // The strip never hijacked the caret keys: the input kept focus and stays open.
    expect(focused()).toBe(input);
    expect(host!.querySelector('.session-tab-rename')).toBe(input);
    expect(closes).not.toHaveBeenCalled();
  });
});
