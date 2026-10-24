import type { Message } from '@wrongstack/contracts/types/messages';
import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { HybridCompactor } from '../../src/execution/compactor.js';
import { checkCompactionQuality } from '../../src/utils/context-evidence.js';

function fakeContext(messages: Message[]): Context {
  const ctx = { messages } as never as Context;
  (ctx as never as { state: unknown }).state = {
    replaceMessages(next: Message[]) {
      messages.length = 0;
      messages.splice(0, 0, ...next);
    },
    appendMessage(m: Message) {
      messages.splice(messages.length, 0, m);
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// HybridCompactor — additional coverage
// ---------------------------------------------------------------------------
describe('HybridCompactor — extra', () => {
  describe('no-op cases', () => {
    it('returns zero savings when there are few messages', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ];
      const ctx = fakeContext(messages);
      const c = new HybridCompactor({ preserveK: 5 });
      const report = await c.compact(ctx);
      expect(report.before).toBe(report.after);
    });

    it('returns zero savings with empty messages', async () => {
      const messages: Message[] = [];
      const ctx = fakeContext(messages);
      const c = new HybridCompactor();
      const report = await c.compact(ctx);
      expect(report.before).toBe(0);
      expect(report.after).toBe(0);
    });
  });

  describe('elision phase', () => {
    it('elides tool results when they exceed threshold outside preserve window', async () => {
      const big = 'x'.repeat(5000);
      const messages: Message[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: 'user', content: `q${i}` });
        messages.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: {} }],
        });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }],
        });
      }
      const ctx = fakeContext(messages);
      const c = new HybridCompactor({ preserveK: 2, eliseThreshold: 500 });
      const report = await c.compact(ctx);
      expect(report.reductions.some((r) => r.phase === 'elision')).toBe(true);
      expect(report.after).toBeLessThan(report.before);
    });

    it('does not elide when tool results are small', async () => {
      const messages: Message[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: 'user', content: `q${i}` });
        messages.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: {} }],
        });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'small' }],
        });
      }
      const ctx = fakeContext(messages);
      const c = new HybridCompactor({ preserveK: 2, eliseThreshold: 50000 });
      const report = await c.compact(ctx);
      const elision = report.reductions.find((r) => r.phase === 'elision');
      expect(elision).toBeUndefined();
    });
  });

  describe('aggressive collapse', () => {
    it('does nothing when cutTarget <= 0', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'only' },
        { role: 'assistant', content: 'one turn' },
      ];
      const ctx = fakeContext(messages);
      const c = new HybridCompactor({ preserveK: 5 });
      const report = await c.compact(ctx, { aggressive: true });
      // With 2 messages and preserveK=5 (needs 10 messages to cut), nothing collapses
      expect(ctx.messages.length).toBe(2);
      expect(report.before).toBe(report.after);
    });

    it('does nothing when no user boundary is found after cutTarget', async () => {
      // All assistant messages at the end — no user message to use as boundary
      const messages: Message[] = [];
      for (let i = 0; i < 6; i++) {
        messages.push({ role: 'user', content: `q${i}` });
      }
      for (let i = 0; i < 6; i++) {
        messages.push({ role: 'assistant', content: `a${i}` });
      }
      const ctx = fakeContext(messages);
      const c = new HybridCompactor({ preserveK: 1 });
      const report = await c.compact(ctx, { aggressive: true });
      // cutTarget = max(0, 12 - 2) = 10. From index 10 onward we have 2
      // assistant messages only (a4, a5), no user → boundary stays -1 → saved=0
      expect(report.before).toBe(report.after);
    });

    it('uses smart digest when smart option is true', async () => {
      const messages: Message[] = [];
      for (let i = 0; i < 12; i++) {
        messages.push({ role: 'user', content: `q${i} ${'x'.repeat(100)}` });
        messages.push({ role: 'assistant', content: `a${i}` });
      }
      const ctx = fakeContext(messages);
      const c = new HybridCompactor({ preserveK: 3, smart: true });
      const report = await c.compact(ctx, { aggressive: true });
      expect(ctx.messages.length).toBeLessThan(24);
      expect(report.collapsedDigest).toBeTruthy();
    });

    it('includes evidence digest when contextEvidence exists', async () => {
      const messages: Message[] = [];
      for (let i = 0; i < 12; i++) {
        messages.push({ role: 'user', content: `q${i}` });
        messages.push({ role: 'assistant', content: `a${i}` });
      }
      const ctx = fakeContext(messages);
      ctx.contextEvidence = {
        currentIntent: { text: 'test intent', updatedAt: Date.now() },
        fileGraph: {},
        toolCalls: [],
        recentToolCalls: [],
        goalTree: {},
        sessionGoals: [],
        todoItems: [],
        activeTodo: undefined,
        activeErrors: [],
        implicitFacts: [],
      } as never;
      const c = new HybridCompactor({ preserveK: 2 });
      const report = await c.compact(ctx, { aggressive: true });
      expect(report.evidenceDigest).toBeTruthy();
      expect(report.collapsedDigest).toContain('[context_state]');
    });
  });

  describe('quality check', () => {
    it('reports quality issues when intent and path trail missing after reduction', async () => {
      // Generate many messages with no intent/goal content
      const messages: Message[] = [];
      // Bulky turns: with tiny ones the collapse digest's own overhead made the
      // transcript LARGER, so nothing was "reduced" and no issue could be raised.
      for (let i = 0; i < 30; i++) {
        messages.push({ role: 'user', content: `query ${i} ${'lorem '.repeat(80)}` });
        messages.push({ role: 'assistant', content: `response ${i} ${'ipsum '.repeat(80)}` });
      }
      const ctx = fakeContext(messages);
      ctx.contextEvidence = {
        currentIntent: null,
        fileGraph: {},
        toolCalls: [],
        recentToolCalls: [],
        goalTree: {},
        sessionGoals: [],
        todoItems: [],
        activeTodo: undefined,
        activeErrors: [],
        implicitFacts: [],
      } as never;
      const c = new HybridCompactor({ preserveK: 2 });
      const report = await c.compact(ctx, { aggressive: true });
      // The old `if (report.quality)` guard plus field-presence checks let a
      // check that never flagged anything pass. Two real contracts instead:
      //
      // 1. No false alarm. The ancient-turn collapse is LOSSLESS for text (only
      //    raw tool I/O is dropped), so a text-only history is not reduced —
      //    it even grows by the digest framing — and quality must stay ok.
      expect(report.after).toBeGreaterThanOrEqual(report.before);
      expect(report.quality).toMatchObject({ ok: true, issues: [] });

      // 2. Real detection. After an actual reduction with no intent, no
      //    file/tool evidence and a keyword-free digest, both anchors are
      //    reported missing (these drive the evidence-floor re-injection).
      const quality = checkCompactionQuality(ctx, {
        collapsedDigest: 'query 1\nresponse 1',
        reduced: true,
      });
      expect(quality).toMatchObject({ ok: false, hasIntent: false, hasPathTrail: false });
      expect(quality?.issues).toHaveLength(2);
    });

    it('reports quality ok when digest contains intent keywords', async () => {
      const messages: Message[] = [];
      for (let i = 0; i < 12; i++) {
        messages.push({ role: 'user', content: `session_goals: test ${i}` });
        messages.push({ role: 'assistant', content: `a${i}` });
      }
      const ctx = fakeContext(messages);
      const c = new HybridCompactor({ preserveK: 2 });
      const report = await c.compact(ctx, { aggressive: true });
      // After compaction, the digest should contain "session_goals"
      // which the quality check recognizes as intent
      expect(report.quality?.hasIntent).toBe(true);
    });
  });

  describe('context window policy', () => {
    it('ignores invalid policy in ctx.meta', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ];
      const ctx = fakeContext(messages);
      ctx.meta = { contextWindowPolicy: 'not-an-object' as never };
      const c = new HybridCompactor({ preserveK: 5 });
      const report = await c.compact(ctx);
      // Should not crash, fall through to defaults
      expect(report.before).toBe(report.after);
    });

    it('ignores policy with missing preserveK or eliseThreshold', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ];
      const ctx = fakeContext(messages);
      ctx.meta = {
        contextWindowPolicy: {
          id: 'test',
          name: 'Test',
          description: '',
          thresholds: { warn: 0.45, soft: 0.6, hard: 0.75 },
          targetLoad: 0.5,
          // missing preserveK and eliseThreshold
        },
      };
      const c = new HybridCompactor({ preserveK: 3 });
      const report = await c.compact(ctx);
      // Should not crash
      expect(report.before).toBe(report.after);
    });
  });

  describe('message repair', () => {
    it('repairs orphan tool_use/tool_result blocks after compaction', async () => {
      // Situation: an assistant tool_use without matching user tool_result
      const messages: Message[] = [
        { role: 'user', content: 'old query' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'looking into it' },
            { type: 'tool_use', id: 'orphan', name: 'read', input: {} },
          ],
        },
        { role: 'user', content: 'recent query' },
        { role: 'assistant', content: 'recent answer' },
      ];
      const ctx = fakeContext(messages);
      const c = new HybridCompactor({ preserveK: 1, eliseThreshold: 1 });
      // NOT aggressive: the aggressive collapse already swallows old turns, so
      // the orphan vanished even with the repair step disabled (mutation-proven).
      // Here only the repair can remove it.
      const report = await c.compact(ctx);
      expect(report.repaired?.removedToolUses).toEqual(['orphan']);
      // Only the protocol block is dropped; the assistant's prose survives.
      expect(JSON.stringify(ctx.messages)).toContain('looking into it');
      // And the invariant itself: after compaction no tool_use may be left
      // without its tool_result (providers reject such a transcript outright).
      const blocks = ctx.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
      const useIds = blocks.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
      const resultIds = new Set(
        blocks.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])),
      );
      expect(useIds.filter((id) => !resultIds.has(id))).toEqual([]);
      // The recent exchange survives the repair.
      expect(JSON.stringify(ctx.messages)).toContain('recent answer');
    });
  });
});
