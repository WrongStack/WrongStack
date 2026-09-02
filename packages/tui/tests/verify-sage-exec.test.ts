import { describe, expect, it } from 'vitest';
import { formatToolOutputSage, formatToolVisualOutput } from '../src/components/history/utils.js';
import { extractSageBlock } from '../src/components/history/sage-output-format.js';

const SAGE_BLOCK = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-test">test memory content here</memory> [tags=test]',
].join('\n');

describe('SAGE stripping for exec output (empirical verification)', () => {
  it('extractSageBlock strips SAGE from exec-style output if present', () => {
    // Even though exec no longer triggers injection, the TUI renderer must
    // still correctly strip SAGE blocks from any tool output that contains
    // them (e.g. from legacy sessions or manual tests).
    const execOutput = `exit 0 · 2 out · 0 err
"some stdout preview"\n\n${SAGE_BLOCK}`;

    const result = extractSageBlock(execOutput);
    expect(result.sageLines.length).toBe(2);
    expect(result.cleanOutput).toBe('exit 0 · 2 out · 0 err\n"some stdout preview"');
    expect(result.cleanOutput).not.toContain('SAGE:');
  });

  it('formatToolOutputSage returns sageLines + clean outLines for exec', () => {
    const execResult =
      JSON.stringify({
        exit_code: 0,
        stdout: 'hello\nworld',
        stderr: '',
        danger: { level: 'safe' },
      }) + `\n\n${SAGE_BLOCK}`;

    const { cleanOutput, outLines, sageLines } = formatToolOutputSage(
      'exec',
      execResult,
      true,
      200,
      5,
    );

    expect(sageLines.length).toBe(2);

    const joinedOut = outLines.join('\n');
    expect(joinedOut).not.toContain('SAGE:');
    expect(joinedOut).not.toContain('mem-test');
    expect(cleanOutput).not.toContain('SAGE:');
  });

  it('formatToolVisualOutput does NOT leak SAGE lines for exec (after pre-strip)', () => {
    const execResult =
      JSON.stringify({
        exit_code: 0,
        stdout: 'hello',
        stderr: '',
      }) + `\n\n${SAGE_BLOCK}`;

    // entry.tsx pre-strips with extractSageBlock, then passes cleanOutput
    const { cleanOutput } = extractSageBlock(execResult);
    const visual = formatToolVisualOutput('exec', cleanOutput, true);

    if (visual) {
      for (const line of visual) {
        expect(line.text).not.toContain('SAGE:');
        expect(line.text).not.toContain('mem-test');
      }
    }
  });

  it('NEGATIVE CONTROL: formatToolVisualOutput on raw exec+SAGE (no pre-strip)', () => {
    // What happens if the JSON has trailing SAGE text?
    // JSON.parse will fail on the trailing non-JSON text.
    // This test just observes — no assertions on pass/fail.
    const execResult =
      JSON.stringify({
        exit_code: 0,
        stdout: 'hello',
        stderr: '',
      }) + `\n\n${SAGE_BLOCK}`;

    const visual = formatToolVisualOutput('exec', execResult, true);
    // Log what the visual formatter produces from contaminated input
    // so we understand the failure mode.
    console.log(
      '[NEGATIVE CONTROL] exec visual from contaminated input:',
      JSON.stringify(visual, null, 2),
    );
  });

  it('also works for grep output with SAGE block', () => {
    const grepResult =
      JSON.stringify({
        matches: ['src/foo.ts:42:const x = 1'],
        count: 1,
      }) + `\n\n${SAGE_BLOCK}`;

    const { cleanOutput, outLines, sageLines } = formatToolOutputSage(
      'grep',
      grepResult,
      true,
      100,
      3,
    );

    expect(sageLines.length).toBe(2);
    const joinedOut = outLines.join('\n');
    expect(joinedOut).not.toContain('SAGE:');
    expect(joinedOut).not.toContain('mem-test');
    expect(cleanOutput).not.toContain('SAGE:');
  });
});
