import { describe, expect, it } from 'vitest';
import { VerificationProcessRunner } from '../../src/verification/verification-process.js';

describe('VerificationProcessRunner null-byte argv (r6)', () => {
  const runner = new VerificationProcessRunner(process.cwd());
  const opts = { cwd: process.cwd(), timeoutMs: 30_000 } as const;

  // Node validates spawn arguments synchronously (ERR_INVALID_ARG_VALUE) and
  // the only caller chain — VerificationContext.runCommand →
  // CommandPlugin.verify → VerifierRegistry.verify → verifyTaskCompletion
  // Phase 2 — has no try/catch at any level, so a rejection here would crash
  // the whole verification run instead of failing one check. runTest already
  // rejects null-byte patterns as a structured failure; the runner must do
  // the same for every spawn failure it can observe.
  it('resolves a NUL-bearing argv as a structured spawn error instead of rejecting', async () => {
    const result = await runner.runProcess(
      process.execPath,
      ['-e', 'process.exit(0)', 'a\0b'],
      opts,
    );
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('spawn error');
    expect(result.stderr).toContain('null byte');
  });

  it('resolves a NUL-bearing command token the same way', async () => {
    const result = await runner.runProcess('no\0such-binary', [], opts);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('spawn error');
  });

  it('keeps the identical call without a null byte working (control)', async () => {
    const result = await runner.runProcess(
      process.execPath,
      ['-e', 'process.exit(0)', 'a-b'],
      opts,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('spawn error');
  });
});
