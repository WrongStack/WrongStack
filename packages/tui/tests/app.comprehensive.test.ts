/**
 * Comprehensive unit tests for the pure-function exports from app.tsx.
 *
 * Strategy: test every export that is (a) a pure function, (b) a re-exported
 * pure function, or (c) a type whose shape can be verified at runtime.
 * This avoids the full Ink-render path (which requires ink-testing-library
 * and a mock terminal) and focuses on deterministic module-level code.
 *
 * Targets:
 *   - renderRunningTools    (from ./running-tools.js)
 *   - selectedSlashCommandLine (from ./slash-command-search.js)
 *   - buildSteeringPreamble (from ./steering-preamble.js)
 *   - reducer               (from ./app-reducer.js)
 *   - Exported types via instanceof / shape assertions
 */

import { describe, expect, it } from 'vitest';
import {
  renderRunningTools,
  selectedSlashCommandLine,
  buildSteeringPreamble,
  reducer,
} from '../src/app.js';
import type { State } from '../src/app.js';

// ── Minimal state fixture for reducer tests ──────────────────────────
function emptyState(): State {
  return {
    entries: [],
    buffer: '',
    cursor: 0,
    streamingText: '',
    toolStream: null,
    status: 'idle',
    interrupts: 0,
    steeringPending: false,
    steerSnapshot: null,
    hint: '',
    brain: { state: 'idle' },
    nextId: 0,
    historyGen: 0,
    picker: { open: false, query: '', matches: [] as never, selected: 0 },
    slashPicker: { open: false, query: '', matches: [] as never, selected: 0 },
    runningTools: new Map(),
    queue: [],
    nextQueueId: 0,
    confirmQueue: [],
    clearConfirm: null,
    slashConfirm: null,
    brainPrompt: null,
    debugStreamStats: null,
    contextChipVersion: 0,
  } as unknown as State;
}

// ═══════════════════════════════════════════════════════════════════
//  1. renderRunningTools
// ═══════════════════════════════════════════════════════════════════
describe('renderRunningTools', () => {
  it('returns empty string for an empty map', () => {
    expect(renderRunningTools(new Map())).toBe('');
  });

  it('returns the oldest running tool name and elapsed seconds', () => {
    const now = Date.now();
    const map = new Map([['a', { name: 'read', startedAt: now - 5_000 }]]);
    const result = renderRunningTools(map);
    expect(result).toMatch(/^running: read \d+\.\ds$/);
    expect(result).not.toContain('+');
  });

  it('appends (+N) suffix when more than one tool is running', () => {
    const now = Date.now();
    const map = new Map([
      ['a', { name: 'read', startedAt: now - 5_000 }],
      ['b', { name: 'write', startedAt: now - 2_000 }],
      ['c', { name: 'grep', startedAt: now - 1_000 }],
    ]);
    const result = renderRunningTools(map);
    // One tool is the "oldest" shown by name; the other two → (+2)
    expect(result).toMatch(/^running: .+ \d+\.\ds \(\+2\)$/);
  });

  it('handles a single running tool without suffix', () => {
    const now = Date.now();
    const map = new Map([['a', { name: 'bash', startedAt: now - 10_000 }]]);
    const result = renderRunningTools(map);
    expect(result).toMatch(/^running: bash \d+\.\ds$/);
    expect(result).not.toContain('+');
  });

  it('handles edge case: empty Map after construction', () => {
    const map = new Map<string, { name: string; startedAt: number }>();
    expect(renderRunningTools(map)).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  2. selectedSlashCommandLine
// ═══════════════════════════════════════════════════════════════════
describe('selectedSlashCommandLine', () => {
  it('returns null when picker is closed', () => {
    expect(
      selectedSlashCommandLine({
        open: false,
        matches: [
          { name: 'help', description: 'Show help', category: 'App', isBuiltin: true },
        ] as never as never,
        selected: 0,
      }),
    ).toBeNull();
  });

  it('returns null when there are no matches', () => {
    expect(selectedSlashCommandLine({ open: true, matches: [] as never, selected: 0 })).toBeNull();
  });

  it('returns /name for the selected match', () => {
    const matches = [
      { name: 'clear', description: 'Clear history', category: 'App', isBuiltin: true },
      { name: 'help', description: 'Show help', category: 'App', isBuiltin: true },
    ] as never;
    expect(selectedSlashCommandLine({ open: true, matches, selected: 0 })).toBe('/clear');
    expect(selectedSlashCommandLine({ open: true, matches, selected: 1 })).toBe('/help');
  });

  it('returns null when selected index is out of bounds', () => {
    const matches = [
      { name: 'clear', description: 'Clear history', category: 'App', isBuiltin: true },
    ] as never;
    expect(selectedSlashCommandLine({ open: true, matches, selected: 5 })).toBeNull();
  });

  it('returns null when selected index is negative', () => {
    const matches = [
      { name: 'clear', description: 'Clear history', category: 'App', isBuiltin: true },
    ] as never;
    expect(selectedSlashCommandLine({ open: true, matches, selected: -1 })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  3. buildSteeringPreamble
// ═══════════════════════════════════════════════════════════════════
describe('buildSteeringPreamble', () => {
  it('produces a preamble with the new direction', () => {
    const snapshot = null;
    const result = buildSteeringPreamble(snapshot, 'try a different approach');
    expect(result).toContain('[STEERING');
    expect(result).toContain('try a different approach');
    expect(result).toContain('New direction:');
    expect(result).toContain('---');
  });

  it('includes running tools when snapshot has them', () => {
    const snapshot = {
      runningTools: ['bash', 'read'],
      subagents: [],
      subagentsTerminated: 0,
      partialAssistantText: '',
    };
    const result = buildSteeringPreamble(snapshot, 'stop everything');
    expect(result).toContain('bash');
    expect(result).toContain('read');
    expect(result).toContain('in-flight tools');
  });

  it('includes subagent info when subagents were terminated', () => {
    const snapshot = {
      runningTools: [],
      subagents: [{ label: 'scout', status: 'running', tool: 'read' }],
      subagentsTerminated: 1,
      partialAssistantText: '',
    };
    const result = buildSteeringPreamble(snapshot, 'reassign');
    expect(result).toContain('scout');
    expect(result).toContain('subagents');
    expect(result).toContain('terminated');
  });

  it('includes partial assistant text when present', () => {
    const snapshot = {
      runningTools: [],
      subagents: [],
      subagentsTerminated: 0,
      partialAssistantText: 'This is a partial response that was cut off mid-sentence',
    };
    const result = buildSteeringPreamble(snapshot, 'continue');
    expect(result).toContain('partial output');
    expect(result).toContain('cut off');
  });

  it('truncates partial assistant text to 300 chars', () => {
    const long = 'x'.repeat(500);
    const snapshot = {
      runningTools: [],
      subagents: [],
      subagentsTerminated: 0,
      partialAssistantText: long,
    };
    const result = buildSteeringPreamble(snapshot, 'continue');
    // The quoted text should be at most 300 chars
    const match = result.match(/"(.+?)"/);
    if (match?.[1] !== undefined) {
      expect(match[1].length).toBeLessThanOrEqual(300);
    }
  });

  it('includes the "authority" section', () => {
    const snapshot = null;
    const result = buildSteeringPreamble(snapshot, 'pivot');
    expect(result).toContain('You have authority to:');
    expect(result).toContain('Abandon the prior plan');
    expect(result).toContain('Re-spawn fresh subagents');
    expect(result).toContain('Ask me to clarify');
  });

  it('produces a valid multi-line preamble with all sections when full snapshot is provided', () => {
    const snapshot = {
      runningTools: ['bash'],
      subagents: [{ label: 'scout', status: 'running', tool: 'read' }],
      subagentsTerminated: 1,
      partialAssistantText: 'building a solution',
    };
    const result = buildSteeringPreamble(snapshot, 'new direction text');
    // Contains all sections
    expect(result).toContain('[STEERING');
    expect(result).toContain('What was happening');
    expect(result).toContain('You have authority');
    expect(result).toContain('New direction:');
    expect(result).toContain('new direction text');
    // Newlines separate sections
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(5);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  4. reducer
// ═══════════════════════════════════════════════════════════════════
describe('reducer', () => {
  describe('streamReset', () => {
    it('clears streamingText but does not change status', () => {
      const state = { ...emptyState(), streamingText: 'hello', status: 'running' as const };
      const next = reducer(state, { type: 'streamReset' });
      expect(next.streamingText).toBe('');
      expect(next.status).toBe('running');
    });

    it('clears streamingText when already idle', () => {
      const state = { ...emptyState(), streamingText: 'hello' };
      const next = reducer(state, { type: 'streamReset' });
      expect(next.streamingText).toBe('');
    });
  });

  describe('toolStreamAppend', () => {
    it('caps an oversized first chunk before retaining it in state', () => {
      const next = reducer(emptyState(), {
        type: 'toolStreamAppend',
        toolUseId: 'tool-1',
        name: 'bash',
        text: 'x'.repeat(250_000),
        startedAt: 1,
      });

      expect(next.toolStream?.text).toHaveLength(100_000);
      expect(next.toolStream?.text).toBe('x'.repeat(100_000));
    });
  });

  describe('toolStreamClear', () => {
    it('clears toolStream when toolUseId matches', () => {
      const state = {
        ...emptyState(),
        toolStream: { toolUseId: 'tool-1', name: 'bash', text: 'in-flight', startedAt: 1 } as never,
      };
      const next = reducer(state, { type: 'toolStreamClear', toolUseId: 'tool-1' });
      expect(next.toolStream).toBeNull();
    });

    it('does not clear toolStream when toolUseId does not match', () => {
      const state = {
        ...emptyState(),
        toolStream: { toolUseId: 'tool-1', name: 'bash', text: 'in-flight', startedAt: 1 },
      };
      const next = reducer(state, { type: 'toolStreamClear', toolUseId: 'tool-2' });
      expect(next.toolStream).not.toBeNull();
    });

    it('handles null toolStream gracefully', () => {
      const state = { ...emptyState(), toolStream: null };
      const next = reducer(state, { type: 'toolStreamClear' });
      expect(next.toolStream).toBeNull();
    });
  });

  describe('resetContextChip', () => {
    it('increments contextChipVersion without touching streamingText or toolStream', () => {
      const state = {
        ...emptyState(),
        streamingText: 'stale',
        toolStream: { toolUseId: 't1', name: 'bash', text: 'output', startedAt: 1 },
        contextChipVersion: 0,
      };
      const next = reducer(state, { type: 'resetContextChip' });
      expect(next.contextChipVersion).toBe(1);
      expect(next.streamingText).toBe('stale');
      expect(next.toolStream).not.toBeNull();
    });
  });

  describe('queueClear', () => {
    it('empties the queue', () => {
      const state = {
        ...emptyState(),
        queue: [
          { id: 1, displayText: 'task 1', blocks: [{ type: 'text' as const, text: 'task 1' }] },
        ],
      };
      const next = reducer(state, { type: 'queueClear' });
      expect(next.queue).toEqual([]);
    });

    it('handles already-empty queue', () => {
      const state = { ...emptyState(), queue: [] };
      const next = reducer(state, { type: 'queueClear' });
      expect(next.queue).toEqual([]);
    });
  });

  describe('clearHistory', () => {
    it('resets the transcript to a single banner entry', () => {
      const state = {
        ...emptyState(),
        entries: [
          {
            kind: 'banner' as const,
            id: 0,
            version: 'test',
            cwd: '/test/project',
            model: 'old',
            provider: 'old',
          },
          { kind: 'user' as const, id: 1, text: 'hello' },
        ],
        historyGen: 5,
      };
      const next = reducer(state, {
        type: 'clearHistory',
        model: 'new-model',
        provider: 'new-provider',
      });
      expect(next.entries).toHaveLength(1);
      expect(next.entries[0]).toMatchObject({
        kind: 'banner',
        model: 'new-model',
        provider: 'new-provider',
      });
      expect(next.historyGen).toBe(6);
    });

    it('clears all in-flight state alongside history', () => {
      const state = {
        ...emptyState(),
        entries: [
          {
            kind: 'banner' as const,
            id: 0,
            version: 'test',
            cwd: '/test/project',
            model: 'm',
            provider: 'p',
          },
        ],
        streamingText: 'stale stream',
        toolStream: { toolUseId: 't1', name: 'bash', text: 'x', startedAt: 1 },
        status: 'running' as const,
        interrupts: 3,
        steeringPending: true,
        steerSnapshot: {
          runningTools: [],
          subagents: [],
          subagentsTerminated: 0,
          partialAssistantText: '',
        },
        queue: [{ id: 1, displayText: 'q', blocks: [{ type: 'text' as const, text: 'q' }] }],
      };
      const next = reducer(state, { type: 'clearHistory', model: 'm', provider: 'p' });
      expect(next.streamingText).toBe('');
      expect(next.toolStream).toBeNull();
      expect(next.status).toBe('idle');
      expect(next.interrupts).toBe(0);
      expect(next.steeringPending).toBe(false);
      expect(next.steerSnapshot).toBeNull();
      expect(next.queue).toEqual([]);
    });
  });

  describe('hint', () => {
    it('updates the hint string', () => {
      const state = { ...emptyState(), hint: 'old hint' };
      const next = reducer(state, { type: 'hint', text: 'new hint' });
      expect(next.hint).toBe('new hint');
    });

    it('accepts empty hint text', () => {
      const state = { ...emptyState(), hint: 'old hint' };
      const next = reducer(state, { type: 'hint', text: '' });
      expect(next.hint).toBe('');
    });
  });

  describe('enqueue', () => {
    it('appends an item to the queue and advances nextQueueId', () => {
      const state = { ...emptyState(), queue: [], nextQueueId: 1 };
      const item = {
        displayText: 'test task',
        blocks: [{ type: 'text' as const, text: 'test task' }],
      };
      const next = reducer(state, { type: 'enqueue', item });
      expect(next.queue).toHaveLength(1);
      expect(next.queue[0]).toMatchObject({ displayText: 'test task', id: 1 });
      expect(next.nextQueueId).toBe(2);
    });

    it('preserves journalRaw provenance on the enqueued item', () => {
      const state = { ...emptyState(), queue: [], nextQueueId: 1 };
      const item = {
        displayText: 'refined task',
        blocks: [{ type: 'text' as const, text: 'refined task' }],
        journalRaw: 'raw task',
      };
      const next = reducer(state, { type: 'enqueue', item });
      expect(next.queue[0]).toMatchObject({
        displayText: 'refined task',
        id: 1,
        journalRaw: 'raw task',
      });
      // The budget projection (what gets persisted) must carry journalRaw so
      // rehydration restores provenance and the byte budget matches the write.
      expect(next.queue).toHaveLength(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
//  5. Type shape verification (runtime structual checks)
// ═══════════════════════════════════════════════════════════════════
describe('exported types', () => {
  it('reducer is a function', () => {
    expect(typeof reducer).toBe('function');
  });

  it('reducer returns a state-compatible object with core fields', () => {
    const result = reducer(emptyState(), { type: 'hint', text: 'test' });
    expect(result).toHaveProperty('hint', 'test');
    expect(result).toHaveProperty('entries');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('queue');
    expect(result).toHaveProperty('buffer');
    expect(result).toHaveProperty('cursor');
  });

  it('renderRunningTools is a function', () => {
    expect(typeof renderRunningTools).toBe('function');
  });

  it('selectedSlashCommandLine is a function', () => {
    expect(typeof selectedSlashCommandLine).toBe('function');
  });

  it('buildSteeringPreamble is a function', () => {
    expect(typeof buildSteeringPreamble).toBe('function');
  });
});
