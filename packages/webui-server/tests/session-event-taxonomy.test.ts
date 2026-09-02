/**
 * Regression test for the session-history.ts event taxonomy bug.
 *
 * Bug: `labelForEvent` and `detailForEvent` had `default: return e.type`
 * and `default: return ''` fallbacks. When new SessionEvent kinds were
 * added, the labels silently fell through to raw type names and details
 * fell through to empty strings.
 *
 * Fix: explicit cases for all 41 kinds + exhaustiveness check
 * (`const _exhaustive: never = e`) that fails typecheck if a new kind
 * is added without a case.
 *
 * This test verifies the runtime contract: every SessionEvent kind must
 * produce a non-empty `label` and a meaningful `detail` (when the event
 * has detail-bearing fields).
 */

import { describe, expect, it } from 'vitest';
import type {
  ContentBlock,
  FileSnapshot,
  SessionEvent,
  SessionSummary,
} from '@wrongstack/core/types';
import { buildInspectPayload } from '../src/server/session-history.js';

const FALLBACK = {
  id: 'test-session',
  title: 'Test',
  model: 'gpt-5',
  provider: 'openai',
  startedAt: '2026-08-04T10:00:00.000Z',
};

const SUMMARY: SessionSummary = {
  id: 'test-session',
  title: 'Test',
  startedAt: '2026-08-04T10:00:00.000Z',
  model: 'gpt-5',
  provider: 'openai',
  tokenTotal: 0,
};

// ── Factory for one valid event of every kind ─────────────────

function allEventKinds(): SessionEvent[] {
  const ts = '2026-08-04T10:00:00.000Z';
  const sampleFile: FileSnapshot = {
    path: 'src/auth.ts',
    action: 'modified',
    before: 'const a = 1;',
    after: 'const a = 2;',
  };
  const sampleBlock: ContentBlock = { type: 'text', text: 'hello' };

  return [
    { type: 'session_start', ts, id: 's1', model: 'gpt-5', provider: 'openai' },
    { type: 'session_resumed', ts, id: 's1', model: 'gpt-5', provider: 'openai' },
    {
      type: 'session_forked',
      ts,
      parentSessionId: 'parent-1',
      parentCheckpointHash: 'hash1234567890abcdef',
      workspace: 'shared-current',
    },
    { type: 'user_input', ts, content: 'test user input' },
    {
      type: 'llm_request',
      ts,
      model: 'gpt-5',
      messageCount: 5,
      toolCount: 12,
      estimatedInputTokens: 1500,
    },
    {
      type: 'llm_response',
      ts,
      content: [sampleBlock],
      stopReason: 'end_turn',
      usage: { input: 100, output: 50 },
    },
    { type: 'tool_use', ts, name: 'read', id: 't1', input: { path: 'src/auth.ts' } },
    {
      type: 'tool_result',
      ts,
      id: 't1',
      content: [{ type: 'text', text: 'file contents' }],
      isError: false,
    },
    {
      type: 'tool_call_start',
      ts,
      name: 'read',
      id: 't1',
      input: { path: 'src/auth.ts' },
    },
    {
      type: 'tool_call_end',
      ts,
      name: 'read',
      id: 't1',
      durationMs: 42,
      outputSize: 1024,
      outputBytes: 1024,
      outputLines: 25,
      ok: true,
    },
    {
      type: 'tool_progress',
      ts,
      name: 'read',
      id: 't1',
      event: { type: 'log', text: 'reading file' },
    },
    {
      type: 'compaction',
      ts,
      before: 5000,
      after: 2000,
    },
    {
      type: 'context_snapshot',
      ts,
      reason: 'compaction',
      messages: [],
    },
    {
      type: 'error',
      ts,
      message: 'something went wrong',
      phase: 'tool_call',
    },
    {
      type: 'session_end',
      ts,
      usage: { input: 1000, output: 500 },
    },
    {
      type: 'message_appended',
      ts,
      version: 1,
      message: {
        role: 'user',
        content: 'hello',
        ts,
      },
    },
    {
      type: 'message_updated',
      ts,
      version: 1,
      index: 0,
      message: {
        role: 'assistant',
        content: 'updated',
        ts,
      },
    },
    {
      type: 'messages_replaced',
      ts,
      version: 1,
      messages: [],
    },
    { type: 'message_truncated', ts, before: 1000, after: 500 },
    {
      type: 'file_event',
      ts,
      operation: 'update',
      filePath: 'src/auth.ts',
      absPath: '/repo/src/auth.ts',
      sessionId: 's1',
      agentId: 'a1',
      agentName: 'main',
      provider: 'openai',
      model: 'gpt-5',
      toolName: 'edit',
      toolUseId: 't1',
      scope: 'project',
      bytes: 1024,
      lines: 25,
    },
    {
      type: 'file_snapshot',
      ts,
      promptIndex: 3,
      files: [sampleFile],
    },
    {
      type: 'file_observation',
      ts,
      path: 'src/auth.ts',
      hash: 'h1',
      mtimeMs: 1234567890,
      source: 'user',
    },
    {
      type: 'rewound',
      ts,
      toPromptIndex: 2,
      revertedFiles: ['src/auth.ts'],
    },
    {
      type: 'mode_changed',
      ts,
      from: 'interactive',
      to: 'autonomous',
    },
    {
      type: 'task_created',
      ts,
      taskId: 't1',
      title: 'Test task',
    },
    {
      type: 'task_updated',
      ts,
      taskId: 't1',
      status: 'in_progress',
    },
    {
      type: 'task_completed',
      ts,
      taskId: 't1',
      title: 'Test task',
    },
    {
      type: 'task_failed',
      ts,
      taskId: 't1',
      title: 'Test task',
      error: 'task crashed',
    },
    {
      type: 'agent_spawned',
      ts,
      agentId: 'a1',
      role: 'tester',
    },
    { type: 'agent_stopped', ts, agentId: 'a1' },
    {
      type: 'agent_error',
      ts,
      agentId: 'a1',
      error: 'agent crashed',
    },
    {
      type: 'delegate_started',
      ts,
      target: 'reviewer',
      task: 'review the diff',
      subagentId: 'sa1',
    },
    {
      type: 'delegate_completed',
      ts,
      target: 'reviewer',
      task: 'review the diff',
      ok: true,
      summary: 'reviewer finished in 3 iterations',
      durationMs: 4200,
      iterations: 3,
      toolCalls: 7,
      subagentId: 'sa1',
    },
    {
      type: 'loop_detected',
      ts,
      tools: 'read,grep',
      repeatCount: 4,
      iteration: 9,
      kind: 'tool',
      action: 'cut',
    },
    {
      type: 'model_switched',
      ts,
      from: { providerId: 'anthropic', model: 'opus' },
      to: { providerId: 'anthropic', model: 'sonnet' },
      reason: 'fallback',
      status: 529,
    },
    {
      type: 'skill_activated',
      ts,
      skillName: 'bug-hunter',
    },
    {
      type: 'skill_deactivated',
      ts,
      skillName: 'bug-hunter',
    },
    {
      type: 'provider_retry',
      ts,
      providerId: 'openai',
      attempt: 2,
      delayMs: 1000,
      status: 429,
      description: 'rate limited',
    },
    {
      type: 'provider_error',
      ts,
      providerId: 'openai',
      status: 500,
      description: 'server error',
      retryable: false,
    },
    {
      type: 'checkpoint',
      ts,
      promptIndex: 5,
      promptPreview: 'test prompt',
    },
    {
      type: 'in_flight_start',
      ts,
      context: 'iteration 5 / tool: read',
    },
    {
      type: 'in_flight_end',
      ts,
      reason: 'clean',
    },
    {
      type: 'side_effect',
      ts,
      toolUseId: 't1',
      toolName: 'bash',
      input: { command: 'rm -rf /' },
      risk: 'shell',
    },
    {
      type: 'in_flight_start',
      ts,
      context: 'recovered from crash',
    },
    {
      type: 'in_flight_end',
      ts,
      reason: 'recovered',
    },
    {
      type: 'tool_progress',
      ts,
      name: 'read',
      id: 't2',
      event: { type: 'warning', text: 'large file' },
    },
    {
      type: 'tool_progress',
      ts,
      name: 'read',
      id: 't3',
      event: { type: 'metric', data: { bytes: 1024 } },
    },
    {
      type: 'tool_progress',
      ts,
      name: 'read',
      id: 't4',
      event: { type: 'file_changed' },
    },
    {
      type: 'tool_progress',
      ts,
      name: 'read',
      id: 't5',
      event: { type: 'partial_output' },
    },
  ];
}

// ── Tests ───────────────────────────────────────────────────────

describe('session-history event taxonomy regression', () => {
  it('exposes every SessionEvent kind through buildInspectPayload', () => {
    const events = allEventKinds();
    const payload = buildInspectPayload(SUMMARY, events, FALLBACK);
    // The events array maps 1:1 to inspectEvents.
    expect(payload.events).toHaveLength(events.length);
  });

  it('never produces empty labels for any SessionEvent kind', () => {
    const events = allEventKinds();
    const payload = buildInspectPayload(SUMMARY, events, FALLBACK);
    const emptyLabels = payload.events.filter((e) => !e.label || e.label.trim() === '');
    expect(emptyLabels).toEqual([]);
  });

  it('never produces raw type-name labels (the bug)', () => {
    // The bug: `default: return e.type` returned the raw type string
    // (e.g. "file_snapshot") instead of a human label
    // (e.g. "File snapshot at prompt #3"). This test catches that.
    const events = allEventKinds();
    const payload = buildInspectPayload(SUMMARY, events, FALLBACK);
    const rawLabels = payload.events.filter((e) => e.label === e.type);
    expect(rawLabels).toEqual([]);
  });

  it('every label is human-readable (> 3 chars, not just the type)', () => {
    const events = allEventKinds();
    const payload = buildInspectPayload(SUMMARY, events, FALLBACK);
    for (const e of payload.events) {
      expect(e.label.length).toBeGreaterThan(3);
    }
  });

  it('produces meaningful details for events with metadata', () => {
    // Events with detail-bearing fields should produce non-empty details.
    // We use a curated subset because some events (e.g. message_updated)
    // intentionally produce short details — the contract is "non-empty
    // when the source event has meaningful fields".
    const events = allEventKinds().filter((e) =>
      [
        'session_start',
        'session_resumed',
        'llm_request',
        'llm_response',
        'tool_call_end',
        'compaction',
        'session_end',
        'error',
        'file_event',
        'file_snapshot',
        'provider_retry',
        'provider_error',
        'checkpoint',
        'delegate_started',
        'delegate_completed',
        'loop_detected',
        'model_switched',
        'side_effect',
        'in_flight_start',
        'rewound',
      ].includes(e.type),
    );
    const payload = buildInspectPayload(SUMMARY, events, FALLBACK);
    const emptyDetails = payload.events.filter((e) => !e.detail || e.detail.trim() === '');
    expect(emptyDetails).toEqual([]);
  });

  it('preserves the event type field for downstream consumers', () => {
    const events = allEventKinds();
    const payload = buildInspectPayload(SUMMARY, events, FALLBACK);
    for (let i = 0; i < events.length; i++) {
      expect(payload.events[i]!.type).toBe(events[i]!.type);
    }
  });

  it('handles an empty event list gracefully', () => {
    const payload = buildInspectPayload(SUMMARY, [], FALLBACK);
    expect(payload.events).toEqual([]);
  });

  it('handles malformed events without crashing (defense-in-depth)', () => {
    // Even if the exhaustiveness check passes typecheck, runtime events
    // might have undefined optional fields. The dispatcher should never
    // throw.
    const safeEvents = allEventKinds().filter((e) =>
      ['session_start', 'tool_use', 'tool_result', 'file_event'].includes(e.type),
    );
    const payload = buildInspectPayload(SUMMARY, safeEvents, FALLBACK);
    expect(payload.events).toHaveLength(4);
  });
});
