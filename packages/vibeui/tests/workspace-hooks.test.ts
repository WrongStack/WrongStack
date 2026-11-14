// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PALETTE_KEY, readAppearance, THEME_KEY, useAppearance } from '../src/lib/use-appearance';
import { modelChoiceAction, useModelChoice } from '../src/lib/use-model-choice';
import { isNearBottom, useStickyScroll } from '../src/lib/use-sticky-scroll';
import { useWorkspaceLayout } from '../src/lib/use-workspace-layout';
import { shortcutFor, useWorkspaceShortcuts } from '../src/lib/workspace-shortcuts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.palette;
});

/** Renders a hook inside a throwaway component and exposes its latest result. */
function renderHook<T>(hook: () => T): { current: () => T } {
  let latest!: T;
  function Probe() {
    latest = hook();
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(Probe)));
  return { current: () => latest };
}

const key = (
  init: Partial<KeyboardEventInit> & { key: string; defaultPrevented?: boolean },
  target: unknown = null,
) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target,
  ...init,
});

describe('shortcutFor', () => {
  it('maps Ctrl and Cmd shortcuts to the same actions', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(shortcutFor(key({ key: 'p', ...mod }), false)).toBe('commands');
      expect(shortcutFor(key({ key: 'P', shiftKey: true, ...mod }), false)).toBe('commands');
      expect(shortcutFor(key({ key: 'F', shiftKey: true, ...mod }), false)).toBe('search');
      expect(shortcutFor(key({ key: ',', ...mod }), false)).toBe('settings');
    }
  });

  it('leaves plain keys and Ctrl+F (browser find) alone', () => {
    expect(shortcutFor(key({ key: 'p' }), false)).toBeNull();
    expect(shortcutFor(key({ key: 'f', ctrlKey: true }), false)).toBeNull();
    expect(shortcutFor(key({ key: ',' }), false)).toBeNull();
  });

  it('closes panels on Escape only outside fields', () => {
    expect(shortcutFor(key({ key: 'Escape' }), false)).toBe('close-panels');
    expect(shortcutFor(key({ key: 'Escape' }, { tagName: 'DIV' }), false)).toBe('close-panels');
    for (const tagName of ['TEXTAREA', 'INPUT', 'SELECT'])
      expect(shortcutFor(key({ key: 'Escape' }, { tagName }), false)).toBeNull();
    expect(shortcutFor(key({ key: 'Escape' }, { isContentEditable: true }), false)).toBeNull();
  });

  it('yields to an open dialog and to handled events', () => {
    expect(shortcutFor(key({ key: 'p', ctrlKey: true }), true)).toBeNull();
    expect(shortcutFor(key({ key: 'Escape' }), true)).toBeNull();
    expect(shortcutFor(key({ key: 'p', ctrlKey: true, defaultPrevented: true }), false)).toBeNull();
  });
});

describe('useWorkspaceShortcuts', () => {
  it('dispatches to the latest handlers and prevents browser defaults', () => {
    const first = vi.fn();
    const second = vi.fn();
    const handlers = {
      commands: first,
      search: vi.fn(),
      settings: vi.fn(),
      'close-panels': vi.fn(),
    };
    const add = vi.spyOn(document, 'addEventListener');
    let rerender!: () => void;
    let current = handlers;
    renderHook(() => {
      const [, setTick] = useState(0);
      rerender = () => setTick((tick) => tick + 1);
      useWorkspaceShortcuts(current);
    });
    current = { ...handlers, commands: second };
    act(() => rerender());
    // The listener is registered once; the re-render only swaps the handler map.
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    add.mockRestore();
    const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    act(() => {
      document.dispatchEvent(escapeEvent);
    });
    expect(handlers['close-panels']).toHaveBeenCalledTimes(1);
    expect(escapeEvent.defaultPrevented).toBe(false);
  });

  it('ignores shortcuts while a modal is open', () => {
    const handlers = {
      commands: vi.fn(),
      search: vi.fn(),
      settings: vi.fn(),
      'close-panels': vi.fn(),
    };
    renderHook(() => useWorkspaceShortcuts(handlers));
    const modal = document.createElement('div');
    modal.className = 'modal-content';
    document.body.append(modal);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }));
    });
    expect(handlers.commands).not.toHaveBeenCalled();
  });
});

describe('useAppearance', () => {
  it('falls back to dark + sage for unknown stored values', () => {
    expect(readAppearance({ theme: null, palette: null })).toEqual({
      theme: 'dark',
      palette: 'sage',
    });
    expect(readAppearance({ theme: 'neon', palette: 'pink' })).toEqual({
      theme: 'dark',
      palette: 'sage',
    });
    expect(readAppearance({ theme: 'light', palette: 'violet' })).toEqual({
      theme: 'light',
      palette: 'violet',
    });
  });

  it('restores, mirrors onto <html> and persists theme and palette', () => {
    localStorage.setItem(THEME_KEY, 'light');
    localStorage.setItem(PALETTE_KEY, 'ocean');
    const hook = renderHook(() => useAppearance());
    expect(hook.current().theme).toBe('light');
    expect(document.documentElement.dataset).toMatchObject({ theme: 'light', palette: 'ocean' });
    act(() => hook.current().toggleTheme());
    act(() => hook.current().setPalette('amber'));
    expect(document.documentElement.dataset).toMatchObject({ theme: 'dark', palette: 'amber' });
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(localStorage.getItem(PALETTE_KEY)).toBe('amber');
  });
});

describe('useWorkspaceLayout', () => {
  const width = (value: number) =>
    Object.defineProperty(window, 'innerWidth', { configurable: true, value });
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it('docks the panel for Studio on wide screens only', () => {
    width(1400);
    expect(renderHook(() => useWorkspaceLayout('studio')).current().panel).toBe(true);
    expect(renderHook(() => useWorkspaceLayout('cozy')).current().panel).toBe(false);
    width(900);
    expect(renderHook(() => useWorkspaceLayout('studio')).current().panel).toBe(false);
    for (const viewport of [1200, 1250]) {
      width(viewport);
      expect(renderHook(() => useWorkspaceLayout('studio')).current().panel).toBe(false);
    }
    width(1251);
    expect(renderHook(() => useWorkspaceLayout('studio')).current().panel).toBe(true);
  });

  it('opens tabs with a fresh request key and reveals agents by counter', () => {
    width(900);
    const hook = renderHook(() => useWorkspaceLayout('cozy'));
    act(() => hook.current().openPanel('tasks'));
    expect(hook.current()).toMatchObject({ panel: true, panelRequest: { tab: 'tasks', key: 1 } });
    act(() => hook.current().openPanel('tasks'));
    expect(hook.current().panelRequest).toEqual({ tab: 'tasks', key: 2 });
    act(() => hook.current().revealAgents());
    act(() => hook.current().revealAgents());
    expect(hook.current().agentReveal).toBe(2);
    act(() => hook.current().showActivity());
    expect(hook.current()).toMatchObject({
      agentReveal: 0,
      panelRequest: { tab: 'activity', key: 3 },
    });
    act(() => hook.current().setSidebar(true));
    act(() => hook.current().closePanels());
    expect(hook.current()).toMatchObject({ sidebar: false, panel: false });
  });
});

describe('useStickyScroll', () => {
  it('leaves the welcome screen at the top and follows when a conversation starts', () => {
    let enabled = false;
    let update!: () => void;
    const hook = renderHook(() => {
      const [revision, setRevision] = useState(0);
      update = () => setRevision((value) => value + 1);
      return useStickyScroll<HTMLElement>([revision], 'one', enabled);
    });
    const el = document.createElement('main');
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    (hook.current().ref as { current: HTMLElement | null }).current = el;
    act(() => update());
    expect(el.scrollTop).toBe(0);
    el.scrollTop = 200;
    act(() => hook.current().onScroll());
    expect(hook.current().showLatest).toBe(false);
    enabled = true;
    act(() => update());
    expect(el.scrollTop).toBe(1000);
    enabled = false;
    act(() => update());
    expect(el.scrollTop).toBe(0);
    expect(hook.current().showLatest).toBe(false);
  });

  it('follows within 100px of the bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 850, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 100 })).toBe(false);
  });

  it('releases on scroll-up, offers Latest, and re-pins on jump', () => {
    const hook = renderHook(() => useStickyScroll<HTMLElement>([], 'one'));
    const el = document.createElement('main');
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    (hook.current().ref as { current: HTMLElement | null }).current = el;
    el.scrollTop = 200;
    act(() => hook.current().onScroll());
    expect(hook.current().showLatest).toBe(true);
    act(() => hook.current().jumpToLatest());
    expect(hook.current().showLatest).toBe(false);
    expect(el.scrollTop).toBe(1000);
    act(() => hook.current().release());
    expect(hook.current().showLatest).toBe(true);
  });
});

describe('useModelChoice', () => {
  const current = { provider: 'p', model: 'big', maxContext: 200_000 };

  it('decides between no-op, confirmation and an immediate switch', () => {
    expect(modelChoiceAction(current, { provider: 'p', model: 'big', context: 1 })).toBe('none');
    expect(modelChoiceAction(current, { provider: 'p', model: 'small', context: 32_000 })).toBe(
      'confirm',
    );
    expect(modelChoiceAction(current, { provider: 'q', model: 'huge', context: 1_000_000 })).toBe(
      'switch',
    );
    // Unknown context windows (0) never block a switch.
    expect(modelChoiceAction(current, { provider: 'q', model: 'mystery', context: 0 })).toBe(
      'switch',
    );
  });

  it('asks before shrinking the context window and switches only on confirm', () => {
    const switchModel = vi.fn();
    const send = vi.fn();
    const hook = renderHook(() => useModelChoice({ ...current, switchModel, send }));
    act(() => hook.current().chooseModel('p', 'small', 32_000));
    expect(switchModel).not.toHaveBeenCalled();
    expect(hook.current().smallerModel).toEqual({ provider: 'p', model: 'small', context: 32_000 });
    act(() => hook.current().cancelPending());
    expect(hook.current().smallerModel).toBeNull();
    act(() => hook.current().chooseModel('p', 'small', 32_000));
    act(() => hook.current().confirmPending());
    expect(switchModel).toHaveBeenCalledWith('p', 'small');
    expect(hook.current().smallerModel).toBeNull();
    act(() => hook.current().refreshModels());
    expect(send.mock.calls).toEqual([['providers.saved'], ['providers.list']]);
  });
});
