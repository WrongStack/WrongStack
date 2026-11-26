import { describe, expect, it } from 'vitest';
import { buildAcpPreflightContext } from '../src/acp-preflight-context.js';

const sources = {
  fetchMemories: async () => [{ id: 'm1', content: 'remembered project rule' }],
};

/**
 * F2639: `maxChars`/`timeoutMs` are read with `Math.max(min, options.x ?? default)`.
 * A NaN value survives both branches: `truncateText(..., NaN)` collapses the
 * block body to "…" and `setTimeout(..., NaN)` fires immediately, racing out the
 * lookups — so a malformed option silently replaces the whole pre-flight context.
 */
describe('ACP preflight option typing (F2639)', () => {
  it('keeps the block when maxChars is not finite', async () => {
    const block = await buildAcpPreflightContext({
      taskDescription: 'fix',
      sources,
      options: { maxChars: Number.NaN as never },
    });

    expect(block).toContain('remembered project rule');
  });

  it('keeps the block when timeoutMs is not finite', async () => {
    const slow = {
      fetchMemories: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [{ id: 'm1', content: 'remembered project rule' }];
      },
    };
    const block = await buildAcpPreflightContext({
      taskDescription: 'fix',
      sources: slow,
      options: { timeoutMs: Number.NaN as never },
    });

    expect(block).toContain('remembered project rule');
  });

  it('renders the block with default options (control)', async () => {
    const block = await buildAcpPreflightContext({ taskDescription: 'fix', sources });

    expect(block).toContain('remembered project rule');
    expect(block).toContain('<wrongstack-preflight-context>');
  });
});
