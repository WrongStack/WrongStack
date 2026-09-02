import { describe, expect, it } from 'vitest';
import {
  buildTranscriptFromEvents,
  type HqSessionSnapshotPayload,
  type HqTranscriptAppendPayload,
  mapSessionEventToEntries,
  parseHqEventPayload,
} from '../../src/hq/index.js';

describe('hq session telemetry protocol', () => {
  const validSnapshot: HqSessionSnapshotPayload = {
    sessionId: '2026-06-23/10-00-00Z_opus_ab12',
    clientKind: 'tui',
    machineId: 'mach-1',
    hostname: 'box.local',
    pid: 123,
    projectId: 'proj-1',
    projectName: 'demo',
    projectRoot: '/home/u/demo',
    gitBranch: 'main',
    status: 'active',
    startedAt: '2026-06-23T10:00:00.000Z',
    lastActivityAt: '2026-06-23T10:01:00.000Z',
    agentCount: 1,
    agents: [
      {
        id: 'leader',
        name: 'leader',
        startedAt: '2026-06-23T10:00:05.000Z',
        status: 'running',
        iterations: 2,
        toolCalls: 4,
        model: 'opus',
        ctxPct: 67,
        lastActivityAt: '2026-06-23T10:01:00.000Z',
      },
    ],
  };

  it('accepts a well-formed session.snapshot payload', () => {
    const r = parseHqEventPayload('session.snapshot', validSnapshot);
    expect(r.ok).toBe(true);
  });

  it('rejects a session.snapshot with an invalid status', () => {
    const r = parseHqEventPayload('session.snapshot', { ...validSnapshot, status: 'bogus' });
    expect(r.ok).toBe(false);
  });

  it('rejects a session.snapshot with a malformed agent', () => {
    const bad = { ...validSnapshot, agents: [{ id: 'x' }] };
    const r = parseHqEventPayload('session.snapshot', bad);
    expect(r.ok).toBe(false);
  });

  it('accepts a well-formed session.transcript payload', () => {
    const payload: HqTranscriptAppendPayload = {
      sessionId: 's1',
      fromSeq: 0,
      entries: [
        { ts: '2026-06-23T10:00:00.000Z', role: 'user', text: 'hi' },
        { ts: '2026-06-23T10:00:01.000Z', role: 'assistant', text: 'hello' },
      ],
    };
    expect(parseHqEventPayload('session.transcript', payload).ok).toBe(true);
  });

  it('rejects a session.transcript with a bad role', () => {
    const payload = {
      sessionId: 's1',
      fromSeq: 0,
      entries: [{ ts: 't', role: 'robot', text: 'x' }],
    };
    expect(parseHqEventPayload('session.transcript', payload).ok).toBe(false);
  });

  it('validates session.ended', () => {
    expect(parseHqEventPayload('session.ended', { sessionId: 's', endedAt: 't' }).ok).toBe(true);
    expect(parseHqEventPayload('session.ended', { sessionId: 's' }).ok).toBe(false);
  });
});

describe('transcript mapper', () => {
  it('maps user_input to a single user entry', () => {
    expect(mapSessionEventToEntries({ type: 'user_input', ts: 't', content: 'hello' })).toEqual([
      { ts: 't', role: 'user', text: 'hello' },
    ]);
  });

  it('extracts assistant text AND tool_use args from one llm_response (real on-disk shape)', () => {
    const out = mapSessionEventToEntries({
      type: 'llm_response',
      ts: 't',
      content: [
        { type: 'text', text: 'listing files' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: 'assistant', text: 'listing files' });
    expect(out[1]!.role).toBe('tool');
    expect(out[1]!.toolUseId).toBe('tu_1');
    expect(out[1]!.toolInput).toContain('ls');
    expect(out[1]!.text).toBe('');
  });

  it('surfaces thinking blocks as a thinking entry BEFORE the assistant text', () => {
    const out = mapSessionEventToEntries({
      type: 'llm_response',
      ts: 't',
      content: [
        { type: 'thinking', thinking: 'let me check the files' },
        { type: 'text', text: 'listing files' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      ],
    });
    expect(out.map((e) => e.role)).toEqual(['thinking', 'assistant', 'tool']);
    expect(out[0]!.text).toBe('let me check the files');
  });

  it('drops empty/whitespace thinking blocks', () => {
    const out = mapSessionEventToEntries({
      type: 'llm_response',
      ts: 't',
      content: [
        { type: 'thinking', thinking: '   ' },
        { type: 'text', text: 'hi' },
      ],
    });
    expect(out.map((e) => e.role)).toEqual(['assistant']);
  });

  it('accepts a session.transcript payload carrying a thinking entry', () => {
    const payload: HqTranscriptAppendPayload = {
      sessionId: 's1',
      fromSeq: 0,
      entries: [{ ts: 't', role: 'thinking', text: 'pondering' }],
    };
    expect(parseHqEventPayload('session.transcript', payload).ok).toBe(true);
  });

  it('merges a tool_result INTO the args entry — one box, chronological order', () => {
    const events = [
      { type: 'user_input', ts: 't0', content: 'run ls' },
      {
        type: 'llm_response',
        ts: 't1',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      { type: 'tool_result', ts: 't2', id: 'tu_1', content: 'a\nb', isError: false },
    ];
    const out = buildTranscriptFromEvents(events);
    // user, assistant, ONE merged tool box (args + result) — no trailing result.
    expect(out.map((e) => e.role)).toEqual(['user', 'assistant', 'tool']);
    const tool = out[2]!;
    expect(tool.toolInput).toContain('ls'); // args
    expect(tool.text).toContain('a'); // result, same box
  });

  it('keeps tool calls interleaved with assistant text (not grouped)', () => {
    const events = [
      {
        type: 'llm_response',
        ts: 't0',
        content: [{ type: 'tool_use', id: 'a', name: 'read', input: { path: 'x' } }],
      },
      { type: 'tool_result', ts: 't1', id: 'a', content: 'data' },
      { type: 'llm_response', ts: 't2', content: [{ type: 'text', text: 'now editing' }] },
      {
        type: 'llm_response',
        ts: 't3',
        content: [{ type: 'tool_use', id: 'b', name: 'write', input: { path: 'x' } }],
      },
      { type: 'tool_result', ts: 't4', id: 'b', content: 'ok' },
    ];
    const out = buildTranscriptFromEvents(events);
    expect(out.map((e) => e.role)).toEqual(['tool', 'assistant', 'tool']);
    expect(out[0]!.text).toContain('data');
    expect(out[1]!.text).toBe('now editing');
    expect(out[2]!.text).toContain('ok');
  });

  it('marks an errored tool_result as role error in the merged box', () => {
    const events = [
      {
        type: 'llm_response',
        ts: 't1',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'bash', input: { command: 'boom' } }],
      },
      { type: 'tool_result', ts: 't2', id: 'tu_2', content: 'failed', isError: true },
    ];
    const out = buildTranscriptFromEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('error');
    expect(out[0]!.isError).toBe(true);
    expect(out[0]!.toolInput).toContain('boom');
    expect(out[0]!.text).toContain('failed');
  });
});

describe('transcript mapper — audit markers', () => {
  it('renders the marker set with the same wording every other surface uses', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { type: 'compaction', ts: 't', before: 8_000, after: 2_000 },
        '⟲ context compacted: 8K → 2K tokens',
      ],
      [{ type: 'mode_changed', ts: 't', from: 'plan', to: 'build' }, 'mode: plan → build'],
      [{ type: 'skill_activated', ts: 't', skillName: 'commit' }, 'skill activated: commit'],
      [{ type: 'skill_deactivated', ts: 't', skillName: 'commit' }, 'skill deactivated: commit'],
      [
        { type: 'message_truncated', ts: 't', before: 900, after: 400 },
        'message truncated: 900 → 400 tokens',
      ],
      [
        {
          type: 'provider_retry',
          ts: 't',
          providerId: 'anthropic',
          attempt: 1,
          delayMs: 2_000,
          description: 'busy',
        },
        '⟳ retry 1 after 2.0s — busy',
      ],
    ];
    for (const [event, text] of cases) {
      const out = mapSessionEventToEntries(event);
      expect(out, `no entry for ${String(event['type'])}`).toHaveLength(1);
      expect(out[0]!.text).toBe(text);
      expect(out[0]!.role).toBe('system');
    }
  });

  it('routes error-level markers to the error role', () => {
    const out = mapSessionEventToEntries({
      type: 'provider_error',
      ts: 't',
      providerId: 'openai',
      status: 500,
      description: 'upstream',
      retryable: false,
    });
    expect(out[0]).toMatchObject({
      role: 'error',
      isError: true,
      text: 'provider error (HTTP 500, fatal): upstream',
    });
  });

  it('keeps subagent lifecycle markers out of the main transcript mapper', () => {
    expect(
      mapSessionEventToEntries({
        type: 'agent_spawned',
        ts: 't',
        agentId: 'agt_1',
        role: 'reviewer',
      }),
    ).toEqual([]);
    expect(mapSessionEventToEntries({ type: 'agent_stopped', ts: 't', agentId: 'agt_1' })).toEqual(
      [],
    );
    expect(
      mapSessionEventToEntries({ type: 'agent_error', ts: 't', agentId: 'agt_1', error: 'nope' }),
    ).toEqual([]);
  });

  it('skips checkpoints — one per prompt would restate the user message next to it', () => {
    expect(
      mapSessionEventToEntries({
        type: 'checkpoint',
        ts: 't',
        promptIndex: 0,
        promptPreview: 'hi',
      }),
    ).toEqual([]);
  });

  it('still ignores lifecycle bookkeeping events', () => {
    for (const type of ['session_start', 'in_flight_start', 'in_flight_end', 'file_snapshot']) {
      expect(mapSessionEventToEntries({ type, ts: 't' })).toEqual([]);
    }
  });

  it('keeps markers in chronological position within a full transcript', () => {
    const out = buildTranscriptFromEvents([
      { type: 'user_input', ts: 't1', content: 'hello' },
      { type: 'compaction', ts: 't2', before: 8_000, after: 2_000 },
      { type: 'llm_response', ts: 't3', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(out.map((e) => e.role)).toEqual(['user', 'system', 'assistant']);
  });
});
