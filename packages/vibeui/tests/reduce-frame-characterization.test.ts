import type { ProtocolEnvelope } from '@wrongstack/webui-protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initialState, reduceFrame, type SessionState } from '../src/lib/session';

/**
 * Characterization net for splitting `reduceFrame` into per-frame-type
 * sub-reducers. It replays one fixed stream that reaches every branch of the
 * reducer and snapshots the state at phase boundaries. A pure refactor must
 * leave every snapshot unchanged; an intentional behavior change updates the
 * snapshot in the same commit, with the reason stated there.
 *
 * Two sources of nondeterminism are pinned:
 * - `Date.now()` (stream activity, cache capture time) via fake timers;
 * - live entry ids (`<frame.type>-<module counter>`): the counter is shared by
 *   every test in the worker, so ids are renumbered in first-seen order. The
 *   frame type stays visible, so moving id generation between frame types is
 *   still caught.
 */

const SESSION = 'one';
const frame = (type: string, payload: Record<string, unknown> = {}): ProtocolEnvelope => ({
  type,
  payload,
});
const own = (type: string, payload: Record<string, unknown> = {}) =>
  frame(type, { sessionId: SESSION, ...payload });

// `<frame.type>-<n>`: dotted frame types plus the bare `error` frame. Agent entry
// ids (`<agentId>-<sequence>`) are per-agent and deterministic, so they stay raw.
const LIVE_ID = /^(error|[a-z]+(?:\.[a-z_]+)+)-(\d+)$/;

function normalize(state: SessionState, ids: Map<string, string>): unknown {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const match = LIVE_ID.exec(value);
      if (!match) return value;
      if (!ids.has(value)) ids.set(value, `${match[1]}#${ids.size + 1}`);
      return ids.get(value);
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  return visit(state);
}

function run(state: SessionState, frames: ProtocolEnvelope[]): SessionState {
  return frames.reduce(reduceFrame, state);
}

const artifactOutput = JSON.stringify({
  type: 'artifact.presentation',
  version: 2,
  sessionId: SESSION,
  kind: 'text',
  id: 'notes',
  title: 'Release notes',
  path: 'docs/notes.md',
});

/** Session start with replay, versions, effort vocabulary and a replayed agent. */
const startPhase: ProtocolEnvelope[] = [
  frame('session.start', {
    sessionId: SESSION,
    provider: 'fixture',
    model: 'fixture-model',
    projectName: 'Project',
    cwd: '/work/project',
    maxContext: 10_000,
    lastInputTokens: 2_500,
    appVersion: '9.9.9',
    latestVersion: '10.0.0',
    updateAvailable: true,
    mode: 'build',
    reasoningEffortLevels: ['low', 'high', 42],
    effortSupported: true,
    projectReasoningEffort: 'high',
    replayMessages: [
      {
        role: 'user',
        origin: 'user_input',
        authoredLength: 1,
        content: [
          { type: 'text', text: 'Earlier request' },
          { type: 'text', text: '[TOOL COACH — inspect first]\nRead before editing.' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
      { role: 'tool', content: 'filtered out' },
    ],
    agentSessions: [
      {
        subagentId: 'auditor',
        agentName: 'Auditor',
        status: 'completed',
        provider: 'fixture',
        model: 'audit-model',
        task: 'Audit the boundary',
        transcript: [
          { kind: 'text', content: 'Looking around' },
          { kind: 'result', content: 'Audit complete' },
        ],
      },
    ],
  }),
];

/** Catalogs, runtime metrics, workspace data and model switching outside a run. */
const workspacePhase: ProtocolEnvelope[] = [
  frame('sessions.list', {
    sessions: [
      { id: SESSION, name: 'Current work', startedAt: '2026-01-01T00:00:00Z' },
      { id: 'older', title: 'Older work' },
      { id: '', name: 'dropped' },
      { id: 'untitled' },
    ],
  }),
  frame('modes.list', {
    activeId: 'review',
    modes: [{ id: 'build', name: 'Build' }, { id: 'review', description: 'Read-only' }, {}],
  }),
  own('mode.switched', { id: 'build' }),
  frame('provider.catalog', {
    providers: [
      { id: 'fixture', name: 'Fixture', hasApiKey: true, family: 'openai', apiBase: 'http://x' },
      { id: 'bare' },
    ],
  }),
  frame('provider.models', {
    provider: 'fixture',
    models: [{ id: 'fixture-model', name: 'Fixture', contextWindow: 10_000 }, { id: 'small' }, {}],
  }),
  own('model.switch_result', { success: false, message: 'Model refused.' }),
  own('provider.model_switched', { to: { provider: 'fixture', model: 'small' } }),
  own('model.switch_result', { provider: 'fixture', model: 'fixture-model' }),
  own('ctx.max_context', { maxContext: 12_000 }),
  own('ctx.pct', { load: 0.25, tokens: 3_000 }),
  own('prefs.updated', { autonomy: 'auto', yolo: true, autonomyDelayMs: 5000 }),
  own('stats.get', {
    usage: { input: 100, output: 50, total: 150 },
    cache: { readTokens: 900, writeTokens: 100, hitRatio: 1.7, last: { hitRatio: 0.5 } },
    currentRequest: { cacheRead: 99_999 },
  }),
  own('key.operation_result', { success: true }),
  own('files.list', { files: ['src/a.ts', 7, 'src/b.ts'] }),
  own('files.tree', {
    tree: [
      {
        name: 'src',
        path: 'src',
        type: 'directory',
        children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }],
      },
    ],
  }),
  own('git.changes', {
    files: [{ path: 'src/a.ts', status: 'M', added: 3, deleted: 1 }],
  }),
  own('git.diff', { path: 'src/a.ts', oldText: 'a', newText: 'b' }),
  own('git.diff', { path: 'logo.png', binary: true }),
];

/** One leader run with streaming, tools, artifacts, worklists, agents and prompts. */
const runPhase: ProtocolEnvelope[] = [
  own('iteration.started'),
  own('provider.thinking_delta', { text: 'Considering the change.' }),
  own('provider.text_delta', { text: 'Working', messageId: 'm1' }),
  own('provider.text_delta', { text: ' on it', messageId: 'm1' }),
  own('tool.started', { id: 'read-1', name: 'read_file', input: { path: 'src/a.ts' } }),
  own('tool.progress', { id: 'read-1', name: 'read_file', event: { type: 'log', text: ' half ' } }),
  own('tool.executed', {
    id: 'read-1',
    name: 'read_file',
    ok: true,
    output: 'file body',
    durationMs: 4,
  }),
  own('tool.started', { id: 'present', name: 'present_artifact', input: {} }),
  own('tool.executed', {
    id: 'present',
    name: 'present_artifact',
    ok: true,
    output: artifactOutput,
  }),
  own('tool.started', { id: 'write-1', name: 'write_file', input: { path: 'src/b.ts' } }),
  own('provider.response', {
    content: [{ type: 'text', text: 'Working on it.' }],
    stopReason: 'tool_use',
  }),
  own('todos.updated', { todos: [{ id: 't1', content: 'Write tests', status: 'in_progress' }] }),
  own('tasks.updated', { tasks: [{ id: 'k1', title: 'Refactor', status: 'pending' }] }),
  own('plan.updated', { plan: { items: [{ id: 'p1', title: 'Plan step', status: 'open' }] } }),
  own('subagent.event', {
    subagentId: 'reviewer',
    kind: 'spawned',
    name: 'Reviewer',
    provider: 'fixture',
    model: 'worker-model',
    description: 'Inspect regressions',
  }),
  own('subagent.event', { subagentId: 'ghost', kind: 'progress' }),
  own('subagent.event', { subagentId: 'reviewer', kind: 'task_started' }),
  own('agent.status_changed', {
    subagentId: 'reviewer',
    status: 'running',
    currentTool: 'grep',
    partialText: 'Scanning…',
    iterations: 2,
    toolCalls: 3,
    tokens: 1_200,
  }),
  own('agent.timeline.message', {
    subagentId: 'reviewer',
    agentName: 'Reviewer',
    kind: 'tool',
    toolName: 'grep',
    content: 'Found 2 matches',
    ts: '2026-01-01T00:00:01Z',
  }),
  own('coordinator.stats', {
    subagentStatuses: [{ id: 'helper', name: 'Helper', status: 'busy', currentTask: 'Assist' }],
  }),
  own('tool.confirm_needed', {
    id: 'c1',
    toolName: 'bash',
    input: { command: 'ls' },
    deadlineAt: 99,
  }),
  own('tool.confirm_needed', { id: 'c2', toolName: 'write_file', input: {} }),
  own('tool.confirm_needed', { id: 'c3', toolName: 'edit', input: {} }),
  own('tool.confirm_needed', { toolName: 'missing-id' }),
  own('tool.confirm_resolved', { id: 'c1' }),
  own('tool.confirm_resolved', { id: 'c3' }),
  own('user.input_requested', {
    request: {
      id: 'q1',
      title: 'Pick a direction',
      tabs: [
        {
          questions: [
            {
              id: 'dir',
              prompt: 'Which way?',
              kind: 'choice',
              required: true,
              allowCustomResponse: false,
              options: [
                { id: 'a', label: 'Left' },
                { id: 'b', label: 'Right' },
              ],
            },
            { id: 'why', prompt: 'Why?', kind: 'text' },
          ],
        },
      ],
    },
  }),
  own('user.input_requested', { request: { id: 'q1', title: 'Duplicate' } }),
  own('error', { phase: 'rate_limit', message: 'Slow down a little.' }),
  own('provider.retry'),
  own('provider.text_delta', { text: 'Done with the change.', messageId: 'm2' }),
  frame('provider.text_delta', { sessionId: 'foreign', text: 'must be ignored' }),
  own('run.result', {
    status: 'done',
    iterations: 3,
    finalText: 'Done with the change.\n\n<nextsteps>\n- Run the tests\n</nextsteps>',
  }),
];

/** After the run: reconciliation, compaction, notices and a failed second run. */
const afterRunPhase: ProtocolEnvelope[] = [
  own('session.run_state', { isRunning: false }),
  own('context.compacted', { before: 3_000, after: 1_200 }),
  frame('sessions.status_update', {
    sessions: [
      { sessionId: SESSION, agents: [{ id: 'reviewer', name: 'Reviewer', status: 'running' }] },
    ],
  }),
  own('chimera.report_available', { hasActionableFindings: false, message: 'Hidden' }),
  own('chimera.report_available', { message: 'Review ready.' }),
  own('user.input_resolved', { requestId: 'q1' }),
  own('todos.cleared'),
  own('session.run_state', { isRunning: true }),
  own('provider.text_delta', { text: 'Second attempt' }),
  own('tool.started', { id: 'bash-2', name: 'bash', input: { command: 'test' } }),
  own('error', { phase: 'provider', message: 'Provider unavailable' }),
];

/** Switching to another session resets every session-scoped field. */
const switchPhase: ProtocolEnvelope[] = [
  frame('session.start', {
    sessionId: 'two',
    provider: 'fixture',
    model: 'fixture-model',
    projectName: 'Project',
    maxContext: 8_000,
    isRunning: false,
  }),
  frame('provider.text_delta', { sessionId: SESSION, text: 'late frame from the old session' }),
];

describe('reduceFrame characterization', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('reaches the same state at every phase boundary of a fixed frame stream', () => {
    const ids = new Map<string, string>();
    let state = run(initialState(), startPhase);
    expect(normalize(state, ids)).toMatchSnapshot('1 session start with replay');

    state = run(state, workspacePhase);
    // files.read / files.image only apply to a preview the controller opened.
    const withPreview: SessionState = {
      ...state,
      preview: {
        requestId: 'r1',
        artifact: {
          id: 'file:src/a.ts',
          sessionId: SESSION,
          path: 'src/a.ts',
          title: 'a.ts',
          kind: 'text',
        },
        content: '',
        error: '',
        loading: true,
      },
    };
    state = run(withPreview, [
      own('files.image', {
        requestId: 'stale',
        filePath: 'src/a.ts',
        dataUrl: 'data:image/png;base64,AA==',
      }),
      own('files.read', { requestId: 'r1', filePath: 'src/a.ts', content: 'export const a = 1;' }),
    ]);
    expect(normalize(state, ids)).toMatchSnapshot('2 workspace data and catalogs');

    state = run(state, runPhase);
    expect(normalize(state, ids)).toMatchSnapshot('3 leader run finished');

    state = run(state, afterRunPhase);
    expect(normalize(state, ids)).toMatchSnapshot('4 reconciliation and failed run');

    state = run(state, switchPhase);
    expect(normalize(state, ids)).toMatchSnapshot('5 switched session');
  });

  it('returns the identical object for frames that do not apply', () => {
    const state = run(initialState(), startPhase);
    for (const ignored of [
      frame('provider.text_delta', { sessionId: 'foreign', text: 'x' }),
      own('files.read', { requestId: 'none', filePath: 'x' }),
      own('sessions.status_update', { sessions: [] }),
      own('user.input_requested', { request: {} }),
      own('tool.confirm_needed', {}),
      own('chimera.report_available', { sessionId: 'foreign', message: 'x' }),
      own('unknown.frame_type'),
      // A frame-type lookup table must not resolve Object.prototype members.
      own('constructor'),
      own('toString'),
      own('__proto__'),
    ]) {
      expect(reduceFrame(state, ignored)).toBe(state);
    }
  });
});
