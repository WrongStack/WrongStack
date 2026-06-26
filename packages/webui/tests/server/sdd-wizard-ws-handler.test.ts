import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { SddInterviewDriver, SpecStore, TaskGraphStore } from '@wrongstack/core';
import { SddWizardWebSocketHandler } from '../../src/server/sdd-wizard-ws-handler.js';

/** Minimal ws stub capturing sent JSON messages. */
function fakeWs() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    on: () => {},
    sent,
  } as never;
}

function lastOfType(ws: { sent: Array<{ type: string; payload: Record<string, unknown> }> }, type: string) {
  const m = ws.sent.filter((x) => x.type === type);
  return m[m.length - 1];
}

function tmp(): string {
  return path.join(os.tmpdir(), `sdd-wizard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const QUESTION = 'Which OAuth providers do you want to support?';

const SPEC_OUTPUT = [
  '```json',
  JSON.stringify({
    title: 'OAuth login',
    overview: 'Add OAuth login with session management.',
    sections: [{ type: 'overview', title: 'Overview', content: 'flow', level: 1 }],
    requirements: [
      { id: 'REQ-1', type: 'security', priority: 'critical', description: 'Verify tokens', acceptanceCriteria: [] },
    ],
  }),
  '```',
].join('\n');

const TASKS_OUTPUT = [
  'Plan: build the middleware first, then tests.',
  '```json',
  JSON.stringify([
    { title: 'Create auth middleware', description: 'jwt', type: 'feature', priority: 'critical' },
    { title: 'Write auth tests', description: 'tests', type: 'test', priority: 'high' },
  ]),
  '```',
].join('\n');

function makeHandler(turnScript?: string[]) {
  const dir = tmp();
  const turns = [...(turnScript ?? [QUESTION, SPEC_OUTPUT, TASKS_OUTPUT])];
  const turnPrompts: string[] = [];
  const startRunCalls: Array<{ taskCount: number; opts: Record<string, unknown> }> = [];

  const handler = new SddWizardWebSocketHandler({
    makeDriver: () =>
      new SddInterviewDriver({
        specStore: new SpecStore({ baseDir: path.join(dir, 'specs') }),
        graphStore: new TaskGraphStore({ baseDir: path.join(dir, 'graphs') }),
        minQuestions: 1,
        maxQuestions: 3,
      }),
    runInterviewTurn: async (prompt: string) => {
      turnPrompts.push(prompt);
      return turns.shift() ?? '';
    },
    startRun: async (driver, opts) => {
      startRunCalls.push({
        taskCount: driver.getGraph()?.nodes.size ?? 0,
        opts: opts as Record<string, unknown>,
      });
      return { runId: 'run-xyz' };
    },
  });
  return { handler, turnPrompts, startRunCalls };
}

describe('SddWizardWebSocketHandler (end-to-end message flow)', () => {
  it('drives goal → question → spec → tasks → run.start over WS', async () => {
    const { handler, startRunCalls } = makeHandler();
    const ws = fakeWs();
    handler.addClient(ws);

    // 1. Start the interview.
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } });
    expect(lastOfType(ws, 'sdd.spec.agent_text').payload.text).toBe(QUESTION);
    let snap = lastOfType(ws, 'sdd.spec.snapshot').payload;
    expect(snap.phase).toBe('questioning');
    expect(snap.busy).toBe(false);
    expect(snap.title).toBe('OAuth login');

    // 2. Answer the question → agent emits the spec → spec_review.
    await handler.handleMessage({
      type: 'sdd.spec.message',
      payload: { text: 'Google and GitHub' },
    });
    snap = lastOfType(ws, 'sdd.spec.snapshot').payload;
    expect(snap.phase).toBe('spec_review');
    expect((snap.spec as { title: string }).title).toBe('OAuth login');

    // 3. Approve the spec → implementation turn emits tasks → graph built.
    await handler.handleMessage({ type: 'sdd.spec.approve', payload: {} });
    snap = lastOfType(ws, 'sdd.spec.snapshot').payload;
    expect(snap.taskCount).toBe(2);
    expect(snap.graphId).toBeTruthy();

    // 4. Start the run → wizard hands off with a runId.
    await handler.handleMessage({ type: 'sdd.run.start', payload: {} });
    expect(startRunCalls).toHaveLength(1);
    expect(startRunCalls[0]?.taskCount).toBe(2);
    expect(lastOfType(ws, 'sdd.run.started').payload.runId).toBe('run-xyz');
  });

  it('forwards the run-config knobs (parallelSlots + worktrees) to startRun', async () => {
    const { handler, startRunCalls } = makeHandler();
    const ws = fakeWs();
    handler.addClient(ws);

    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } });
    await handler.handleMessage({ type: 'sdd.spec.message', payload: { text: 'Google and GitHub' } });
    await handler.handleMessage({ type: 'sdd.spec.approve', payload: {} });

    // Start with explicit parallel slots + worktrees disabled.
    await handler.handleMessage({
      type: 'sdd.run.start',
      payload: { parallelSlots: 8, worktrees: false },
    });

    expect(startRunCalls).toHaveLength(1);
    expect(startRunCalls[0]?.opts.parallelSlots).toBe(8);
    expect(startRunCalls[0]?.opts.worktrees).toBe(false);
  });

  it('surfaces an error when starting a run with no spec', async () => {
    const { handler, startRunCalls } = makeHandler();
    const ws = fakeWs();
    handler.addClient(ws);
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'X' } });
    // Jump straight to run.start before any spec/tasks exist.
    await handler.handleMessage({ type: 'sdd.run.start', payload: {} });
    expect(startRunCalls).toHaveLength(0);
    expect(lastOfType(ws, 'sdd.spec.error').payload.message).toMatch(/spec/i);
  });

  it('rejects an empty goal', async () => {
    const { handler } = makeHandler();
    const ws = fakeWs();
    handler.addClient(ws);
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: '   ' } });
    expect(lastOfType(ws, 'sdd.spec.error').payload.message).toMatch(/goal/i);
  });

  it('accumulates the full Q&A history (transcript data) across turns', async () => {
    // Two questions, then the spec — the transcript renders snapshot.answers.
    const { handler } = makeHandler(['Q1: providers?', 'Q2: session store?', SPEC_OUTPUT]);
    const ws = fakeWs();
    handler.addClient(ws);

    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } });
    // After Q1, the user answers → Q2 arrives.
    await handler.handleMessage({ type: 'sdd.spec.message', payload: { text: 'Google + GitHub' } });
    let snap = lastOfType(ws, 'sdd.spec.snapshot').payload as {
      answers: Array<{ question: string; answer: string }>;
    };
    expect(snap.answers).toEqual([{ question: 'Q1: providers?', answer: 'Google + GitHub' }]);

    // Answer Q2 → the spec is generated.
    await handler.handleMessage({ type: 'sdd.spec.message', payload: { text: 'Redis' } });
    snap = lastOfType(ws, 'sdd.spec.snapshot').payload as never;
    expect(snap.answers).toEqual([
      { question: 'Q1: providers?', answer: 'Google + GitHub' },
      { question: 'Q2: session store?', answer: 'Redis' },
    ]);
    expect((lastOfType(ws, 'sdd.spec.snapshot').payload as { phase: string }).phase).toBe('spec_review');
  });
});
