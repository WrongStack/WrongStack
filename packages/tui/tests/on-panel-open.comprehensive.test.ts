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
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'pluginPickerOpen' });
  });

  it('mcpPickerOpen dispatches and returns true', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('mcpPickerOpen')).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'mcpPickerOpen' });
  });

  it('toolsPickerOpen dispatches and returns true', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('toolsPickerOpen')).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'toolsPickerOpen' });
  });

  it('projectPickerOpen delegates to the opener', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('projectPickerOpen')).toBe(true);
    expect(deps.openProjectPicker).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('statuslineOpen delegates to openStatuslinePicker', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('statuslineOpen')).toBe(true);
    expect(deps.openStatuslinePicker).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});

describe('createPanelOpenDispatcher — mode/brain/shadow/help panels', () => {
  it('modePickerOpen calls openModePicker when available', () => {
    const openModePicker = vi.fn();
    const deps = makeDeps({ openModePicker });
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('modePickerOpen')).toBe(true);
    expect(openModePicker).toHaveBeenCalledTimes(1);
  });

  it('modePickerOpen returns false when openModePicker is not available', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('modePickerOpen')).toBe(false);
  });

  it('brainOpen calls openBrainPanel when available', () => {
    const openBrainPanel = vi.fn();
    const deps = makeDeps({ openBrainPanel });
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('brainOpen')).toBe(true);
    expect(openBrainPanel).toHaveBeenCalledTimes(1);
  });

  it('brainOpen returns false when openBrainPanel is not available', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('brainOpen')).toBe(false);
  });

  it('shadowOpen calls openShadowPanel when available', () => {
    const openShadowPanel = vi.fn();
    const deps = makeDeps({ openShadowPanel });
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('shadowOpen')).toBe(true);
    expect(openShadowPanel).toHaveBeenCalledTimes(1);
  });

  it('shadowOpen returns false when openShadowPanel is not available', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('shadowOpen')).toBe(false);
  });

  it('helpOpen calls openHelpPanel when available', () => {
    const openHelpPanel = vi.fn();
    const deps = makeDeps({ openHelpPanel });
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('helpOpen')).toBe(true);
    expect(openHelpPanel).toHaveBeenCalledTimes(1);
  });

  it('helpOpen returns false when openHelpPanel is not available', () => {
    const deps = makeDeps();
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('helpOpen')).toBe(false);
  });
});

describe('createPanelOpenDispatcher — auth panel', () => {
  it('authOpen delegates to openAuthPanel("list")', () => {
    const openAuthPanel = vi.fn().mockReturnValue(true);
    const deps = makeDeps({ openAuthPanel });
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('authOpen')).toBe(true);
    expect(openAuthPanel).toHaveBeenCalledWith('list');
  });

  it('authOauthOpen delegates to openAuthPanel("oauth")', () => {
    const openAuthPanel = vi.fn().mockReturnValue(true);
    const deps = makeDeps({ openAuthPanel });
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('authOauthOpen')).toBe(true);
    expect(openAuthPanel).toHaveBeenCalledWith('oauth');
  });

  it('returns false when the opener reports no auth host', () => {
    const openAuthPanel = vi.fn().mockReturnValue(false);
    const deps = makeDeps({ openAuthPanel });
    const dispatcher = createPanelOpenDispatcher(deps);
    expect(dispatcher('authOpen')).toBe(false);
  });

  it('returns false when no openAuthPanel is wired', () => {
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
    'toggleKanbanPanel',
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
    expect(dispatcher('PLUGIN_PICKER_OPEN')).toBe(false);
    expect(dispatcher('')).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.openProjectPicker).not.toHaveBeenCalled();
    expect(deps.openStatuslinePicker).not.toHaveBeenCalled();
  });
});

describe('createPanelOpenDispatcher — full action catalogue', () => {
  it('covers every action dispatched by the slash commands', () => {
    const deps = makeDeps({
      openAuthPanel: vi.fn().mockReturnValue(true),
      openModePicker: vi.fn(),
      openBrainPanel: vi.fn(),
      openShadowPanel: vi.fn(),
      openHelpPanel: vi.fn(),
    });
    const dispatcher = createPanelOpenDispatcher(deps);
    const catalogue = [
      'pluginPickerOpen',
      'mcpPickerOpen',
      'toolsPickerOpen',
      'projectPickerOpen',
      'statuslineOpen',
      'authOpen',
      'authOauthOpen',
      'modePickerOpen',
      'brainOpen',
      'shadowOpen',
      'helpOpen',
      'toggleMonitor',
      'toggleAuditPanel',
      'toggleAgentsMonitor',
      'toggleWorktreeMonitor',
      'togglePlanPanel',
      'toggleKanbanPanel',
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
    expect(dispatcher('whatever')).toBe(false);
  });
});
