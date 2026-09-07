import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  type MemoryPort,
  SAGE_SURFACE_CAPABILITY,
  type Sage,
  type SageSurface,
} from '../../src/index.js';
import { createSageDomainTermExtractorMiddleware } from '../../src/middleware/domain-term-extractor-middleware.js';
import { createSageOutcomeCaptureMiddleware } from '../../src/middleware/outcome-capture.js';
import { createSagePathRemapMiddleware } from '../../src/middleware/path-remap.js';
import {
  applyCooldown,
  availableHintChars,
  containsMemoryText,
  pruneCooldowns,
  visibleContextText,
} from '../../src/middleware/tool-call-memory-retrieval.js';
import {
  observeBurstRejections,
  containsMemoryText as scoringContainsMemoryText,
} from '../../src/middleware/tool-call-memory-scoring.js';
import {
  dedupeRetrievedByText,
  selectDiverseMemories,
} from '../../src/middleware/tool-call-memory-trace.js';

function makeMemory(id: string, overrides: Partial<Sage> = {}): Sage {
  return {
    id,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: `text for ${id}`,
    importance: 0.8,
    confidence: 0.8,
    freshness: 0.8,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePort(surface: Partial<SageSurface>): MemoryPort {
  return {
    getCapability: (cap: unknown) => {
      if (cap === SAGE_SURFACE_CAPABILITY) return surface as SageSurface;
      return undefined;
    },
  } as unknown as MemoryPort;
}

describe('sage middleware 100% coverage suite', () => {
  describe('path-remap.ts', () => {
    it('handles shell command renames (mv) and remaps memory anchors', async () => {
      const memories: Sage[] = [
        makeMemory('m1', {
          anchors: [{ type: 'file', path: 'old/file.ts' }],
        }),
      ];
      const updated: Array<{ id: string; patch: Partial<Sage> }> = [];
      const surface: Partial<SageSurface> = {
        listSage: vi.fn(async () => memories),
        updateSage: vi.fn(async (id, patch) => {
          updated.push({ id, patch });
          return memories[0]!;
        }),
      };
      const memory = makePort(surface);
      const mw = createSagePathRemapMiddleware({ memory });

      const payload: ToolCallPipelinePayload = {
        toolUse: {
          id: 'call_1',
          name: 'bash',
          input: { command: 'mv old/file.ts new/file.ts' },
        },
        ctx: {
          projectRoot: '/project',
          cwd: '/project',
        } as unknown as ToolCallPipelinePayload['ctx'],
        result: {
          content: 'success',
          is_error: false,
        },
      };

      const res = await mw.handler(payload, async (p) => p);
      expect(res.result.content).toBe('success');
      expect(updated).toHaveLength(1);
      expect(updated[0]?.patch.anchors).toEqual([{ type: 'file', path: 'new/file.ts' }]);
    });

    it('handles lsp_rename capturing old symbol and updating symbol anchors and text', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-remap-'));
      const testFile = path.join(tmpDir, 'test.ts');
      fs.writeFileSync(testFile, 'const myOldIdentifier = 42;\n', 'utf8');

      const memories: Sage[] = [
        makeMemory('m-sym', {
          text: 'Usage of myOldIdentifier here',
          anchors: [{ type: 'symbol', path: 'test.ts', symbol: 'myOldIdentifier' }],
        }),
      ];
      const updated: Array<{ id: string; patch: Partial<Sage> }> = [];
      const surface: Partial<SageSurface> = {
        listSage: vi.fn(async () => memories),
        updateSage: vi.fn(async (id, patch) => {
          updated.push({ id, patch });
          return memories[0]!;
        }),
      };
      const memory = makePort(surface);
      const mw = createSagePathRemapMiddleware({ memory });

      const payload: ToolCallPipelinePayload = {
        toolUse: {
          id: 'call_lsp',
          name: 'lsp_rename',
          input: {
            path: testFile,
            line: 1,
            character: 8, // inside myOldIdentifier
            new_name: 'myNewIdentifier',
          },
        },
        ctx: {
          projectRoot: tmpDir,
          cwd: tmpDir,
        } as unknown as ToolCallPipelinePayload['ctx'],
        result: {
          content: 'renamed',
          is_error: false,
        },
      };

      await mw.handler(payload, async (p) => p);
      expect(updated).toHaveLength(1);
      expect(updated[0]?.patch.anchors).toEqual([
        { type: 'symbol', path: 'test.ts', symbol: 'myNewIdentifier' },
      ]);
      expect(updated[0]?.patch.text).toBe('Usage of myNewIdentifier here');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('respects allow rate-limiter and skips when result is_error or surface missing', async () => {
      const mwNoSurface = createSagePathRemapMiddleware({ memory: makePort({}) });
      const payloadErr: ToolCallPipelinePayload = {
        toolUse: { id: 'c', name: 'bash', input: { command: 'mv a b' } },
        ctx: { projectRoot: '/p', cwd: '/p' } as any,
        result: { content: 'err', is_error: true },
      };
      await mwNoSurface.handler(payloadErr, async (p) => p);

      const mwLimited = createSagePathRemapMiddleware({
        memory: makePort({ listSage: vi.fn(async () => []), updateSage: vi.fn() }),
        maxPerHour: 0, // blocks all
      });
      const payloadOk: ToolCallPipelinePayload = {
        toolUse: { id: 'c2', name: 'bash', input: { command: 'mv a.ts b.ts' } },
        ctx: { projectRoot: '/p', cwd: '/p' } as any,
        result: { content: 'ok', is_error: false },
      };
      await mwLimited.handler(payloadOk, async (p) => p);
    });
  });

  describe('outcome-capture.ts', () => {
    it('captures error patterns when errorPatterns: true', async () => {
      const remembered: Sage[] = [];
      const surface: Partial<SageSurface> = {
        rememberSage: vi.fn(async (input) => {
          const mem = makeMemory('err-1', input);
          remembered.push(mem);
          return mem;
        }),
      };
      const mw = createSageOutcomeCaptureMiddleware({
        memory: makePort(surface),
        errorPatterns: true,
      });

      const payload: ToolCallPipelinePayload = {
        toolUse: {
          id: 'c',
          name: 'bash',
          input: { command: 'npm test' },
        },
        ctx: {} as any,
        result: {
          content: 'Error: Cannot find module foo',
          is_error: true,
        },
      };

      await mw.handler(payload, async (p) => p);
      expect(remembered).toHaveLength(1);
      expect(remembered[0]?.kind).toBe('error_pattern');
      expect(remembered[0]?.text).toContain('Error: Cannot find module foo');
    });

    it('returns early when both toolOutcomes and errorPatterns are disabled or surface missing', async () => {
      const mw = createSageOutcomeCaptureMiddleware({
        memory: makePort({}),
        toolOutcomes: false,
        errorPatterns: false,
      });
      const payload: ToolCallPipelinePayload = {
        toolUse: { id: 'c', name: 'bash', input: {} },
        ctx: {} as any,
        result: { content: 'ok', is_error: false },
      };
      const res = await mw.handler(payload, async (p) => p);
      expect(res).toBe(payload);
    });
  });

  describe('domain-term-extractor-middleware.ts', () => {
    it('extracts messages with block array content and handles projectRoot undefined', async () => {
      const mockExtractor = {
        extractFromConversation: vi.fn(() => [{ term: 'foo', confidence: 0.9 }]),
        persistVia: vi.fn(async () => 1),
        persistViaAndMirror: vi.fn(async () => 1),
      };
      const logLines: string[] = [];

      const mw = createSageDomainTermExtractorMiddleware({
        memory: makePort({}),
        projectRoot: undefined, // test projectRoot === undefined path
        extractorFactory: () => mockExtractor as any,
        log: (l) => logLines.push(l),
      });

      const request = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'image', text: null },
              { content: 'world' },
            ],
          },
          {
            role: 'assistant',
            content: 'I can help with foo term',
          },
          {
            role: 'system',
            content: 'system message ignored',
          },
        ],
      };

      await mw.handler(request as any, async (r) => r);
      // Wait for microtask queue
      await new Promise((r) => setTimeout(r, 10));

      expect(mockExtractor.extractFromConversation).toHaveBeenCalled();
      expect(mockExtractor.persistVia).toHaveBeenCalled();
      expect(mockExtractor.persistViaAndMirror).not.toHaveBeenCalled();
    });

    it('catches extraction errors and logs them, and handles extractSnapshot failure', async () => {
      const logLines: string[] = [];
      const mw = createSageDomainTermExtractorMiddleware({
        memory: makePort({}),
        extractorFactory: () => {
          throw new Error('extractor init failure');
        },
        log: (l) => logLines.push(l),
      });

      const request = {
        messages: [{ role: 'user', content: 'test msg' }],
      };

      await mw.handler(request as any, async (r) => r);
      await new Promise((r) => setTimeout(r, 10));
      expect(logLines.some((l) => l.includes('extractor init failure'))).toBe(true);

      // Extract snapshot throwing
      const badRequest = {
        get messages() {
          throw new Error('messages access error');
        },
      };
      const res = await mw.handler(badRequest as any, async (r) => r);
      expect(res).toBe(badRequest);
    });
  });

  describe('tool-call-memory-trace.ts', () => {
    it('dedupeRetrievedByText deduplicates by normalized text', () => {
      const m1 = makeMemory('1', { text: 'Hello   World' });
      const m2 = makeMemory('2', { text: 'hello world' });
      const m3 = makeMemory('3', { text: 'Different text' });

      const deduped = dedupeRetrievedByText([
        { memory: m1, reason: 'r1' } as any,
        { memory: m2, reason: 'r2' } as any,
        { memory: m3, reason: 'r3' } as any,
      ]);

      expect(deduped).toHaveLength(2);
      expect(deduped[0]?.memory.id).toBe('1');
      expect(deduped[1]?.memory.id).toBe('3');
    });

    it('selectDiverseMemories covers diversity caps, deferred kinds, and limit cuts', () => {
      // 1. limit <= 0
      const r0 = selectDiverseMemories([makeMemory('1')], 0);
      expect(r0.selected).toHaveLength(0);
      expect(r0.dropped).toHaveLength(1);

      // 2. graphOnly and queryOnly caps
      const reasons = new Map<string, string[]>();
      reasons.set('g1', ['graph:related']);
      reasons.set('g2', ['graph:related']);
      reasons.set('q1', ['query:keyword']);
      reasons.set('q2', ['query:keyword']);
      reasons.set('q3', ['query:keyword']);

      const memories = [
        makeMemory('g1'),
        makeMemory('g2'),
        makeMemory('q1'),
        makeMemory('q2'),
        makeMemory('q3'),
      ];

      const rCaps = selectDiverseMemories(memories, 10, reasons);
      // g2 dropped by graphOnly cap (1)
      expect(rCaps.dropped.some((d) => d.memory.id === 'g2')).toBe(true);
      // q3 dropped by queryOnly cap (2)
      expect(rCaps.dropped.some((d) => d.memory.id === 'q3')).toBe(true);

      // 3. Kind count >= 3 gets deferred
      const mSameKind = [
        makeMemory('k1', { kind: 'fact' }),
        makeMemory('k2', { kind: 'fact' }),
        makeMemory('k3', { kind: 'fact' }),
        makeMemory('k4', { kind: 'fact' }), // deferred
        makeMemory('k5', { kind: 'decision' }),
      ];
      const rDeferred = selectDiverseMemories(mSameKind, 5);
      expect(rDeferred.selected.map((m) => m.id)).toEqual(['k1', 'k2', 'k3', 'k5', 'k4']);

      // 4. selected.length >= limit reaches cut
      const rLimit = selectDiverseMemories(
        [
          makeMemory('a1', { kind: 'fact' }),
          makeMemory('a2', { kind: 'fact' }),
          makeMemory('a3', { kind: 'fact' }),
          makeMemory('a4', { kind: 'fact' }), // deferred
          makeMemory('a5', { kind: 'decision' }),
          makeMemory('a6', { kind: 'decision' }),
        ],
        2,
      );
      expect(rLimit.selected).toHaveLength(2);
      expect(rLimit.dropped.length).toBeGreaterThan(0);
    });
  });

  describe('tool-call-memory-retrieval.ts', () => {
    it('applyCooldown and pruneCooldowns handle cooldown windows and cleanup', () => {
      const seen = new Map<string, number>();
      const now = Date.now();
      seen.set('<no-session>:m1', now - 10_000); // 10s ago
      seen.set('<no-session>:m2', now - 100_000); // 100s ago

      const m1 = makeMemory('m1');
      const m2 = makeMemory('m2');
      const m3 = makeMemory('m3');

      // Cooldown 30s: m1 is active cooldown, m2 is expired cooldown, m3 never seen
      const filtered = applyCooldown([m1, m2, m3], seen, 30_000);
      expect(filtered.map((m) => m.id)).toEqual(['m2', 'm3']);

      // repeatCooldownMs <= 0: all seen memories blocked
      const blocked = applyCooldown([m1, m2, m3], seen, 0);
      expect(blocked.map((m) => m.id)).toEqual(['m3']);

      // pruneCooldowns
      const pruneState = { lastPruneAt: 0 };
      pruneCooldowns(seen, pruneState, now, 50_000);
      expect(seen.has('<no-session>:m1')).toBe(true);
      expect(seen.has('<no-session>:m2')).toBe(false); // pruned

      // Calling again within 60s does not prune
      pruneCooldowns(seen, pruneState, now + 10_000, 50_000);
      expect(pruneState.lastPruneAt).toBe(now);
    });

    it('visibleContextText extracts text from result and prompt blocks', () => {
      const payload: ToolCallPipelinePayload = {
        toolUse: { id: 'c', name: 'read', input: {} },
        ctx: {
          systemPrompt: [{ text: 'System prompt instruction' }, { text: 'Another block' }],
        } as any,
        result: {
          content: 'Result content text',
          is_error: false,
        },
      };
      const text = visibleContextText(payload);
      expect(text).toContain('result content text');
      expect(text).toContain('system prompt instruction');
      expect(text).toContain('another block');
    });

    it('containsMemoryText verifies minimum length requirement', () => {
      expect(containsMemoryText('long text here', 'ab')).toBe(false);
      expect(
        containsMemoryText(
          'some long text here that includes this phrase definitely',
          'that includes this phrase definitely',
        ),
      ).toBe(true);
    });

    it('availableHintChars respects tool.maxOutputBytes', () => {
      const payloadWithoutLimit: ToolCallPipelinePayload = {
        toolUse: { id: 'c', name: 'read', input: {} },
        ctx: {} as any,
        result: { content: 'hello', is_error: false },
      };
      expect(availableHintChars(payloadWithoutLimit, 500)).toBe(500);

      const payloadWithLimit: ToolCallPipelinePayload = {
        toolUse: { id: 'c', name: 'read', input: {} },
        tool: { maxOutputBytes: 20 } as any,
        ctx: {} as any,
        result: { content: '1234567890', is_error: false }, // 10 bytes
      };
      // remaining = 20 - 10 - 2 = 8. 8 / 3 = 2 chars
      expect(availableHintChars(payloadWithLimit, 500)).toBe(2);
    });
  });

  describe('tool-call-memory-scoring.ts', () => {
    it('observeBurstRejections tracks rejection burst and emits burst event', () => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const fakeBus = {
        emit: (event: string, payload: unknown) => {
          emitted.push({ event, payload });
        },
      };

      const now = Date.now();
      // Emit multiple rejections with gate 'belowScore' to reach BURST_THRESHOLD (3)
      for (let i = 0; i < 3; i++) {
        observeBurstRejections(
          [
            {
              id: 'burst-mem',
              kind: 'fact',
              gate: 'belowScore',
              reason: 'low score',
              at: new Date(now + i * 10).toISOString(),
            },
          ],
          fakeBus as any,
          now + i * 10,
        );
      }

      expect(emitted.some((e) => e.event === 'memory.injector_rejection_burst')).toBe(true);

      // Overflow history past BURST_THRESHOLD * 2 (6)
      for (let i = 0; i < 10; i++) {
        observeBurstRejections(
          [
            {
              id: 'burst-mem',
              kind: 'fact',
              gate: 'belowScore',
              reason: 'low score',
              at: new Date(now + 100 + i * 10).toISOString(),
            },
          ],
          fakeBus as any,
          now + 100 + i * 10,
        );
      }
    });

    it('scoring containsMemoryText checks min length', () => {
      expect(scoringContainsMemoryText('haystack', 'short')).toBe(false);
      expect(
        scoringContainsMemoryText(
          'haystack with enough text to exceed minimum length requirement',
          'enough text to exceed minimum length requirement',
        ),
      ).toBe(true);
    });
  });
});
