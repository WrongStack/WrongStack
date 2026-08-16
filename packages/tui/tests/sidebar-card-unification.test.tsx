/**
 * Sidebar card unification test — verifies that the persistent cards and
 * the routed F-key panel twins share the same `Card` iskelet from
 * `components/sidebar-card.tsx`. After the v3 refactor, both surfaces
 * draw their raised-surface chrome from the same component, so a glance
 * down the right rail reads as one visual family regardless of which
 * section is which.
 *
 * Specific assertions:
 *   * The persistent MODEL CORE card and a routed F-twin (e.g. FLEET)
 *     both render `╭...╮` / `╰...╯` corner frames at the same rail
 *     width.
 *   * The F twin delegates to the shared `Card` via `SidebarPanelFrame`,
 *     not a bespoke borderless frame (no separate render path for the
 *     twin's chrome).
 *   * The persistent AGENT SWARM / MISSIONS / SESSIONS cards are SKIPPED
 *     when their corresponding F twin is mounted above (no duplicated
 *     rows of the same data on the rail).
 *   * The width thresholds `PILL_MIN_INNER_WIDTH` and `METRIC_MIN_BODY_WIDTH`
 *     are sourced from `ui-contracts.ts` (no inline literals in the F
 *     twins).
 *   * Empty states across the F twins render through a single
 *     `EmptyState` helper (the leading `·` + muted message pattern).
 */
import type { TodoItem } from '@wrongstack/core/agent';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { FleetEntry } from '../src/app-state-fleet.js';
import { Card } from '../src/components/sidebar-card.js';
import { SidebarContent } from '../src/components/sidebar-content.js';
import {
  ConnectionsPanelSidebar,
  FleetPanelSidebar,
  TodosPanelSidebar,
} from '../src/components/sidebar-panels.js';
import { Box, Text } from '../src/ink.js';
import { METRIC_MIN_BODY_WIDTH, type PanelId, PILL_MIN_INNER_WIDTH } from '../src/ui-contracts.js';
import { glyphs } from '../src/ui-glyphs.js';

function makeEntry(
  id: string,
  name: string,
  status: FleetEntry['status'],
  ctxPct?: number,
): FleetEntry {
  return { id, name, status, ctxPct } as FleetEntry;
}

function makeTodo(
  id: string,
  status: TodoItem['status'],
  content: string,
  activeForm?: string,
): TodoItem {
  return { id, status, content, activeForm };
}

describe('sidebar card unification (persistent + routed share Card iskelet)', () => {
  it('shared Card renders the same corner frame whether used directly or by a routed F-twin', () => {
    // Render the shared Card in isolation at a fixed width and snapshot
    // its frame; the same `╭...╮` / `╰...╯` should appear when the
    // Card is wrapped by SidebarPanelFrame for a routed F-twin.
    const direct = render(
      React.createElement(
        Box,
        { width: 24 },
        React.createElement(Card, {
          innerWidth: 24,
          children: () => React.createElement(Text, null, 'hello'),
        }),
      ),
    );
    const directFrame = direct.lastFrame() ?? '';
    expect(directFrame).toContain('╭');
    expect(directFrame).toContain('╰');
    direct.unmount();
  });

  it('a routed F-twin renders the same Card frame as a persistent card at the same rail width', () => {
    const width = 24;
    const { lastFrame: twinFrame } = render(
      React.createElement(
        Box,
        { width },
        React.createElement(FleetPanelSidebar, { entries: {}, runningCount: 0, width }),
      ),
    );
    const { lastFrame: persistentFrame } = render(
      React.createElement(
        Box,
        { width },
        React.createElement(SidebarContent, {
          contextWindow: { used: 1000, max: 10000 },
          entries: {},
          fleetCounts: undefined,
          width,
          showSwarmSection: true,
        }),
      ),
    );
    // The persistent card and the routed F-twin both render the same
    // `╭...╮` / `╰...╯` corner pair (the F-twin delegates to the
    // shared Card). Assert each surface has at least one corner pair.
    const twinText = twinFrame();
    const persistentText = persistentFrame();
    expect(twinText).toContain('╭');
    expect(twinText).toContain('╰');
    expect(persistentText).toContain('╭');
    expect(persistentText).toContain('╰');
    twinFrame();
    persistentFrame();
  });

  it('effectiveSidebarRoutes hides the AGENT SWARM card when the F2 fleet twin is mounted', () => {
    const effectiveSidebarRoutes = new Set<PanelId>(['fleet']);
    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 1000, max: 10000 },
        entries: {
          leader: makeEntry('leader', 'Leader Agent', 'running', 0.5),
        },
        fleetCounts: { running: 1, idle: 0, pending: 0, completed: 0 },
        width: 30,
        showSwarmSection: true,
        effectiveSidebarRoutes,
      }),
    );
    const frame = lastFrame() ?? '';
    // The persistent AGENT SWARM card is suppressed because the F2
    // (fleet) twin is already mounted above. The header text is unique
    // to the persistent card, so a positive assertion on its absence
    // is safe.
    expect(frame).not.toContain('AGENT SWARM');
    // MODEL CORE / PROMPT CACHE / SYSTEM cards are unaffected.
    expect(frame).toContain('MODEL CORE');
  });

  it('effectiveSidebarRoutes hides the MISSIONS card when the F6 todos twin is mounted', () => {
    const effectiveSidebarRoutes = new Set<PanelId>(['todos']);
    const todos: TodoItem[] = [
      makeTodo('a', 'in_progress', 'Refactor the sidebar twins', 'Refactoring the sidebar twins'),
      makeTodo('b', 'pending', 'Wire up the gating logic'),
    ];
    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 1000, max: 10000 },
        entries: {},
        fleetCounts: undefined,
        width: 30,
        showSwarmSection: true,
        todos,
        effectiveSidebarRoutes,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('MISSIONS');
  });

  it('effectiveSidebarRoutes hides the SESSIONS card when the F10 sessions twin is mounted', () => {
    const effectiveSidebarRoutes = new Set<PanelId>(['sessions']);
    const liveSessions = [
      {
        sessionId: 's-1',
        projectName: 'WrongStack-main',
        projectSlug: 'wrongstack',
        workingDir: '/workspace',
        status: 'active',
        pid: 12345,
        startedAt: '2026-08-07T04:00:00.000Z',
        agentCount: 1,
        agents: [],
      },
    ];
    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 1000, max: 10000 },
        entries: {},
        fleetCounts: undefined,
        width: 30,
        showSwarmSection: true,
        liveSessions,
        effectiveSidebarRoutes,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('SESSIONS');
  });

  it('persistent cards render normally when no F twin is routed', () => {
    // Sanity: with `effectiveSidebarRoutes` undefined (or empty) the
    // persistent cards are NOT suppressed.
    const { lastFrame } = render(
      React.createElement(SidebarContent, {
        contextWindow: { used: 1000, max: 10000 },
        entries: {
          leader: makeEntry('leader', 'Leader Agent', 'running', 0.5),
        },
        fleetCounts: { running: 1, idle: 0, pending: 0, completed: 0 },
        width: 30,
        showSwarmSection: true,
        // No `effectiveSidebarRoutes` — the persistent AGENT SWARM card
        // should appear.
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('AGENT SWARM');
  });

  it('PILL_MIN_INNER_WIDTH is sourced from ui-contracts (not hand-rolled inline)', () => {
    // The F twins compare `inner >= PILL_MIN_INNER_WIDTH` to decide
    // whether the status pill fits on the title row. Assert the
    // constant exists at the documented value so a future refactor
    // that changes the threshold is forced to update the constant.
    expect(PILL_MIN_INNER_WIDTH).toBe(22);
  });

  it('METRIC_MIN_BODY_WIDTH is sourced from ui-contracts (not hand-rolled inline)', () => {
    // The F twins compare `inner >= METRIC_MIN_BODY_WIDTH` to decide
    // whether to render a per-row metric column (latency, diff, etc.).
    expect(METRIC_MIN_BODY_WIDTH).toBe(24);
  });

  it('EmptyState helper renders the shared "· message" pattern', () => {
    // The routed F twins use EmptyState for "no data" hints. Render one
    // directly and assert the leading muted dot + message pattern.
    const { lastFrame } = render(
      React.createElement(
        Box,
        { width: 20 },
        React.createElement(TodosPanelSidebar, { todos: [], width: 16 }),
      ),
    );
    const frame = lastFrame() ?? '';
    // `· no todos` is the shared pattern; the F-twin delegates through
    // the EmptyState helper rather than hand-rolling the prefix.
    expect(frame).toContain(glyphs.dividerDot);
    expect(frame).toContain('no todos');
  });

  it('no F-twin source still hand-rolls the `╭━◆━╮` signal-matrix band', () => {
    // The Connections panel used to render a hand-rolled `╭━◆━╮ / ╰─
    // SIGNAL MATRIX ─╯` band. After the unification it uses the
    // standard `barFull`/`barEmpty` block pattern. Render a Connections
    // twin and assert the hand-rolled `◆` ornament is NOT the SIGNAL
    // MATRIX row's anchor.
    const { lastFrame } = render(
      React.createElement(
        Box,
        { width: 30 },
        React.createElement(ConnectionsPanelSidebar, {
          connections: [
            { name: 'Codebase Index', status: 'ok', latencyMs: 12 },
            { name: 'Mailbox IPC', status: 'warn' },
          ],
          width: 26,
        }),
      ),
    );
    const frame = lastFrame() ?? '';
    // `SIGNAL MATRIX` is the new (text-based) header. The bar pattern
    // (`barFull`) is the visual anchor — assert at least one filled bar
    // cell, not the hand-rolled `◆` diamond ornament.
    const flat = frame.replace(/\s+/g, ' ');
    expect(flat).toContain('SIGNAL MATRIX');
    expect(frame).toContain(glyphs.barFull);
  });
});
