import { describe, expect, it } from 'vitest';
import { InjectionTracker } from '../src/middleware/injection-tracker.js';
import {
  memoryInjectorAgentCoverage as injector,
  MemoryInjectorAgent,
} from '../src/middleware/memory-injector-agent.js';
import {
  createSageTurnMiddleware,
  turnMemoryCoverage as turn,
} from '../src/middleware/turn-memory.js';

describe('turn middleware helper coverage', () => {
  it('normalizes system blocks once and returns the cached value on a repeat', () => {
    const normalize = turn.makeNormalizedSystemFn();
    expect(normalize(undefined)).toBe('');
    expect(normalize([])).toBe('');
    const blocks = [
      undefined,
      { type: 'image', text: 'ignored' },
      { type: 'text', text: '' },
      { type: 'text', text: '  Hello   World ' },
    ] as never;
    expect(normalize(blocks)).toBe('hello world');
    expect(normalize(blocks)).toBe('hello world');
    expect(normalize([{ type: 'text', text: 'Changed' }])).toBe('changed');
  });

  it('extracts string and text-block messages by role', () => {
    expect(
      turn.lastMessageTextByRole(
        [
          { role: 'user', content: ' first ' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: ' answer ' },
              { type: 'tool_result', tool_use_id: 'tool', content: 'ignored' },
            ],
          },
        ] as never,
        'assistant',
      ),
    ).toBe('answer');
    expect(turn.lastMessageTextByRole([] as never, 'user')).toBe('');
  });

  it('appends to a missing system array and tracks only rendered eligible memories', async () => {
    const memories = ['alpha beta gamma first', 'alpha beta gamma second'].map((text, index) => ({
      id: `memory-${index}`,
      revision: 1,
      scope: 'project',
      kind: 'fact',
      status: 'active',
      text,
      importance: 1,
      confidence: 1,
      freshness: 1,
      tags: [],
      anchors: [],
      sources: [],
      createdAt: '2026',
      updatedAt: '2026',
    }));
    const tracker = new InjectionTracker({ minTokens: 1 });
    const middleware = createSageTurnMiddleware({
      memory: {
        searchSage: async () => memories as never,
        recordInjection: async () => {},
      },
      tracker,
      maxChars: 100,
      minScore: 0,
    });
    const request = {
      model: 'test',
      messages: [{ role: 'user', content: 'alpha beta gamma' }],
    };
    const result = await middleware.handler(request as never, async (value) => value);
    expect(result.system).toHaveLength(1);
    expect(tracker.size).toBe(1);
  });
});

describe('InjectionTracker completion coverage', () => {
  const text = 'alpha beta gamma delta epsilon';

  it('covers empty inputs, size pruning, overflow, and TTL throttling', () => {
    const empty = new InjectionTracker();
    expect(empty.consumeMatches('anything')).toEqual([]);
    empty.record('one', text, 1);
    expect(empty.consumeMatches(' ')).toEqual([]);
    expect(empty.consumeMatches('a an')).toEqual([]);

    const tracker = new InjectionTracker({
      maxEntries: 1,
      ttlMs: Number.MAX_SAFE_INTEGER,
      minTokens: 1,
    });
    tracker.record('one', text, 1);
    tracker.record('two', `${text} two`, 2);
    tracker.record('three', `${text} three`, 3);
    expect(tracker.size).toBe(1);
    expect(tracker.consumeMatches('alpha beta gamma delta epsilon three', 50)).toEqual(['three']);

    const expiring = new InjectionTracker({ ttlMs: 100, minTokens: 1 });
    expiring.record('expired', text, 100);
    expect(expiring.snapshotContext(text, undefined, 150).activeMemoryIds).toEqual(['expired']);
    expect(expiring.snapshotContext(text, undefined, 251).activeMemoryIds).toEqual([]);
  });

  it('evicts old context sessions and handles rendered context fallbacks', () => {
    const tracker = new InjectionTracker({ maxEntries: 1, minTokens: 2 });
    tracker.record('one', text, 1, 'first', 'rendered text without a matching prefix');
    expect(tracker.snapshotContext(text, 'first', 2).activeMemoryIds).toEqual(['one']);
    tracker.record('two', 'zeta eta theta iota', 3, 'second');
    tracker.snapshotContext('zeta eta theta iota', 'second', 4);
    tracker.snapshotContext('zeta eta theta iota', 'third', 5);
    expect(tracker.snapshotContextParts(['', '   '], 'third', 6)).toEqual({
      activeMemoryIds: [],
      enteredMemoryIds: [],
      exitedMemoryIds: [],
    });

    const mixedAge = new InjectionTracker({ ttlMs: 100, minTokens: 1 });
    mixedAge.record('old', text, 100, 'old-session');
    mixedAge.snapshotContext(text, 'old-session', 100);
    mixedAge.record('fresh', `${text} fresh`, 150, 'fresh-session');
    mixedAge.snapshotContext(`${text} fresh`, 'fresh-session', 150);
    expect(mixedAge.snapshotContext(`${text} fresh`, 'fresh-session', 201).activeMemoryIds).toEqual(
      ['fresh'],
    );
  });
});

describe('MemoryInjectorAgent helper coverage', () => {
  it('covers task-aware opt-out and medium context pressure', () => {
    const agent = new MemoryInjectorAgent();
    const ctx = {
      todos: 'invalid',
      currentKanbanTaskId: 'task-1',
      currentKanbanBoardId: 'board-1',
      lastRequestTokens: 70,
      meta: { effectiveMaxContext: 100, kanban: null },
    } as never;
    const plan = agent.plan({
      ctx,
      trigger: 'read',
      toolQuery: 'alpha alpha beta',
      baseMaxHints: 8,
      baseMaxChars: 2_800,
      taskAware: true,
    });
    expect(plan.maxHints).toBe(3);
    expect(plan.maxChars).toBe(1_400);
    expect(plan.taskSignals).toEqual(['kanban-task task-1', 'kanban-board board-1']);

    expect(
      agent.plan({
        ctx,
        trigger: 'read',
        toolQuery: 'alpha',
        baseMaxHints: 8,
        baseMaxChars: 2_800,
        taskAware: false,
      }).taskSignals,
    ).toEqual([]);

    const noMeta = {} as never;
    agent.record(noMeta, plan, {
      candidates: 0,
      eligible: 0,
      injected: 0,
      injectedChars: 0,
    });
    expect((noMeta as { meta: object }).meta).toBeDefined();
  });

  it('collects bounded Kanban values and pressure fallbacks', () => {
    const output: string[] = [];
    injector.collectKanbanSignals([], output);
    injector.collectKanbanSignals(
      {
        title: '  Board   title ',
        tags: ['one', 2, 'two'],
        labels: Array.from({ length: 10 }, (_, index) => `label-${index}`),
      },
      output,
    );
    expect(output).toHaveLength(8);
    expect(output[0]).toBe('title Board title');

    expect(
      injector.collectTaskSignals({
        todos: [
          { status: 'in_progress', activeForm: ' Doing now ', content: 'fallback' },
          { status: 'in_progress', content: 'fallback' },
        ],
        meta: { kanban: { summary: '' } },
      } as never),
    ).toEqual(['Doing now', 'fallback']);
    expect(
      injector.readContextPressure({
        lastRequestTokens: 50,
        provider: { capabilities: { maxContext: 200 } },
      } as never),
    ).toBe(0.25);
    expect(injector.readContextPressure({ lastRequestTokens: 50 } as never)).toBe(0);
    expect(injector.readContextPressure({ lastRequestTokens: 0 } as never)).toBe(0);
  });

  it('deduplicates and truncates unique query terms', () => {
    expect(injector.uniqueTerms(' Alpha alpha   BETA ', 20)).toBe('Alpha BETA');
    expect(injector.uniqueTerms('one verylongterm', 4)).toBe('one');
    expect(injector.uniqueTerms('   ', 10)).toBe('');
  });
});
