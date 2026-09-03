import * as os from 'node:os';
import * as path from 'node:path';
import { SddInterviewDriver, SpecStore, TaskGraphStore } from '@wrongstack/sdd';
import { SddWizardWebSocketHandler } from '@wrongstack/webui-server';
import { describe, expect, it, vi } from 'vitest';

/** Minimal ws stub capturing sent JSON messages. */
function fakeWs() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    readyState: 1,
    // `sendSerialized` reads `bufferedAmount` to enforce the
    // `WEBUI_WS_MAX_BUFFERED_BYTES` backpressure cap, and may call
    // `terminate()` / `close()` when a client cannot keep up. The
    // production WebSocket type treats `undefined` as `0`, so these
    // methods are functionally redundant for unit tests that never
    // approach 32 MiB of buffered frames — but adding them keeps the
    // stub in lockstep with the real `ws` surface so future tests
    // can exercise the backpressure path without a refactor.
    bufferedAmount: 0,
    terminate: () => {},
    close: () => {},
    send: (data: string) => sent.push(JSON.parse(data)),
    on: () => {},
    sent,
  } as never;
}

function requireLastOfType(
  ws: { sent: Array<{ type: string; payload: Record<string, unknown> }> },
  type: string,
) {
  const matches = ws.sent.filter((x) => x.type === type);
  const match = matches[matches.length - 1];
  if (!match) throw new Error(`expected at least one ${type} frame, got none`);
  return match;
}

/**
 * B-07: relaxed variant for the merged-from-webui "fails closed" test below.
 * `requireLastOfType` throws when no frame exists; `lastOfType` returns
 * `undefined` instead so callers can assert on absence without try/catch.
 */
function lastOfType(
  ws: { sent: Array<{ type: string; payload: Record<string, unknown> }> },
  type: string,
) {
  const matches = ws.sent.filter((x) => x.type === type);
  return matches[matches.length - 1];
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
      {
        id: 'REQ-1',
        type: 'security',
        priority: 'critical',
        description: 'Verify tokens',
        acceptanceCriteria: [],
      },
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
  it('drops retained clients and interview state on dispose', () => {
    const { handler } = makeHandler();
    handler.addClient(fakeWs());
    const internal = handler as unknown as {
      clients: Set<unknown>;
      driver: SddInterviewDriver | null;
      lastAgentText: string;
    };
    internal.lastAgentText = 'retained interview output';

    handler.dispose();
    expect(internal.clients.size).toBe(0);
    expect(internal.driver).toBeNull();
    expect(internal.lastAgentText).toBe('');
  });

  it('drives goal → question → spec → tasks → run.start over WS', async () => {
    const { handler, startRunCalls } = makeHandler();
    const ws = fakeWs();
    handler.addClient(ws);

    // 1. Start the interview.
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } });
    expect(requireLastOfType(ws, 'sdd.spec.agent_text').payload.text).toBe(QUESTION);
    let snap = requireLastOfType(ws, 'sdd.spec.snapshot').payload;
    expect(snap.phase).toBe('questioning');
    expect(snap.busy).toBe(false);
    expect(snap.title).toBe('OAuth login');

    // 2. Answer the question → agent emits the spec → spec_review.
    await handler.handleMessage({
      type: 'sdd.spec.message',
      payload: { text: 'Google and GitHub' },
    });
    snap = requireLastOfType(ws, 'sdd.spec.snapshot').payload;
    expect(snap.phase).toBe('spec_review');
    expect((snap.spec as { title: string }).title).toBe('OAuth login');

    // 3. Approve the spec → implementation turn emits tasks → graph built.
    await handler.handleMessage({ type: 'sdd.spec.approve', payload: {} });
    snap = requireLastOfType(ws, 'sdd.spec.snapshot').payload;
    expect(snap.taskCount).toBe(3);
    expect(snap.graphId).toBeTruthy();

    // 4. Start the run → wizard hands off with a runId.
    await handler.handleMessage({ type: 'sdd.run.start', payload: {} });
    expect(startRunCalls).toHaveLength(1);
    expect(startRunCalls[0]?.taskCount).toBe(3);
    expect(requireLastOfType(ws, 'sdd.run.started').payload.runId).toBe('run-xyz');
  });

  it('forwards the run-config knobs (parallelSlots + worktrees + planDecompose) to startRun', async () => {
    const { handler, startRunCalls } = makeHandler();
    const ws = fakeWs();
    handler.addClient(ws);

    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } });
    await handler.handleMessage({
      type: 'sdd.spec.message',
      payload: { text: 'Google and GitHub' },
    });
    await handler.handleMessage({ type: 'sdd.spec.approve', payload: {} });

    // Start with explicit parallel slots + worktrees disabled + plan decompose on.
    await handler.handleMessage({
      type: 'sdd.run.start',
      payload: { parallelSlots: 8, worktrees: false, planDecompose: true },
    });

    expect(startRunCalls).toHaveLength(1);
    expect(startRunCalls[0]?.opts.parallelSlots).toBe(8);
    expect(startRunCalls[0]?.opts.worktrees).toBe(false);
    expect(startRunCalls[0]?.opts.planDecompose).toBe(true);
  });

  it('blocks a second start while an interview is mid-flow (continuity)', async () => {
    const { handler } = makeHandler();
    const ws = fakeWs();
    handler.addClient(ws);
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } });
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'Something else' } });
    expect(requireLastOfType(ws, 'sdd.spec.error').payload.message).toMatch(/already in progress/i);
  });

  it('discards an interview so a fresh goal can start', async () => {
    const { handler, turnPrompts } = makeHandler();
    const ws = fakeWs();
    handler.addClient(ws);
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } });
    const turnsBefore = turnPrompts.length;
    await handler.handleMessage({ type: 'sdd.spec.discard', payload: {} });
    const discarded = requireLastOfType(ws, 'sdd.spec.snapshot').payload as { discarded?: boolean };
    expect(discarded.discarded).toBe(true);
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'New feature' } });
    expect(turnPrompts.length).toBeGreaterThan(turnsBefore);
    expect((requireLastOfType(ws, 'sdd.spec.snapshot').payload as { title: string }).title).toMatch(
      /New feature/,
    );
  });

  it('starts a run from a graph id when startRunFromGraphId is wired', async () => {
    const fromGraph: string[] = [];
    const handler = new SddWizardWebSocketHandler({
      makeDriver: () =>
        new SddInterviewDriver({
          specStore: new SpecStore({ baseDir: path.join(tmp(), 'specs') }),
          graphStore: new TaskGraphStore({ baseDir: path.join(tmp(), 'graphs') }),
        }),
      runInterviewTurn: async () => '',
      startRun: async () => ({ runId: 'unused' }),
      startRunFromGraphId: async (graphId) => {
        fromGraph.push(graphId);
        return { runId: 'from-g' };
      },
    });
    const ws = fakeWs();
    handler.addClient(ws);
    await handler.handleMessage({
      type: 'sdd.run.from_graph',
      payload: { graphId: 'graph-abc', worktrees: true },
    });
    expect(fromGraph).toEqual(['graph-abc']);
    expect(requireLastOfType(ws, 'sdd.run.started').payload).toMatchObject({
      runId: 'from-g',
      graphId: 'graph-abc',
    });
  });

  it('starts a run from a spec id via resolveGraphIdForSpec', async () => {
    const fromGraph: string[] = [];
    const handler = new SddWizardWebSocketHandler({
      makeDriver: () =>
        new SddInterviewDriver({
          specStore: new SpecStore({ baseDir: path.join(tmp(), 'specs') }),
          graphStore: new TaskGraphStore({ baseDir: path.join(tmp(), 'graphs') }),
        }),
      runInterviewTurn: async () => '',
      startRun: async () => ({ runId: 'unused' }),
      startRunFromGraphId: async (graphId) => {
        fromGraph.push(graphId);
        return { runId: 'from-spec-run' };
      },
      resolveGraphIdForSpec: async (specId) => (specId === 'spec-1' ? 'graph-from-spec' : null),
    });
    const ws = fakeWs();
    handler.addClient(ws);
    await handler.handleMessage({
      type: 'sdd.run.from_spec',
      payload: { specId: 'spec-1', worktrees: true },
    });
    expect(fromGraph).toEqual(['graph-from-spec']);
    expect(requireLastOfType(ws, 'sdd.run.started').payload).toMatchObject({
      runId: 'from-spec-run',
      graphId: 'graph-from-spec',
      specId: 'spec-1',
    });
  });

  it('surfaces an error when starting a run with no spec', async () => {
    const { handler, startRunCalls } = makeHandler();
    const ws = fakeWs();
    handler.addClient(ws);
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'X' } });
    // Jump straight to run.start before any spec/tasks exist.
    await handler.handleMessage({ type: 'sdd.run.start', payload: {} });
    expect(startRunCalls).toHaveLength(0);
    expect(requireLastOfType(ws, 'sdd.spec.error').payload.message).toMatch(/spec/i);
  });

  it('rejects an empty goal', async () => {
    const { handler } = makeHandler();
    const ws = fakeWs();
    handler.addClient(ws);
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: '   ' } });
    expect(requireLastOfType(ws, 'sdd.spec.error').payload.message).toMatch(/goal/i);
  });

  it('accumulates the full Q&A history (transcript data) across turns', async () => {
    // Two questions, then the spec — the transcript renders snapshot.answers.
    const { handler } = makeHandler(['Q1: providers?', 'Q2: session store?', SPEC_OUTPUT]);
    const ws = fakeWs();
    handler.addClient(ws);

    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } });
    // After Q1, the user answers → Q2 arrives.
    await handler.handleMessage({ type: 'sdd.spec.message', payload: { text: 'Google + GitHub' } });
    let snap = requireLastOfType(ws, 'sdd.spec.snapshot').payload as {
      answers: Array<{ question: string; answer: string }>;
    };
    expect(snap.answers).toEqual([{ question: 'Q1: providers?', answer: 'Google + GitHub' }]);

    // Answer Q2 → the spec is generated.
    await handler.handleMessage({ type: 'sdd.spec.message', payload: { text: 'Redis' } });
    snap = requireLastOfType(ws, 'sdd.spec.snapshot').payload as never;
    expect(snap.answers).toEqual([
      { question: 'Q1: providers?', answer: 'Google + GitHub' },
      { question: 'Q2: session store?', answer: 'Redis' },
    ]);
    expect((requireLastOfType(ws, 'sdd.spec.snapshot').payload as { phase: string }).phase).toBe(
      'spec_review',
    );
  });

  it('recovers from a latched resume failure on the next handleMessage', async () => {
    // First call: makeDriver() returns a driver whose loadExisting() rejects
    // (simulates the kanban daemon being unreachable during bootstrap). The
    // handler latches resumeError and refuses the first user frame. The
    // second call returns a driver that loads successfully (no prior
    // session), so the gate releases and the next start can proceed.
    let attempt = 0;
    const recoveredDir = tmp();
    const recoveredDriver = () =>
      new SddInterviewDriver({
        specStore: new SpecStore({ baseDir: path.join(recoveredDir, 'specs') }),
        graphStore: new TaskGraphStore({ baseDir: path.join(recoveredDir, 'graphs') }),
        minQuestions: 1,
        maxQuestions: 3,
      });
    const handler = new SddWizardWebSocketHandler({
      makeDriver: () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            loadExisting: async () => {
              throw new Error('kanban daemon unreachable');
            },
          } as never;
        }
        return recoveredDriver();
      },
      runInterviewTurn: async () => '',
      startRun: async () => ({ runId: 'unused' }),
    });
    const ws = fakeWs();
    handler.addClient(ws);

    // Bootstrap has the first attempt fail → resumeError is latched.
    await handler['ready'].catch(() => {});
    // First user frame after a latched failure: kicks the single-flight
    // re-probe, which recovers (attempt === 2 returns false). The gate
    // releases; the start handler proceeds and a snapshot is broadcast.
    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } });
    // The successful start produces a snapshot, not another error.
    expect(requireLastOfType(ws, 'sdd.spec.snapshot').payload).toBeDefined();
    expect(attempt).toBeGreaterThanOrEqual(2);
  });

  it('stays latched when the first throw AND the retry also throw', async () => {
    // Both probe attempts reject — the gate must stay latched and every
    // surviving frame must surface the same error until recovery (which
    // never happens in this test).
    let probeCalls = 0;
    const handler = new SddWizardWebSocketHandler({
      makeDriver: () => {
        probeCalls += 1;
        return {
          loadExisting: async () => {
            throw new Error('persistent failure');
          },
          getLastAgentText: () => undefined,
          getPhase: () => 'questioning' as const,
          getSession: () => ({
            id: 's1',
            phase: 'questioning' as const,
            title: '',
            userIntent: '',
          }),
          getAIPrompt: () => '',
        } as never;
      },
      runInterviewTurn: async () => '',
      startRun: async () => ({ runId: 'unused' }),
    });
    const ws = fakeWs();
    handler.addClient(ws);

    // Bootstrap → latched initial failure.
    await handler['ready'].catch(() => {});
    expect(probeCalls).toBe(1);

    // Two surviving frames fire concurrently. The single-flight slot
    // guarantees the second one re-uses the same in-flight probe promise
    // instead of stampeding the IPC client with a third makeDriver() call.
    await Promise.all([
      handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } }),
      handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'OAuth login' } }),
    ]);
    // Both frames share exactly one re-probe (not two).
    expect(probeCalls).toBe(2);
    // Both frames broadcast the preserved latched error.
    expect(requireLastOfType(ws, 'sdd.spec.error').payload.message).toMatch(/persistent failure/);
  });

  // B-07: migrated from packages/webui/tests/server/sdd-wizard-ws-handler.test.ts
  // — covers the "fails closed" branch where the authoritative state probe
  // throws BEFORE the interview is driven. Server's existing suite never
  // exercised this path; the failure-closed contract is now asserted here.
  it('fails closed when authoritative interview state cannot be read', async () => {
    const runInterviewTurn = vi.fn(async () => QUESTION);
    const handler = new SddWizardWebSocketHandler({
      makeDriver: () =>
        ({
          loadExisting: async () => {
            throw new Error('project daemon unavailable');
          },
        }) as never,
      runInterviewTurn,
      startRun: async () => ({ runId: 'unreachable' }),
    });
    const ws = fakeWs();
    handler.addClient(ws);

    await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'Do not overwrite' } });

    expect(lastOfType(ws, 'sdd.spec.error')?.payload.message).toBe('project daemon unavailable');
    expect(runInterviewTurn).not.toHaveBeenCalled();
  });
});
