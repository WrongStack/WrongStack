import { describe, expect, it } from 'vitest';
import { buildAutomationResult } from '../src/automation/result.js';

describe('automation result evidence', () => {
  it('decodes Git quoted UTF-8 paths used by international projects', () => {
    expect(buildAutomationResult('', '+++ "b/src/\\303\\247.ts"\n', 0).changedFiles).toEqual([
      'src/ç.ts',
    ]);
    expect(buildAutomationResult('', null, 0).validation.evidence).not.toContain('changes.patch');
  });
  it('retains unknown pricing instead of treating a legacy zero as free', () => {
    const result = buildAutomationResult(
      JSON.stringify({
        status: 'done',
        finalText: 'All tests passed',
        usage: { input: 12, output: 4, cost: 0 },
      }),
      '--- a/old.ts\n+++ b/new.ts\n',
      1234,
    );
    expect(result.usage).toMatchObject({ inputTokens: 12, costUsd: null, costSource: 'unknown' });
    expect(result.validation.status).toBe('not-verified');
    expect(result.changedFiles).toEqual(['old.ts', 'new.ts']);
  });
  it('accepts explicitly priced zero and ignores trailing ordinary JSON logs', () => {
    const output =
      JSON.stringify({ status: 'done', usage: { cost: 0, costSource: 'catalog-estimate' } }) +
      '\n{"level":"info"}\n';
    expect(buildAutomationResult(output, '', 0).usage.costUsd).toBe(0);
  });
  it('does not resurrect an earlier result behind corrupt final output', () => {
    expect(
      buildAutomationResult('{"status":"done","finalText":"old"}\n{truncated', null, 0).finalText,
    ).toBeNull();
  });
  it('bounds final output and changed-file metadata', () => {
    const result = buildAutomationResult(
      JSON.stringify({
        status: 'done',
        finalText: 'x'.repeat(20000),
        usage: { input: -1, output: '5' },
      }),
      Array.from({ length: 250 }, (_, i) => `+++ b/file${i}`).join('\n'),
      100,
    );
    expect(result.finalText).toHaveLength(16384);
    expect(result.changedFiles).toHaveLength(200);
    expect(result.changedFilesTruncated).toBe(true);
    expect(result.usage.inputTokens).toBeNull();
    expect(result.usage.outputTokens).toBeNull();
  });
});
