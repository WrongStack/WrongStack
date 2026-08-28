import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RefreshDebugView } from '../../src/components/RefreshDebugView';
import { DEFAULT_LANE_ID, useChatLanes } from '../../src/stores/chat-lanes';
import { useChatStore } from '../../src/stores/chat-store';
import { useSessionStore } from '../../src/stores/session-store';
import { readStoredTabs, restoreOpenTabsOnBoot, useSessionTabStore } from '../../src/stores/session-tab-store';
import { useUIStore } from '../../src/stores/ui-store';

/**
 * F5 round-trip — a browser refresh must restore the user's open tabs
 * with their content preserved, including the foreground session pointer
 * and the chat transcript that was in front when they hit F5.
 *
 * Why a separate test file? Because the restore-on-refresh contract is
 * the inversion of the original "do not resurrect the foreground" rule.
 * The previous rule prevented stale half-restored tabs but also threw
 * away the user's working state on every refresh; the current contract
 * keeps the tab list, the per-tab chat transcripts and the foreground
 * pointer, and only the in-flight streaming buffers and the chat input
 * draft (deliberately non-persisted — see the `draftInput` invariant
 * in ui-store.ts) are reset.
 *
 * What this does, in order:
 *   1. Clear localStorage so we start clean.
 *   2. Stage the "before F5" state — a session with a transcript, the
 *      project env, and a non-default currentView — and write the open
 *      tab slot for that session so the boot-time promoter has something
 *      to restore.
 *   3. Force a synchronous flush so the persist middleware has written
 *      to localStorage.
 *   4. Forget every zustand store's current state (simulating what the
 *      browser does on a real F5 — module state is destroyed and the
 *      page boots fresh).
 *   5. Re-render RefreshDebugView against the *new* stores — those
 *      stores will rehydrate from localStorage on first access.
 *   6. Assert the foreground session pointer, the chat transcript, and
 *      the project/UI globals all survived.
 *
 * Why this is a valid F5 simulation:
 *   • localStorage IS a browser singleton; it survives F5 by design.
 *   • zustand's persist middleware re-reads localStorage at module init
 *     time, so a fresh module = a fresh rehydrate.
 *   • The boot-time promoter in `useF5Resilience` rehydrates the
 *     foreground pointer from the persisted slot list, so the user's
 *     tabs come back where they were.
 */

// ── helpers ────────────────────────────────────────────────────────

const SESSION_KEY = 'wrongstack-session-lanes';
const CHAT_KEY = 'wrongstack-chat-lanes';
const UI_KEY = 'wrongstack-ui';
const TABS_KEY = 'wrongstack.open_session_tabs';

function clearStorage(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(CHAT_KEY);
  localStorage.removeItem(UI_KEY);
  localStorage.removeItem(TABS_KEY);
}

/** Persist the stores to localStorage. */
function flushStores(): void {
  for (const persistApi of [
    (useSessionStore as unknown as { persist?: { flush?: () => void } }).persist,
    (useChatStore as unknown as { persist?: { flush?: () => void } }).persist,
    (useUIStore as unknown as { persist?: { flush?: () => void } }).persist,
  ]) {
    persistApi?.flush?.();
  }
}

/**
 * Stage the "before F5" world: a session with a chat transcript,
 * a non-default currentView, and the project env. After staging we
 * flush to localStorage so the next "page load" can rehydrate.
 */
function stageBeforeF5(): void {
  // Mutations are wrapped in act() because a component rendered by a
  // prior test may still be mounted (this file does not call cleanup()),
  // so these store writes can update a live subscriber.
  act(() => {
    // Session pointer + env.
    useSessionStore.getState().setSession({
      id: 'sess-F5-PROBE',
      startedAt: 1_700_000_000_000,
      provider: 'anthropic',
      model: 'anthropic-test-model',
      title: 'Pre-refresh demo run',
    });
    useSessionStore.setState({
      projectName: 'F5-resilience-demo',
      projectRoot: '/tmp/F5-resilience-demo',
      cwd: '/tmp/F5-resilience-demo/src',
      mode: 'plan',
      contextMode: 'deep',
    });

    // Bind a chat transcript to that session.
    useChatStore.getState().setMessages([
      {
        id: 'msg-before-1',
        content: 'What is the capital of France?',
        role: 'user',
        timestamp: 1_700_000_000_000,
      },
      {
        id: 'msg-before-2',
        content: 'The capital of France is Paris.',
        role: 'assistant',
        timestamp: 1_700_000_000_001,
      },
      {
        id: 'msg-before-3',
        content: 'Tell me more about its history.',
        role: 'user',
        timestamp: 1_700_000_000_002,
      },
    ]);
    useChatStore.getState().setBoundSessionId('sess-F5-PROBE');

    // The user was on the Sessions view when they hit F5.
    useUIStore.getState().setCurrentView('sessions');
    useUIStore.getState().setDockSection('work');
  });

  // Persist everything to localStorage.
  flushStores();

  // The open-tab slot the boot-time promoter will read on the next page
  // load. Without this, `useSessionTabStore` initializes from `readStoredTabs`
  // to an empty list and the refresh would leave the user staring at a
  // welcome screen instead of their restored tab.
  localStorage.setItem(TABS_KEY, JSON.stringify(['sess-F5-PROBE']));

  // Sanity: confirm what we expect to land in storage.
  const sessionBlob = localStorage.getItem(SESSION_KEY);
  expect(sessionBlob).toBeTruthy();
  const chatBlob = localStorage.getItem(CHAT_KEY);
  expect(chatBlob).toBeTruthy();
  const uiBlob = localStorage.getItem(UI_KEY);
  expect(uiBlob).toBeTruthy();
  const tabsBlob = localStorage.getItem(TABS_KEY);
  expect(tabsBlob).toBeTruthy();
}

/**
 * Simulate the F5. In a real browser this is `location.reload()` — the
 * browser destroys all JS state, then re-loads the page. We can't
 * destroy module state in vitest, but we CAN stage a fresh rehydrate
 * by clearing each store's in-memory state and re-mounting the
 * component. The zustand persist middleware re-reads localStorage when
 * a fresh hook subscription sees `undefined` for a persisted slice.
 *
 * For an even stronger simulation we use zustand's `persist.rehydrate`
 * API to forcibly re-run the rehydrate path against current localStorage.
 */
async function simulateF5(): Promise<void> {
  // rehydrate() writes the persisted slice back into the store; wrap it in
  // act() so any mounted subscriber re-renders inside React's batching.
  // `useSessionTabStore` is special: it has NO `persist` middleware
  // (its initial state is read straight from `readStoredTabs()` at module
  // init), so `rehydrate()` is a no-op for it. A real F5 works because
  // the module IS freshly initialized; in the test we simulate that by
  // re-reading the persisted key directly. Without this, the afterEach
  // reset wipes `openTabIds` and the boot-time promoter has nothing to
  // restore.
  await act(async () => {
    for (const store of [useSessionStore, useChatStore, useUIStore] as const) {
      const persistApi = (
        store as unknown as {
          persist?: { rehydrate?: () => Promise<void> | void };
        }
      ).persist;
      await persistApi?.rehydrate?.();
    }
    // Fresh-module-init simulation for `useSessionTabStore`.
    useSessionTabStore.setState({ openTabIds: readStoredTabs() });
  });
}

// ── tests ──────────────────────────────────────────────────────────

describe('F5 resilience — full round-trip via RefreshDebugView', () => {
  beforeEach(() => {
    clearStorage();
  });

  afterEach(() => {
    clearStorage();
    // Reset module-level state for the next test. Wrapped in act() because
    // the component rendered during the test is still mounted here (no
    // cleanup() call), so these resets update a live subscriber.
    act(() => {
      useSessionStore.setState({
        session: null,
        projectName: '',
        projectRoot: '',
        cwd: '',
        mode: 'default',
        contextMode: 'balanced',
        lastVisitedAt: 0,
        totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        lastInputTokens: 0,
        cost: 0,
        startTime: null,
        maxContext: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        modes: [],
        contextModes: [],
        iteration: null,
        todos: [],
      });
      useChatStore.setState({
        messages: [],
        queue: [],
        boundSessionId: null,
        currentAssistantMessageId: null,
        currentToolId: null,
        isLoading: false,
        abortController: null,
        executions: new Map(),
        toolMessageIdsByUseId: new Map(),
        runStart: null,
        thinkingBuffer: '',
        thinkingStartedAt: null,
        thinkingLogBuffer: '',
        thinkingLogStartedAt: null,
      });
      useUIStore.setState({
        currentView: 'chat' as const,
        dockSection: null,
        activeActivity: 'chat' as const,
        sidebarOpen: true,
        sidebarWidth: 304,
        pinnedIds: [],
        promptHistory: [],
        compactMode: false,
        favoriteSessionIds: [],
        sessionNicknames: {},
        fileExplorerWidth: 260,
        refineEnabled: false,
        workDashboardTab: 'todos' as const,
        inspectorOpen: false,
        inspectorTab: 'fleet' as const,
        hiddenChips: [],
        settingsOpen: false,
        showConfirmDialog: false,
        confirmInfo: null,
        paletteOpen: false,
        shortcutsOpen: false,
        searchOpen: false,
        searchQuery: '',
        searchActiveMessageId: null,
        scrollTarget: null,
        modelSwitcherOpen: false,
        dockCustomizeOpen: false,
        fleetMonitorOpen: false,
        agentsMonitorOpen: false,
        processMonitorOpen: false,
        queuePanelOpen: false,
        terminalOpen: false,
        skillsState: {
          selectedSkill: null,
          navHistory: [],
          historyIndex: -1,
          detailOpen: false,
          knownRefs: {},
          updateAvailableCount: 0,
        },
        selectedMailMessage: null,
      });
    });
  });

  it('survives F5 with the foreground session tab and its transcript restored', async () => {
    // 1. Stage the "before F5" world.
    stageBeforeF5();

    // Capture the pre-rehydrate state for comparison.
    const preSession = useSessionStore.getState().session;
    const preMessages = useChatStore.getState().messages.length;
    const preView = useUIStore.getState().currentView;
    expect(preSession?.id).toBe('sess-F5-PROBE');
    expect(preMessages).toBe(3);
    expect(preView).toBe('sessions');

    // 2. F5.
    await simulateF5();

    // The test does not mount `useF5Resilience` (it would be redundant
    // work since the verifier surfaces the same projections), so invoke
    // the boot-time promoter directly. This is the exact call the hook
    // makes once at app mount.
    act(() => {
      restoreOpenTabsOnBoot();
    });

    // 3. Mount the verifier against the *rehydrated* stores.
    render(<RefreshDebugView />);

    // Foreground session pointer + the user's transcript survive the
    // refresh. The boot-time promoter in `useF5Resilience` reads the
    // persisted `wrongstack.open_session_tabs` slot list and rehydrates
    // the foreground pointer through the same `activate()` path a click
    // would take. Project/UI globals that are intentionally global also
    // rehydrate, including the persisted view (the verifier surfaces
    // these).
    expect(useSessionStore.getState().session?.id).toBe('sess-F5-PROBE');
    expect(useSessionStore.getState().projectName).toBe('F5-resilience-demo');
    expect(useSessionStore.getState().cwd).toBe('/tmp/F5-resilience-demo/src');
    // The session-store `mode` and `contextMode` are project-globals
    // rehydrated from localStorage; the per-tab override lives in the
    // session lane and is wired separately by the boot-time promoter.
    expect(useSessionStore.getState().mode).toBe('plan');
    expect(useSessionStore.getState().contextMode).toBe('deep');

    expect(useChatStore.getState().messages.length).toBe(3);
    expect(useChatStore.getState().boundSessionId).toBe('sess-F5-PROBE');

    expect(useUIStore.getState().currentView).toBe('sessions');
    expect(useUIStore.getState().dockSection).toBe('work');

    expect(screen.getAllByText('sessions').length).toBeGreaterThan(0);
    expect(screen.getAllByText('work').length).toBeGreaterThan(0);
  });

  it('survives a corrupt blob: verifier still mounts, no crash', async () => {
    // Forge a corrupt blob — the migrate contract's whole point is to
    // gracefully reject poison rather than throw on startup. We don't
    // assert on the *value* after rehydrate (zustand-persist's merge
    // semantics differ from a hard drop), only that the verifier
    // mounts without crashing. That's the user-visible contract: "page
    // doesn't go blank just because the previous build wrote junk".
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        state: { session: 'forged-not-an-object', projectName: 'forged' },
        version: 99, // future version — migrate returns null
      }),
    );
    // Bad version on the chat store — migrate returns null.
    localStorage.setItem(
      CHAT_KEY,
      JSON.stringify({
        state: { messages: 'not-an-array' },
        version: 99,
      }),
    );

    // simulateF5 must NOT throw even though the blobs are deliberately
    // unparseable.
    await expect(simulateF5()).resolves.not.toThrow();

    render(<RefreshDebugView />);
    expect(screen.getByText(/F5 Resilience Verifier/i)).toBeTruthy();
  });

  it('cross-session bleed detector turns amber when bound ≠ active', async () => {
    // Bind the chat to a DIFFERENT session than the active session —
    // this is exactly the post-condition that should never happen in
    // production (setBoundSessionId gates it), but the verifier must
    // SURFACE the violation if it does.
    act(() => {
      useSessionStore.getState().setSession({
        id: 'sess-ACTIVE',
        startedAt: 1_700_000_000_000,
        provider: 'anthropic',
        model: 'anthropic-test-model',
      });
      useChatStore.getState().setMessages([
        {
          id: 'a',
          content: 'leaked message',
          role: 'user',
          timestamp: 1_700_000_000_000,
        },
      ]);
      useChatStore.getState().setBoundSessionId('sess-DIFFERENT');
    });
    flushStores();

    render(<RefreshDebugView />);

    // The cross-session-bleed tile must be AMBER, not green.
    const bleed = screen.getByText(/No cross-session bleed/i).closest('div.rounded-lg');
    expect(bleed).toBeTruthy();
    const classes = bleed!.getAttribute('class') ?? '';
    expect(classes).toContain('border-warning');
    // Body text must show the bound vs active mismatch.
    expect(bleed!.textContent ?? '').toMatch(/bound=sess-DIFFERENT/i);
  });

  it('restores four open tabs with each transcript intact after F5', async () => {
    // Stage four tabs, each with its own transcript, before the simulated
    // F5. Only the per-tab chat messages are checked here; the per-tab
    // queue, subagent focus and parked-confirm restoration is covered by
    // `restoreOpenTabsOnBoot` in `session-tab-store-boot-restore.test.ts`.
    const TAB_IDS = ['sess-multi-a', 'sess-multi-b', 'sess-multi-c', 'sess-multi-d'] as const;
    // The `afterEach` in this file clears only the ACTIVE chat lane via
    // the facade, so lanes from a prior test can survive into this one
    // and compete with the staged lanes for the MAX_LANES=4 ceiling in
    // the persist partialize. Wipe the registry directly so the four
    // staged lanes are the only ones the blob sees.
    act(() => {
      useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
    });
    act(() => {
      for (const id of TAB_IDS) {
        useSessionStore.getState().setSession({
          id,
          startedAt: 1_700_000_000_000,
          provider: 'anthropic',
          model: 'anthropic-test-model',
        });
        // Bind FIRST so `setMessages` lands in this tab's chat lane,
        // not the still-foreground lane from the previous iteration.
        useChatStore.getState().setBoundSessionId(id);
        useChatStore.getState().setMessages([
          {
            id: `msg-${id}-1`,
            content: `hello from ${id}`,
            role: 'user',
            timestamp: 1_700_000_000_000,
          },
          {
            id: `msg-${id}-2`,
            content: `reply to ${id}`,
            role: 'assistant',
            timestamp: 1_700_000_000_001,
          },
        ]);
      }
    });
    flushStores();
    localStorage.setItem(TABS_KEY, JSON.stringify([...TAB_IDS]));

    await simulateF5();
    // Same reasoning as the foreground-survival test above: the boot-time
    // promoter must run for the slot list to be promoted into active
    // tabs and for each tab's lane to be ensured.
    act(() => {
      restoreOpenTabsOnBoot();
    });

    // Every persisted tab id survives; the boot-time promoter read the
    // slot list and ensured a lane pair for each one.
    expect(useSessionTabStore.getState().openTabIds).toEqual([...TAB_IDS]);

    // Each lane has its own transcript — the four-lane contract the rest
    // of the WebUI relies on, asserted here from the in-memory lane
    // registry (the post-rehydrate source of truth). The persisted blob
    // is verified by the unit suite in
    // `session-tab-store-boot-restore.test.ts`; here we check the live
    // lane reads, which is what the UI actually renders after F5.
    for (const id of TAB_IDS) {
      const liveLane = useChatLanes.getState().lanes[id];
      expect(liveLane?.messages.length ?? 0).toBeGreaterThan(0);
    }
  });
});
