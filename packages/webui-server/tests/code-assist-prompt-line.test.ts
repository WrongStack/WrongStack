import { describe, expect, it } from 'vitest';
import { buildCodeAssistPrompt } from '../src/server/code-assist-prompt.js';

describe('buildCodeAssistPrompt line validation', () => {
  it('omits non-finite and non-positive line numbers from the prompt', () => {
    const ok = buildCodeAssistPrompt({ filePath: 'a.ts', preset: 'explain', line: 10 } as never, {
      projectRoot: '/r',
      allowEdits: false,
    });
    expect(ok).toContain('TARGET LINE: 10');

    const nan = buildCodeAssistPrompt(
      { filePath: 'a.ts', preset: 'explain', line: Number.NaN } as never,
      { projectRoot: '/r', allowEdits: false },
    );
    expect(nan).not.toContain('NaN');
    expect(nan).not.toContain('TARGET LINE:');

    const neg = buildCodeAssistPrompt({ filePath: 'a.ts', preset: 'explain', line: -3 } as never, {
      projectRoot: '/r',
      allowEdits: false,
    });
    expect(neg).not.toContain('TARGET LINE:');
  });
});
