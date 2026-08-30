import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { HybridCompactor } from '../../src/execution/compactor.js';
import { createContextEvidenceState } from '../../src/utils/context-evidence.js';
import type { Message } from '../../src/types/messages.js';

function fakeContext(messages: Message[]): Context {
  const ctx = { messages } as never as Context;
  // Minimal state shim — compactors route mutations through ctx.state since
  // L1-A, but we don't want each test to spin up the full Context.
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

describe('HybridCompactor', () => {
  it('elides large old tool_results outside preserve window', async () => {
    const big = 'x'.repeat(4_000);
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `query ${i}` });
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
    const c = new HybridCompactor({ preserveK: 5, eliseThreshold: 1000 });
    const report = await c.compact(ctx);
    expect(report.reductions.some((r) => r.phase === 'elision')).toBe(true);
    expect(report.after).toBeLessThan(report.before);
  });

  it('aggressive mode collapses ancient turns', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `t${i} ${'x'.repeat(500)}` });
      messages.push({ role: 'assistant', content: 'ok' });
    }
    const ctx = fakeContext(messages);
    const c = new HybridCompactor({ preserveK: 3 });
    const before = messages.length;
    await c.compact(ctx, { aggressive: true });
    expect(ctx.messages.length).toBeLessThan(before);
  });

  it('preserves recent turns', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `q${i}` });
      messages.push({ role: 'assistant', content: `a${i}` });
    }
    const lastFew = messages.slice(-6);
    const ctx = fakeContext(messages);
    const c = new HybridCompactor({ preserveK: 3 });
    await c.compact(ctx, { aggressive: true });
    for (const m of lastFew) {
      expect(ctx.messages).toContainEqual(m);
    }
  });

  it('honors context-window policy from ctx.meta', async () => {
    const big = 'x'.repeat(5000);
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: big }] },
      { role: 'assistant', content: 'old done' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'recent', name: 'read', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'recent', content: big }] },
    ];
    const ctx = fakeContext(messages);
    ctx.meta = {
      contextWindowPolicy: {
        id: 'frugal',
        name: 'Frugal',
        description: '',
        thresholds: { warn: 0.45, soft: 0.6, hard: 0.75 },
        aggressiveOn: 'warn',
        preserveK: 1,
        eliseThreshold: 500,
        targetLoad: 0.5,
      },
    };
    const c = new HybridCompactor({ preserveK: 20, eliseThreshold: 10000 });
    await c.compact(ctx);

    expect(JSON.stringify(ctx.messages[1])).toContain('[elided:');
    expect(JSON.stringify(ctx.messages[4])).toContain(big);
  });

  it('repairs orphan protocol blocks after compaction', async () => {
    const messages: Message[] = [
      { role: 'user', content: `old ${'x'.repeat(500)}` },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'cut', name: 'read', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'tail' },
          { type: 'tool_result', tool_use_id: 'cut', content: 'late' },
        ],
      },
      { role: 'assistant', content: 'done' },
    ];
    const ctx = fakeContext(messages);
    const c = new HybridCompactor({ preserveK: 1 });

    const report = await c.compact(ctx, { aggressive: true });

    expect(report.repaired).toEqual({
      removedToolUses: [],
      removedToolResults: ['cut'],
      removedMessages: 0,
    });
    expect(JSON.stringify(ctx.messages)).not.toContain('"tool_use"');
    // Lossless collapse: ancient turns become a single `system` digest that
    // PRESERVES the original user text (no more placeholder data loss). The
    // dropped tool_use is noted as an omitted-tool marker, not silently lost.
    const digestMsg = ctx.messages[0];
    expect(digestMsg?.role).toBe('system');
    expect(String(digestMsg?.content)).toContain('[prior_turns_digest:');
    expect(String(digestMsg?.content)).toContain('old'); // original user instruction kept
    expect(String(digestMsg?.content)).toContain('tool call(s) omitted');
    // Tail preserved; orphan tool_result stripped down to its text block.
    expect(ctx.messages.slice(1)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'tail' }] },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('aggressive collapse preserves earlier text (lossless) and reports the digest', async () => {
    const messages: Message[] = [];
    messages.push({ role: 'user', content: 'IMPORTANT: always use tabs not spaces' });
    messages.push({ role: 'assistant', content: 'Understood, using tabs.' });
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `q${i}` });
      messages.push({ role: 'assistant', content: `a${i}` });
    }
    const ctx = fakeContext(messages);
    const c = new HybridCompactor({ preserveK: 3 });
    const report = await c.compact(ctx, { aggressive: true });

    // The early instruction must survive collapse — previously it was deleted
    // and replaced with a static placeholder.
    const digestMsg = ctx.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('prior_turns_digest'),
    );
    expect(digestMsg).toBeDefined();
    expect(String(digestMsg?.content)).toContain('IMPORTANT: always use tabs not spaces');
    expect(report.collapsedDigest).toContain('IMPORTANT: always use tabs not spaces');
  });

  it('injects context evidence into aggressive collapse digests', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: 'user', content: `q${i}` });
      messages.push({ role: 'assistant', content: `a${i}` });
    }
    const ctx = fakeContext(messages);
    ctx.contextEvidence = createContextEvidenceState();
    ctx.contextEvidence.currentIntent = {
      text: 'improve context window management',
      updatedAt: Date.now(),
    };
    ctx.contextEvidence.fileGraph['packages/core/src/execution/compactor.ts'] = {
      path: 'packages/core/src/execution/compactor.ts',
      reads: 1,
      writes: 0,
      tools: ['read#u1'],
      referenced: true,
      lastToolUseId: 'u1',
    };
    ctx.contextEvidence.toolCalls.push({
      toolUseId: 'u1',
      toolName: 'read',
      ok: true,
      summary: 'read packages/core/src/execution/compactor.ts',
      files: ['packages/core/src/execution/compactor.ts'],
      symbols: ['HybridCompactor'],
      commands: [],
      errors: [],
      status: 'referenced',
      referenceCount: 1,
      seenAt: Date.now(),
    });

    const report = await new HybridCompactor({ preserveK: 2 }).compact(ctx, { aggressive: true });

    expect(report.evidenceDigest).toContain('intent: improve context window management');
    expect(report.collapsedDigest).toContain('[context_state]');
    expect(report.collapsedDigest).toContain('dependency_graph');
    expect(report.collapsedDigest).toContain('packages/core/src/execution/compactor.ts');
    expect(report.quality?.ok).toBe(true);
  });
});
