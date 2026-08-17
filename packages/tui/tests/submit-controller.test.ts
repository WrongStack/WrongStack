import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSubmitController, type SubmitControllerHost } from '../src/submit-controller.js';
import type { Action, State } from '../src/app-reducer.js';

type CapturedAction = Action & {
  type: string;
  info?: { resolve?: (value: never) => void } & Record<string, unknown>;
  entry?: { kind: string; text: string } & Record<string, unknown>;
  item?: Record<string, unknown>;
  text?: string;
  title?: string;
};

function cell<T>(value: T): { current: T } {
  return { current: value };
}

function makeBuilder() {
  const appended: string[] = [];
  return {
    appended,
    appendText: vi.fn((text: string) => {
      appended.push(text);
    }),
    submit: vi.fn(async () => [{ type: 'text', text: appended.join('') }] as never),
  };
}

function makeHost(overrides: {
  state?: Partial<State>;
  statusRef?: State['status'];
  slashResult?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  live?: Record<string, unknown>;
  todos?: Array<Record<string, unknown>>;
  suggestions?: string[];
  enhanceEnabled?: boolean;
  midRunPicker?: boolean;
  autonomy?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  nextStepsTimer?: ReturnType<typeof setInterval> | undefined;
  settings?: Record<string, unknown>;
  sddContext?: string;
  director?: unknown;
} = {}) {
  const actions: CapturedAction[] = [];
  const builder = makeBuilder();
  const state = {
    status: 'idle',
    steeringPending: false,
    steerSnapshot: null,
    buffer: '',
    leader: { ctxTokens: 0, ctxMaxTokens: undefined },
    settingsPicker: { preRefineSeconds: 0 },
    ...overrides.state,
  } as State;
  const stateRef = cell({ ...state, status: overrides.statusRef ?? state.status } as State);
  const dispatch = vi.fn((action: Action) => {
    const captured = action as CapturedAction;
    actions.push(captured);
    if (captured.type === 'sendModePickerClose') {
      stateRef.current = { ...stateRef.current, status: 'idle' } as State;
    }
  });
  const attachments = { expand: vi.fn(async (token: string) => [{ type: 'text', text: `expanded ${token}` }]) };
  const ctx = {
    model: 'model-live',
    provider: { id: 'provider-live', capabilities: { maxContext: 8_000 } },
    todos: overrides.todos ?? [],
    messages: [],
    lastRequestTokens: 100,
    meta: {} as Record<string, unknown>,
    // todoTool.execute routes board writes through ctx.state.replaceTodos.
    state: {
      replaceTodos: (items: unknown[]) => {
        ctx.todos = items as typeof ctx.todos;
      },
    },
  };
  const agent = { ctx };
  const slashRegistry = {
    dispatch: vi.fn(async () => ({ ...(overrides.slashResult ?? {}) })),
  };
  const eternalLoop = vi.fn(async () => {});
  const parallelLoop = vi.fn(async () => {});
  const settings = overrides.settings ?? { shellBangWarningDontShowAgain: true };

  const host = {
    capabilities: {
      agent,
      slashRegistry,
      tokenCounter: { reset: vi.fn() },
      getSettings: vi.fn(() => settings),
      saveSettings: vi.fn(async () => null),
      getYolo: vi.fn(() => false),
      getAutonomy: vi.fn(() => overrides.autonomy ?? 'off'),
      getEternalEngine: vi.fn(() => (overrides.autonomy === 'eternal' ? { currentState: 'running' } : null)),
      getParallelEngine: vi.fn(() =>
        overrides.autonomy === 'eternal-parallel' ? { currentState: 'running' } : null,
      ),
      getModeLabel: vi.fn(() => 'plan'),
      getToolsItems: vi.fn(() => [
        { enabled: true },
        { enabled: false },
        { enabled: true },
      ]),
      onExit: vi.fn(),
      clearTerminal: vi.fn(),
      onClearHistory: vi.fn(),
      getSuggestions: vi.fn(() => overrides.suggestions ?? []),
      getSDDContext: vi.fn(async () => overrides.sddContext),
      switchAutonomy: vi.fn(),
      memoryStore: undefined,
      getEnhancerReasoning: undefined,
      buildEnhancerProvider: undefined,
      getEnhanceFallbackRef: undefined,
      getConfiguredRefinerRef: undefined,
      getPickableProviders: undefined,
      ...(overrides.capabilities ?? {}),
    },
    state,
    live: {
      mouseMode: false,
      nativeMouse: false,
      model: 'model-live',
      provider: 'provider-live',
      maxContext: 8_000,
      yolo: false,
      autonomy: overrides.autonomy ?? 'off',
      modeLabel: undefined,
      setMouseMode: vi.fn(),
      setNativeMouse: vi.fn(),
      setModel: vi.fn(),
      setProvider: vi.fn(),
      setMaxContext: vi.fn(),
      setYolo: vi.fn(),
      setAutonomy: vi.fn(),
      setModeLabel: vi.fn(),
      setToolCount: vi.fn(),
      ...(overrides.live ?? {}),
    },
    refs: {
      state: stateRef,
      interrupts: cell(0),
      autoSubmitStreak: cell(0),
      autoSubmitCapWarned: cell(false),
      autoSubmitLoopGuard: cell({ reset: vi.fn() }),
      tokenPreviews: cell(new Map<string, string>()),
      attachments,
      builder: cell(builder as never),
      sessionGeneration: cell(0),
      eternalLoop: cell(eternalLoop as never),
      parallelLoop: cell(parallelLoop as never),
      enhanceEnabled: cell(overrides.enhanceEnabled ?? false),
      enhanceOriginal: cell(''),
      enhanceAbort: cell(null),
      enhanceCancelled: cell(false),
      nextStepsTimer: cell(overrides.nextStepsTimer),
      midRunSendPicker: cell(overrides.midRunPicker ?? false),
      historyScroll: cell({ scrollToBottom: vi.fn() }),
    },
    actions: {
      dispatch,
      clearDraft: vi.fn(),
      setDraft: vi.fn(),
      pasteClipboardImage: vi.fn(async () => {}),
      openPromptPicker: vi.fn(async () => {}),
      refreshGoalSummary: vi.fn(),
      exit: vi.fn(),
      runBlocks: vi.fn(async () => {}),
      liveDirector: vi.fn(() => overrides.director ?? null),
      setMemoryContextMonitor: vi.fn(),
      runSteerSequence: vi.fn((direction: string) => ({ preamble: `STEER-PREAMBLE(${direction})` })),
      setEnhanceStartedAt: vi.fn(),
      setEnhanceDuration: vi.fn(),
      setRefineProvider: vi.fn(),
      setRefineModel: vi.fn(),
      onAfterClear: vi.fn(),
    },
  } as unknown as SubmitControllerHost;

  return {
    host,
    actions,
    builder,
    dispatch,
    stateRef,
    attachments,
    slashRegistry,
    agent,
    ctx,
    eternalLoop,
    parallelLoop,
    submit: createSubmitController(host),
    capabilities: host.capabilities as unknown as Record<string, ReturnType<typeof vi.fn>>,
    liveSetters: (host.live as unknown as Record<string, ReturnType<typeof vi.fn>>),
    actionFns: (host.actions as unknown as Record<string, ReturnType<typeof vi.fn>>),
    refs: (host.refs as unknown as Record<string, { current: unknown }>),
  };
}

function findAction(h: { actions: CapturedAction[] }, type: string): CapturedAction | undefined {
  return h.actions.find((a) => a.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createSubmitController — empty and special inputs', () => {
  it('ignores an empty buffer without dispatching anything', async () => {
    const h = makeHost();
    await h.submit('');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.actionFns['runBlocks']).not.toHaveBeenCalled();
  });

  it('consumes pending steering on Enter with an empty buffer', async () => {
    const h = makeHost({ state: { steeringPending: true } as Partial<State> });
    await h.submit('   ');
    expect(findAction(h, 'steerConsume')).toBeDefined();
  });

  it('routes /image to the clipboard paste flow', async () => {
    const h = makeHost();
    await h.submit('/image');
    expect(h.actionFns['pasteClipboardImage']).toHaveBeenCalled();
    expect(h.actionFns['clearDraft']).toHaveBeenCalled();
    expect(h.actionFns['runBlocks']).not.toHaveBeenCalled();
  });

  it('prints usage for a bare "!"', async () => {
    const h = makeHost();
    await h.submit('!   ');
    const entry = findAction(h, 'addEntry')?.entry;
    expect(entry?.text).toBe('Usage: !<shell command>');
  });
});

describe('createSubmitController — !<shell> bang commands', () => {
  it('re-dispatches through /dev when the warning is suppressed', async () => {
    const h = makeHost({ settings: { shellBangWarningDontShowAgain: true } });
    await h.submit('! pnpm test ');
    expect(findAction(h, 'shellCommandWarningOpen')).toBeUndefined();
    expect(h.slashRegistry.dispatch).toHaveBeenCalledWith('/dev pnpm test', h.ctx);
  });

  it('asks for confirmation and aborts on "no"', async () => {
    const h = makeHost({ settings: {} });
    const pending = h.submit('!rm -rf node_modules');
    const open = findAction(h, 'shellCommandWarningOpen');
    const resolve = open?.info?.resolve as ((v: string) => void) | undefined;
    expect(resolve).toBeDefined();
    resolve?.('no');
    await pending;
    expect(findAction(h, 'shellCommandWarningClose')).toBeDefined();
    expect(h.slashRegistry.dispatch).not.toHaveBeenCalled();
  });

  it('persists dont-show-again and proceeds', async () => {
    const h = makeHost({ settings: { theme: 'dark' } });
    const pending = h.submit('!pnpm build');
    const open = findAction(h, 'shellCommandWarningOpen');
    const resolve = open?.info?.resolve as ((v: string) => void) | undefined;
    expect(resolve).toBeDefined();
    resolve?.('dont-show-again');
    await pending;
    expect(h.capabilities['saveSettings']).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark', shellBangWarningDontShowAgain: true }),
    );
    expect(h.slashRegistry.dispatch).toHaveBeenCalledWith('/dev pnpm build', h.ctx);
  });

  it('surfaces settings-save errors but still runs the command', async () => {
    const h = makeHost({
      settings: {},
      capabilities: { saveSettings: vi.fn(async () => 'could not persist settings') },
    });
    const pending = h.submit('!pnpm build');
    const open = findAction(h, 'shellCommandWarningOpen');
    const resolve = open?.info?.resolve as ((v: string) => void) | undefined;
    expect(resolve).toBeDefined();
    resolve?.('dont-show-again');
    await pending;
    expect(h.actions.some((a) => a.entry?.kind === 'warn' && a.entry?.text === 'could not persist settings')).toBe(
      true,
    );
    expect(h.slashRegistry.dispatch).toHaveBeenCalled();
  });
});

describe('createSubmitController — slash commands', () => {
  it('opens the prompt picker for bare /prompt and /prompts-browse', async () => {
    const a = makeHost();
    await a.submit('/prompt');
    const b = makeHost();
    await b.submit('/prompts-browse');
    expect(a.actionFns['openPromptPicker']).toHaveBeenCalled();
    expect(b.actionFns['openPromptPicker']).toHaveBeenCalled();
    expect(a.slashRegistry.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches through the registry, echoes the result, and refreshes the goal summary', async () => {
    const h = makeHost({ slashResult: { message: 'switched to gpt-x' } });
    await h.submit('/model gpt-x');
    expect(h.slashRegistry.dispatch).toHaveBeenCalledWith('/model gpt-x', h.ctx);
    expect(h.actionFns['refreshGoalSummary']).toHaveBeenCalled();
    expect(h.actions.some((a) => a.entry?.kind === 'info' && a.entry?.text === 'switched to gpt-x')).toBe(true);
    expect(findAction(h, 'historyPush')?.text).toBe('/model gpt-x');
    expect(h.actionFns['clearDraft']).toHaveBeenCalled();
  });

  it('redacts telegram setup tokens in the echoed user entry', async () => {
    const h = makeHost();
    await h.submit('/telegram-setup 123456:ABC-DEF_secret');
    const user = h.actions.find((a) => a.entry?.kind === 'user');
    expect(user?.entry?.text).toBe('/telegram-setup [token redacted]');
  });

  it('emits goalRunInit when the command returns run metadata', async () => {
    const h = makeHost({ slashResult: { metadata: { goalRunInit: { title: 'Ship v2' } } } });
    await h.submit('/goal start');
    expect(findAction(h, 'goalRunInit')?.title).toBe('Ship v2');
  });

  it('re-syncs the status bar when agent.ctx drifted from the live values', async () => {
    const h = makeHost();
    h.ctx.model = 'model-new';
    h.ctx.provider = { id: 'provider-new', capabilities: { maxContext: 64_000 } };
    await h.submit('/use provider-new/model-new');
    expect(h.liveSetters['setModel']).toHaveBeenCalledWith('model-new');
    expect(h.liveSetters['setProvider']).toHaveBeenCalledWith('provider-new');
    expect(h.liveSetters['setMaxContext']).toHaveBeenCalledWith(64_000);
    expect(h.liveSetters['setToolCount']).toHaveBeenCalledWith(2);
    expect(h.liveSetters['setModeLabel']).toHaveBeenCalledWith('plan');
  });

  it('does not touch the status bar when values already match', async () => {
    const h = makeHost();
    await h.submit('/help');
    expect(h.liveSetters['setModel']).not.toHaveBeenCalled();
    expect(h.liveSetters['setProvider']).not.toHaveBeenCalled();
    expect(h.liveSetters['setMaxContext']).not.toHaveBeenCalled();
    expect(h.liveSetters['setYolo']).not.toHaveBeenCalled();
    expect(h.liveSetters['setAutonomy']).not.toHaveBeenCalled();
  });

  it('kicks the eternal and parallel loops when autonomy demands it', async () => {
    const eternal = makeHost({ autonomy: 'eternal' });
    await eternal.submit('/autonomy eternal');
    expect(eternal.eternalLoop).toHaveBeenCalled();

    const parallel = makeHost({ autonomy: 'eternal-parallel' });
    await parallel.submit('/autonomy eternal-parallel');
    expect(parallel.parallelLoop).toHaveBeenCalled();
  });

  it('exits when the command result requests it', async () => {
    const h = makeHost({ slashResult: { exit: true } });
    await h.submit('/exit');
    expect(h.actionFns['exit']).toHaveBeenCalled();
    expect(h.capabilities['onExit']).toHaveBeenCalledWith(0);
  });

  it('renders paste previews for inline tokens in a slash command', async () => {
    const h = makeHost();
    const previews = h.refs['tokenPreviews']?.current as Map<string, string> | undefined;
    previews?.set('[file:a.ts]', 'line1\nline2');
    await h.submit('/summarize [file:a.ts]');
    const user = h.actions.find((a) => a.entry?.kind === 'user');
    expect(user?.entry?.pasteContent).toContain('[file:a.ts]');
    expect(user?.entry?.pasteContent).toContain('  line1\n  line2');
  });

  it('surfaces dispatch errors as error entries', async () => {
    const h = makeHost();
    h.slashRegistry.dispatch = vi.fn(async () => {
      throw new Error('registry exploded');
    });
    await h.submit('/boom');
    expect(h.actions.some((a) => a.entry?.kind === 'error' && a.entry?.text === 'registry exploded')).toBe(true);
  });
});

describe('createSubmitController — /mouse metadata', () => {
  it('applies the on/off/toggle/native intents and persists the change', async () => {
    const on = makeHost({ slashResult: { metadata: { mouseToggle: 'on' } }, live: { mouseMode: false } });
    await on.submit('/mouse on');
    expect(on.liveSetters['setMouseMode']).toHaveBeenCalledWith(true);
    expect(on.actions.some((a) => a.entry?.text.includes('Mouse mode: ON'))).toBe(true);

    const off = makeHost({ slashResult: { metadata: { mouseToggle: 'off' } }, live: { mouseMode: true } });
    await off.submit('/mouse off');
    expect(off.liveSetters['setMouseMode']).toHaveBeenCalledWith(false);

    const toggle = makeHost({ slashResult: { metadata: { mouseToggle: 'toggle' } }, live: { mouseMode: false } });
    await toggle.submit('/mouse toggle');
    expect(toggle.liveSetters['setMouseMode']).toHaveBeenCalledWith(true);

    const native = makeHost({ slashResult: { metadata: { mouseToggle: 'native' } }, live: { nativeMouse: false } });
    await native.submit('/mouse native');
    expect(native.liveSetters['setNativeMouse']).toHaveBeenCalledWith(true);
    expect(native.actions.some((a) => a.entry?.text.includes('NATIVE'))).toBe(true);
    expect(native.capabilities['saveSettings']).toHaveBeenCalled();
  });

  it('reports the current state for a query without changing anything', async () => {
    const h = makeHost({ slashResult: { metadata: { mouseToggle: 'query' } }, live: { mouseMode: true } });
    await h.submit('/mouse');
    expect(h.liveSetters['setMouseMode']).not.toHaveBeenCalled();
    expect(h.liveSetters['setNativeMouse']).not.toHaveBeenCalled();
    expect(h.capabilities['saveSettings']).not.toHaveBeenCalled();
    expect(h.actions.some((a) => a.entry?.text.includes('Mouse mode: ON'))).toBe(true);
  });
});

describe('createSubmitController — /clear cascade', () => {
  function clearedHost(extra: Record<string, unknown> = {}) {
    return makeHost({ slashResult: { metadata: { cleared: true, ...extra } } });
  }

  it('runs the full teardown when the registry confirms the clear', async () => {
    const h = clearedHost();
    const abort = { abort: vi.fn() };
    (h.refs['enhanceAbort'] as { current: unknown }).current = abort;
    await h.submit('/clear');
    expect(h.refs['sessionGeneration']?.current).toBe(1);
    expect(h.capabilities['clearTerminal']).toHaveBeenCalled();
    expect(h.capabilities['onClearHistory']).toHaveBeenCalled();
    expect(h.actionFns['setMemoryContextMonitor']).toHaveBeenCalled();
    const tokenCounter = h.capabilities['tokenCounter'] as unknown as {
      reset: ReturnType<typeof vi.fn>;
    };
    expect(tokenCounter.reset).toHaveBeenCalled();
    expect(abort.abort).toHaveBeenCalledWith('session cleared');
    expect(h.refs['enhanceCancelled']?.current).toBe(true);
    expect(h.refs['enhanceOriginal']?.current).toBe('');
    expect(h.refs['autoSubmitStreak']?.current).toBe(0);
    expect(h.actionFns['onAfterClear']).toHaveBeenCalled();
  });

  it('cancels a pending next-steps auto-submit timer', async () => {
    const timer = setInterval(() => {}, 10_000);
    const h = makeHost({ slashResult: { metadata: { cleared: true } }, nextStepsTimer: timer });
    await h.submit('/clear');
    expect(h.refs['nextStepsTimer']?.current).toBeUndefined();
    clearInterval(timer);
  });

  it('terminates live subagents before clearing when a director exists', async () => {
    const terminateAll = vi.fn(async () => {});
    const h = makeHost({ slashResult: { metadata: { cleared: true } }, director: { terminateAll } });
    await h.submit('/clear');
    expect(terminateAll).toHaveBeenCalled();
  });

  it('does not clear when the command name merely contains "clear"', async () => {
    const h = makeHost({ slashResult: { metadata: { cleared: true } } });
    await h.submit('/clear-cache');
    expect(h.capabilities['clearTerminal']).not.toHaveBeenCalled();
    expect(h.actionFns['onAfterClear']).not.toHaveBeenCalled();
  });

  it('does not clear when the registry did not confirm', async () => {
    const h = makeHost({ slashResult: { metadata: {} } });
    await h.submit('/clear');
    expect(h.capabilities['clearTerminal']).not.toHaveBeenCalled();
  });
});

describe('createSubmitController — plain messages', () => {
  it('appends the text to the builder, echoes the user bubble, and runs', async () => {
    const h = makeHost();
    await h.submit('hello world');
    expect(h.builder.appendText).toHaveBeenCalledWith('hello world');
    expect(findAction(h, 'historyPush')?.text).toBe('hello world');
    expect(h.actionFns['clearDraft']).toHaveBeenCalled();
    const user = h.actions.find((a) => a.entry?.kind === 'user' && !('queued' in (a.entry ?? {})));
    expect(user?.entry?.text).toBe('hello world');
    expect(h.actionFns['runBlocks']).toHaveBeenCalledTimes(1);
  });

  it('returns silently when no builder is wired', async () => {
    const h = makeHost();
    (h.refs['builder'] as { current: unknown }).current = null;
    await h.submit('hello');
    expect(h.actionFns['runBlocks']).not.toHaveBeenCalled();
  });

  it('prepends the SDD session context when one is active', async () => {
    const h = makeHost({ sddContext: 'SPEC CONTEXT' });
    await h.submit('what next?');
    expect(h.builder.appendText).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('[SDD SESSION ACTIVE]\nSPEC CONTEXT'),
    );
    expect(h.builder.appendText).toHaveBeenNthCalledWith(2, 'what next?');
  });

  it('builds paste previews limited to six content lines', async () => {
    const h = makeHost();
    const previews = h.refs['tokenPreviews']?.current as Map<string, string> | undefined;
    previews?.set(
      '[pasted #1 note]',
      ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].join('\n'),
    );
    await h.submit('check this [pasted #1 note]');
    const user = h.actions.find((a) => a.entry?.kind === 'user');
    expect(user?.entry?.pasteContent).toContain('  l6');
    expect(user?.entry?.pasteContent).not.toContain('l7');
  });

  it('injects a steering preamble and consumes the steering state', async () => {
    const h = makeHost({ state: { steeringPending: true } as Partial<State> });
    await h.submit('go left instead');
    expect(h.builder.appendText).toHaveBeenCalledWith(expect.stringContaining('go left instead'));
    const user = h.actions.find((a) => a.entry?.kind === 'user');
    expect(user?.entry?.text).toBe('↯ go left instead');
    expect(findAction(h, 'steerConsume')).toBeDefined();
  });
});

describe('createSubmitController — bare continue', () => {
  const todos = [
    { id: 't1', content: 'Write the docs', status: 'pending' as const, activeForm: 'Writing the docs' },
  ];

  function continueHost(extra: Parameters<typeof makeHost>[0] = {}) {
    return makeHost({ todos, ...extra });
  }

  async function resolveContinue(
    h: ReturnType<typeof continueHost>,
    value: 'proceed' | 'edit' | 'cancel',
  ) {
    await new Promise((r) => setTimeout(r, 0));
    const open = findAction(h, 'continueConfirmOpen');
    const resolve = open?.info?.resolve as ((v: 'proceed' | 'edit' | 'cancel') => void) | undefined;
    expect(resolve).toBeDefined();
    resolve?.(value);
  }

  it('marks the next todo in_progress and sends the resolved instruction on proceed', async () => {
    const h = continueHost();
    const pending = h.submit('continue');
    await resolveContinue(h, 'proceed');
    await pending;
    expect(h.ctx.todos[0]?.status).toBe('in_progress');
    expect(h.builder.appendText).toHaveBeenLastCalledWith(expect.stringContaining('Write the docs'));
    expect(h.actionFns['runBlocks']).toHaveBeenCalled();
    const user = h.actions.find((a) => a.entry?.kind === 'user');
    expect(user?.entry?.text).not.toBe('continue');
  });

  it('cancel discards the turn without running', async () => {
    const h = continueHost();
    const pending = h.submit('continue');
    await resolveContinue(h, 'cancel');
    await pending;
    expect(h.actionFns['clearDraft']).toHaveBeenCalled();
    expect(h.actionFns['runBlocks']).not.toHaveBeenCalled();
  });

  it('edit seeds the composer with the resolved instruction', async () => {
    const h = continueHost();
    const pending = h.submit('continue');
    await resolveContinue(h, 'edit');
    await pending;
    expect(h.actionFns['setDraft']).toHaveBeenCalledWith(
      expect.stringContaining('Write the docs'),
      expect.any(Number),
    );
    expect(h.actionFns['runBlocks']).not.toHaveBeenCalled();
  });

  it('does not run the confirm flow for a non-continue message', async () => {
    const h = continueHost();
    await h.submit('continue with the auth refactor');
    expect(findAction(h, 'continueConfirmOpen')).toBeUndefined();
    expect(h.actionFns['runBlocks']).toHaveBeenCalled();
  });
});

describe('createSubmitController — busy agent', () => {
  it('silently queues when the mid-run picker is off', async () => {
    const h = makeHost({ statusRef: 'running', midRunPicker: false });
    await h.submit('while you are at it');
    expect(findAction(h, 'sendModePickerOpen')).toBeUndefined();
    const queued = h.actions.find((a) => a.entry?.kind === 'user' && 'queued' in (a.entry ?? {}));
    expect(queued?.entry?.queued).toBe(true);
    const enqueue = findAction(h, 'enqueue');
    expect(enqueue?.item?.displayText).toBe('while you are at it');
    expect(h.actionFns['runBlocks']).not.toHaveBeenCalled();
  });

  it('queues with journalRaw when the prompt was refined', async () => {
    const h = makeHost({ statusRef: 'running', midRunPicker: false });
    const pending = h.submit('queued message');
    await pending;
    const enqueue = findAction(h, 'enqueue');
    expect(enqueue?.item).not.toHaveProperty('journalRaw');
  });

  it('folds a btw note without interrupting the run', async () => {
    const h = makeHost({ statusRef: 'running', midRunPicker: true });
    const pending = h.submit('btw remember the milk');
    await new Promise((r) => setTimeout(r, 0));
    const open = findAction(h, 'sendModePickerOpen');
    const resolve = open?.info?.resolve as ((v: string) => void) | undefined;
    expect(resolve).toBeDefined();
    resolve?.('btw');
    await pending;
    expect(h.actions.some((a) => a.entry?.kind === 'info' && a.entry?.text.includes('Noted (1 pending)'))).toBe(true);
    expect(h.actionFns['runBlocks']).not.toHaveBeenCalled();
  });

  it('steers immediately when the user picks steer', async () => {
    const h = makeHost({ statusRef: 'running', midRunPicker: true });
    const pending = h.submit('change direction now');
    await new Promise((r) => setTimeout(r, 0));
    const open = findAction(h, 'sendModePickerOpen');
    const resolve = open?.info?.resolve as ((v: string) => void) | undefined;
    expect(resolve).toBeDefined();
    resolve?.('steer');
    await pending;
    expect(h.actionFns['runSteerSequence']).toHaveBeenCalledWith('change direction now');
    expect(h.builder.appendText).toHaveBeenCalledWith('STEER-PREAMBLE(change direction now)');
    expect(h.actionFns['runBlocks']).toHaveBeenCalled();
  });

  it('restores the draft on cancel', async () => {
    const h = makeHost({ statusRef: 'running', midRunPicker: true });
    const pending = h.submit('never mind');
    await new Promise((r) => setTimeout(r, 0));
    const open = findAction(h, 'sendModePickerOpen');
    const resolve = open?.info?.resolve as ((v: string) => void) | undefined;
    expect(resolve).toBeDefined();
    resolve?.('cancel');
    await pending;
    expect(h.actionFns['setDraft']).toHaveBeenCalledWith('never mind', 'never mind'.length);
    expect(h.actionFns['runBlocks']).not.toHaveBeenCalled();
  });

  it('switches autonomy off when an auto countdown is interrupted by input', async () => {
    const timer = setInterval(() => {}, 10_000);
    const h = makeHost({ statusRef: 'running', autonomy: 'auto', nextStepsTimer: timer, midRunPicker: false });
    await h.submit('manual correction');
    expect(h.capabilities['switchAutonomy']).toHaveBeenCalledWith('off');
    clearInterval(timer);
  });

  it('leaves autonomy alone when no countdown is running', async () => {
    const h = makeHost({ statusRef: 'running', autonomy: 'auto', midRunPicker: false });
    await h.submit('manual correction');
    expect(h.capabilities['switchAutonomy']).not.toHaveBeenCalled();
  });
});

describe('createSubmitController — runText follow-ups', () => {
  it('runs the queued text through the builder after the command renders', async () => {
    const h = makeHost({ slashResult: { runText: 'auto follow-up' } });
    await h.submit('/steer go faster');
    expect(h.builder.appendText).toHaveBeenCalledWith('auto follow-up');
    expect(h.actionFns['runBlocks']).toHaveBeenCalled();
  });

  it('leaves the journal raw marker empty for unrefined text', async () => {
    const h = makeHost();
    await h.submit('plain text');
    expect(Object.keys(h.ctx.meta).length).toBe(0);
  });
});
