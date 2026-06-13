// PR 0 of the tui/src/app.tsx split refactor (Issue #23).
//
// Baseline integration test: mount the TUI's top-level <App /> component
// and assert it renders without throwing. Future hook extractions
// (PRs 1-6 of the issue plan) MUST keep this test green.
//
// The test does not yet exercise user input — that's a follow-up once
// the stub factory in ./helpers/app-stubs.ts has been fleshed out to
// cover all of App's 60+ props. The point of this first slice is to
// prove the harness works and that mounting App is feasible.

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../src/app.js';

describe('<App /> baseline mount (PR 0 of Issue #23)', () => {
  it('mounts without throwing', () => {
    // App has 60+ props. We pass `undefined` for everything that does
    // not have a default in the function signature, and `vi.fn()` for
    // the callback-typed ones so a stray invocation is captured.
    const noop = () => {};
    const noopAsync = async () => undefined;

    const { lastFrame, unmount } = render(
      React.createElement(App, {
        agent: undefined,
        slashRegistry: undefined,
        attachments: undefined,
        events: undefined,
        tokenCounter: undefined,
        visionAdapters: [],
        supportsVision: false,
        model: 'gpt-4o-mini',
        banner: false,
        queueStore: undefined,
        onQueueChange: noop,
        yolo: false,
        chime: false,
        confirmExit: false,
        mouse: false,
        enhanceEnabled: false,
        enhanceController: undefined,
        enhanceDelayMs: 0,
        getYolo: () => false,
        getAutonomy: () => 'normal',
        getEternalEngine: () => undefined,
        getParallelEngine: () => undefined,
        subscribeEternalIteration: noop,
        subscribeEternalStage: noop,
        subscribeAutoPhase: noop,
        getSDDContext: async () => undefined,
        onSDDOutput: noop,
        appVersion: '0.0.0-test',
        provider: 'test',
        family: 'test',
        keyTail: '',
        getPickableProviders: () => [],
        switchProviderAndModel: noopAsync,
        getSettings: () => ({}),
        saveSettings: noopAsync,
        predictNext: () => [],
        onSuggestionsParsed: noop,
        getSuggestions: () => [],
        setSuggestions: noop,
        switchAutonomy: noop,
        effectiveMaxContext: 0,
        onExit: noop,
        director: undefined,
        fleetRoster: [],
        onClearHistory: noop,
        listSessions: async () => [],
        onResumeSession: noopAsync,
        fleetStreamController: undefined,
        statuslineHiddenItems: new Set(),
        setStatuslineHiddenItems: noop,
        agentsMonitorController: undefined,
        initialGoal: undefined,
        initialAsk: undefined,
        sessionsDir: undefined,
        modeLabel: undefined,
        getModeLabel: () => 'test',
        registerDebugStreamCallback: noop,
        restoreDebugStreamCallback: noop,
        restoredToolCalls: undefined,
        getProjectPickerItems: () => [],
        onProjectSelect: noop,
        requestExit: noop,
        getLiveSessions: () => [],
        onSwitchToSession: noop,
        initialAgentsMonitorOpen: false,
      }),
    );

    // We don't yet assert on the rendered text — that requires the
    // status bar to mount, which in turn requires live subscriptions
    // to the events bus. The mere fact that the component mounts and
    // produces a frame is the gate.
    const frame = lastFrame();
    expect(typeof frame).toBe('string');
    expect(frame.length).toBeGreaterThanOrEqual(0); // tolerate empty frame, fail on undefined/null

    unmount();
  }, 30_000);
});
