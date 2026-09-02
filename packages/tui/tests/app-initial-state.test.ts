import type { Message, SessionEvent } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  buildRestoredCheckpoints,
  buildRestoredEntries,
  createInitialState,
  type RestoredToolCall,
} from '../src/app-initial-state.js';

function checkpoint(promptIndex: number, promptPreview: string): SessionEvent {
  return {
    type: 'checkpoint',
    ts: `2026-07-05T10:00:0${promptIndex}.000Z`,
    promptIndex,
    promptPreview,
  } as SessionEvent;
}

describe('buildRestoredCheckpoints', () => {
  it('returns an empty list without events', () => {
    expect(buildRestoredCheckpoints(undefined)).toEqual([]);
    expect(buildRestoredCheckpoints([])).toEqual([]);
  });

  it('rebuilds checkpoints from a resumed session so /rewind has targets', () => {
    const restored = buildRestoredCheckpoints([
      checkpoint(0, 'first prompt'),
      { type: 'user_input', ts: '2026-07-05T10:00:01.000Z', content: 'noise' } as SessionEvent,
      checkpoint(1, 'second prompt'),
    ]);

    expect(restored).toEqual([
      {
        promptIndex: 0,
        promptPreview: 'first prompt',
        ts: '2026-07-05T10:00:00.000Z',
        fileCount: 0,
      },
      {
        promptIndex: 1,
        promptPreview: 'second prompt',
        ts: '2026-07-05T10:00:01.000Z',
        fileCount: 0,
      },
    ]);
  });

  it('keeps the last write per promptIndex and sorts ascending', () => {
    const restored = buildRestoredCheckpoints([
      checkpoint(2, 'later'),
      checkpoint(1, 'earlier'),
      { ...checkpoint(2, 'rewritten after a rewind') } as SessionEvent,
    ]);

    expect(restored.map((c) => c.promptIndex)).toEqual([1, 2]);
    expect(restored[1]?.promptPreview).toBe('rewritten after a rewind');
  });

  it('derives fileCount from the file_snapshot events that follow each checkpoint', () => {
    const snapshot = (promptIndex: number, paths: string[]): SessionEvent =>
      ({
        type: 'file_snapshot',
        ts: `2026-07-05T10:00:1${promptIndex}.000Z`,
        promptIndex,
        files: paths.map((p) => ({ path: p, action: 'modified', before: 'a', after: 'b' })),
      }) as SessionEvent;

    const restored = buildRestoredCheckpoints([
      checkpoint(0, 'first prompt'),
      snapshot(0, ['a.ts', 'b.ts']),
      checkpoint(1, 'second prompt'),
      // Two separate snapshot events for the same prompt must sum, not overwrite.
      snapshot(1, ['c.ts']),
      snapshot(1, ['d.ts', 'e.ts', 'f.ts']),
      checkpoint(2, 'read-only prompt'),
    ]);

    expect(restored.map((c) => [c.promptIndex, c.fileCount])).toEqual([
      [0, 2],
      [1, 4],
      [2, 0],
    ]);
  });
});

function userMsg(text: string): Message {
  return { role: 'user', content: text, ts: '2026-07-05T10:00:00.000Z' };
}

function assistantText(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ts: '2026-07-05T10:00:01.000Z',
  };
}

describe('buildRestoredEntries', () => {
  it('returns an empty list when messages are missing or empty', () => {
    expect(buildRestoredEntries(undefined)).toEqual([]);
    expect(buildRestoredEntries([])).toEqual([]);
  });

  it('filters system messages and rehydrates visible history entries', () => {
    const messages: Message[] = [
      { role: 'system', content: 'hidden system prompt', ts: '2026-07-05T10:00:00.000Z' },
      userMsg('resume me'),
      assistantText('welcome back'),
    ];

    const entries = buildRestoredEntries(messages);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'resume me' });
    expect(entries[1]).toMatchObject({ kind: 'assistant', text: 'welcome back' });
  });

  it('includes tool entries when restored tool calls are present', () => {
    const messages: Message[] = [
      userMsg('check file'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running read' },
          { type: 'tool_use', id: 'tu-1', name: 'read', input: { path: 'a.ts' } },
        ],
        ts: '2026-07-05T10:00:01.000Z',
      },
    ];
    const toolCalls: RestoredToolCall[] = [
      { id: 'tu-1', name: 'read', durationMs: 12, ok: true, outputBytes: 50, outputLines: 2 },
    ];

    const entries = buildRestoredEntries(messages, toolCalls);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool']);
  });

  it('preserves assistant/tool block order within restored assistant messages', () => {
    const messages: Message[] = [
      userMsg('inspect and explain'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect first. ' },
          { type: 'tool_use', id: 'tu-1', name: 'read', input: { path: 'a.ts' } },
          { type: 'text', text: 'The file shows the issue. ' },
          { type: 'tool_use', id: 'tu-2', name: 'edit', input: { path: 'a.ts' } },
          { type: 'text', text: 'Patch applied.' },
        ],
        ts: '2026-07-05T10:00:01.000Z',
      },
    ];
    const toolCalls: RestoredToolCall[] = [
      { id: 'tu-1', name: 'read', durationMs: 12, ok: true, outputBytes: 50, outputLines: 2 },
      { id: 'tu-2', name: 'edit', durationMs: 20, ok: true, outputBytes: 75, outputLines: 3 },
    ];

    const entries = buildRestoredEntries(messages, toolCalls);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(entries[1]).toMatchObject({ kind: 'assistant', text: 'I will inspect first.' });
    expect(entries[2]).toMatchObject({ kind: 'tool', name: 'read' });
    expect(entries[3]).toMatchObject({ kind: 'assistant', text: 'The file shows the issue.' });
    expect(entries[4]).toMatchObject({ kind: 'tool', name: 'edit' });
    expect(entries[5]).toMatchObject({ kind: 'assistant', text: 'Patch applied.' });
  });
});

describe('createInitialState', () => {
  it('builds a banner entry when banner mode is enabled', () => {
    const state = createInitialState({
      banner: true,
      appVersion: '1.2.3',
      provider: 'anthropic',
      model: 'anthropic-test-model',
      cwd: '/repo',
      family: 'anthropic',
      keyTail: 'abcd',
      restoredEntries: [],
      enhanceEnabled: true,
      initialAgentsMonitorOpen: false,
    });

    expect(state.entries[0]).toMatchObject({
      kind: 'banner',
      version: '1.2.3',
      provider: 'anthropic',
      model: 'anthropic-test-model',
      cwd: '/repo',
      family: 'anthropic',
      keyTail: 'abcd',
    });
  });

  it('threads the preflight update-check fields into the banner entry', () => {
    const state = createInitialState({
      banner: true,
      appVersion: '1.2.3',
      provider: 'anthropic',
      model: 'anthropic-test-model',
      cwd: '/repo',
      latestVersion: '1.3.0',
      updateAvailable: true,
      restoredEntries: [],
      enhanceEnabled: false,
    });

    expect(state.entries[0]).toMatchObject({
      kind: 'banner',
      version: '1.2.3',
      latestVersion: '1.3.0',
      updateAvailable: true,
    });
  });

  it('prepends the banner before restored entries and derives nextId from entry count', () => {
    const restoredEntries = [
      { id: 1, kind: 'user' as const, text: 'restored user' },
      { id: 2, kind: 'assistant' as const, text: 'restored assistant' },
    ];

    const state = createInitialState({
      banner: true,
      appVersion: 'dev',
      provider: 'agent',
      model: 'anthropic-test-model',
      cwd: '/repo',
      restoredEntries,
      enhanceEnabled: false,
      initialAgentsMonitorOpen: true,
    });

    expect(state.entries).toHaveLength(3);
    expect(state.entries[0]).toMatchObject({ kind: 'banner' });
    expect(state.entries[1]).toMatchObject({ kind: 'user', text: 'restored user' });
    expect(state.entries[2]).toMatchObject({ kind: 'assistant', text: 'restored assistant' });
    expect(state.nextId).toBe(3);
    expect(state.agentsMonitorOpen).toBe(true);
    expect(state.enhanceEnabled).toBe(false);
  });

  it('uses defaults when banner mode is disabled', () => {
    const state = createInitialState({
      banner: false,
      model: 'anthropic-test-model',
      cwd: '/repo',
      restoredEntries: [],
      enhanceEnabled: true,
    });

    expect(state.entries).toEqual([]);
    expect(state.nextId).toBe(1);
    expect(state.buffer).toBe('');
    expect(state.historyIndex).toBe(0);
    expect(state.modePicker.open).toBe(false);
    expect(state.settingsPicker.mode).toBe('off');
  });
});
