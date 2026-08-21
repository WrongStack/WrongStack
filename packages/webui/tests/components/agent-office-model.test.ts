import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_ICONS,
  type AgentVisualRole,
  type ClientOfficeStats,
  type OfficeAgentModel,
  TOOL_ICONS,
  agentVisualRole,
  clientOfficeStats,
  deskPersonality,
  deskWaitState,
  fallbackLogCalls,
  formatUptime,
  mergeCalls,
  mergeMail,
  relativeTime,
  shortModelName,
  shortPath,
} from '../../src/components/AgentOfficeView/model';
import type { OfficeMailActivity, OfficeToolCall } from '../../src/lib/agent-office';

// ── fixtures ────────────────────────────────────────────────────────────────

function agent(overrides: Record<string, unknown> = {}) {
  return {
    serverId: 'worker-1',
    name: 'Worker One',
    role: '',
    currentTask: '',
    ...overrides,
  } as never;
}

function client(overrides: Record<string, unknown> = {}) {
  return { sessionId: 'sess-1', ...overrides } as never;
}

function call(overrides: Partial<OfficeToolCall> = {}): OfficeToolCall {
  return {
    id: 'c1',
    toolName: 'read_file',
    kind: 'read',
    status: 'succeeded',
    startedAt: 1_000,
    completedAt: 2_000,
    durationMs: 1_000,
    summary: 'read',
    ...overrides,
  } as OfficeToolCall;
}

function mail(overrides: Partial<OfficeMailActivity> = {}): OfficeMailActivity {
  return {
    id: 'm1',
    direction: 'incoming',
    timestampMs: 1_000,
    ...overrides,
  } as OfficeMailActivity;
}

function model(overrides: Partial<OfficeAgentModel> = {}): OfficeAgentModel {
  return {
    key: 'k',
    client: client(),
    agent: agent(),
    calls: [],
    history: [],
    mail: [],
    ...overrides,
  } as OfficeAgentModel;
}

// ── icon tables ─────────────────────────────────────────────────────────────

describe('icon tables', () => {
  it('maps every tool kind to an icon', () => {
    expect(Object.keys(TOOL_ICONS).sort()).toEqual(
      ['read', 'write', 'edit', 'terminal', 'web', 'search', 'memory', 'other'].sort(),
    );
    for (const icon of Object.values(TOOL_ICONS)) expect(icon).toBeTruthy();
  });

  it('maps every visual role to an icon', () => {
    expect(Object.keys(AGENT_ROLE_ICONS).sort()).toEqual(
      ['leader', 'builder', 'researcher', 'reviewer', 'planner', 'operator'].sort(),
    );
  });
});

// ── agentVisualRole ─────────────────────────────────────────────────────────

describe('agentVisualRole', () => {
  it('recognises the bare leader id', () => {
    expect(agentVisualRole(agent({ serverId: 'leader' }))).toBe('leader');
  });

  it('recognises a scoped leader id', () => {
    expect(agentVisualRole(agent({ serverId: 'leader@1234' }))).toBe('leader');
  });

  it('does not treat "leadership-bot" as the leader', () => {
    expect(agentVisualRole(agent({ serverId: 'leadership-bot' }))).not.toBe('leader');
  });

  it.each([
    ['review the diff', 'reviewer'],
    ['security audit', 'reviewer'],
    ['QA checker', 'reviewer'],
    ['verify the fix', 'reviewer'],
    ['research the API', 'researcher'],
    ['explore the codebase', 'researcher'],
    ['recon pass', 'researcher'],
    ['plan the migration', 'planner'],
    ['architect the module', 'planner'],
    ['write the spec', 'planner'],
    ['implement the handler', 'builder'],
    ['refactor the store', 'builder'],
    ['frontend work', 'builder'],
  ] as Array<[string, AgentVisualRole]>)('classifies %j as %s', (task, expected) => {
    expect(agentVisualRole(agent({ currentTask: task }))).toBe(expected);
  });

  it('falls back to operator for an unclassifiable agent', () => {
    expect(agentVisualRole(agent({ name: 'zzz', role: '', currentTask: '' }))).toBe('operator');
  });

  it('is case-insensitive', () => {
    expect(agentVisualRole(agent({ role: 'REVIEWER' }))).toBe('reviewer');
  });

  it('matches across role, name and task combined', () => {
    expect(agentVisualRole(agent({ role: '', name: '', currentTask: 'audit' }))).toBe('reviewer');
    expect(agentVisualRole(agent({ role: 'planner', name: '', currentTask: '' }))).toBe('planner');
  });

  it('applies the documented precedence — reviewer beats builder', () => {
    // "review" is tested before "implement", so a task mentioning both is a
    // reviewer. This ordering is what keeps a "review the implementation"
    // agent from being drawn as a builder.
    expect(agentVisualRole(agent({ currentTask: 'review the implementation' }))).toBe('reviewer');
  });

  it('tolerates missing role/name/task fields', () => {
    expect(
      agentVisualRole({ serverId: 'w1', role: undefined, name: undefined } as never),
    ).toBe('operator');
  });
});

// ── deskPersonality ─────────────────────────────────────────────────────────

describe('deskPersonality', () => {
  it('is deterministic for the same identity and role', () => {
    expect(deskPersonality('worker-1', 'builder')).toEqual(deskPersonality('worker-1', 'builder'));
  });

  it.each([
    ['leader', 'plum', 0],
    ['builder', 'ocean', 1],
    ['researcher', 'mint', 2],
    ['reviewer', 'rose', 3],
    ['planner', 'amber', 4],
    ['operator', 'graphite', 5],
  ] as Array<[AgentVisualRole, string, number]>)(
    '%s always gets the %s palette and avatar %i — colour is information',
    (role, palette, avatar) => {
      const a = deskPersonality('anything', role);
      const b = deskPersonality('something-else-entirely', role);
      expect(a.palette).toBe(palette);
      expect(b.palette).toBe(palette);
      expect(a.avatar).toBe(avatar);
      expect(b.avatar).toBe(avatar);
    },
  );

  it('keeps decoration within its documented ranges', () => {
    for (const id of ['a', 'bb', 'ccc', 'worker-42', '', 'a'.repeat(200)]) {
      const p = deskPersonality(id, 'operator');
      expect(p.layout).toBeGreaterThanOrEqual(0);
      expect(p.layout).toBeLessThan(4);
      expect(p.clutter).toBeGreaterThanOrEqual(0);
      expect(p.clutter).toBeLessThan(3);
      expect(p.motion).toBeGreaterThanOrEqual(0);
      expect(p.motion).toBeLessThan(4);
      expect(['bot', 'cactus', 'duck', 'radio']).toContain(p.charm);
    }
  });

  it('varies decoration across identities', () => {
    const layouts = new Set(
      Array.from({ length: 40 }, (_, i) => deskPersonality(`agent-${i}`, 'builder').layout),
    );
    expect(layouts.size).toBeGreaterThan(1);
  });

  it('handles the empty identity without NaN', () => {
    const p = deskPersonality('', 'builder');
    expect(Number.isInteger(p.layout)).toBe(true);
    expect(Number.isInteger(p.motion)).toBe(true);
  });
});

// ── shortModelName ──────────────────────────────────────────────────────────

describe('shortModelName', () => {
  it('strips the provider prefix', () => {
    expect(shortModelName('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('keeps only the last path segment', () => {
    expect(shortModelName('a/b/c/model')).toBe('model');
  });

  it('passes a bare model name through', () => {
    expect(shortModelName('opus')).toBe('opus');
  });

  it('truncates with an ellipsis beyond the cap', () => {
    expect(shortModelName('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250…');
    expect(shortModelName('claude-sonnet-4-20250514')).toHaveLength(22);
  });

  it('respects a custom cap', () => {
    expect(shortModelName('abcdefghij', 5)).toBe('abcd…');
  });

  it('leaves a name exactly at the cap untouched', () => {
    expect(shortModelName('a'.repeat(22))).toBe('a'.repeat(22));
  });

  it('ignores empty segments from leading or trailing slashes', () => {
    expect(shortModelName('/opus/')).toBe('opus');
  });

  it('falls back to the raw value for an all-slash input', () => {
    expect(shortModelName('///')).toBe('///');
  });

  it('returns the empty string for empty input', () => {
    expect(shortModelName('')).toBe('');
  });
});

// ── shortPath ───────────────────────────────────────────────────────────────

describe('shortPath', () => {
  it('returns undefined for undefined', () => {
    expect(shortPath(undefined)).toBeUndefined();
  });

  it('returns the empty string unchanged', () => {
    expect(shortPath('')).toBe('');
  });

  it('leaves a short path untouched', () => {
    expect(shortPath('src/app.ts')).toBe('src/app.ts');
  });

  it('leaves a path exactly at the cap untouched', () => {
    const p = 'a'.repeat(46);
    expect(shortPath(p)).toBe(p);
  });

  it('collapses a long path to its last two segments', () => {
    expect(shortPath('packages/webui/src/components/AgentOfficeView/model.ts')).toBe(
      '…/AgentOfficeView/model.ts',
    );
  });

  it('handles Windows separators', () => {
    expect(shortPath('C:\\very\\long\\path\\that\\exceeds\\the\\cap\\for\\sure\\file.ts')).toBe(
      '…/sure/file.ts',
    );
  });

  it('tail-truncates when even the last two segments are too long', () => {
    const long = `${'a'.repeat(60)}/${'b'.repeat(60)}`;
    const out = shortPath(long);
    expect(out?.startsWith('…')).toBe(true);
    expect(out).toHaveLength(46);
  });

  it('tail-truncates a long single-segment path', () => {
    const out = shortPath('x'.repeat(100));
    expect(out).toHaveLength(46);
    expect(out?.startsWith('…')).toBe(true);
  });

  it('respects a custom cap', () => {
    expect(shortPath('src/a/b/c.ts', 6)).toBe('…/b/c.ts');
  });
});

// ── relativeTime ────────────────────────────────────────────────────────────

describe('relativeTime', () => {
  const NOW = 1_000_000;

  it('shows "now" under 5 seconds', () => {
    expect(relativeTime(NOW, NOW)).toBe('now');
    expect(relativeTime(NOW - 4_999, NOW)).toBe('now');
  });

  it('switches to seconds at 5s', () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe('5s');
    expect(relativeTime(NOW - 59_000, NOW)).toBe('59s');
  });

  it('switches to minutes at 60s', () => {
    expect(relativeTime(NOW - 60_000, NOW)).toBe('1m');
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe('59m');
  });

  it('switches to hours at 60m', () => {
    expect(relativeTime(NOW - 3_600_000, NOW)).toBe('1h');
    expect(relativeTime(NOW - 50 * 3_600_000, NOW)).toBe('50h');
  });

  it('clamps a future timestamp to "now" instead of going negative', () => {
    expect(relativeTime(NOW + 100_000, NOW)).toBe('now');
  });
});

// ── formatUptime ────────────────────────────────────────────────────────────

describe('formatUptime', () => {
  const NOW = Date.parse('2026-07-29T12:00:00Z');
  const at = (ms: number) => new Date(NOW - ms).toISOString();

  it('renders an em dash when there is no start time', () => {
    expect(formatUptime(undefined, NOW)).toBe('—');
  });

  it('renders an em dash for an unparseable start time', () => {
    expect(formatUptime('not a date', NOW)).toBe('—');
  });

  it('renders seconds under a minute', () => {
    expect(formatUptime(at(0), NOW)).toBe('0s');
    expect(formatUptime(at(59_000), NOW)).toBe('59s');
  });

  it('renders minutes, hours and days at each boundary', () => {
    expect(formatUptime(at(60_000), NOW)).toBe('1m');
    expect(formatUptime(at(3_600_000), NOW)).toBe('1h');
    expect(formatUptime(at(86_400_000), NOW)).toBe('1d');
    expect(formatUptime(at(10 * 86_400_000), NOW)).toBe('10d');
  });

  it('clamps a future start time to 0s', () => {
    expect(formatUptime(at(-60_000), NOW)).toBe('0s');
  });
});

// ── clientOfficeStats ───────────────────────────────────────────────────────

describe('clientOfficeStats', () => {
  const EMPTY: ClientOfficeStats = {
    files: 0,
    reads: 0,
    writes: 0,
    edits: 0,
    linesAdded: 0,
    linesRemoved: 0,
    terminalCalls: 0,
    incomingMail: 0,
    outgoingMail: 0,
  };

  it('returns zeroes for no agents', () => {
    expect(clientOfficeStats([])).toEqual(EMPTY);
  });

  it('treats an agent with no activity as all zeroes', () => {
    expect(clientOfficeStats([model()])).toEqual(EMPTY);
  });

  it('sums counters across agents', () => {
    const stats = clientOfficeStats([
      model({
        agent: agent({
          activity: { reads: 2, writes: 1, edits: 3, linesAdded: 10, linesRemoved: 4, terminalCalls: 5 },
        }),
      }),
      model({
        agent: agent({
          activity: { reads: 1, writes: 1, edits: 0, linesAdded: 5, linesRemoved: 1, terminalCalls: 2 },
        }),
      }),
    ]);
    expect(stats).toMatchObject({
      reads: 3,
      writes: 2,
      edits: 3,
      linesAdded: 15,
      linesRemoved: 5,
      terminalCalls: 7,
    });
  });

  it('de-duplicates files touched by more than one agent', () => {
    const stats = clientOfficeStats([
      model({ agent: agent({ activity: { filesTouched: ['a.ts', 'b.ts'] } }) }),
      model({ agent: agent({ activity: { filesTouched: ['b.ts', 'c.ts'] } }) }),
    ]);
    expect(stats.files).toBe(3);
  });

  it('de-duplicates mail by id across agents', () => {
    const stats = clientOfficeStats([
      model({ mail: [mail({ id: 'm1' }), mail({ id: 'm2', direction: 'outgoing' })] }),
      model({ mail: [mail({ id: 'm1' })] }),
    ]);
    expect(stats.incomingMail).toBe(1);
    expect(stats.outgoingMail).toBe(1);
  });

  it('prefers the session counter when it exceeds the observed record count', () => {
    // The mail list is capped/lossy; the session counter is authoritative when
    // it is higher, so a trimmed list never under-reports traffic.
    const stats = clientOfficeStats([
      model({
        agent: agent({ activity: { mailReceived: 50, mailSent: 30 } }),
        mail: [mail({ id: 'm1' })],
      }),
    ]);
    expect(stats.incomingMail).toBe(50);
    expect(stats.outgoingMail).toBe(30);
  });

  it('prefers the observed record count when it exceeds the session counter', () => {
    const stats = clientOfficeStats([
      model({
        agent: agent({ activity: { mailReceived: 1, mailSent: 0 } }),
        mail: [mail({ id: 'm1' }), mail({ id: 'm2' }), mail({ id: 'm3' })],
      }),
    ]);
    expect(stats.incomingMail).toBe(3);
  });
});

// ── fallbackLogCalls ────────────────────────────────────────────────────────

describe('fallbackLogCalls', () => {
  it('returns an empty list for no logs', () => {
    expect(fallbackLogCalls(agent(), client(), [])).toEqual([]);
  });

  it('builds a unique id per log entry', () => {
    const calls = fallbackLogCalls(agent(), client(), [
      { name: 'read_file', ok: true, durationMs: 10, at: 100 },
      { name: 'read_file', ok: true, durationMs: 10, at: 100 },
    ]);
    expect(calls[0].id).toBe('worker-1:log:100:0');
    expect(calls[1].id).toBe('worker-1:log:100:1');
  });

  it('marks a successful log as succeeded with a completion summary', () => {
    const [c] = fallbackLogCalls(agent(), client(), [
      { name: 'bash', ok: true, durationMs: 250, at: 1_000 },
    ]);
    expect(c).toMatchObject({
      status: 'succeeded',
      summary: 'bash completed',
      startedAt: 750,
      completedAt: 1_000,
      durationMs: 250,
    });
  });

  it('marks a failed log as failed', () => {
    const [c] = fallbackLogCalls(agent(), client(), [
      { name: 'bash', ok: false, durationMs: 10, at: 100 },
    ]);
    expect(c).toMatchObject({ status: 'failed', summary: 'bash failed' });
  });

  it('clamps startedAt at zero when the duration exceeds the timestamp', () => {
    const [c] = fallbackLogCalls(agent(), client(), [
      { name: 'bash', ok: true, durationMs: 5_000, at: 1_000 },
    ]);
    expect(c.startedAt).toBe(0);
  });

  it('classifies the tool kind from its name', () => {
    const calls = fallbackLogCalls(agent(), client(), [
      { name: 'read_file', ok: true, durationMs: 1, at: 1 },
      { name: 'bash', ok: true, durationMs: 1, at: 2 },
    ]);
    expect(calls[0].kind).toBe('read');
    expect(calls[1].kind).toBe('terminal');
  });
});

// ── mergeCalls ──────────────────────────────────────────────────────────────

describe('mergeCalls', () => {
  it('returns an empty list for no sources', () => {
    expect(mergeCalls()).toEqual([]);
    expect(mergeCalls([], [])).toEqual([]);
  });

  it('sorts newest first', () => {
    const out = mergeCalls([
      call({ id: 'a', toolName: 'a', completedAt: 1_000 }),
      call({ id: 'b', toolName: 'b', completedAt: 3_000 }),
      call({ id: 'c', toolName: 'c', completedAt: 2_000 }),
    ]);
    expect(out.map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('drops a duplicate id within the 2.5s window', () => {
    const out = mergeCalls(
      [call({ id: 'same', toolName: 'x', completedAt: 1_000 })],
      [call({ id: 'same', toolName: 'y', completedAt: 2_000 })],
    );
    expect(out).toHaveLength(1);
  });

  it('drops a duplicate tool name within the window even with different ids', () => {
    const out = mergeCalls(
      [call({ id: 'a', toolName: 'read_file', completedAt: 1_000 })],
      [call({ id: 'b', toolName: 'read_file', completedAt: 2_000 })],
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });

  it('keeps the same tool name outside the window', () => {
    const out = mergeCalls(
      [call({ id: 'a', toolName: 'read_file', completedAt: 1_000 })],
      [call({ id: 'b', toolName: 'read_file', completedAt: 4_000 })],
    );
    expect(out).toHaveLength(2);
  });

  it('treats the window as strictly under 2500ms', () => {
    expect(
      mergeCalls([
        call({ id: 'a', toolName: 't', completedAt: 0 }),
        call({ id: 'b', toolName: 't', completedAt: 2_500 }),
      ]),
    ).toHaveLength(2);
    expect(
      mergeCalls([
        call({ id: 'a', toolName: 't', completedAt: 0 }),
        call({ id: 'b', toolName: 't', completedAt: 2_499 }),
      ]),
    ).toHaveLength(1);
  });

  it('falls back to startedAt for an in-flight call with no completedAt', () => {
    const out = mergeCalls([
      call({ id: 'running', toolName: 'x', startedAt: 5_000, completedAt: undefined }),
      call({ id: 'done', toolName: 'y', completedAt: 1_000 }),
    ]);
    expect(out.map((c) => c.id)).toEqual(['running', 'done']);
  });

  it('merges more than two sources', () => {
    const out = mergeCalls(
      [call({ id: 'a', toolName: 'a', completedAt: 1_000 })],
      [call({ id: 'b', toolName: 'b', completedAt: 5_000 })],
      [call({ id: 'c', toolName: 'c', completedAt: 9_000 })],
    );
    expect(out.map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });
});

// ── mergeMail ───────────────────────────────────────────────────────────────

describe('mergeMail', () => {
  it('returns an empty list for no sources', () => {
    expect(mergeMail()).toEqual([]);
  });

  it('sorts newest first', () => {
    const out = mergeMail([
      mail({ id: 'a', timestampMs: 1 }),
      mail({ id: 'b', timestampMs: 3 }),
      mail({ id: 'c', timestampMs: 2 }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['b', 'c', 'a']);
  });

  it('lets a later source win for the same id — full records beat snapshots', () => {
    const out = mergeMail(
      [mail({ id: 'm1', timestampMs: 1, body: 'snapshot' } as never)],
      [mail({ id: 'm1', timestampMs: 1, body: 'full record' } as never)],
    );
    expect(out).toHaveLength(1);
    expect((out[0] as unknown as { body: string }).body).toBe('full record');
  });

  it('caps the list at 12 entries, keeping the newest', () => {
    const many = Array.from({ length: 20 }, (_, i) => mail({ id: `m${i}`, timestampMs: i }));
    const out = mergeMail(many);
    expect(out).toHaveLength(12);
    expect(out[0].id).toBe('m19');
    expect(out.at(-1)?.id).toBe('m8');
  });
});

// ── deskWaitState ───────────────────────────────────────────────────────────

describe('deskWaitState', () => {
  const now = 1_000_000;

  it('is not waiting when the agent is idle/offline', () => {
    const state = deskWaitState(
      model({ agent: agent({ status: 'idle' }), history: [call({ completedAt: now - 500_000 })] }),
      now,
    );
    expect(state.waiting).toBe(false);
  });

  it('is not waiting while a tool call is running', () => {
    const state = deskWaitState(
      model({
        agent: agent({ status: 'active' }),
        current: call({ id: 'running', startedAt: now - 500_000, completedAt: undefined }),
      }),
      now,
    );
    expect(state.waiting).toBe(false);
  });

  it('is not waiting before the threshold elapses', () => {
    const state = deskWaitState(
      model({ agent: agent({ status: 'active' }), history: [call({ completedAt: now - 10_000 })] }),
      now,
    );
    expect(state.waiting).toBe(false);
  });

  it('reports telemetry when an active agent has no calls and no todos', () => {
    const state = deskWaitState(
      model({
        agent: agent({ status: 'active', toolCalls: 0 }),
        client: client({ todos: undefined }),
      }),
      now,
    );
    expect(state.waiting).toBe(true);
    expect(state.reason).toBe('telemetry');
    expect(state.idleMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('reports mail-reply when the newest outgoing mail is unanswered', () => {
    const state = deskWaitState(
      model({
        agent: agent({ status: 'active', toolCalls: 3 }),
        client: client({ todos: [{ text: 'x', status: 'pending' }] }),
        history: [call({ completedAt: now - 400_000 })],
        mail: [
          mail({ id: 'out', direction: 'outgoing', timestampMs: now - 300_000, subject: 'review?' }),
          mail({ id: 'in', direction: 'incoming', timestampMs: now - 350_000 }),
        ],
      }),
      now,
    );
    expect(state.waiting).toBe(true);
    expect(state.reason).toBe('mail-reply');
    expect(state.anchor).toBe('review?');
  });

  it('falls back to no-work when there is nothing actionable to wait on', () => {
    const state = deskWaitState(
      model({
        agent: agent({ status: 'active', toolCalls: 5, currentTask: 'refactor X' }),
        client: client({ todos: [{ text: 'x', status: 'in_progress' }] }),
        history: [call({ completedAt: now - 400_000, summary: 'edit model.ts' })],
      }),
      now,
    );
    expect(state.waiting).toBe(true);
    expect(state.reason).toBe('no-work');
    expect(state.anchor).toBe('refactor X');
  });

  it('uses the last history summary as anchor when no current task exists', () => {
    const state = deskWaitState(
      model({
        agent: agent({ status: 'active', toolCalls: 2, currentTask: '' }),
        client: client({ todos: [{ text: 'x', status: 'in_progress' }] }),
        history: [call({ completedAt: now - 400_000, summary: 'last thing' })],
      }),
      now,
    );
    expect(state.reason).toBe('no-work');
    expect(state.anchor).toBe('last thing');
  });

  it('treats incoming mail as activity that resets the idle clock', () => {
    const state = deskWaitState(
      model({
        agent: agent({ status: 'active', toolCalls: 2 }),
        client: client({ todos: [{ text: 'x', status: 'pending' }] }),
        history: [call({ completedAt: now - 400_000 })],
        mail: [mail({ direction: 'incoming', timestampMs: now - 5_000 })],
      }),
      now,
    );
    expect(state.waiting).toBe(false);
    expect(state.idleMs).toBe(5_000);
  });
});
