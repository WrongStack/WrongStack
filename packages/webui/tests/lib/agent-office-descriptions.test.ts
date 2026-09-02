import { describe, expect, it } from 'vitest';
import {
  buildAgentToolCalls,
  buildSnapshotMailActivities,
  buildSnapshotToolCalls,
  classifyOfficeTool,
  synthesizeCurrentTool,
} from '../../src/lib/agent-office';
import type { VizEvent } from '../../src/stores/viz-store';

/**
 * The per-kind description branches of `describeTool` and the snapshot
 * builders. Every summary is produced through `buildAgentToolCalls`, which is
 * the only public door into the private `describeTool`/`lineRange` helpers.
 */

const AGENT = 'sa1';

function toolEvent(data: Record<string, unknown>, overrides: Partial<VizEvent> = {}): VizEvent {
  return {
    id: `ev_${Math.random()}`,
    kind: 'tool:executed',
    timestamp: 1_000,
    source: AGENT,
    target: String(data['name'] ?? 'Tool'),
    label: String(data['name'] ?? 'Tool'),
    data: { agentId: AGENT, ...data },
    flowGroup: `agent:${AGENT}`,
    ...overrides,
  } as VizEvent;
}

/** The single call produced by one event. */
function callFor(data: Record<string, unknown>, overrides: Partial<VizEvent> = {}) {
  const calls = buildAgentToolCalls([toolEvent(data, overrides)], AGENT);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

describe('classifyOfficeTool', () => {
  it.each([
    ['Read', 'read'],
    ['read_file', 'read'],
    ['open_file', 'read'],
    ['fs.file_read', 'read'],
    ['Write', 'write'],
    ['create_note', 'write'],
    ['save_draft', 'write'],
    ['Edit', 'edit'],
    ['apply_patch', 'edit'],
    ['update_config', 'edit'],
    ['Bash', 'terminal'],
    ['powershell', 'terminal'],
    ['run_command', 'terminal'],
    ['WebFetch', 'web'],
    ['browser_open', 'web'],
    ['http_get', 'web'],
    ['Grep', 'search'],
    ['glob_files', 'search'],
    ['query_db', 'search'],
    ['memory_recall', 'memory'],
    ['remember', 'memory'],
    ['Anything', 'other'],
  ])('classifies %s as %s', (name, kind) => {
    expect(classifyOfficeTool(name)).toBe(kind);
  });

  it('normalises separators before matching', () => {
    // `.`, `:`, `/` and `-` all fold to `_`, so `read-file` and `read.file`
    // hit the same `read_file` rule as the underscore spelling.
    expect(classifyOfficeTool('read-file')).toBe('read');
    expect(classifyOfficeTool('file.write')).toBe('write');
  });

  it('does not match a prefixed name against an anchored rule', () => {
    // The read/write rules are anchored at `^`, so a namespaced tool falls
    // through unless it also matches one of the unanchored alternates
    // (`file_read` / `file_write`).
    expect(classifyOfficeTool('mcp:read-file')).toBe('other');
    expect(classifyOfficeTool('mcp:file-read')).toBe('read');
  });
});

describe('describeTool — read', () => {
  it('reports the number of lines read when the server counted them', () => {
    const call = callFor({ name: 'Read', input: { file_path: '/repo/a.ts' }, outputLines: 1_234 });
    expect(call.summary).toBe(`${(1_234).toLocaleString()} lines read`);
    expect(call.target).toBe('/repo/a.ts');
  });

  it('labels an explicit line range', () => {
    const call = callFor({ name: 'Read', input: { file_path: 'a.ts', line: 10, end_line: 20 } });
    expect(call.lineLabel).toBe('L10–20');
  });

  it('derives the end line from a limit', () => {
    const call = callFor({ name: 'Read', input: { file_path: 'a.ts', line: 10, limit: 5 } });
    expect(call.lineLabel).toBe('L10–14');
  });

  it('labels a bare start line on its own', () => {
    const call = callFor({ name: 'Read', input: { file_path: 'a.ts', offset: 42 } });
    expect(call.lineLabel).toBe('L42');
  });

  it('ignores a zero limit rather than producing an inverted range', () => {
    const call = callFor({ name: 'Read', input: { file_path: 'a.ts', line: 10, limit: 0 } });
    expect(call.lineLabel).toBe('L10');
  });

  it('has no line label when the input carries no position', () => {
    const call = callFor({ name: 'Read', input: { file_path: 'a.ts' } });
    expect(call.lineLabel).toBeUndefined();
  });
});

describe('describeTool — terminal', () => {
  it('summarises the first line of the command', () => {
    const call = callFor({ name: 'Bash', input: { command: 'pnpm test\n# and more' } });
    expect(call.summary).toBe('pnpm test');
    expect(call.target).toBe('pnpm test\n# and more');
  });

  it('truncates a long command with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const call = callFor({ name: 'Bash', input: { command: long } });
    expect(call.summary).toHaveLength(70);
    expect(call.summary.endsWith('…')).toBe(true);
  });

  it('falls back to the tool name when no command field is present', () => {
    const call = callFor({ name: 'Bash', input: {} });
    expect(call.summary).toBe('Bash');
  });

  it('accepts any of the command aliases', () => {
    expect(callFor({ name: 'Bash', input: { cmd: 'ls' } }).summary).toBe('ls');
    expect(callFor({ name: 'Bash', input: { script: 'ls -l' } }).summary).toBe('ls -l');
    expect(callFor({ name: 'Bash', input: { shell: 'pwd' } }).summary).toBe('pwd');
  });
});

describe('describeTool — web', () => {
  it('names the fetched url', () => {
    const call = callFor({ name: 'WebFetch', input: { url: 'https://example.test' } });
    expect(call.summary).toBe('Fetched https://example.test');
    expect(call.target).toBe('https://example.test');
  });

  it('falls back to the query when there is no url', () => {
    const call = callFor({ name: 'WebSearch', input: { query: 'vitest v8' } });
    expect(call.summary).toContain('vitest v8');
    expect(call.target).toBe('vitest v8');
  });

  it('degrades to a generic label with neither', () => {
    const call = callFor({ name: 'browser_open', input: {} });
    expect(call.summary).toBe('Went online');
    expect(call.target).toBeUndefined();
  });
});

describe('describeTool — search', () => {
  it('quotes the search pattern', () => {
    const call = callFor({ name: 'Grep', input: { pattern: 'TODO' } });
    expect(call.summary).toContain('TODO');
  });

  it('prefers an explicit path as the target', () => {
    const call = callFor({ name: 'Grep', input: { pattern: 'TODO', path: 'src/a.ts' } });
    expect(call.target).toBe('src/a.ts');
  });

  it('falls back to the file basename as the query', () => {
    // With no query field, `shortTarget` (the basename) stands in.
    const call = callFor({ name: 'Glob', input: { file_path: '/repo/deep/x.ts' } });
    expect(call.summary).toContain('x.ts');
  });

  it('degrades to a generic label with nothing to search on', () => {
    const call = callFor({ name: 'Glob', input: {} });
    expect(call.summary).toBe('Searching project');
  });
});

describe('describeTool — memory', () => {
  it('quotes the recalled key', () => {
    const call = callFor({ name: 'memory_recall', input: { key: 'auth-notes' } });
    expect(call.summary).toContain('auth-notes');
    expect(call.target).toBe('auth-notes');
  });

  it('degrades to a generic label', () => {
    const call = callFor({ name: 'remember', input: {} });
    expect(call.summary).toBe('Checking memory');
  });
});

describe('describeTool — other', () => {
  it('appends the basename when there is a path', () => {
    const call = callFor({ name: 'CustomTool', input: { path: '/repo/notes.md' } });
    expect(call.summary).toBe('CustomTool · notes.md');
  });

  it('is just the tool name otherwise', () => {
    const call = callFor({ name: 'CustomTool', input: {} });
    expect(call.summary).toBe('CustomTool');
  });
});

describe('buildAgentToolCalls — status and identity', () => {
  it('marks a started event as running', () => {
    const call = callFor({ name: 'Read', id: 't1' }, { kind: 'tool:started' });
    expect(call.status).toBe('running');
  });

  it('marks a progress event as running', () => {
    const call = callFor({ name: 'Read', id: 't1' }, { kind: 'tool:progress' });
    expect(call.status).toBe('running');
  });

  it('marks an explicit failure as failed', () => {
    const call = callFor({ name: 'Read', id: 't1', ok: false });
    expect(call.status).toBe('failed');
  });

  it('treats anything else as succeeded', () => {
    expect(callFor({ name: 'Read', id: 't1' }).status).toBe('succeeded');
  });

  it('ignores an event kind that is not a tool envelope', () => {
    expect(
      buildAgentToolCalls([toolEvent({ name: 'Read' }, { kind: 'agent:spawned' })], AGENT),
    ).toEqual([]);
  });

  it('ignores an envelope with no resolvable tool name', () => {
    const event = toolEvent({}, { target: undefined, label: '' });
    (event as { data: Record<string, unknown> }).data = { agentId: AGENT };
    (event as { kind: string }).kind = 'tool:executed';
    (event as { source: string }).source = AGENT;
    // `toolNameFor` falls back to `event.source` for a `tool:*` kind, so the
    // name resolves to the agent id — the event is kept, not dropped.
    expect(buildAgentToolCalls([event], AGENT)).toHaveLength(1);
  });

  it('drops calls belonging to a different agent', () => {
    const other = toolEvent({ name: 'Read', agentId: 'sa2' });
    expect(buildAgentToolCalls([other], AGENT)).toEqual([]);
  });

  it('drops calls from a different session when a session filter is given', () => {
    const event = toolEvent({ name: 'Read', sessionId: 'sess_b' });
    expect(buildAgentToolCalls([event], AGENT, 'sess_a')).toEqual([]);
  });

  it('keeps a call with no session id even under a session filter', () => {
    expect(buildAgentToolCalls([toolEvent({ name: 'Read' })], AGENT, 'sess_a')).toHaveLength(1);
  });

  it('merges start and completion envelopes into one call', () => {
    const started = toolEvent({ name: 'Read', id: 't1' }, { kind: 'tool:started', timestamp: 500 });
    const done = toolEvent(
      { name: 'Read', id: 't1', ok: true, input: { file_path: 'a.ts' }, durationMs: 20 },
      { timestamp: 900 },
    );
    const calls = buildAgentToolCalls([done, started], AGENT);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 'succeeded', startedAt: 500 });
  });

  it('sorts the newest completion first', () => {
    const older = toolEvent({ name: 'Read', id: 'a' }, { timestamp: 100 });
    const newer = toolEvent({ name: 'Write', id: 'b' }, { timestamp: 900 });
    const calls = buildAgentToolCalls([older, newer], AGENT);
    expect(calls.map((c) => c.toolName)).toEqual(['Write', 'Read']);
  });

  it('drops the compact twin of a richer envelope for the same tool', () => {
    const rich = toolEvent(
      { name: 'Read', id: 'rich', input: { file_path: 'a.ts' } },
      {
        timestamp: 1_000,
      },
    );
    const compact = toolEvent({ name: 'Read', id: 'compact' }, { timestamp: 1_100 });
    const calls = buildAgentToolCalls([rich, compact], AGENT);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeDefined();
  });

  it('keeps a bare envelope when the richer one is far apart in time', () => {
    const rich = toolEvent(
      { name: 'Read', id: 'rich', input: { file_path: 'a.ts' } },
      {
        timestamp: 1_000,
      },
    );
    const compact = toolEvent({ name: 'Read', id: 'compact' }, { timestamp: 100_000 });
    expect(buildAgentToolCalls([rich, compact], AGENT)).toHaveLength(2);
  });
});

describe('buildSnapshotToolCalls', () => {
  const receipt = (id: string, at: number) => ({
    id,
    name: 'Read',
    completedAt: at,
    ok: true,
  });

  it('returns nothing without receipts', () => {
    expect(buildSnapshotToolCalls(undefined, AGENT)).toEqual([]);
    expect(buildSnapshotToolCalls([], AGENT)).toEqual([]);
  });

  it('converts receipts into completed office calls', () => {
    const calls = buildSnapshotToolCalls(
      [receipt('r1', 1_000) as never, receipt('r2', 2_000) as never],
      AGENT,
      'sess_a',
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ agentId: AGENT, status: 'succeeded' });
  });
});

describe('buildSnapshotMailActivities', () => {
  const receipt = (id: string, at: number, direction: 'incoming' | 'outgoing') => ({
    id,
    direction,
    from: 'a',
    to: 'b',
    type: 'note',
    subject: `s-${id}`,
    at,
  });

  it('returns nothing without receipts', () => {
    expect(buildSnapshotMailActivities(undefined)).toEqual([]);
    expect(buildSnapshotMailActivities([])).toEqual([]);
  });

  it('marks incoming parcels unread and outgoing ones read', () => {
    const [incoming, outgoing] = buildSnapshotMailActivities([
      receipt('a', 2_000, 'incoming') as never,
      receipt('b', 1_000, 'outgoing') as never,
    ]);
    expect(incoming).toMatchObject({ unread: true });
    expect(outgoing).toMatchObject({ unread: false });
  });

  it('sorts newest first and caps the list at twelve', () => {
    const many = Array.from({ length: 20 }, (_, i) => receipt(`m${i}`, i * 1_000, 'incoming'));
    const out = buildSnapshotMailActivities(many as never);

    expect(out).toHaveLength(12);
    expect(out[0]?.id).toBe('m19');
  });
});

describe('synthesizeCurrentTool', () => {
  it.each([
    ['Read', 'Reading a file'],
    ['Write', 'Writing a file'],
    ['Edit', 'Updating code'],
    ['Bash', 'Running a command'],
    ['WebFetch', 'Working online'],
    ['Grep', 'Searching project'],
    ['remember', 'Checking memory'],
  ])('summarises a live %s as "%s"', (toolName, summary) => {
    expect(synthesizeCurrentTool(AGENT, toolName).summary).toBe(summary);
  });

  it('falls back to the raw tool name for an unclassified tool', () => {
    expect(synthesizeCurrentTool(AGENT, 'DoTheThing').summary).toBe('DoTheThing');
  });

  it('keys the placeholder so a repeat of the same tool collapses', () => {
    expect(synthesizeCurrentTool(AGENT, 'Read', 'sess_a')).toMatchObject({
      id: `${AGENT}:live:Read`,
      sessionId: 'sess_a',
    });
  });
});
