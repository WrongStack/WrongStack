import React from 'react';
import { describe, expect, it } from 'vitest';
import { StatusBar, type StatusBarProps } from '../src/components/status-bar.js';
import type { StatusBarClickMap } from '../src/components/status-bar-types.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

/**
 * Rail-composition pin for the volatility-grouped 4-line statusline.
 *
 * status-bar-separators.test.ts pins individual chips; this file pins the
 * COMPLETE composition — which chip ids sit on which physical rail and in
 * what left-to-right order — at a wide (140) and a narrow (90) terminal.
 * The click-map spans are the source of truth: `layoutRail` performs the
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
    idsByLine.set(
      line.line,
      line.spans.map((s) => s.id),
    );
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

    // L1 — IDENTITY: static session header with the theme/sessions/tools
    // tail (all three off by default, forced on here by the fixture).
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

    // L2 — VITALS: the per-turn telemetry. context/tokens/cost/cache are
    // four independent entries now (they used to be one atomic `primary-0`
    // composite); the ephemeral hint is last so overflow drops it first.
    expect(idsByLine.get(1)).toEqual(['state', 'context', 'elapsed', 'queue', 'hint']);

    // L3 — SAFETY & WORK: posture first, then the work boards.
    expect(idsByLine.get(2)).toEqual([
      'yolo',
      'autonomy',
      'breaker',
      'token_saving',
      'processes',
      'side_effects',
      'dropped_tools',
      'goal',
      'todos',
      'plan',
      'tasks',
    ]);

    // L4 — ASYNC: fleet/peers/services, then the countdowns.
    expect(idsByLine.get(3)).toEqual([
      'fleet',
      'mailbox',
      'mailbox_peers',
      'mailbox_last',
      'memory_context',
      'next_steps',
      'auto_proceed',
    ]);

    // Visual order signature of the volatility grouping: the safety rail
    // reads posture-first (YOLO → autonomy → breaker) and carries the work
    // boards, while the vitals rail above it holds only telemetry.
    const safetyLine = lines.find((l) => l.includes('YOLO')) ?? '';
    expect(safetyLine).toMatch(/YOLO.*AUTO.*kill\/reset in 25s/);
    expect(safetyLine).not.toContain('ctx');
    const vitalsLine = lines.find((l) => l.includes('ctx')) ?? '';
    expect(vitalsLine).toMatch(/ctx.*queued 2/);
  });

  it('at 90 columns identity shortens rather than dropping, and rails stay isolated', async () => {
    const { idsByLine } = await capture(90);

    const identity = idsByLine.get(0) ?? [];
    // Shorten-before-drop: at 90 the identity rail concedes detail, not chips.
    for (const id of ['project', 'working_dir', 'git', 'model', 'tools']) {
      expect(identity).toContain(id);
    }

    const vitals = idsByLine.get(1) ?? [];
    expect(vitals[0]).toBe('state');
    // The misplacement regression guard: identity trivia and posture chips
    // never drift onto the vitals rail.
    for (const id of ['theme', 'sessions', 'tools', 'yolo', 'autonomy']) {
      expect(vitals).not.toContain(id);
    }

    const safety = idsByLine.get(2) ?? [];
    expect(safety[0]).toBe('yolo');
    expect(safety.indexOf('breaker')).toBeGreaterThan(safety.indexOf('autonomy'));
    expect(safety.indexOf('todos')).toBeGreaterThan(safety.indexOf('breaker'));

    expect((idsByLine.get(3) ?? [])[0]).toBe('fleet');
  });
});
