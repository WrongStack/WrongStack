import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `WS_HANDLERS` declares ~40 entries inline rather than delegating to a named
 * handler — specs, sdd.*, goal.assess, side_effects, todos, the agent timeline
 * bridge and the whole codemap activity overlay. They are only reachable
 * through the map, so they are driven here by key.
 */

const send = vi.fn();
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ send }) }));

const { WS_HANDLERS } = await import('../../src/hooks/ws-handlers');
const { useFleetStore, useSessionStore, useSideEffectStore, useSpecsStore } = await import(
  '../../src/stores'
);
const { useCodemapActivityStore } = await import('../../src/stores/codemap-activity-store');
const { useCodemapIndexStore } = await import('../../src/stores/codemap-index-store');
const { useSddBoardStore } = await import('../../src/stores/sdd-board-store');
const { useSddWizardStore } = await import('../../src/stores/sdd-wizard-store');
const { useGoalAssessStore } = await import('../../src/stores/goal-assess-store');

/** Dispatch through the map exactly as `useWebSocket` does. */
function fire(type: string, payload: unknown = {}) {
  const handler = WS_HANDLERS[type as keyof typeof WS_HANDLERS];
  expect(handler, `no handler registered for ${type}`).toBeTypeOf('function');
  handler?.({ type, payload } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState({ session: null, todos: [] });
  useCodemapActivityStore.setState({
    history: new Map(),
    pulses: new Map(),
    activeOperations: new Map(),
    totalCount: 0,
  });
});

describe('specs', () => {
  it('stores the spec list', () => {
    fire('specs.list', { specs: [{ id: 's1', title: 'One' }] });
    expect(useSpecsStore.getState().specs).toHaveLength(1);
  });

  it('falls back to an empty list when the field is missing', () => {
    useSpecsStore.getState().setSpecs([{ id: 's1' } as never]);
    fire('specs.list', {});
    expect(useSpecsStore.getState().specs).toEqual([]);
  });

  it('stores the spec detail verbatim', () => {
    fire('specs.detail', { id: 's1', body: 'text' });
    expect(useSpecsStore.getState().detail).toMatchObject({ id: 's1' });
  });
});

describe('sdd board and wizard', () => {
  it('stores a board snapshot', () => {
    fire('sdd.board.snapshot', { runId: 'r1', columns: [] });
    expect(useSddBoardStore.getState().snapshot).toMatchObject({ runId: 'r1' });
  });

  it('stores the board list', () => {
    fire('sdd.board.list', { boards: [{ runId: 'r1' }] });
    expect(useSddBoardStore.getState().boards).toHaveLength(1);
  });

  it('defaults an absent board list to empty', () => {
    useSddBoardStore.getState().setBoards([{ runId: 'r1' } as never]);
    fire('sdd.board.list', {});
    expect(useSddBoardStore.getState().boards).toEqual([]);
  });

  it('records a lifecycle result and stamps it with a time', () => {
    fire('sdd.board.lifecycle_result', { op: 'clean', ok: true });

    const result = useSddBoardStore.getState().lifecycleResult;
    expect(result).toMatchObject({ op: 'clean', ok: true });
    expect(typeof result?.at).toBe('number');
    expect(useSddBoardStore.getState().destroying).toBe(false);
  });

  it('resets the wizard after a successful destroy', () => {
    useSddWizardStore.getState().setAgentText('leftover');
    fire('sdd.board.lifecycle_result', { op: 'destroy', ok: true });
    expect(useSddWizardStore.getState().agentText).toBe('');
  });

  it('keeps the wizard when a destroy fails', () => {
    useSddWizardStore.getState().setAgentText('leftover');
    fire('sdd.board.lifecycle_result', { op: 'destroy', ok: false });
    expect(useSddWizardStore.getState().agentText).toBe('leftover');
  });

  it('keeps the wizard for a non-destroy op', () => {
    useSddWizardStore.getState().setAgentText('leftover');
    fire('sdd.board.lifecycle_result', { op: 'clean', ok: true });
    expect(useSddWizardStore.getState().agentText).toBe('leftover');
  });

  it('stores a spec snapshot', () => {
    fire('sdd.spec.snapshot', { phase: 'interview' });
    expect(useSddWizardStore.getState().snapshot).toMatchObject({ phase: 'interview' });
  });

  it('stores agent text', () => {
    fire('sdd.spec.agent_text', { text: 'draft' });
    expect(useSddWizardStore.getState().agentText).toBe('draft');
  });

  it('treats missing agent text as empty', () => {
    useSddWizardStore.getState().setAgentText('draft');
    fire('sdd.spec.agent_text', {});
    expect(useSddWizardStore.getState().agentText).toBe('');
  });

  it('stores the spec error message', () => {
    fire('sdd.spec.error', { message: 'bad spec' });
    expect(useSddWizardStore.getState().error).toBe('bad spec');
  });

  it('falls back to a generic error label', () => {
    fire('sdd.spec.error', {});
    expect(useSddWizardStore.getState().error).toBe('Error');
  });

  it('records the started run id', () => {
    fire('sdd.run.started', { runId: 'run_1' });
    expect(useSddWizardStore.getState().startedRunId).toBe('run_1');
  });

  it('clears the run id when the server omits it', () => {
    fire('sdd.run.started', {});
    expect(useSddWizardStore.getState().startedRunId).toBeNull();
  });
});

describe('goal.assess.result', () => {
  const base = {
    realistic: true,
    durationClaimed: '2h',
    explanation: 'looks fine',
    recommendedDuration: '3h',
    concerns: ['scope'],
    parseFailed: false,
  };

  it('projects the assessment onto the store', () => {
    // The store drops a reply whose reqSeq doesn't match the in-flight
    // request — a stale-response guard. Line the two up.
    useGoalAssessStore.setState({ currentSeq: 7 });
    fire('goal.assess.result', { ...base, reqSeq: 7 });
    expect(useGoalAssessStore.getState().result).toMatchObject({
      realistic: true,
      recommendedDuration: '3h',
      reqSeq: 7,
    });
  });

  it('defaults a missing request sequence to zero, matching a never-bumped store', () => {
    useGoalAssessStore.setState({ currentSeq: 0, result: null });
    fire('goal.assess.result', base);
    expect(useGoalAssessStore.getState().result?.reqSeq).toBe(0);
  });

  it('drops a reply whose sequence has already been superseded', () => {
    useGoalAssessStore.setState({ currentSeq: 9, result: null });
    fire('goal.assess.result', { ...base, reqSeq: 8 });
    expect(useGoalAssessStore.getState().result).toBeNull();
  });
});

describe('side_effects', () => {
  it('replaces the recorded side effects', () => {
    fire('side_effects', { sideEffects: [{ id: 'e1', kind: 'write' }] });
    expect(useSideEffectStore.getState().sideEffects).toHaveLength(1);
  });

  it('clears them when the field is absent', () => {
    fire('side_effects', {});
    expect(useSideEffectStore.getState().sideEffects).toEqual([]);
  });

  it('ignores a message scoped to a different session', () => {
    useSessionStore.setState({
      session: { id: 'sess_a', startedAt: 1, model: 'm', provider: 'p' },
    });
    useSideEffectStore.getState().setSideEffects([{ id: 'keep' } as never]);
    fire('side_effects', { sessionId: 'sess_b', sideEffects: [] });
    expect(useSideEffectStore.getState().sideEffects).toHaveLength(1);
  });
});

describe('todos.cleared', () => {
  it('empties the worklist', () => {
    useSessionStore.getState().setTodos([{ content: 'x', status: 'pending' } as never]);
    fire('todos.cleared', {});
    expect(useSessionStore.getState().todos).toEqual([]);
  });

  it('ignores another session', () => {
    useSessionStore.setState({
      session: { id: 'sess_a', startedAt: 1, model: 'm', provider: 'p' },
      todos: [{ content: 'x', status: 'pending' } as never],
    });
    fire('todos.cleared', { sessionId: 'sess_b' });
    expect(useSessionStore.getState().todos).toHaveLength(1);
  });
});

describe('agent timeline bridge', () => {
  beforeEach(() => {
    useFleetStore.setState({ agentTranscripts: new Map() });
  });

  function timeline(id: string) {
    return useFleetStore.getState().getAgentTranscript(id);
  }

  it('appends a timeline message', () => {
    fire('agent.timeline.message', {
      subagentId: 'sa1',
      agentName: 'scout',
      content: 'looking',
      kind: 'text',
      iteration: 2,
      ts: '2026-01-01T00:00:00.000Z',
      toolName: 'Read',
      toolOk: true,
      costUsd: 0.01,
    });

    expect(timeline('sa1')).toHaveLength(1);
    expect(timeline('sa1')[0]).toMatchObject({ kind: 'text', iteration: 2, toolName: 'Read' });
  });

  it('appends a status change with the summary as the content', () => {
    fire('agent.status_changed', {
      subagentId: 'sa1',
      agentName: 'scout',
      status: 'running',
      ts: '2026-01-01T00:00:00.000Z',
      summary: 'started work',
    });

    expect(timeline('sa1')[0]).toMatchObject({
      kind: 'status',
      content: 'started work',
      status: 'running',
      iteration: 0,
    });
  });

  it('falls back to the raw status when no summary is given', () => {
    fire('agent.status_changed', {
      subagentId: 'sa1',
      agentName: 'scout',
      status: 'done',
      ts: '2026-01-01T00:00:00.000Z',
    });
    expect(timeline('sa1')[0]).toMatchObject({ content: 'done' });
  });

  // Traffic for a tab that is not in front is KEPT and stamped with its own
  // conversation. Dropping it (the previous behaviour) meant a worker that ran
  // while you were looking elsewhere came back with an empty transcript; the
  // separation comes from the stamp plus the session-filtered roster, not from
  // throwing the lines away.
  it('keeps timeline traffic for another session, stamped with that session', () => {
    useSessionStore.setState({
      session: { id: 'sess_a', startedAt: 1, model: 'm', provider: 'p' },
    });
    fire('agent.timeline.message', {
      sessionId: 'sess_b',
      subagentId: 'sa1',
      agentName: 'scout',
      content: 'x',
      kind: 'text',
      iteration: 0,
      ts: '2026-01-01T00:00:00.000Z',
    });
    expect(timeline('sa1')).toHaveLength(1);
    expect(timeline('sa1')[0]).toMatchObject({ sessionId: 'sess_b', content: 'x' });
  });

  it('keeps a status change for another session, stamped with that session', () => {
    useSessionStore.setState({
      session: { id: 'sess_a', startedAt: 1, model: 'm', provider: 'p' },
    });
    fire('agent.status_changed', {
      sessionId: 'sess_b',
      subagentId: 'sa1',
      agentName: 'scout',
      status: 'done',
      ts: '2026-01-01T00:00:00.000Z',
    });
    expect(timeline('sa1')).toHaveLength(1);
    expect(timeline('sa1')[0]).toMatchObject({ sessionId: 'sess_b', status: 'done' });
  });
});

describe('inert handlers', () => {
  // These types are consumed by a component listening on the raw stream. The
  // map still needs an entry so the dispatcher doesn't log "unhandled".
  it.each([
    'tasks.updated',
    'plan.updated',
    'session.checkpoints',
    'process.list',
    'projects.list',
    'projects.added',
    'projects.selected',
    'tool.disabled',
    'tool.enabled',
  ])('%s is registered and does nothing', (type) => {
    expect(() => fire(type, {})).not.toThrow();
  });
});

describe('codemap activity overlay', () => {
  function active(): unknown[] {
    return useCodemapActivityStore.getState().getActiveOperations();
  }

  it('tool.started opens an activity for each file target', () => {
    fire('tool.started', {
      id: 'tu1',
      name: 'Edit',
      fileTargets: [{ filePath: 'a.ts', operation: 'edit' }],
    });
    expect(active()).toHaveLength(1);
  });

  it('tool.started with no file targets still records the tool itself', () => {
    // `targetActivities` substitutes a synthetic `(tool:<name>)` row so a
    // pathless tool (Bash, WebFetch) still shows as live work on the map.
    fire('tool.started', { id: 'tu1', name: 'Bash', input: {} });
    const [only] = active() as Array<{ filePath: string; attribution: string; type: string }>;
    expect(only).toMatchObject({
      filePath: '(tool:Bash)',
      type: 'execute',
      attribution: 'correlated',
    });
  });

  it('tool.executed closes the activity it opened', () => {
    fire('tool.started', {
      id: 'tu1',
      name: 'Edit',
      fileTargets: [{ filePath: 'a.ts', operation: 'edit' }],
    });
    fire('tool.executed', { id: 'tu1', durationMs: 12, ok: true });
    expect(active()).toHaveLength(0);
  });

  it('tool.executed without an id is a no-op for the overlay', () => {
    fire('tool.started', {
      id: 'tu1',
      name: 'Edit',
      fileTargets: [{ filePath: 'a.ts', operation: 'edit' }],
    });
    fire('tool.executed', { durationMs: 12 });
    expect(active()).toHaveLength(1);
  });

  it('treats a missing ok flag as success', () => {
    fire('tool.started', {
      id: 'tu1',
      name: 'Edit',
      fileTargets: [{ filePath: 'a.ts', operation: 'edit' }],
    });
    fire('tool.executed', { id: 'tu1' });
    const history = useCodemapActivityStore.getState().getActivityForFile('a.ts');
    expect(history.at(-1)).toMatchObject({ ok: true });
  });

  it('codemap.tool_started opens an activity without the chat handler', () => {
    fire('codemap.tool_started', {
      id: 'tu2',
      name: 'Write',
      fileTargets: [{ filePath: 'b.ts', operation: 'create' }],
    });
    expect(active()).toHaveLength(1);
  });

  it('codemap.tool_started with no targets records the synthetic tool row', () => {
    fire('codemap.tool_started', { id: 'tu2', name: 'Bash', input: {} });
    expect(active()[0]).toMatchObject({ filePath: '(tool:Bash)' });
  });

  it('derives file targets from the tool input when the server sends none', () => {
    fire('codemap.tool_started', { id: 'tu3', name: 'Edit', input: { file_path: 'x.ts' } });
    // `extractPaths` reads path/file/filePath/target/files — not `file_path`,
    // so this falls through to the synthetic row.
    expect(active()[0]).toMatchObject({ filePath: '(tool:Edit)' });
  });

  it('reads a recognised input key as a real target', () => {
    fire('codemap.tool_started', { id: 'tu4', name: 'Edit', input: { filePath: 'y.ts' } });
    expect(active()[0]).toMatchObject({ filePath: 'y.ts', attribution: 'exact' });
  });

  it('codemap.tool_executed closes it', () => {
    fire('codemap.tool_started', {
      id: 'tu2',
      name: 'Write',
      fileTargets: [{ filePath: 'b.ts', operation: 'create' }],
    });
    fire('codemap.tool_executed', { id: 'tu2', ok: false });
    expect(active()).toHaveLength(0);
  });

  it('codemap.tool_executed without an id is inert', () => {
    fire('codemap.tool_started', {
      id: 'tu2',
      name: 'Write',
      fileTargets: [{ filePath: 'b.ts', operation: 'create' }],
    });
    fire('codemap.tool_executed', {});
    expect(active()).toHaveLength(1);
  });

  it('codemap.file_event records an external write', () => {
    fire('codemap.file_event', { filePath: 'c.ts', operation: 'edit', source: 'watcher' });
    expect(useCodemapActivityStore.getState().getActivityForFile('c.ts')).toHaveLength(1);
  });

  it('codemap.file_event without a path is dropped', () => {
    fire('codemap.file_event', { operation: 'edit' });
    expect(useCodemapActivityStore.getState().totalCount).toBe(0);
  });

  it('tool.progress records a deterministic file change', () => {
    fire('tool.progress', {
      id: 'tu3',
      name: 'Formatter',
      event: { type: 'file_changed', path: 'd.ts', operation: 'edit', text: 'formatted' },
    });
    expect(useCodemapActivityStore.getState().getActivityForFile('d.ts')).toHaveLength(1);
  });

  it('tool.progress ignores a non file_changed event', () => {
    fire('tool.progress', { id: 'tu3', event: { type: 'log', text: 'hi' } });
    expect(useCodemapActivityStore.getState().totalCount).toBe(0);
  });

  it('file.saved records the save', () => {
    fire('file.saved', { filePath: 'e.ts' });
    expect(useCodemapActivityStore.getState().getActivityForFile('e.ts')).toHaveLength(1);
  });

  it('file.saved without a path is inert', () => {
    fire('file.saved', {});
    expect(useCodemapActivityStore.getState().totalCount).toBe(0);
  });

  it('codemap.index_updated stamps the index store and bumps the generation', () => {
    const before = useCodemapIndexStore.getState().generation;
    fire('codemap.index_updated', { at: 1_700_000_000_000 });

    const state = useCodemapIndexStore.getState();
    expect(state.lastUpdatedAt).toBe(1_700_000_000_000);
    expect(state.generation).toBe(before + 1);
  });

  it('codemap.index_updated defaults the timestamp to now', () => {
    useCodemapIndexStore.setState({ lastUpdatedAt: null });
    fire('codemap.index_updated', {});
    expect(useCodemapIndexStore.getState().lastUpdatedAt).toBeGreaterThan(0);
  });

  it('provider.response runs the session handler through the map entry', () => {
    useSessionStore.setState({ session: null, lastInputTokens: 0 });
    fire('provider.response', {
      usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 },
      stopReason: 'end_turn',
      messageId: 'm1',
      content: 'done',
      blocks: [{ type: 'tool_use', name: 'Edit', input: { filePath: 'f.ts' } }],
    });
    // The handler seeds lastInputTokens with input + cacheWrite - cacheRead
    // (95), but updateUsage then overwrites it with the full billed input
    // (input + cacheRead + cacheWrite). The later write wins.
    expect(useSessionStore.getState().lastInputTokens).toBe(115);
  });
});
