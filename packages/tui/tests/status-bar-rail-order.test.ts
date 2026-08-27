import React from 'react';
import { describe, expect, it } from 'vitest';
import { StatusBar, type StatusBarProps } from '../src/components/status-bar.js';
import type { StatusBarClickMap } from '../src/components/status-bar-types.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

/**
 * Rail-composition pin for the 4-line statusline re-map.
 *
 * status-bar-separators.test.ts pins individual chips; this file pins the
 * COMPLETE composition — which chip ids sit on which physical rail and in
 * what left-to-right order — at a wide (140) and a narrow (90) terminal.
 * The click-map spans are the source of truth: computeRailSpans mirrors the
 * exact keep/drop and right-anchor math PowerlineRail renders, so the pin
 * reflects what the user sees without depending on ANSI codes or glyph
 * widths.
 *
 * Deliberately outside this pin: eternal_stage, brain, enhance and
 * debug_stream (visibility depends on live data presence, not layout) and
 * version/index (right-anchored, not part of the left span sequence).
 */

const richProps = {
  provider: 'openai',
  model: 'gpt-5.6',
  state: 'idle',
  projectName: 'proj',
  workingDir: 'dir',
  git: { branch: 'main', added: 0, deleted: 0, untracked: 0 },
  modeLabel: 'teach',
  promptVariant: 'pro',
  sessionCount: 2,
  toolCount: 41,
  version: '1.2.3',
  yolo: true,
  autonomy: 'auto',
  breakerCountdown: { remainingMs: 25_000, totalMs: 60_000 },
  context: { used: 25_000, max: 100_000 },
  queueCount: 2,
  processCount: 1,
  fleetWorkingTime: 5_000,
  tokenSavingMode: 'medium',
  sideEffectCount: 1,
  hint: 'ok',
  goalSummary: { goal: 'ship', goalState: 'active', iterations: 3 },
  todos: { pending: 2, inProgress: 1, completed: 1 },
  plan: { open: 1, inProgress: 1, done: 0 },
  tasks: { pending: 1, inProgress: 0, completed: 0, blocked: 0, failed: 0 },
  nextStepsAutoSubmitCountdown: 15,
  autoProceedCountdown: 8,
  droppedTools: 1,
  fleet: { running: 1, idle: 0, pending: 0, completed: 0 },
  mailbox: {
    unread: 2,
    onlineAgents: 3,
    onlineClients: { tui: 1, webui: 0, repl: 0 },
    lastSubject: 'handoff',
    lastFrom: 'w',
  },
  Sage: { total: 100, activeInContext: 2 },
} satisfies Partial<StatusBarProps>;

interface Captured {
  lines: string[];
  idsByLine: Map<number, string[]>;
}

async function capture(columns: number): Promise<Captured> {
  const clickMapRef: { current: StatusBarClickMap | null } = { current: null };
  const view = renderRealTty(
    React.createElement(StatusBar, {
      ...richProps,
      clickMapRef,
    } as StatusBarProps),
    { columns, rows: 24 },
  );
  await settle();
  const clickMap = clickMapRef.current;
  expect(clickMap).toBeTruthy();
  const idsByLine = new Map<number, string[]>();
  for (const line of clickMap?.lines ?? []) {
    idsByLine.set(line.line, line.spans.map((s) => s.id));
  }
  const lines = view.lines();
  view.unmount();
  return { lines, idsByLine };
}

describe('StatusBar 4-rail chip composition', () => {
  it('at 140 columns every rail renders its full chip sequence in render order', async () => {
    const { lines, idsByLine } = await capture(140);

    // Four physical rails: unconditional 0/1, conditional work/fleet on 2/3.
    expect([...idsByLine.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

    // L1 — workspace & identity: static session header with the
    // theme/sessions/tools tail (moved off the run-state rail 2026-08-27).
    expect(idsByLine.get(0)).toEqual([
      'project',
      'working_dir',
      'git',
      'model',
      'mode',
      'prompt_variant',
      'theme',
      'sessions',
      'tools',
    ]);

    // L2 — run state, safety & vitals: breaker leads the dynamic block
    // (urgency-first), the ctx·tokens·cost·cache composite (primary-0) sits
    // center, the ephemeral hint is last so overflow drops it first.
    expect(idsByLine.get(1)).toEqual([
      'state',
      'yolo',
      'autonomy',
      'breaker',
      'primary-0',
      'queue',
      'processes',
      'elapsed',
      'token_saving',
      'side_effects',
      'hint',
    ]);

    // L3 — active work & countdowns.
    expect(idsByLine.get(2)).toEqual([
      'goal',
      'todos',
      'plan',
      'tasks',
      'next_steps',
      'auto_proceed',
      'dropped_tools',
    ]);

    // L4 — fleet, connectivity & background services.
    expect(idsByLine.get(3)).toEqual([
      'fleet',
      'mailbox',
      'detail-1',
      'detail-2',
      'memory-0',
      'memory-1',
    ]);

    // Visual order signature of the re-map on the run-state rail: the
    // breaker countdown renders BEFORE the context meter — it used to trail
    // the dim hint text inside the old primary-chip bundle. (Anchored on
    // YOLO, not the state label: stateChip relabels "idle" when fleet
    // agents are running.)
    const runStateLine = lines.find((l) => l.includes('YOLO')) ?? '';
    expect(runStateLine).toMatch(/YOLO.*AUTO.*kill\/reset in 25s.*ctx.*queued 2/);
  });

  it('at 90 columns identity leads survive, the static tail drops, and the dynamic block keeps its order', async () => {
    const { idsByLine } = await capture(90);

    const identity = idsByLine.get(0) ?? [];
    for (const id of ['project', 'working_dir', 'git', 'model']) {
      expect(identity).toContain(id);
    }
    // Static session trivia is the L1 overflow sacrifice — never the
    // dynamic run-state content. That trade is the point of the re-map.
    expect(identity).not.toContain('tools');

    const runState = idsByLine.get(1) ?? [];
    expect(runState[0]).toBe('state');
    // Urgency-first order survives narrowing: breaker still leads vitals.
    expect(runState.indexOf('breaker')).toBeGreaterThan(-1);
    expect(runState.indexOf('primary-0')).toBeGreaterThan(runState.indexOf('breaker'));
    // The misplacement regression guard: these never drift back to L2.
    for (const id of ['theme', 'sessions', 'tools', 'hint']) {
      expect(runState).not.toContain(id);
    }

    // Conditional rails still open below with their lead chips intact.
    expect(idsByLine.get(2) ?? []).toEqual(expect.arrayContaining(['goal', 'todos']));
    expect((idsByLine.get(3) ?? [])[0]).toBe('fleet');
  });
});
