import { describe, expect, it } from 'vitest';
import { createPromptJournalToolCallRecorder } from '../src/prompt-journal/tool-call-recorder.js';

describe('createPromptJournalToolCallRecorder prototype key guard (F2244)', () => {
  it('does not treat Object.prototype keys like toString as journal categories', async () => {
    const recorder = createPromptJournalToolCallRecorder();
    let toolsMapped = false;
    await recorder.handler(
      {
        ctx: {
          projectRoot: '/tmp/nonexistent-wrongstack-test',
          tools: {
            map: () => {
              toolsMapped = true;
              return [];
            },
          },
        },
        toolUse: { name: 'toString', input: {} },
      } as unknown as Parameters<typeof recorder.handler>[0],
      async (v) => v,
    );
    expect(toolsMapped).toBe(false);
  });
});
