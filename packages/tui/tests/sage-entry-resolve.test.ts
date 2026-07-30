/**
 * A tool history entry gets its SAGE block from `tool.executed.sage` (live) or
 * from the inline suffix in `output` (replay). `resolveEntrySage` picks the
 * right source, so a memory block always renders as memory — the event's
 * ~400-char output preview used to slice a memory line mid-fence and the
 * remainder then rendered as raw tool text.
 */
import { describe, expect, it } from 'vitest';
import {
  formatToolOutputSageWith,
  resolveEntrySage,
} from '../src/components/history/sage-output-format.js';

const HEADER = '--- SAGE: related project knowledge (Memory Injector) ---';
const MEM_A = '- [fact] <memory id="mem-a">globbing is daemon-backed</memory> [tags=glob]';
const MEM_B = '- [decision][high] <memory id="mem-b">board writes go through IPC</memory>';
const MEM_TRUNCATED =
  '- [fact] <memory id="mem-truncated">memory content cut by an upstream preview…';

describe('resolveEntrySage', () => {
  it('uses the structured lines and leaves the body untouched', () => {
    const split = resolveEntrySage('packages/a.ts\npackages/b.ts', [HEADER, MEM_A]);
    expect(split.sageLines).toEqual([HEADER, MEM_A]);
    expect(split.cleanOutput).toBe('packages/a.ts\npackages/b.ts');
  });

  it('falls back to splitting the inline block when no lines are supplied', () => {
    const split = resolveEntrySage(`packages/a.ts\n\n${HEADER}\n${MEM_B}`, undefined);
    expect(split.sageLines).toEqual([HEADER, MEM_B]);
    expect(split.cleanOutput).toBe('packages/a.ts');
  });

  it('extracts a final U+2026-truncated memory line without consuming unrelated output', () => {
    const split = resolveEntrySage(
      `unrelated tool output\n\n${HEADER}\n${MEM_A}\n${MEM_TRUNCATED}`,
      undefined,
    );
    expect(split.cleanOutput).toBe('unrelated tool output');
    expect(split.sageLines).toEqual([HEADER, MEM_A, MEM_TRUNCATED]);
  });

  it('treats an empty array as "nothing delivered" and falls back', () => {
    const split = resolveEntrySage(`x\n\n${HEADER}\n${MEM_A}`, []);
    expect(split.sageLines).toEqual([HEADER, MEM_A]);
  });

  it('reports no memory for an entry with neither source', () => {
    expect(resolveEntrySage('plain output', undefined).sageLines).toEqual([]);
    expect(resolveEntrySage(undefined, undefined)).toEqual({ cleanOutput: '', sageLines: [] });
  });

  it('does not alias the caller array', () => {
    const lines = [HEADER, MEM_A];
    const split = resolveEntrySage('x', lines);
    split.sageLines.push('mutated');
    expect(lines).toEqual([HEADER, MEM_A]);
  });
});

describe('formatToolOutputSageWith with structured lines', () => {
  const formatToolOutput = (_name: string, output: string | undefined): string[] =>
    (output ?? '').split('\n');

  it('formats only the tool body and returns the memory separately', () => {
    const result = formatToolOutputSageWith({
      toolName: 'glob',
      output: 'packages/a.ts',
      ok: true,
      sageLines: [HEADER, MEM_A],
      formatToolOutput,
    });
    expect(result.outLines).toEqual(['packages/a.ts']);
    expect(result.outLines.join('\n')).not.toContain('SAGE');
    expect(result.sageLines).toEqual([HEADER, MEM_A]);
  });

  it('honours injected memory on a tool that returned nothing', () => {
    const result = formatToolOutputSageWith({
      toolName: 'glob',
      output: '',
      ok: true,
      sageLines: [HEADER, MEM_A],
      formatToolOutput,
    });
    expect(result.cleanOutput).toBe('');
    expect(result.sageLines).toEqual([HEADER, MEM_A]);
  });

  it('honours injected memory on a tool with an undefined body', () => {
    // Pinned because `formatToolOutputSageWith` deliberately returns the
    // structured lines even when no body was ever produced; a future refactor
    // must not silently revert this to "no body → no card".
    const result = formatToolOutputSageWith({
      toolName: 'glob',
      output: undefined,
      ok: true,
      sageLines: [HEADER, MEM_A, MEM_B],
      formatToolOutput,
    });
    expect(result.cleanOutput).toBe('');
    expect(result.sageLines).toEqual([HEADER, MEM_A, MEM_B]);
  });

  it('keeps the replay path working when no lines are supplied', () => {
    const result = formatToolOutputSageWith({
      toolName: 'glob',
      output: `packages/a.ts\n\n${HEADER}\n${MEM_A}`,
      ok: true,
      formatToolOutput,
    });
    expect(result.cleanOutput).toBe('packages/a.ts');
    expect(result.sageLines).toEqual([HEADER, MEM_A]);
  });
});
