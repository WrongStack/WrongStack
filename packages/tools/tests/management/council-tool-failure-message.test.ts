import { describe, expect, it } from 'vitest';
import { createCouncilTool } from '../../src/management/council-tool.js';

/**
 * The orchestrator's reasons already end in a period, and the tool appended
 * another: "Council failed: Council quorum was not met.. Errors: …"
 * (audit 2026-09-15).
 */
describe('council tool failure message', () => {
  it('does not double the period after the orchestrator reason', async () => {
    const tool = createCouncilTool({
      defaultProfile: 'fast',
      caller: {
        async call() {
          throw new Error('voter failed');
        },
      },
    });

    const error = await tool
      .execute({ question: 'Ship it?' }, {} as never, { signal: new AbortController().signal })
      .then(
        () => undefined,
        (err: unknown) => err as Error,
      );

    expect(error?.message).toMatch(/^Council failed: /);
    expect(error?.message).not.toMatch(/\.\./);
    expect(error?.message).toContain('voter failed');
  });
});
