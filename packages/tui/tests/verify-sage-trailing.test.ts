import { describe, expect, it } from 'vitest';
import { extractSageBlock } from '../src/components/history/sage-output-format.js';
import { formatToolOutputSage } from '../src/components/history/utils.js';

const SAGE_BLOCK = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-1">test memory content</memory> [tags=test]',
  '- [decision][high] <memory id="mem-2">another memory</memory>',
].join('\n');

describe('SAGE stripping — vulnerability probe (trailing content)', () => {
  it('strips SAGE block with trailing newline', () => {
    const output = `hello\n\n${SAGE_BLOCK}\n`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(3);
    expect(result.cleanOutput).toBe('hello');
    expect(result.cleanOutput).not.toContain('SAGE');
  });

  it('strips SAGE block with trailing blank line', () => {
    const output = `hello\n\n${SAGE_BLOCK}\n\n`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(3);
    expect(result.cleanOutput).toBe('hello');
    expect(result.cleanOutput).not.toContain('SAGE');
  });

  it('strips SAGE block with trailing spaces-only line', () => {
    const output = `hello\n\n${SAGE_BLOCK}\n   `;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(3);
    expect(result.cleanOutput).toBe('hello');
    expect(result.cleanOutput).not.toContain('SAGE');
  });

  it('strips SAGE block exactly at end', () => {
    const output = `hello\n\n${SAGE_BLOCK}`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(3);
    expect(result.cleanOutput).toBe('hello');
    expect(result.cleanOutput).not.toContain('SAGE');
  });

  it('formatToolOutputSage strips trailing-newline SAGE from clean output and outLines', () => {
    const execJson = JSON.stringify({ exit_code: 0, stdout: 'hello', stderr: '' });
    const contaminated = `${execJson}\n\n${SAGE_BLOCK}\n`;
    const { cleanOutput, outLines, sageLines } = formatToolOutputSage('exec', contaminated, true);
    expect(sageLines.length).toBe(3);
    expect(cleanOutput).toBe(execJson);
    expect(cleanOutput).not.toContain('SAGE');
    expect(outLines.some((line) => line.includes('SAGE') || line.includes('<memory'))).toBe(false);
  });

  it('formatToolOutputSage strips trailing-blank-line SAGE from clean output and outLines', () => {
    const execJson = JSON.stringify({ exit_code: 0, stdout: 'hello', stderr: '' });
    const contaminated = `${execJson}\n\n${SAGE_BLOCK}\n\n`;
    const { cleanOutput, outLines, sageLines } = formatToolOutputSage('exec', contaminated, true);
    expect(sageLines.length).toBe(3);
    expect(cleanOutput).toBe(execJson);
    expect(cleanOutput).not.toContain('SAGE');
    expect(outLines.some((line) => line.includes('SAGE') || line.includes('<memory'))).toBe(false);
  });
});
