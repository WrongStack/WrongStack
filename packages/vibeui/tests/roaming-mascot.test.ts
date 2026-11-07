// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoamingMascot } from '../src/components/roaming-mascot';
import { WorkspacePreferencesProvider } from '../src/components/workspace-preferences';
import { MASCOT_REACTION_MS } from '../src/lib/mascot';
import { WORKSPACE_PREFERENCES_KEY } from '../src/lib/workspace-preferences';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 31 normalizes `translate(0px, 0px)` to `translate(0px)` when the style
// round-trips through getComputedStyle, so the home transform compares in its
// normalized serialization.
const JSDOM_MASCOT_HOME = 'translate(0px) scale(0.5)';

let reducedMotion = false;
const motionListeners = new Set<() => void>();
const players: Array<{ onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> }> = [];
const roots: Root[] = [];

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
}

beforeEach(() => {
  reducedMotion = false;
  motionListeners.clear();
  players.length = 0;
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return reducedMotion;
      },
      addEventListener: (_: string, listener: () => void) => motionListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => motionListeners.delete(listener),
    })),
  );
  // Give the workspace a desktop layout so Stacky has a safe gutter to roam in.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('main-workspace')) return rect(0, 0, 1400, 900) as DOMRect;
    if (this.classList.contains('conversation')) return rect(0, 60, 1400, 700) as DOMRect;
    if (this.classList.contains('composer-area')) return rect(0, 760, 1400, 140) as DOMRect;
    return rect(20, 700, 88, 64) as DOMRect;
  });
  (HTMLElement.prototype as { animate?: unknown }).animate = vi.fn(() => {
    const player = { onfinish: null as (() => void) | null, cancel: vi.fn() };
    players.push(player);
    return player;
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

type Props = Partial<Parameters<typeof RoamingMascot>[0]>;
function mount(props: Props = {}, preferences?: Record<string, unknown>) {
  if (preferences) localStorage.setItem(WORKSPACE_PREFERENCES_KEY, JSON.stringify(preferences));
  const handlers = {
    onFiles: vi.fn(),
    onIdeas: vi.fn(),
    onMemory: vi.fn(),
    onNewChat: vi.fn(),
  };
  const workspace = document.createElement('div');
  workspace.className = 'main-workspace';
  const conversation = document.createElement('div');
  conversation.className = 'conversation';
  const composer = document.createElement('div');
  composer.className = 'composer-area';
  const host = document.createElement('div');
  workspace.append(conversation, host, composer);
  document.body.append(workspace);
  const root = createRoot(host);
  roots.push(root);
  const render = (next: Props = {}) =>
    act(() =>
      root.render(
        createElement(
          WorkspacePreferencesProvider,
          null,
          createElement(RoamingMascot, {
            working: false,
            connected: true,
            outcome: null,
            ...handlers,
            ...props,
            ...next,
          }),
        ),
      ),
    );
  render();
  return { host, handlers, render };
}

const home = (host: HTMLElement) => host.querySelector<HTMLElement>('.stacky-home');
const actor = () => document.querySelector<HTMLButtonElement>('button[aria-label="Meet Stacky"]')!;
const byText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.includes(text),
  )!;
const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const reactionText = () => document.querySelector('.stacky-reaction-text')?.textContent;
const menu = () => document.querySelector('.stacky-menu');
const openMenu = () => act(() => actor().click());
const selectTab = (name: string) =>
  act(() => {
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (item) => item.textContent === name,
    )!;
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
const storedPreferences = () =>
  JSON.parse(localStorage.getItem(WORKSPACE_PREFERENCES_KEY) || 'null');

describe('Stacky, the roaming mascot', () => {
  it.each([
    { view: 'focus', mascot: 'roam' },
    { view: 'studio', mascot: 'quiet' },
    { view: 'cozy', mascot: 'off' },
  ])('stays hidden outside cozy view or when switched off: %j', (preferences) => {
    const { host } = mount({}, preferences);
    expect(home(host)).toBe(null);
    expect(host.innerHTML).toBe('');
  });

  it('reflects the session mood and status', () => {
    const { host, render } = mount({ connected: false });
    expect(home(host)?.dataset.mood).toBe('offline');
    expect(home(host)?.dataset.roaming).toBe('false');
    render({ connected: true, working: true });
    expect(home(host)?.dataset.mood).toBe('working');
    render({ connected: true, working: false, outcome: 'done' });
    expect(home(host)?.dataset.mood).toBe('done');
    openMenu();
    expect(menu()?.textContent).toContain('All done for now. What shall we make next?');
    expect(actor().getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps still and plays quietly under reduced motion', () => {
    reducedMotion = true;
    const { host } = mount();
    expect(home(host)?.dataset.playful).toBe('false');
    expect(home(host)?.dataset.roaming).toBe('false');
    expect(actor().style.transform).toBe(JSDOM_MASCOT_HOME);
    openMenu();
    expect(reactionText()).toBe('Tap me for a high five.');
    act(() => byLabel('Give Stacky a high five').click());
    expect(reactionText()).toBe('A quiet little smile, just for you.');
    selectTab('Comfort');
    expect(menu()?.textContent).toContain('Your reduced-motion setting keeps me still.');
  });

  it('plays gestures that wear off after the reaction window', () => {
    vi.useFakeTimers();
    const { host } = mount();
    expect(home(host)?.dataset.playful).toBe('true');
    openMenu();
    act(() => byLabel('Give Stacky a high five').click());
    expect(reactionText()).toBe('Right back at you!');
    expect(home(host)?.dataset.gesture).toBe('highfive');
    act(() => byText('Little dance').click());
    expect(reactionText()).toBe('A tiny dance, just for you.');
    act(() => byText('Big stretch').click());
    expect(reactionText()).toBe('A little stretch feels lovely.');
    expect(home(host)?.dataset.gesture).toBe('stretch');
    act(() => vi.advanceTimersByTime(MASCOT_REACTION_MS));
    expect(home(host)?.dataset.gesture).toBe('none');
    expect(reactionText()).toBe('Tap me for a high five.');
  });

  it('opens a fresh chat and the help shortcuts, closing the menu each time', () => {
    const { handlers, render } = mount();
    openMenu();
    act(() => byText('New chat').click());
    expect(handlers.onNewChat).toHaveBeenCalledTimes(1);
    expect(menu()).toBe(null);
    for (const [title, handler] of [
      ['My files', handlers.onFiles],
      ['Ideas & skills', handlers.onIdeas],
      ['Memory', handlers.onMemory],
    ] as const) {
      openMenu();
      selectTab('Help');
      act(() => byText(title).click());
      expect(handler).toHaveBeenCalledTimes(1);
      expect(menu()).toBe(null);
    }
    render({ newChatLocked: true });
    openMenu();
    expect(byText('New chat').disabled).toBe(true);
  });

  it('saves comfort choices and can be put to sleep', () => {
    const { host } = mount();
    openMenu();
    selectTab('Comfort');
    expect(menu()?.textContent).toContain('I stay by the edge, and rest while you type.');
    expect(byText('Wander a little').getAttribute('aria-pressed')).toBe('true');
    act(() => byText('Sit quietly').click());
    expect(storedPreferences().mascot).toBe('quiet');
    expect(home(host)?.dataset.playful).toBe('false');
    openMenu();
    act(() => byLabel('Put Stacky to sleep').click());
    expect(storedPreferences().mascot).toBe('off');
    expect(home(host)).toBe(null);
  });

  it('wanders along the gutter and pauses while the user types', () => {
    vi.useFakeTimers();
    const { host } = mount();
    expect(home(host)?.dataset.roaming).toBe('true');
    expect(actor().style.transform).toBe(JSDOM_MASCOT_HOME);
    act(() => vi.advanceTimersByTime(10_000));
    expect(players).toHaveLength(1);
    expect(home(host)?.dataset.moving).toBe('true');
    const [keyframes, options] = vi.mocked(HTMLElement.prototype.animate).mock.calls[0]!;
    expect((keyframes as Keyframe[])[1]?.transform).toBe('translate(-4px, -590px) scale(1)');
    expect((options as KeyframeAnimationOptions).fill).toBe('forwards');
    act(() => players[0]!.onfinish?.());
    expect(actor().style.transform).toBe('translate(-4px, -590px) scale(1)');
    expect(players[0]!.cancel).toHaveBeenCalled();
    expect(home(host)?.dataset.moving).toBe('false');

    const input = document.createElement('input');
    document.body.append(input);
    act(() => input.focus());
    expect(home(host)?.dataset.roaming).toBe('false');
    act(() => vi.advanceTimersByTime(30_000));
    expect(players).toHaveLength(1);
    act(() => input.blur());
    expect(home(host)?.dataset.roaming).toBe('true');
    act(() => vi.advanceTimersByTime(14_000));
    expect(players).toHaveLength(2);
  });

  it('stops roaming when reduced motion is switched on and cancels the active move', () => {
    vi.useFakeTimers();
    const { host } = mount();
    act(() => vi.advanceTimersByTime(10_000));
    expect(players).toHaveLength(1);
    reducedMotion = true;
    act(() => {
      for (const listener of motionListeners) listener();
    });
    expect(players[0]!.cancel).toHaveBeenCalled();
    expect(home(host)?.dataset.roaming).toBe('false');
    expect(home(host)?.dataset.playful).toBe('false');
    expect(actor().style.transform).toBe(JSDOM_MASCOT_HOME);
  });

  it('hides from overlays and a hidden tab', async () => {
    const { host } = mount();
    expect(home(host)?.dataset.roaming).toBe('true');
    const panel = document.createElement('div');
    panel.className = 'workspace-panel';
    // MutationObserver callbacks are microtasks; flush them inside an async act.
    await act(async () => {
      document.body.append(panel);
      await Promise.resolve();
    });
    expect(home(host)?.dataset.roaming).toBe('false');
    await act(async () => {
      panel.remove();
      await Promise.resolve();
    });
    expect(home(host)?.dataset.roaming).toBe('true');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(home(host)?.dataset.roaming).toBe('false');
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    }
  });
});
