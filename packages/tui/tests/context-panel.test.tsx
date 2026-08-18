import type { ContextBreakdown } from '@wrongstack/core/utils';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ContextPanel, type ContextPanelData } from '../src/components/context-panel.js';
import { emptyMemoryContextMonitor } from '../src/memory-context-monitor.js';
import { waitForFrame } from './helpers/frame-wait.js';

const ESC = String.fromCharCode(27);
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;

/** Flush ink's input handling + React re-render before reading the frame. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function breakdown(): ContextBreakdown {
  return {
    system: {
      total: 30_000,
      bySource: {
        identity: 18_000,
        'tool-usage': 6_000,
        environment: 4_000,
        skills: 2_000,
        glossary: 0,
        mode: 0,
        plan: 0,
        'leader-after-task': 0,
        contributor: 0,
        ledger: 0,
        peers: 0,
        nextsteps: 0,
        other: 0,
      },
    },
    tools: { total: 12_000, builtin: 7_000, mcp: 5_000, count: 42, mcpByServer: { gmail: 5_000 } },
    history: {
      total: 41_000,
      text: 25_000,
      toolInputs: 5_000,
      toolResults: 8_000,
      thinking: 3_000,
      other: 0,
      messageCount: 12,
    },
    volatile: { ledger: 300, nextsteps: 100, total: 400 },
    total: 83_400,
    effectiveMaxContext: 200_000,
    usedPct: 0.417,
    warnings: [],
  };
}

function baseData(overrides: Partial<ContextPanelData> = {}): ContextPanelData {
  return {
    ctxPct: 0.42,
    ctxTokens: 83_400,
    ctxMaxTokens: 200_000,
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    mode: 'default',
    uptime: '3m',
    breakdown: breakdown(),
    fleetEntries: [],
    leaderIterations: 4,
    leaderToolCalls: 9,
    leaderStatus: 'idle',
    memoryContext: emptyMemoryContextMonitor(),
    ...overrides,
  };
}

describe('ContextPanel tabs', () => {
  it('opens on the Overview tab and does not render other tabs', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ContextPanel, { data: baseData(), onClose: () => {} }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('PRESSURE');
    expect(frame).toContain('TOKEN METRICS');
    // Only the active tab renders — Composition/Threshold sections are hidden.
    expect(frame).not.toContain('CONTEXT COMPOSITION');
    expect(frame).not.toContain('THRESHOLD MAP');
    unmount();
  });

  it('jumps to the Composition tab with a number key and shows measured (not fake) data', async () => {
    const { lastFrame, stdin, unmount } = render(
      React.createElement(ContextPanel, { data: baseData(), onClose: () => {} }),
    );
    stdin.write('2');
    const frame = await waitForFrame({ lastFrame }, (f) => f.includes('CONTEXT COMPOSITION'));
    expect(frame).toContain('CONTEXT COMPOSITION');
    expect(frame).toContain('Measured breakdown');
    expect(frame).toContain('System');
    expect(frame).toContain('History');
    expect(frame).toContain('inputs 5.0k');
    expect(frame).toContain('thinking 3.0k');
    // Overview content is gone once we switch away.
    expect(frame).not.toContain('PRESSURE');
    unmount();
  });

  it('cycles tabs with the right/left arrows and wraps around', async () => {
    const { lastFrame, stdin, unmount } = render(
      React.createElement(ContextPanel, { data: baseData(), onClose: () => {} }),
    );
    stdin.write(RIGHT); // overview -> composition
    expect(await waitForFrame({ lastFrame }, (f) => f.includes('CONTEXT COMPOSITION'))).toContain(
      'CONTEXT COMPOSITION',
    );
    stdin.write(RIGHT); // composition -> thresholds
    expect(await waitForFrame({ lastFrame }, (f) => f.includes('THRESHOLD MAP'))).toContain(
      'THRESHOLD MAP',
    );
    stdin.write(LEFT); // thresholds -> composition
    expect(await waitForFrame({ lastFrame }, (f) => f.includes('CONTEXT COMPOSITION'))).toContain(
      'CONTEXT COMPOSITION',
    );
    unmount();
  });

  it('shows an honest empty state on the Composition tab when no request is assembled', async () => {
    const { lastFrame, stdin, unmount } = render(
      React.createElement(ContextPanel, {
        data: baseData({ breakdown: undefined }),
        onClose: () => {},
      }),
    );
    stdin.write('2');
    const frame = await waitForFrame({ lastFrame }, (f) => f.includes('No request assembled yet'));
    expect(frame).toContain('CONTEXT COMPOSITION');
    expect(frame).toContain('No request assembled yet');
    unmount();
  });

  it('closes on q and leaves Esc to the central ESC_CLOSE_PANELS table', async () => {
    let closed = false;
    const { stdin, unmount } = render(
      React.createElement(ContextPanel, {
        data: baseData(),
        onClose: () => {
          closed = true;
        },
      }),
    );
    // Esc is deliberately NOT handled by the panel — the central table in
    // esc-close-panels.ts dispatches toggleContextPanel. Handling it here too
    // double-fired the toggle and re-opened the panel on a single keypress.
    stdin.write(ESC);
    // A lone ESC must clear ink's escape-sequence disambiguation window before
    // it commits to `key.escape`, so wait a real tick rather than a microtask.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(closed).toBe(false);
    stdin.write('q');
    await flush();
    expect(closed).toBe(true);
    unmount();
  });
});
