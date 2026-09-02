import { describe, expect, it } from 'vitest';
import {
  CHAT_MARKER_SOURCES,
  projectSessionMarkers,
  SESSION_MARKER_EVENT_TYPES,
  sessionEventToMarker,
} from '../../src/types/session-markers.js';
import type { SessionEvent } from '../../src/types/session.js';

const TS = '2026-07-25T10:00:00.000Z';

describe('sessionEventToMarker', () => {
  it('formats a compaction with level and per-phase reductions', () => {
    const marker = sessionEventToMarker({
      type: 'compaction',
      ts: TS,
      before: 120_000,
      after: 48_000,
      level: 'soft',
      reductions: [
        { phase: 'elision', saved: 40_000 },
        { phase: 'summary', saved: 32_000 },
      ],
    });
    expect(marker).toEqual({
      ts: TS,
      source: 'compaction',
      level: 'info',
      text: '⟲ context compacted (soft): 120K → 48K tokens [elision: −40000, summary: −32000]',
    });
  });

  it('omits the level suffix and the reduction list when absent', () => {
    const marker = sessionEventToMarker({
      type: 'compaction',
      ts: TS,
      before: 10_000,
      after: 4_000,
    });
    expect(marker?.text).toBe('⟲ context compacted: 10K → 4K tokens');
  });

  it('prefixes an error with its phase', () => {
    expect(
      sessionEventToMarker({ type: 'error', ts: TS, message: 'boom', phase: 'provider' }),
    ).toEqual({ ts: TS, source: 'error', level: 'error', text: '[provider] boom' });
  });

  it('drops the phase prefix when the phase is empty', () => {
    expect(sessionEventToMarker({ type: 'error', ts: TS, message: 'boom', phase: '' })?.text).toBe(
      'boom',
    );
  });

  it('renders a provider retry as a warning, with sub-second precision under 1s', () => {
    expect(
      sessionEventToMarker({
        type: 'provider_retry',
        ts: TS,
        providerId: 'anthropic',
        attempt: 2,
        delayMs: 500,
        status: 429,
        description: 'rate limited',
      }),
    ).toEqual({
      ts: TS,
      source: 'provider_retry',
      level: 'warn',
      text: '⟳ retry 2 (HTTP 429) after 0.50s — rate limited',
    });
  });

  it('omits the HTTP status from a retry when the transport reported none', () => {
    expect(
      sessionEventToMarker({
        type: 'provider_retry',
        ts: TS,
        providerId: 'anthropic',
        attempt: 1,
        delayMs: 2_000,
        description: 'socket hang up',
      })?.text,
    ).toBe('⟳ retry 1 after 2.0s — socket hang up');
  });

  it('marks a provider error with its retryability', () => {
    expect(
      sessionEventToMarker({
        type: 'provider_error',
        ts: TS,
        providerId: 'openai',
        status: 500,
        description: 'upstream',
        retryable: true,
      }),
    ).toEqual({
      ts: TS,
      source: 'provider_error',
      level: 'error',
      text: 'provider error (HTTP 500, retryable): upstream',
    });
  });

  it('truncates a long checkpoint preview to 60 characters', () => {
    const preview = 'x'.repeat(80);
    expect(
      sessionEventToMarker({ type: 'checkpoint', ts: TS, promptIndex: 3, promptPreview: preview })
        ?.text,
    ).toBe(`✓ checkpoint #3: "${'x'.repeat(60)}"`);
  });

  it('carries agentId on the subagent lifecycle markers', () => {
    expect(
      sessionEventToMarker({ type: 'agent_spawned', ts: TS, agentId: 'agt_123', role: 'reviewer' }),
    ).toEqual({
      ts: TS,
      source: 'agent_spawned',
      level: 'info',
      text: 'spawned as reviewer',
      agentId: 'agt_123',
    });
    expect(
      sessionEventToMarker({ type: 'agent_stopped', ts: TS, agentId: 'agt_123' }),
    ).toMatchObject({ level: 'info', text: 'stopped', agentId: 'agt_123' });
    expect(
      sessionEventToMarker({
        type: 'agent_error',
        ts: TS,
        agentId: 'agt_123',
        error: 'x'.repeat(100),
      }),
    ).toMatchObject({ level: 'error', text: `error: ${'x'.repeat(80)}`, agentId: 'agt_123' });
  });

  it('formats mode and skill transitions', () => {
    expect(
      sessionEventToMarker({ type: 'mode_changed', ts: TS, from: 'plan', to: 'build' })?.text,
    ).toBe('mode: plan → build');
    expect(
      sessionEventToMarker({ type: 'skill_activated', ts: TS, skillName: 'commit' })?.text,
    ).toBe('skill activated: commit');
    expect(
      sessionEventToMarker({ type: 'skill_deactivated', ts: TS, skillName: 'commit' })?.text,
    ).toBe('skill deactivated: commit');
  });

  it('reports truncation as a before→after transition, or a cap when it did not shrink', () => {
    expect(
      sessionEventToMarker({ type: 'message_truncated', ts: TS, before: 900, after: 400 }),
    ).toEqual({
      ts: TS,
      source: 'message_truncated',
      level: 'warn',
      text: 'message truncated: 900 → 400 tokens',
    });
    expect(
      sessionEventToMarker({ type: 'message_truncated', ts: TS, before: 400, after: 400 })?.text,
    ).toBe('message truncated at 400 tokens');
  });

  it('returns null for conversation-bearing and lifecycle events', () => {
    const nonMarkers: SessionEvent[] = [
      { type: 'user_input', ts: TS, content: 'hi' },
      { type: 'session_start', ts: TS, id: 's', model: 'm', provider: 'p' },
      { type: 'in_flight_start', ts: TS, context: 'iteration 0' },
      { type: 'file_snapshot', ts: TS, promptIndex: 0, files: [] },
    ];
    for (const ev of nonMarkers) expect(sessionEventToMarker(ev)).toBeNull();
  });
});

describe('marker source sets', () => {
  it('excludes checkpoint from the chat subset but keeps it in the full set', () => {
    expect(SESSION_MARKER_EVENT_TYPES.has('checkpoint')).toBe(true);
    expect(CHAT_MARKER_SOURCES.has('checkpoint')).toBe(false);
  });

  it('excludes subagent and delegation lifecycle from the chat subset', () => {
    for (const type of [
      'agent_spawned',
      'agent_session_linked',
      'agent_stopped',
      'agent_error',
      'delegate_started',
      'delegate_completed',
    ] as const) {
      expect(SESSION_MARKER_EVENT_TYPES.has(type)).toBe(true);
      expect(CHAT_MARKER_SOURCES.has(type)).toBe(false);
    }
  });

  it('otherwise holds exactly the same sources', () => {
    const chatOnly = [...SESSION_MARKER_EVENT_TYPES].filter(
      (t) =>
        t !== 'checkpoint' &&
        t !== 'agent_spawned' &&
        t !== 'agent_session_linked' &&
        t !== 'agent_stopped' &&
        t !== 'agent_error' &&
        t !== 'delegate_started' &&
        t !== 'delegate_completed',
    );
    expect([...CHAT_MARKER_SOURCES].sort()).toEqual(chatOnly.sort());
  });

  it('never claims a conversation-bearing event', () => {
    for (const type of ['user_input', 'llm_response', 'tool_use', 'tool_result'] as const) {
      expect(SESSION_MARKER_EVENT_TYPES.has(type)).toBe(false);
    }
  });
});

describe('projectSessionMarkers', () => {
  const events: SessionEvent[] = [
    { type: 'user_input', ts: '2026-07-25T10:00:00.000Z', content: 'hi' },
    { type: 'checkpoint', ts: '2026-07-25T10:00:01.000Z', promptIndex: 0, promptPreview: 'hi' },
    { type: 'mode_changed', ts: '2026-07-25T10:00:02.000Z', from: 'plan', to: 'build' },
    { type: 'compaction', ts: '2026-07-25T10:00:03.000Z', before: 8_000, after: 2_000 },
  ];

  it('keeps JSONL order and skips non-marker events', () => {
    expect(projectSessionMarkers(events).map((m) => m.source)).toEqual([
      'checkpoint',
      'mode_changed',
      'compaction',
    ]);
  });

  it('honours a restricted source set', () => {
    expect(projectSessionMarkers(events, CHAT_MARKER_SOURCES).map((m) => m.source)).toEqual([
      'mode_changed',
      'compaction',
    ]);
  });

  it('returns an empty array for an event stream with no markers', () => {
    expect(projectSessionMarkers([{ type: 'user_input', ts: TS, content: 'hi' }])).toEqual([]);
  });
});
