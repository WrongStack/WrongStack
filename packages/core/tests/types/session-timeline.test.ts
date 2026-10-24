import type { Message } from '@wrongstack/contracts/types/messages';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import { CHAT_MARKER_SOURCES } from '@wrongstack/contracts/types/session-markers';
import {
  projectLastRequestTokens,
  projectSessionTimeline,
  projectSessionToolMeta,
  type SessionTimelineEntry,
} from '@wrongstack/contracts/types/session-timeline';
import { describe, expect, it } from 'vitest';

const kinds = (entries: SessionTimelineEntry[]): string[] => entries.map((e) => e.kind);

describe('projectSessionToolMeta', () => {
  it('projects tool_call_end records and prefers outputBytes over the legacy field', () => {
    const meta = projectSessionToolMeta([
      {
        type: 'tool_call_end',
        ts: 't',
        name: 'read',
        id: 'tu-1',
        durationMs: 12,
        outputSize: 100,
        outputBytes: 250,
        ok: true,
      },
      { type: 'user_input', ts: 't', content: 'ignored' },
    ] as SessionEvent[]);

    expect(meta).toEqual([
      {
        id: 'tu-1',
        name: 'read',
        durationMs: 12,
        outputBytes: 250,
        outputTokens: undefined,
        outputLines: undefined,
        ok: true,
        agentId: undefined,
      },
    ]);
  });

  it('falls back to outputSize on journals written before outputBytes existed', () => {
    const [meta] = projectSessionToolMeta([
      { type: 'tool_call_end', ts: 't', name: 'grep', id: 'x', durationMs: 1, outputSize: 42 },
    ] as SessionEvent[]);
    expect(meta?.outputBytes).toBe(42);
  });

  it('carries the writer-stamped agentId so subagent tool calls stay attributable', () => {
    const [meta] = projectSessionToolMeta([
      {
        type: 'tool_call_end',
        ts: 't',
        name: 'bash',
        id: 'x',
        durationMs: 1,
        outputSize: 0,
        agentId: 'scout',
      },
    ] as SessionEvent[]);
    expect(meta?.agentId).toBe('scout');
  });
});

describe('projectSessionTimeline — conversation backbone', () => {
  it('separates host notes from authored text while retaining them for collapsed inspection', () => {
    const timeline = projectSessionTimeline({
      messages: [
        {
          role: 'user',
          origin: 'user_input',
          authoredLength: 1,
          content: [
            { type: 'text', text: 'Please fix the layout' },
            {
              type: 'text',
              text: '[TOOL COACH — inspect before changing]\nRead the component first.',
            },
            {
              type: 'text',
              text: '[Same-session notes — in-process, not mailbox. Fold into the current task;\ndo not restart unless a steer contradicts the goal.]\nReviewer note',
            },
          ],
        },
      ],
    });
    expect(timeline).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: 'Please fix the layout',
        runtimeContext: [
          expect.stringContaining('TOOL COACH'),
          expect.stringContaining('Same-session notes'),
        ],
      }),
    ]);
  });
  it('keeps runtime-only notes out of user bubbles and preserves tool results', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'read', name: 'read_file', input: {} }],
      },
      {
        role: 'user',
        origin: 'runtime',
        authoredLength: 0,
        content: [
          { type: 'tool_result', tool_use_id: 'read', content: 'source code' },
          { type: 'text', text: '[TOOL COACH — verification phase]\nCheck the result.' },
        ],
      },
    ];
    const timeline = projectSessionTimeline({ messages, runtimeContextEntries: true });
    expect(timeline.filter((entry) => entry.kind === 'user')).toEqual([]);
    expect(timeline[0]).toMatchObject({ kind: 'tool', output: 'source code' });
    expect(timeline[1]).toMatchObject({
      kind: 'system',
      runtimeContext: [expect.stringContaining('TOOL COACH')],
    });
    // Surfaces that do not render runtimeContext get no empty "Runtime context" note.
    expect(projectSessionTimeline({ messages }).map((entry) => entry.kind)).toEqual(['tool']);
  });
  it('recognizes older host blocks without deleting an explicitly authored discussion of their markers', () => {
    const timeline = projectSessionTimeline({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Fix this' },
            { type: 'text', text: '[TOOL COACH — advisory guidance]\nInspect tools' },
          ],
        },
        {
          role: 'user',
          origin: 'user_input',
          authoredLength: 1,
          content: [
            {
              type: 'text',
              text: '[TOOL COACH — advisory guidance] is the marker I want to discuss',
            },
          ],
        },
      ],
    });
    expect(timeline[0]).toMatchObject({
      text: 'Fix this',
      runtimeContext: [expect.stringContaining('Inspect tools')],
    });
    expect(timeline[1]).toMatchObject({
      kind: 'user',
      text: '[TOOL COACH — advisory guidance] is the marker I want to discuss',
    });
  });
  it('walks content blocks in order so prose after a tool stays after it', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        ts: '2026-01-01T00:00:00Z',
        content: [
          { type: 'text', text: 'before' },
          { type: 'tool_use', id: 'tu-1', name: 'read', input: {} },
          { type: 'text', text: 'after' },
        ],
      },
    ];
    expect(kinds(projectSessionTimeline({ messages }))).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('marks only tool-free assistant messages as final', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        ts: 'a',
        content: [
          { type: 'text', text: 'thinking out loud' },
          { type: 'tool_use', id: 'tu-1', name: 'read', input: {} },
        ],
      },
      { role: 'assistant', ts: 'b', content: 'done' },
    ];
    const entries = projectSessionTimeline({ messages });
    const assistants = entries.filter((e) => e.kind === 'assistant');
    expect(assistants.map((e) => (e as { final: boolean }).final)).toEqual([false, true]);
  });

  it('pairs a tool_result into the tool entry it belongs to', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        ts: 'a',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'read', input: { path: 'x' } }],
      },
      {
        role: 'user',
        ts: 'b',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'body', is_error: false }],
      },
    ];
    const entries = projectSessionTimeline({ messages });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', name: 'read', output: 'body', ok: true });
  });

  it('leaves ok undefined for a call the journal never resolved', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        ts: 'a',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'bash', input: {} }],
      },
    ];
    const [entry] = projectSessionTimeline({ messages });
    // NOT `false`: an interrupted call is not a failed one, and reporting it
    // as failed is what the SimpleUI replay used to do.
    expect((entry as { ok?: boolean }).ok).toBeUndefined();
  });

  it('enriches tool entries from tool_call_end metadata', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        ts: 'a',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'read', input: {} }],
      },
    ];
    const events = [
      {
        type: 'tool_call_end',
        ts: 'a',
        name: 'read',
        id: 'tu-1',
        durationMs: 90,
        outputSize: 10,
        outputBytes: 10,
        outputTokens: 3,
        outputLines: 2,
        ok: true,
      },
    ] as SessionEvent[];
    expect(projectSessionTimeline({ messages, events })[0]).toMatchObject({
      kind: 'tool',
      durationMs: 90,
      outputBytes: 10,
      outputTokens: 3,
      outputLines: 2,
      ok: true,
    });
  });

  it('accepts pre-projected toolMeta, as the wire delivers it', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        ts: 'a',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'read', input: {} }],
      },
    ];
    expect(
      projectSessionTimeline({ messages, toolMeta: [{ id: 'tu-1', durationMs: 7 }] })[0],
    ).toMatchObject({ kind: 'tool', durationMs: 7 });
  });

  it('renders an orphan tool_result rather than dropping the evidence', () => {
    const messages: Message[] = [
      {
        role: 'user',
        ts: 'a',
        content: [{ type: 'tool_result', tool_use_id: 'tu-gone', content: 'r', is_error: true }],
      },
    ];
    expect(projectSessionTimeline({ messages })[0]).toMatchObject({
      kind: 'tool',
      name: 'tu-gone',
      ok: false,
    });
  });

  it('hides system-injected runtime messages by default and keeps them on request', () => {
    const messages: Message[] = [
      { role: 'system', ts: 'a', content: '[MAILBOX] you have 2 messages' },
      { role: 'user', ts: 'b', content: 'hello' },
    ];
    expect(kinds(projectSessionTimeline({ messages }))).toEqual(['user']);
    expect(kinds(projectSessionTimeline({ messages, hideSystemInjections: false }))).toEqual([
      'system',
      'user',
    ]);
  });

  it('carries image blocks on the prompt they were attached to', () => {
    const messages: Message[] = [
      {
        role: 'user',
        ts: 'a',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        ],
      },
    ];
    const [entry] = projectSessionTimeline({ messages });
    expect(entry).toMatchObject({ kind: 'user', text: 'what is this?' });
    expect((entry as { images?: unknown[] }).images).toEqual([
      { mediaType: 'image/png', data: 'AAA', url: undefined },
    ]);
  });

  it('gives an image-only prompt an entry of its own', () => {
    const messages: Message[] = [
      {
        role: 'user',
        ts: 'a',
        content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
      },
    ];
    const [entry] = projectSessionTimeline({ messages });
    expect(entry).toMatchObject({ kind: 'user', text: '' });
    expect((entry as { images?: unknown[] }).images).toHaveLength(1);
  });
});

describe('projectSessionTimeline — thinking placement', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      ts: 'a',
      content: [
        { type: 'thinking', thinking: 'step one' },
        { type: 'thinking', thinking: 'step two' },
        { type: 'text', text: 'answer' },
      ],
    },
  ];

  it('inline: one entry per block, before the prose', () => {
    const entries = projectSessionTimeline({ messages, thinkingPlacement: 'inline' });
    expect(kinds(entries)).toEqual(['thinking', 'thinking', 'assistant']);
    expect(entries.map((e) => (e.kind === 'thinking' ? e.index : null))).toEqual([1, 2, null]);
  });

  it('merged-after: one joined entry, after the prose', () => {
    const entries = projectSessionTimeline({ messages, thinkingPlacement: 'merged-after' });
    expect(kinds(entries)).toEqual(['assistant', 'thinking']);
    expect((entries[1] as { text: string }).text).toBe('step one\n\nstep two');
  });

  it('drops whitespace-only thinking in both placements', () => {
    const blank: Message[] = [
      { role: 'assistant', ts: 'a', content: [{ type: 'thinking', thinking: '   ' }] },
    ];
    expect(kinds(projectSessionTimeline({ messages: blank }))).toEqual([]);
    expect(
      kinds(projectSessionTimeline({ messages: blank, thinkingPlacement: 'merged-after' })),
    ).toEqual([]);
  });
});

describe('projectSessionTimeline — marker merge', () => {
  const messages: Message[] = [
    { role: 'user', ts: '2026-01-01T00:00:00Z', content: 'first' },
    { role: 'assistant', ts: '2026-01-01T00:00:10Z', content: 'reply' },
  ];

  it('inserts markers at their chronological position without reordering turns', () => {
    const events = [
      { type: 'compaction', ts: '2026-01-01T00:00:05Z', before: 100_000, after: 40_000 },
    ] as SessionEvent[];
    expect(kinds(projectSessionTimeline({ messages, events }))).toEqual([
      'user',
      'marker',
      'assistant',
    ]);
  });

  it('keeps the backbone entry first on a timestamp tie', () => {
    const events = [
      { type: 'compaction', ts: '2026-01-01T00:00:00Z', before: 1000, after: 500 },
    ] as SessionEvent[];
    expect(kinds(projectSessionTimeline({ messages, events }))).toEqual([
      'user',
      'marker',
      'assistant',
    ]);
  });

  it('appends markers that outlive the conversation', () => {
    const events = [
      { type: 'compaction', ts: '2026-01-01T09:00:00Z', before: 1000, after: 500 },
    ] as SessionEvent[];
    expect(kinds(projectSessionTimeline({ messages, events }))).toEqual([
      'user',
      'assistant',
      'marker',
    ]);
  });

  it('honours a restricted marker source set', () => {
    const events = [
      { type: 'checkpoint', ts: '2026-01-01T00:00:05Z', promptIndex: 1, promptPreview: 'first' },
    ] as SessionEvent[];
    expect(kinds(projectSessionTimeline({ messages, events }))).toContain('marker');
    // `checkpoint` is deliberately absent from the chat set — one is written
    // per prompt, so a chat transcript would restate every user message.
    expect(
      kinds(projectSessionTimeline({ messages, events, markerSources: CHAT_MARKER_SOURCES })),
    ).toEqual(['user', 'assistant']);
  });

  it('accepts pre-projected markers and ignores markerSources for them', () => {
    const entries = projectSessionTimeline({
      messages,
      markers: [
        {
          ts: '2026-01-01T00:00:05Z',
          source: 'agent_spawned',
          level: 'info',
          text: 'spawned as reviewer',
          agentId: 'scout',
        },
      ],
      markerSources: CHAT_MARKER_SOURCES,
    });
    expect(kinds(entries)).toEqual(['user', 'marker', 'assistant']);
    expect(entries[1]).toMatchObject({ source: 'agent_spawned', agentId: 'scout' });
  });
});

/**
 * How full is the window? — answered from the journal.
 *
 * Every resume path used to answer it with `SessionData.usage.input`, the sum
 * of every request the session ever made. On a long conversation that reported
 * millions of tokens against a window measured in hundreds of thousands, and
 * the fill bar drew it faithfully.
 */
describe('projectLastRequestTokens', () => {
  const response = (ts: string, usage: { input: number; cacheRead?: number }): SessionEvent =>
    ({
      type: 'llm_response',
      ts,
      content: [],
      stopReason: 'end_turn',
      usage: { output: 10, ...usage },
    }) as SessionEvent;

  it('reads the LAST response, never the sum of every one before it', () => {
    const events: SessionEvent[] = [
      response('t1', { input: 100_000 }),
      response('t2', { input: 150_000 }),
      response('t3', { input: 180_000 }),
    ];

    expect(projectLastRequestTokens(events)).toBe(180_000);
  });

  it('counts the whole prompt the model loaded, cache included', () => {
    expect(projectLastRequestTokens([response('t1', { input: 2_000, cacheRead: 118_000 })])).toBe(
      120_000,
    );
  });

  it('scans past everything that is not a response', () => {
    const events: SessionEvent[] = [
      response('t1', { input: 90_000 }),
      { type: 'tool_call_start', ts: 't2', name: 'read', id: 'tu-1', input: {} } as SessionEvent,
      { type: 'user_input', ts: 't3', content: 'hi' } as SessionEvent,
    ];

    expect(projectLastRequestTokens(events)).toBe(90_000);
  });

  it('is undefined when the session never reached the model', () => {
    // Deliberately not 0: the caller must leave the estimate UNSET, because a
    // published zero draws an authoritative "0% full" instead of nothing.
    expect(projectLastRequestTokens([])).toBeUndefined();
    expect(projectLastRequestTokens(undefined)).toBeUndefined();
    expect(projectLastRequestTokens([response('t1', { input: 0 })])).toBeUndefined();
  });
});
