import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import {
  buildConversationContinuityBlock,
  buildContextEvidenceDigest,
  createContextEvidenceState,
  markAssistantReferencedEvidence,
  recordToolOutputEvidence,
  recordUserIntentEvidence,
  repeatedReadPressure,
} from '../../src/utils/context-evidence.js';

function makeCtx(projectRoot = process.cwd()): Context {
  return { projectRoot } as never as Context;
}

describe('createContextEvidenceState', () => {
  it('returns a fresh empty state', () => {
    const s = createContextEvidenceState();
    expect(s.sessionGoals).toEqual([]);
    expect(s.toolCalls).toEqual([]);
    expect(s.fileGraph).toEqual({});
    expect(typeof s.updatedAt).toBe('number');
  });
});

describe('recordUserIntentEvidence', () => {
  it('records the intent and pushes goalish text to sessionGoals', () => {
    const ctx = makeCtx();
    recordUserIntentEvidence(ctx, 'Implement the auth module');
    const s = (
      ctx as never as {
        contextEvidence: { currentIntent: { text: string }; sessionGoals: string[] };
      }
    ).contextEvidence;
    expect(s.currentIntent.text).toBe('Implement the auth module');
    expect(s.sessionGoals).toContain('Implement the auth module');
  });

  it('bounds the real-user continuity tail independently of tool messages', () => {
    const ctx = makeCtx();
    for (let i = 0; i < 12; i++) recordUserIntentEvidence(ctx, `instruction ${i}`);
    const state = (
      ctx as never as { contextEvidence: { recentUserTurns: Array<{ text: string }> } }
    ).contextEvidence;
    expect(state.recentUserTurns).toHaveLength(8);
    expect(state.recentUserTurns[0]?.text).toBe('instruction 4');
    expect(state.recentUserTurns.at(-1)?.text).toBe('instruction 11');
  });

  it('does not add non-goalish text when goals already exist', () => {
    const ctx = makeCtx();
    recordUserIntentEvidence(ctx, 'Implement feature X');
    recordUserIntentEvidence(ctx, 'thanks'); // not goalish, goals non-empty
    const s = (ctx as never as { contextEvidence: { sessionGoals: string[] } }).contextEvidence;
    expect(s.sessionGoals).toEqual(['Implement feature X']);
  });

  it('ignores empty/whitespace intent', () => {
    const ctx = makeCtx();
    recordUserIntentEvidence(ctx, '   ');
    expect((ctx as never as { contextEvidence?: unknown }).contextEvidence).toBeUndefined();
  });

  it('does not let runtime Kanban/status steering displace human turns', () => {
    const ctx = makeCtx();
    recordUserIntentEvidence(ctx, 'Keep working on the context task');
    recordUserIntentEvidence(ctx, '[KANBAN TODO UPDATE] internal board refresh');
    const state = (
      ctx as never as {
        contextEvidence: {
          currentIntent: { text: string };
          recentUserTurns: Array<{ text: string }>;
        };
      }
    ).contextEvidence;
    expect(state.currentIntent.text).toBe('Keep working on the context task');
    expect(state.recentUserTurns.map((turn) => turn.text)).toEqual([
      'Keep working on the context task',
    ]);
  });

  it('dedups + bounds sessionGoals', () => {
    const ctx = makeCtx();
    for (let i = 0; i < 12; i++) recordUserIntentEvidence(ctx, `goal ${i}`);
    recordUserIntentEvidence(ctx, 'goal 0'); // dup → moved to end
    const s = (ctx as never as { contextEvidence: { sessionGoals: string[] } }).contextEvidence;
    expect(s.sessionGoals.length).toBe(8);
    expect(s.sessionGoals.at(-1)).toBe('goal 0');
  });
});

describe('buildConversationContinuityBlock', () => {
  it('keeps recent human instructions visible with a fixed-size volatile block', () => {
    const ctx = makeCtx();
    recordUserIntentEvidence(ctx, 'Fix cancellation without invoking fallbacks');
    recordUserIntentEvidence(ctx, 'Continue, and keep the second session running');
    const block = buildConversationContinuityBlock(ctx);

    expect(block?.text).toContain('[conversation_continuity]');
    expect(block?.text).toContain('prior-1: Fix cancellation');
    expect(block?.text).toContain('current: Continue');
    // Marker-free by design: the block rides the live-context tail AFTER the
    // deep cache boundary; a cache_control here would churn the cache.
    expect(block?.cache_control).toBeUndefined();
    expect(block?.text.length).toBeLessThan(4_000);
  });

  it('rebuilds continuity from journaled user_input provenance on resume', () => {
    const ctx = {
      contextEvidence: createContextEvidenceState(),
      messages: [
        { role: 'user', content: 'real instruction', origin: 'user_input' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'large output' }],
        },
        { role: 'user', content: '[loop-detector] retry', origin: 'runtime' },
      ],
    } as never as Context;

    const block = buildConversationContinuityBlock(ctx);
    expect(block?.text).toContain('real instruction');
    expect(block?.text).not.toContain('large output');
    expect(block?.text).not.toContain('loop-detector');
  });
});

describe('recordToolOutputEvidence', () => {
  it('extracts files, symbols, commands, errors and records metadata', () => {
    const ctx = makeCtx();
    const meta = recordToolOutputEvidence(ctx, {
      toolUseId: 't1',
      toolName: 'bash',
      input: { command: 'npm test', path: 'src/a.ts' },
      content: 'src/b.ts:1\nfunction foo() {}\nError: something failed',
      ok: false,
    });
    expect(meta.toolName).toBe('bash');
    expect(meta.commands).toEqual(['npm test']);
    expect(meta.symbols).toContain('foo');
    expect(meta.errors.some((e) => e.includes('failed'))).toBe(true);
    expect(meta.files.length).toBeGreaterThan(0);
    expect(meta.inputSummary).toContain('path=src/a.ts');
    expect(
      (ctx as never as { contextEvidence: { toolCalls: unknown[] } }).contextEvidence.toolCalls,
    ).toHaveLength(1);
  });

  it('caps toolCalls at 80', () => {
    const ctx = makeCtx();
    for (let i = 0; i < 85; i++) {
      recordToolOutputEvidence(ctx, {
        toolUseId: `t${i}`,
        toolName: 'read',
        input: { path: 'a.ts' },
        content: 'x',
        ok: true,
      });
    }
    expect(
      (ctx as never as { contextEvidence: { toolCalls: unknown[] } }).contextEvidence.toolCalls,
    ).toHaveLength(80);
  });

  it('normalises an absolute path under projectRoot to a relative one', () => {
    const root = process.cwd();
    const ctx = makeCtx(root);
    const child = path.join(root, 'src', 'a.ts');
    const meta = recordToolOutputEvidence(ctx, {
      toolUseId: 't1',
      toolName: 'read',
      input: { path: child },
      content: 'x',
      ok: true,
    });
    expect(meta.files).toContain('src/a.ts');
  });

  it('records a write into the file graph (writes counter)', () => {
    const ctx = makeCtx();
    recordToolOutputEvidence(ctx, {
      toolUseId: 't1',
      toolName: 'edit',
      input: { path: 'a.ts' },
      content: '',
      ok: true,
    });
    const fg = (
      ctx as never as {
        contextEvidence: { fileGraph: Record<string, { writes: number; reads: number }> };
      }
    ).contextEvidence.fileGraph;
    expect(fg['a.ts']!.writes).toBe(1);
    expect(fg['a.ts']!.reads).toBe(0);
  });

  it('summarises read/grep/edit/write outputs', () => {
    const read = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 'r',
      toolName: 'read',
      input: { path: 'a.ts' },
      content: 'x',
      ok: true,
    });
    expect(read.summary).toBe('read a.ts');
    const grep = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 'g',
      toolName: 'grep',
      input: { pattern: 'foo' },
      content: 'a.ts:1:foo',
      ok: true,
    });
    expect(grep.summary).toContain('searched foo');
    const edit = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 'e',
      toolName: 'edit',
      input: { path: 'a.ts' },
      content: '',
      ok: true,
    });
    expect(edit.summary).toBe('edited a.ts');
    const write = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 'w',
      toolName: 'write',
      input: { file: 'b.ts' },
      content: '',
      ok: true,
    });
    expect(write.summary).toBe('wrote b.ts');
    const other = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 'o',
      toolName: 'tree',
      input: {},
      content: 'first line here',
      ok: true,
    });
    expect(other.summary).toBe('first line here');
    const empty = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 'n',
      toolName: 'tree',
      input: {},
      content: '   ',
      ok: true,
    });
    expect(empty.summary).toBe('tree returned no text');
  });

  it('records implicit facts (error / read / edit)', () => {
    const ctx = makeCtx();
    recordToolOutputEvidence(ctx, {
      toolUseId: 'e1',
      toolName: 'bash',
      input: { command: 'x' },
      content: 'Error: boom',
      ok: false,
    });
    recordToolOutputEvidence(ctx, {
      toolUseId: 'r1',
      toolName: 'read',
      input: { path: 'a.ts' },
      content: 'x',
      ok: true,
      outputLines: 10,
    });
    recordToolOutputEvidence(ctx, {
      toolUseId: 'w1',
      toolName: 'write',
      input: { file: 'b.ts' },
      content: '',
      ok: true,
    });
    const facts = (ctx as never as { contextEvidence: { implicitFacts: string[] } }).contextEvidence
      .implicitFacts;
    expect(facts.some((f) => f.includes('exposed error'))).toBe(true);
    expect(facts.some((f) => f.includes('read a.ts'))).toBe(true);
    expect(facts.some((f) => f.includes('write changed b.ts'))).toBe(true);
  });

  it('tracks repeated reads of the same file', () => {
    const ctx = makeCtx();
    recordToolOutputEvidence(ctx, {
      toolUseId: 'r1',
      toolName: 'read',
      input: { path: 'a.ts' },
      content: 'x',
      ok: true,
    });
    recordToolOutputEvidence(ctx, {
      toolUseId: 'r2',
      toolName: 'read',
      input: { path: 'a.ts' },
      content: 'x',
      ok: true,
    });
    expect(repeatedReadPressure(ctx)).toBe(2);
    // A different file resets the streak (no new repeated entry for b.ts).
    recordToolOutputEvidence(ctx, {
      toolUseId: 'r3',
      toolName: 'read',
      input: { path: 'b.ts' },
      content: 'x',
      ok: true,
    });
    expect(repeatedReadPressure(ctx)).toBe(2);
    // A non-read tool resets lastReadPath.
    recordToolOutputEvidence(ctx, {
      toolUseId: 'e1',
      toolName: 'edit',
      input: { path: 'a.ts' },
      content: '',
      ok: true,
    });
    expect(repeatedReadPressure(ctx)).toBe(2);
  });

  it('extracts symbols from the grep pattern input', () => {
    const meta = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 'g',
      toolName: 'grep',
      input: { pattern: 'myFunc' },
      content: 'no matches',
      ok: true,
    });
    expect(meta.symbols).toContain('myFunc');
  });

  it('extracts errors only from the tail and caps at 5', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    lines.push('Error: tail failure');
    const meta = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 't',
      toolName: 'read',
      input: { path: 'a.ts' },
      content: lines.join('\n'),
      ok: true,
    });
    expect(meta.errors).toEqual(['Error: tail failure']);
  });
});

describe('markAssistantReferencedEvidence', () => {
  it('marks a tool referenced when the assistant mentions its file/symbol/error', () => {
    const ctx = makeCtx();
    recordToolOutputEvidence(ctx, {
      toolUseId: 't1',
      toolName: 'read',
      input: { path: 'a.ts' },
      content: 'function compute() {}',
      ok: true,
    });
    markAssistantReferencedEvidence(ctx, 'I checked a.ts and compute looks fine');
    const tool = (
      ctx as never as {
        contextEvidence: { toolCalls: Array<{ status: string; referenceCount: number }> };
      }
    ).contextEvidence.toolCalls[0]!;
    expect(tool.status).toBe('referenced');
    expect(tool.referenceCount).toBe(1);
  });

  it('is a no-op on empty text', () => {
    const ctx = makeCtx();
    recordToolOutputEvidence(ctx, {
      toolUseId: 't1',
      toolName: 'read',
      input: { path: 'a.ts' },
      content: 'x',
      ok: true,
    });
    markAssistantReferencedEvidence(ctx, '   ');
    const tool = (ctx as never as { contextEvidence: { toolCalls: Array<{ status: string }> } })
      .contextEvidence.toolCalls[0]!;
    expect(tool.status).toBe('seen');
  });

  it('only scans the most recent tool calls', () => {
    const ctx = makeCtx();
    // Push >20 tool calls; the oldest (referencing old.ts) is outside the scan window.
    for (let i = 0; i < 25; i++) {
      recordToolOutputEvidence(ctx, {
        toolUseId: `t${i}`,
        toolName: 'read',
        input: { path: `f${i}.ts` },
        content: 'x',
        ok: true,
      });
    }
    markAssistantReferencedEvidence(ctx, 'f0.ts');
    const state = (
      ctx as never as { contextEvidence: { toolCalls: Array<{ files: string[]; status: string }> } }
    ).contextEvidence;
    const oldTool = state.toolCalls.find((t) => t.files.includes('f0.ts'));
    expect(oldTool?.status).toBe('seen'); // not referenced — outside the 20-call window
  });
});

describe('buildContextEvidenceDigest', () => {
  it('emits all populated sections', () => {
    const ctx = makeCtx();
    recordUserIntentEvidence(ctx, 'Implement feature');
    recordToolOutputEvidence(ctx, {
      toolUseId: 't1',
      toolName: 'edit',
      input: { path: 'a.ts' },
      content: '',
      ok: true,
    });
    recordToolOutputEvidence(ctx, {
      toolUseId: 't2',
      toolName: 'bash',
      input: { command: 'x' },
      content: 'Error: boom',
      ok: false,
    });
    markAssistantReferencedEvidence(ctx, 'a.ts');
    const digest = buildContextEvidenceDigest(ctx);
    expect(digest).toContain('intent: Implement feature');
    expect(digest).toContain('session_goals:');
    expect(digest).toContain('dependency_graph:');
    expect(digest).toContain('- a.ts');
    expect(digest).toContain('tool_trail:');
    expect(digest).toContain('implicit_facts:');
  });

  it('truncates an oversized digest', () => {
    const ctx = makeCtx();
    for (let i = 0; i < 80; i++) {
      recordToolOutputEvidence(ctx, {
        toolUseId: `t${i}`,
        toolName: 'bash',
        input: { command: `c${i}`, path: `src/${'p'.repeat(200)}/file-${i}.ts` },
        content: `${'x'.repeat(220)} line ${i}`,
        ok: true,
      });
    }
    const digest = buildContextEvidenceDigest(ctx);
    expect(digest.length).toBeLessThanOrEqual(4_000 + 40);
    expect(digest).toContain('chars]'); // confirmed truncated
  });
});

describe('context-evidence extraction edges', () => {
  it('visits array-valued path inputs (files[])', () => {
    const meta = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 't',
      toolName: 'grep',
      input: { files: ['a.ts', 'b.ts'] },
      content: '',
      ok: true,
    });
    expect(meta.files).toEqual(['a.ts', 'b.ts']);
  });

  it('rejects an over-long path (>260 chars)', () => {
    const meta = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 't',
      toolName: 'read',
      input: { path: `${'a'.repeat(300)}.ts` },
      content: '',
      ok: true,
    });
    expect(meta.files).toEqual([]);
  });

  it('caps extracted symbols at 30', () => {
    const content = Array.from({ length: 35 }, (_, i) => `function f${i}() {}`).join('\n');
    const meta = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 't',
      toolName: 'read',
      input: { path: 'a.ts' },
      content,
      ok: true,
    });
    expect(meta.symbols.length).toBe(30);
  });

  it('extractCommands handles non-object input and non-string command', () => {
    const nonObj = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 't',
      toolName: 'bash',
      input: undefined as never,
      content: '',
      ok: true,
    });
    expect(nonObj.commands).toEqual([]);
    const noCmd = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 't',
      toolName: 'bash',
      input: {},
      content: '',
      ok: true,
    });
    expect(noCmd.commands).toEqual([]);
  });

  it('caps extracted errors at 5', () => {
    const content = Array.from({ length: 7 }, (_, i) => `Error: failure ${i}`).join('\n');
    const meta = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 't',
      toolName: 'read',
      input: { path: 'a.ts' },
      content,
      ok: true,
    });
    expect(meta.errors.length).toBe(5);
  });

  it('summarizeInput returns undefined for non-object input', () => {
    const meta = recordToolOutputEvidence(makeCtx(), {
      toolUseId: 't',
      toolName: 'read',
      input: undefined as never,
      content: 'x',
      ok: true,
    });
    expect(meta.inputSummary).toBeUndefined();
  });

  it('trims the repeated-reads list past 10 entries', () => {
    const ctx = makeCtx();
    for (let f = 0; f < 12; f++) {
      recordToolOutputEvidence(ctx, {
        toolUseId: `a${f}`,
        toolName: 'read',
        input: { path: `f${f}.ts` },
        content: 'x',
        ok: true,
      });
      recordToolOutputEvidence(ctx, {
        toolUseId: `b${f}`,
        toolName: 'read',
        input: { path: `f${f}.ts` },
        content: 'x',
        ok: true,
      });
    }
    const rr = (ctx as never as { contextEvidence: { repeatedReads: unknown[] } }).contextEvidence
      .repeatedReads;
    expect(rr.length).toBeLessThanOrEqual(10);
  });

  it('marks a tool referenced via a symbol name', () => {
    const ctx = makeCtx();
    recordToolOutputEvidence(ctx, {
      toolUseId: 't1',
      toolName: 'read',
      input: { path: 'a.ts' },
      content: 'class HttpClient {}',
      ok: true,
    });
    markAssistantReferencedEvidence(ctx, 'the HttpClient class');
    const tool = (ctx as never as { contextEvidence: { toolCalls: Array<{ status: string }> } })
      .contextEvidence.toolCalls[0]!;
    expect(tool.status).toBe('referenced');
  });

  it('marks a tool referenced via an error head', () => {
    const ctx = makeCtx();
    recordToolOutputEvidence(ctx, {
      toolUseId: 't1',
      toolName: 'bash',
      input: { command: 'x' },
      content: 'Error: something terrible happened here',
      ok: false,
    });
    markAssistantReferencedEvidence(ctx, 'Error: something terrible happened here');
    const tool = (ctx as never as { contextEvidence: { toolCalls: Array<{ status: string }> } })
      .contextEvidence.toolCalls[0]!;
    expect(tool.status).toBe('referenced');
  });

  it('marks a tool referenced via a file basename (full path not mentioned)', () => {
    const ctx = makeCtx();
    recordToolOutputEvidence(ctx, {
      toolUseId: 't1',
      toolName: 'read',
      input: { path: 'src/deep/nested/module.ts' },
      content: 'x',
      ok: true,
    });
    markAssistantReferencedEvidence(ctx, 'I edited module.ts just now'); // basename only
    const tool = (ctx as never as { contextEvidence: { toolCalls: Array<{ status: string }> } })
      .contextEvidence.toolCalls[0]!;
    expect(tool.status).toBe('referenced');
  });
});
