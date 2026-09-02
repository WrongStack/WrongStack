import { describe, expect, it } from 'vitest';
import {
  capSageLines,
  SAGE_INJECTOR_HEADINGS,
  splitSageOutputBlock,
} from '../../src/utils/sage-output-block.js';

const HEADER = '--- SAGE: related project knowledge (Memory Injector) ---';
const TASK_HEADER = '--- SAGE: task-aware project knowledge (Memory Injector) ---';
const MEM_A =
  '- [pattern][high] <memory id="mem_a">Kanban board writes go through the daemon</memory> (packages/core/src/kanban.ts) [relation=about_file; tags=kanban,daemon]';
const MEM_B =
  '- [fact] <memory id="mem_b">Vitest single-file runs must start at the repo root</memory>';

describe('splitSageOutputBlock', () => {
  it('splits a complete block off the tool body', () => {
    const { body, sageLines } = splitSageOutputBlock(
      `packages/a.ts\npackages/b.ts\n\n${HEADER}\n${MEM_A}\n${MEM_B}`,
    );
    expect(body).toBe('packages/a.ts\npackages/b.ts');
    expect(sageLines).toEqual([HEADER, MEM_A, MEM_B]);
  });

  it('accepts the task-aware heading', () => {
    expect(splitSageOutputBlock(`x\n\n${TASK_HEADER}\n${MEM_B}`).sageLines[0]).toBe(TASK_HEADER);
    expect(SAGE_INJECTOR_HEADINGS.has(TASK_HEADER)).toBe(true);
  });

  it('tolerates trailing blank lines without keeping them', () => {
    const { body, sageLines } = splitSageOutputBlock(`x\n\n${HEADER}\n${MEM_A}\n\n   \n`);
    expect(body).toBe('x');
    expect(sageLines).toEqual([HEADER, MEM_A]);
  });

  it('takes the LAST block so a SAGE-looking line inside tool output cannot steal it', () => {
    const body = `grep hit: ${HEADER}`;
    const { body: out, sageLines } = splitSageOutputBlock(`${body}\n\n${HEADER}\n${MEM_A}`);
    expect(out).toBe(body);
    expect(sageLines).toEqual([HEADER, MEM_A]);
  });

  it('recovers a block whose last memory line an upstream cap truncated', () => {
    const cut = `${MEM_A.slice(0, 60)}…`;
    const { body, sageLines } = splitSageOutputBlock(`x\n\n${HEADER}\n${MEM_B}\n${cut}`);
    expect(body).toBe('x');
    expect(sageLines).toEqual([HEADER, MEM_B, cut]);
  });

  it('rejects a truncated line that is not last — the block shape is broken', () => {
    const cut = `${MEM_A.slice(0, 60)}…`;
    expect(splitSageOutputBlock(`x\n\n${HEADER}\n${cut}\n${MEM_B}`).sageLines).toEqual([]);
  });

  it.each([
    ['header only', `tool output\n\n${HEADER}`],
    ['header plus prose', `tool output\n\n${HEADER}\nthis is ordinary prose`],
    ['real content after the block', `x\n\n${HEADER}\n${MEM_A}\ntrailing tool line`],
    ['no header at all', 'plain tool output\nsecond line'],
  ])('leaves %s untouched', (_label, output) => {
    expect(splitSageOutputBlock(output)).toEqual({ body: output, sageLines: [] });
  });

  it('handles an empty tool body with an injected block', () => {
    const { body, sageLines } = splitSageOutputBlock(`${HEADER}\n${MEM_A}`);
    expect(body).toBe('');
    expect(sageLines).toEqual([HEADER, MEM_A]);
  });
});

describe('capSageLines', () => {
  it('keeps whole memory lines that fit', () => {
    const capped = capSageLines([HEADER, MEM_A, MEM_B], HEADER.length + MEM_A.length + 1);
    expect(capped).toEqual([HEADER, MEM_A]);
  });

  it('never slices inside a line — a fenceless fragment breaks every parser', () => {
    for (const budget of [80, 120, 200, 400, 2_000]) {
      const capped = capSageLines([HEADER, MEM_A, MEM_B], budget);
      expect(capped.join('\n').length).toBeLessThanOrEqual(budget);
      for (const line of capped.slice(1)) {
        expect([MEM_A, MEM_B]).toContain(line);
      }
    }
  });

  it('drops the block entirely when not even one memory fits', () => {
    expect(capSageLines([HEADER, MEM_A], HEADER.length + 4)).toEqual([]);
    expect(capSageLines([HEADER, MEM_A], 10)).toEqual([]);
  });

  it('returns nothing for a header-only block', () => {
    expect(capSageLines([HEADER], 5_000)).toEqual([]);
    expect(capSageLines([], 5_000)).toEqual([]);
  });
});
