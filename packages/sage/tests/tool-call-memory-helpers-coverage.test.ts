import * as path from 'node:path';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  toolCallMemoryCoverage as coverage,
  createSageToolCallMiddleware,
  type SageRetrieverLike,
} from '../src/middleware/tool-call-memory.js';
import type { Sage } from '../src/types.js';

function sage(id: string, overrides: Partial<Sage> = {}): Sage {
  return {
    id,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: `memory ${id}`,
    importance: 0.8,
    confidence: 0.8,
    freshness: 0.8,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026',
    updatedAt: '2026',
    ...overrides,
  };
}

describe('tool-call memory parsing helpers', () => {
  it('extracts every trigger and mutation policy shape', () => {
    expect(coverage.extractTrigger('unknown', {})).toBeUndefined();
    expect(coverage.extractTrigger('read', { path: ' src/a.ts ' })).toMatchObject({
      trigger: 'read',
      paths: ['src/a.ts'],
      queryText: expect.stringContaining('a.ts'),
    });
    expect(coverage.enrichPathQuery(['packages/auth/session.ts'])).toContain('session');
    expect(coverage.enrichPathQuery(['packages/auth/session.ts'])).toContain('auth');
    expect(coverage.extractTrigger('tree', {})).toMatchObject({ paths: ['.'] });
    expect(coverage.extractTrigger('grep', { pattern: 'needle', glob: '*.ts' })).toMatchObject({
      trigger: 'grep',
      queryText: 'needle *.ts',
    });
    expect(coverage.extractTrigger('glob', { pattern: '*.ts', path: 'src' })).toMatchObject({
      trigger: 'glob',
    });
    expect(coverage.extractTrigger('glob', { pattern: '*.ts' })).toMatchObject({ paths: ['.'] });
    expect(coverage.extractTrigger('codebase_search', { q: 'symbol' })).toMatchObject({
      trigger: 'codebase_search',
      queryText: 'symbol',
    });
    // bash is intentionally excluded from injection triggers — memory should
    // not be shown for command-execution tools.
    expect(coverage.extractTrigger('bash', { command: 'pnpm test' })).toBeUndefined();
    // exec is also excluded — pure command output doesn't need memory context.
    expect(coverage.extractTrigger('exec', { cmd: 'pnpm lint' })).toBeUndefined();
    expect(coverage.extractTrigger('write', { path: 'a.ts' })).toMatchObject({
      trigger: 'write',
    });
    expect(coverage.extractTrigger('edit', { path: 'a.ts' })).toMatchObject({ trigger: 'edit' });
    expect(
      coverage.extractTrigger('replace', {
        files: ['a.ts,b.ts', 'c.ts'],
        pattern: ['old'],
        glob: '*.ts',
      }),
    ).toMatchObject({ trigger: 'edit', paths: ['a.ts', 'b.ts', 'c.ts'] });
    expect(coverage.extractTrigger('patch', { patch: 'not a patch' })).toMatchObject({
      trigger: 'patch',
      paths: [],
    });

    expect(coverage.didMutate('replace', { dry_run: false })).toBe(true);
    expect(coverage.didMutate('replace', {})).toBe(false);
    expect(coverage.didMutate('patch', { dry_run: true })).toBe(false);
    expect(coverage.didMutate('patch', {})).toBe(true);
    expect(coverage.didMutate('write', {})).toBe(true);
    expect(coverage.isMutationTrigger('write')).toBe(true);
    expect(coverage.isMutationTrigger('edit')).toBe(true);
    expect(coverage.isMutationTrigger('patch')).toBe(true);
    expect(coverage.isMutationTrigger('read')).toBe(false);
  });

  it('normalizes scalar, array, file-list, and unified-patch values', () => {
    expect(coverage.stringValues(' value ')).toEqual(['value']);
    expect(coverage.stringValues(' ')).toEqual([]);
    expect(coverage.stringValues([' one ', 2, '', 'two'])).toEqual(['one', 'two']);
    expect(coverage.stringValues(null)).toEqual([]);
    expect(coverage.isString(' value ')).toBe(true);
    expect(coverage.isString('')).toBe(false);
    expect(coverage.isString(1)).toBe(false);
    expect(coverage.splitFileList(' a.ts, ,b.ts ')).toEqual(['a.ts', 'b.ts']);
    expect(coverage.extractPatchPaths({})).toEqual([]);

    const patch = [
      '+++ /dev/null',
      '+++ a/src/one.ts',
      '+++ a/src/one.ts',
      '+++ a/',
      '+++ a\\src\\two.ts',
    ].join('\n');
    expect(coverage.extractPatchPaths({ patch, directory: 'packages', strip: 1 })).toEqual([
      path.join('packages', 'src/one.ts'),
      path.join('packages', 'src/two.ts'),
    ]);
    expect(coverage.extractPatchPaths({ patch: '+++ a/src/one.ts', strip: 99 })).toEqual([]);
    expect(coverage.extractPatchPaths({ patch: '+++ a/src/one.ts', strip: Number.NaN })).toEqual([
      'a/src/one.ts',
    ]);
  });

  it('extracts nested result paths only from supported keys and triggers', () => {
    expect(coverage.extractResultPaths('invalid json', 'read')).toEqual([]);
    const content = JSON.stringify({
      path: 'one.ts',
      files: ['two.ts', { file_path: 'three.ts' }, 1],
      nested: { file: 'four.ts', ignored: 'no.ts' },
      results: [{ path: 'five.ts' }],
      primitive: null,
    });
    expect(coverage.extractResultPaths(content, 'glob')).toEqual([
      'one.ts',
      'two.ts',
      'three.ts',
      'five.ts',
    ]);
    expect(
      coverage.extractResultPaths(JSON.stringify({ results: ['ignored.ts'] }), 'read'),
    ).toEqual([]);
    expect(coverage.extractResultPaths('42', 'tree')).toEqual([]);
    expect(coverage.extractResultPaths(JSON.stringify('top-level'), 'read')).toEqual([]);
  });

  it('resolves concrete in-project paths and ignores globs and escapes', () => {
    const projectRoot = path.resolve('project');
    const workingDir = path.join(projectRoot, 'src');
    expect(
      coverage.resolveTriggerPaths(
        [
          'a.ts',
          'a.ts',
          '*.ts',
          path.join(projectRoot, 'absolute.ts'),
          path.resolve(projectRoot, '..', 'outside.ts'),
        ],
        { projectRoot, workingDir, cwd: projectRoot } as never,
      ),
    ).toEqual([path.join(workingDir, 'a.ts'), path.join(projectRoot, 'absolute.ts')]);
    expect(
      coverage.resolveTriggerPaths(['a.ts'], { projectRoot, cwd: projectRoot } as never),
    ).toEqual([path.join(projectRoot, 'a.ts')]);
    expect(coverage.resolveTriggerPaths(['a.ts'], { projectRoot } as never)).toEqual([
      path.join(projectRoot, 'a.ts'),
    ]);
  });
});

describe('tool-call memory selection and scoring helpers', () => {
  it('covers cooldown keys, pruning, and score boundaries', () => {
    expect(coverage.cooldownKey('memory')).toBe('<no-session>:memory');
    expect(coverage.cooldownKey('memory', 'session')).toBe('session:memory');
    const now = Date.now();
    expect(coverage.applyCooldown([sage('fresh')], new Map(), 100)).toHaveLength(1);
    expect(
      coverage.applyCooldown(
        [sage('blocked')],
        new Map([['session:blocked', now]]),
        100,
        'session',
      ),
    ).toEqual([]);
    expect(
      coverage.applyCooldown(
        [sage('expired')],
        new Map([['session:expired', now - 101]]),
        100,
        'session',
      ),
    ).toHaveLength(1);

    const small = new Map([['one', now]]);
    const smallPruneState = { lastPruneAt: 0 };
    coverage.pruneCooldowns(small, smallPruneState, now, 100);
    expect(small.size).toBe(1);
    const large = new Map<string, number>();
    for (let index = 0; index <= 10_000; index++) large.set(String(index), index === 0 ? 1 : now);
    const largePruneState = { lastPruneAt: 0 };
    coverage.pruneCooldowns(large, largePruneState, now, 100);
    expect(large.has('0')).toBe(false);

    expect(coverage.scoreForInjection(sage('score'))).toBeCloseTo(4.8);
    expect(coverage.normalizedInjectionScore(sage('score'))).toBeCloseTo(0.8);
    expect(coverage.computeInjectionProof(sage('proof'), 0.8).score).toBeCloseTo(
      coverage.contextualInjectionScore(sage('proof'), 0.8),
    );
    expect(
      coverage.contextualInjectionScore(
        sage('permanent', { persistence: 'permanent', injectionCount: 20, useCount: 0 }),
        1,
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      coverage.contextualInjectionScore(
        sage('short', {
          kind: 'preference',
          persistence: 'short_lived',
          importance: 0,
          confidence: 0,
          freshness: 0,
          injectionCount: 2,
        }),
        0,
      ),
    ).toBe(0);
    expect(
      coverage.contextualInjectionScore(sage('used', { injectionCount: 3, useCount: 1 }), 0.8),
    ).toBeGreaterThan(
      coverage.contextualInjectionScore(sage('unused-default', { injectionCount: 3 }), 0.8),
    );
    expect(
      coverage.contextualInjectionScore(
        sage('anchored', { anchors: [{ type: 'file', path: 'a.ts' }] }),
        0.8,
      ),
    ).toBeGreaterThan(coverage.contextualInjectionScore(sage('unanchored'), 0.8));
    expect(
      coverage.contextualInjectionScore(sage('unused-default', { injectionCount: 3 }), 0.8),
    ).toBeGreaterThan(0);
    expect(
      coverage.contextualInjectionScore(sage('long-lived', { persistence: 'long_lived' }), 0.5),
    ).toBeGreaterThan(0);
    for (const kind of [
      'fact',
      'decision',
      'convention',
      'warning',
      'anti_pattern',
      'workflow',
      'bug_root_cause',
      'file_note',
      'symbol_note',
      'command_note',
    ] as Sage['kind'][]) {
      expect(coverage.durableMemoryKind(kind)).toBe(true);
    }
    expect(coverage.durableMemoryKind('preference')).toBe(false);
  });

  it('formats bounded trace values and all anchor shapes', () => {
    expect(coverage.boundedText(' short  text ', 100)).toBe('short text');
    expect(coverage.boundedText('long text', 5)).toBe('long…');
    expect(coverage.boundedText('long', 0)).toBe('…');
    expect(coverage.formatTraceAnchor({ type: 'symbol', symbol: 'run' })).toBe('symbol:run');
    expect(coverage.formatTraceAnchor({ type: 'file', path: 'src/a.ts' })).toBe('file:src/a.ts');
    expect(coverage.formatTraceAnchor({ type: 'command', command: 'pnpm test' })).toBe(
      'command:pnpm test',
    );
    expect(coverage.formatTraceAnchor({ type: 'agent', role: 'reviewer' })).toBe('agent:reviewer');
    expect(coverage.formatTraceAnchor({ type: 'file' })).toBe('file');
    expect(
      coverage.toTraceMemory(
        {
          memory: sage('trace', {
            text: 'x'.repeat(200),
            tags: ['query-tag', 'task-tag'],
            anchors: [{ type: 'file', path: 'src/a.ts' }],
          }),
          relationStrength: 0.8,
          retrievalReasons: ['query:exact-file'],
        },
        {
          queryText: 'query-tag',
          taskSignals: ['task-tag signal'],
          maxHints: 2,
          maxChars: 100,
          contextPressure: 0,
        },
      ),
    ).toEqual(
      expect.objectContaining({
        activationReasons: expect.arrayContaining(['tag:#query-tag', 'task:#task-tag']),
      }),
    );
  });

  it('deduplicates text and diversifies path, graph, query, and kind budgets', () => {
    const duplicate = [
      { memory: sage('one', { text: 'Same text' }), relationStrength: 1, retrievalReasons: [] },
      { memory: sage('two', { text: ' same   TEXT ' }), relationStrength: 1, retrievalReasons: [] },
    ];
    expect(coverage.dedupeRetrievedByText(duplicate)).toHaveLength(1);
    expect(coverage.selectDiverseMemories([sage('one')], 0)).toEqual([]);

    const memories = Array.from({ length: 8 }, (_, index) =>
      sage(String(index), { kind: index < 5 ? 'fact' : 'decision' }),
    );
    const reasons = new Map<string, string[]>([
      ['0', ['graph:shared-anchor']],
      ['1', ['graph:shared-anchor']],
      ['2', ['query:text-terms:a']],
      ['3', ['query:text-terms:b']],
      ['4', ['query:text-terms:c']],
      ['5', ['anchor:path-match']],
      ['6', []],
      ['7', []],
    ]);
    const selected = coverage.selectDiverseMemories(memories, 6, reasons);
    expect(selected.length).toBeLessThanOrEqual(6);
    expect(selected.map((memory) => memory.id)).toContain('5');
    expect(coverage.selectDiverseMemories(memories, 2)).toHaveLength(2);

    const deferred = Array.from({ length: 9 }, (_, index) =>
      sage(`deferred-${index}`, { kind: 'fact' }),
    );
    const deferredReasons = new Map<string, string[]>();
    for (let index = 0; index < 3; index++) {
      deferredReasons.set(`deferred-${index}`, ['anchor:path-match']);
    }
    deferredReasons.set('deferred-3', ['graph:first']);
    deferredReasons.set('deferred-4', ['graph:second']);
    deferredReasons.set('deferred-5', ['query:first']);
    deferredReasons.set('deferred-6', ['query:second']);
    deferredReasons.set('deferred-7', ['query:third']);
    deferredReasons.set('deferred-8', []);
    expect(
      coverage.selectDiverseMemories(deferred, 20, deferredReasons).map((item) => item.id),
    ).toEqual([
      'deferred-0',
      'deferred-1',
      'deferred-2',
      'deferred-3',
      'deferred-5',
      'deferred-6',
      'deferred-8',
    ]);
    expect(
      coverage
        .selectDiverseMemories(
          deferred.slice(0, 5),
          4,
          new Map([
            ['deferred-0', ['anchor:path-match']],
            ['deferred-1', ['anchor:path-match']],
            ['deferred-2', ['anchor:path-match']],
          ]),
        )
        .map((item) => item.id),
    ).toEqual(['deferred-0', 'deferred-1', 'deferred-2', 'deferred-3']);
  });

  it('computes visible context and byte-aware output budgets', () => {
    const payload = {
      result: { content: 'RESULT' },
      ctx: { systemPrompt: [{ text: 'PROMPT' }, {}] },
      tool: { maxOutputBytes: 100 },
    } as unknown as ToolCallPipelinePayload;
    expect(coverage.visibleContextText(payload)).toBe('result\nprompt\n');
    expect(coverage.availableHintChars(payload, 1_000)).toBeLessThan(100);
    expect(coverage.availableHintChars({ ...payload, tool: undefined }, -1)).toBe(0);
    expect(
      coverage.availableHintChars(
        { ...payload, result: { content: 'x'.repeat(200) } } as never,
        100,
      ),
    ).toBe(0);
  });

  it('emits bounded task signals in injector traces', () => {
    const events = { emit: vi.fn() };
    coverage.emitInjectorTrace(
      events as never,
      {
        nextPayload: {
          toolUse: { name: 'read' },
          ctx: { session: { id: 'session' } },
        },
        outcome: 'skipped',
        trigger: { trigger: 'read', paths: [] },
        plan: {
          queryText: 'query',
          taskSignals: ['  task   signal  ', 'x'.repeat(200)],
          contextPressure: 0.5,
          maxHints: 2,
          maxChars: 100,
        },
        candidates: [],
        eligible: [],
        rejected: [],
        activated: [],
        injected: [],
        injectedChars: 0,
      } as never,
    );
    expect(events.emit).toHaveBeenCalledWith(
      'memory.injector_run',
      expect.objectContaining({
        taskSignals: ['task signal', `${'x'.repeat(159)}…`],
        sessionId: 'session',
      }),
    );
  });
});

describe('triggered retrieval helper', () => {
  it('merges path/query duplicates, expands strong graph seeds, and filters lifecycle records', async () => {
    const seed = sage('seed', {
      text: 'specific authentication symbol',
      anchors: [{ type: 'file', path: 'src/auth.ts' }],
    });
    const related = sage('related', {
      anchors: [{ type: 'file', path: 'src/auth.ts' }],
    });
    const memory = {
      retrieveForPath: vi.fn(async () => [seed]),
      searchSage: vi.fn(async () => [
        seed,
        sage('weak', { text: 'unrelated' }),
        sage('deleted', { status: 'deleted' }),
        sage('never', { contextPolicy: 'never' }),
        sage('review', { kind: 'memory_review' }),
      ]),
      findRelatedSage: vi.fn(async () => [related, sage('unrelated-related')]),
    } as SageRetrieverLike;
    const result = await coverage.retrieveTriggeredMemories(
      memory,
      { trigger: 'read', paths: ['src/auth.ts'], queryText: 'specific authentication symbol' },
      3,
    );
    expect(result.map((item) => item.memory.id)).toEqual(
      expect.arrayContaining(['seed', 'related', 'weak']),
    );
    expect(result.map((item) => item.memory.id)).not.toEqual(
      expect.arrayContaining(['deleted', 'never', 'review', 'unrelated-related']),
    );
    expect(memory.findRelatedSage).toHaveBeenCalled();
  });

  it('supports empty mutation queries without graph expansion', async () => {
    const memory = {
      retrieveForPath: vi.fn(async () => [
        sage('stale', { status: 'stale', anchors: [{ type: 'file', path: 'src/a.ts' }] }),
      ]),
      searchSage: vi.fn(async () => []),
    } as SageRetrieverLike;
    const result = await coverage.retrieveTriggeredMemories(
      memory,
      { trigger: 'write', paths: ['src/a.ts'], queryText: ' ' },
      0,
    );
    expect(result[0]?.memory.status).toBe('stale');
    expect(memory.searchSage).not.toHaveBeenCalled();
  });
});

describe('tool-call middleware failure coverage', () => {
  function payload(
    projectRoot: string | null | undefined = path.resolve('project'),
  ): ToolCallPipelinePayload {
    return {
      toolUse: {
        type: 'tool_use',
        id: 'tool',
        name: 'read',
        input: { path: 'src/a.ts' },
      },
      result: {
        type: 'tool_result',
        tool_use_id: 'tool',
        content: 'source',
      },
      ctx: {
        projectRoot,
        cwd: projectRoot,
        session: { id: 'session' },
        signal: new AbortController().signal,
      },
    } as unknown as ToolCallPipelinePayload;
  }

  it('emits an error trace when path resolution fails before planning', async () => {
    const events = { emit: vi.fn() };
    const middleware = createSageToolCallMiddleware({
      memory: {
        retrieveForPath: vi.fn(async () => []),
        searchSage: vi.fn(async () => []),
      },
      events: events as never,
    });
    const value = payload(null);
    await expect(middleware.handler(value, async (next) => next)).resolves.toBe(value);
    expect(events.emit).toHaveBeenCalledWith(
      'memory.injector_run',
      expect.objectContaining({ outcome: 'error', error: expect.any(String) }),
    );
  });

  it('silently preserves malformed payloads that fail before trigger extraction', async () => {
    const middleware = createSageToolCallMiddleware({
      memory: {
        retrieveForPath: vi.fn(async () => []),
        searchSage: vi.fn(async () => []),
      },
    });
    const malformed = { toolUse: { name: 'read', input: {} }, ctx: {} } as never;
    await expect(middleware.handler(malformed, async (next) => next)).resolves.toBe(malformed);
  });

  it('emits planned retrieval errors for Error and non-Error failures', async () => {
    for (const failure of [new Error('retrieval failed'), 'retrieval failed as text']) {
      const events = { emit: vi.fn() };
      const middleware = createSageToolCallMiddleware({
        memory: {
          retrieveForPath: vi.fn(async () => {
            throw failure;
          }),
          searchSage: vi.fn(async () => []),
        },
        events: events as never,
      });
      const value = payload();
      await expect(middleware.handler(value, async (next) => next)).resolves.toBe(value);
      expect(events.emit).toHaveBeenCalledWith(
        'memory.injector_run',
        expect.objectContaining({
          outcome: 'error',
          error: failure instanceof Error ? failure.message : String(failure),
        }),
      );
    }
  });

  it('keeps injected context and traces an audit-write failure', async () => {
    for (const failure of [new Error('audit failed'), 'audit failed as text']) {
      const events = { emit: vi.fn() };
      const memory = sage('audit', {
        text: 'authentication token validation convention',
        // The anchor is what earns the injection now: a path lookup only
        // contributes relation strength for memories that actually point at
        // the file the tool touched.
        anchors: [{ type: 'file', path: 'src/a.ts' }],
        importance: 1,
        confidence: 1,
        freshness: 1,
      });
      const middleware = createSageToolCallMiddleware({
        memory: {
          retrieveForPath: vi.fn(async () => [memory]),
          searchSage: vi.fn(async () => []),
          recordInjection: vi.fn(async () => {
            throw failure;
          }),
        },
        events: events as never,
        minScore: 0,
      });
      const value = payload();
      await middleware.handler(value, async (next) => next);
      expect(value.result.content).toContain(memory.text);
      expect(events.emit).toHaveBeenCalledWith(
        'memory.injector_run',
        expect.objectContaining({
          outcome: 'injected',
          error: failure instanceof Error ? failure.message : failure,
        }),
      );
    }
  });

  it('decomposes the score into terms that sum back to it', () => {
    // The displayed proof is only trustworthy if the parts add up to the
    // number the gate used. Anything added to the score without a matching
    // term silently makes the UI lie about why a memory was injected.
    const cases: Array<[string, Partial<Sage>, number]> = [
      ['plain', {}, 0.8],
      ['anchored', { anchors: [{ type: 'file', path: 'a.ts' }] }, 0.95],
      ['permanent-used', { persistence: 'permanent', useCount: 4 }, 0.7],
      ['short-lived-unused', { persistence: 'short_lived', injectionCount: 6 }, 0.62],
      ['preference-kind', { kind: 'preference' }, 0.5],
    ];
    for (const [label, overrides, relation] of cases) {
      const proof = coverage.computeInjectionProof(sage(label, overrides), relation);
      const sum = proof.terms.reduce((total, term) => total + term.value, 0);
      expect(Math.max(0, Math.min(1, sum))).toBeCloseTo(proof.score, 10);
      expect(proof.relationStrength).toBe(relation);
    }
  });

  it('keeps the refactored score identical to the original weighting', () => {
    // Independent restatement of the pre-refactor formula. If someone retunes
    // the weights, this fails and forces the change to be deliberate.
    const legacy = (memory: Sage, relation: number): number => {
      const metadata = (memory.importance * 3 + memory.confidence * 2 + memory.freshness) / 6;
      const persistence = memory.persistence ?? 'long_lived';
      const persistenceBoost =
        persistence === 'permanent' ? 0.08 : persistence === 'long_lived' ? 0.04 : -0.08;
      const durable = ['fact', 'decision', 'convention', 'warning', 'anti_pattern', 'workflow',
        'bug_root_cause', 'file_note', 'symbol_note', 'command_note'].includes(memory.kind);
      const uses = memory.useCount ?? 0;
      const injections = memory.injectionCount ?? 0;
      return Math.max(0, Math.min(1,
        metadata * 0.48 +
          relation * 0.48 +
          persistenceBoost +
          (durable ? 0.04 : 0) +
          (uses > 0 ? Math.min(0.14, 0.05 + uses * 0.02) : 0) +
          (memory.anchors.length > 0 ? 0.04 : -0.05) -
          (injections >= 3 && uses === 0 ? Math.min(0.18, 0.05 + injections * 0.012) : 0)));
    };
    for (const relation of [0, 0.62, 0.8, 0.95, 1]) {
      for (const overrides of [
        {},
        { anchors: [{ type: 'file' as const, path: 'a.ts' }] },
        { persistence: 'permanent' as const, useCount: 3 },
        { persistence: 'short_lived' as const, injectionCount: 9 },
        { kind: 'preference' as const },
      ]) {
        const memory = sage('parity', overrides);
        expect(coverage.contextualInjectionScore(memory, relation)).toBeCloseTo(
          legacy(memory, relation),
          10,
        );
      }
    }
  });
});
