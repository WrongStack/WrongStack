// Tests for the slash-command → TUI panel dispatch bridge.
//
// The bridge logic lives in `packages/tui/src/on-panel-open.ts` so the
// dispatch table can be tested in isolation (without mounting React, which
// is brittle under ink-testing-library). The useEffect in `app.tsx` just
// installs `createPanelOpenDispatcher(...)` at `onPanelOpen.current`.
//
// What this file pins down:
//   - the documented action catalogue dispatches the correct reducer action
//   - unknown actions return false (text fallback for slash command)
//   - projectPickerOpen delegates to the host-side opener (lazy items)
//   - statuslineOpen delegates to the statuslineHiddenForPicker callback
//   - the helper never throws on garbage input (defensive against typos)

import { describe, expect, it, vi } from 'vitest';
import { createPanelOpenDispatcher, type PanelOpenDeps } from '../src/on-panel-open.js';

type MockedPanelOpenDeps = PanelOpenDeps & {
  dispatch: ReturnType<typeof vi.fn>;
  openProjectPicker: ReturnType<typeof vi.fn>;
  openStatuslinePicker: ReturnType<typeof vi.fn>;
};

function makeDeps(over: Partial<PanelOpenDeps> = {}): MockedPanelOpenDeps {
  const dispatch = vi.fn();
  const openProjectPicker = vi.fn();
  const openStatuslinePicker = vi.fn();
  // vi.fn() is callable and satisfies each dep's function signature at runtime;
  // the cast reconciles vitest's Mock<Procedure> nominal type with the deps'
  // structural function types (they differ only by the Constructable overload).
  return {
    dispatch,
    openProjectPicker,
    openStatuslinePicker,
    ...over,
  } as MockedPanelOpenDeps;
}

describe('createPanelOpenDispatcher — picker openers', () => {
  it('pluginPickerOpen dispatches { type: "pluginPickerOpen" } and returns true', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('pluginPickerOpen')).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'pluginPickerOpen' });
  });

  it('projectPickerOpen delegates to the opener (does NOT dispatch here)', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('projectPickerOpen')).toBe(true);
    expect(deps.openProjectPicker).toHaveBeenCalledTimes(1);
    // The dispatcher does not itself call dispatch — the opener owns the
    // `projectPickerOpen` action once items are loaded.
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('projectPickerOpen opener may be async — fire-and-forget', async () => {
    const opener = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ openProjectPicker: opener });
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('projectPickerOpen')).toBe(true);
    // The dispatcher doesn't await; just kicks the promise chain.
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it('statuslineOpen delegates to openStatuslinePicker and returns true', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('statuslineOpen')).toBe(true);
    expect(deps.openStatuslinePicker).toHaveBeenCalledTimes(1);
    // Dispatcher does not directly dispatch — opener owns the statuslineOpen
    // action (which requires a hiddenItems snapshot).
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});

describe('createPanelOpenDispatcher — auth panel', () => {
  it('authOpen delegates to openAuthPanel("list") and returns its result', () => {
    const openAuthPanel = vi.fn().mockReturnValue(true);
    const deps = makeDeps({ openAuthPanel });
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('authOpen')).toBe(true);
    expect(openAuthPanel).toHaveBeenCalledWith('list');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('authOauthOpen delegates to openAuthPanel("oauth")', () => {
    const openAuthPanel = vi.fn().mockReturnValue(true);
    const deps = makeDeps({ openAuthPanel });
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('authOauthOpen')).toBe(true);
    expect(openAuthPanel).toHaveBeenCalledWith('oauth');
  });

  it('returns false (text fallback) when the opener reports no auth host', () => {
    const openAuthPanel = vi.fn().mockReturnValue(false);
    const deps = makeDeps({ openAuthPanel });
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('authOpen')).toBe(false);
  });

  it('returns false when no openAuthPanel is wired (older host)', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('authOpen')).toBe(false);
    expect(dispatcher('authOauthOpen')).toBe(false);
  });
});

describe('createPanelOpenDispatcher — toggle panels', () => {
  it('toggleMonitor dispatches and returns true', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('toggleMonitor')).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'toggleMonitor' });
  });

  it('toggleAuditPanel dispatches and returns true', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('toggleAuditPanel')).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'toggleAuditPanel' });
  });

  it.each([
    'toggleAgentsMonitor',
    'toggleWorktreeMonitor',
    'togglePlanPanel',
    'toggleTodosMonitor',
    'toggleQueuePanel',
    'toggleProcessList',
    'toggleGoalPanel',
    'toggleSessionsPanel',
    'toggleCoordinatorMonitor',
  ])('toggle* action %s dispatches the matching action type', (action) => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher(action)).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith({ type: action });
  });
});

describe('createPanelOpenDispatcher — text fallback', () => {
  it('returns false for an unrecognised action and does NOT dispatch', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);

    expect(dispatcher('notARealAction')).toBe(false);
    expect(dispatcher('PLUGIN_PICKER_OPEN')).toBe(false); // case-sensitive
    expect(dispatcher('')).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.openProjectPicker).not.toHaveBeenCalled();
    expect(deps.openStatuslinePicker).not.toHaveBeenCalled();
  });

  it('returning false means the slash command can print its text response', () => {
    // Models the contract used by slash-commands/plugin.ts:
    //   if ((trimmed === 'menu' || trimmed === '') && opts.onPanelOpen.current) {
    //     const opened = opts.onPanelOpen.current('pluginPickerOpen');
    //     if (opened) return { message: 'Opened plugin menu.' };
    //   }
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);

    // Successful path: bridge returns true and slash command returns early.
    expect(dispatcher('pluginPickerOpen')).toBe(true);

    // Headless / REPL fallback path: unknown action returns false and the
    // slash command falls through to `onPlugin?.(trimmed)` text render.
    expect(dispatcher('headless-mode')).toBe(false);
  });
});

describe('createPanelOpenDispatcher — full action catalogue', () => {
  it('covers every action dispatched by the slash commands and F-key registry', () => {
    const deps = makeDeps({ openAuthPanel: vi.fn().mockReturnValue(true) });
    const dispatcher = createPanelOpenDispatcher(deps);

    // Actions referenced by packages/cli/src/slash-commands/{plugin,f-keys,audit,settings,auth}.ts
    // and packages/tui/src/f-key-panels.ts.
    const catalogue = [
      'pluginPickerOpen',
      'projectPickerOpen',
      'statuslineOpen',
      'authOpen',
      'authOauthOpen',
      'toggleMonitor',
      'toggleAuditPanel',
      'toggleAgentsMonitor',
      'toggleWorktreeMonitor',
      'togglePlanPanel',
      'toggleTodosMonitor',
      'toggleQueuePanel',
      'toggleProcessList',
      'toggleGoalPanel',
      'toggleSessionsPanel',
      'toggleCoordinatorMonitor',
    ];
    for (const action of catalogue) {
      expect(dispatcher(action)).toBe(true);
    }
    // Every documented action should be in the catalogue list above.
    expect(new Set(catalogue).size).toBe(catalogue.length);
    // Plus fallthrough returns false.
    expect(dispatcher('whatever')).toBe(false);
  });
});
