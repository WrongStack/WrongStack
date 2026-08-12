import { describe, expect, it, vi } from 'vitest';
import {
  extractCascadeEvidence,
  verifyCascadeEvidence,
} from '../src/chimera-cascade-evidence.js';

const block = (body: unknown): string =>
  `fixed\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;

describe('extractCascadeEvidence', () => {
  it('extracts the canonical verification_evidence block', () => {
    expect(
      extractCascadeEvidence(
        block({
          verification_evidence: {
            typecheck: { command: 'pnpm typecheck', exitCode: 0 },
            lint: { command: 'pnpm lint', exitCode: 0 },
          },
        }),
      ),
    ).toEqual({
      typecheck: { command: 'pnpm typecheck', exitCode: 0 },
      lint: { command: 'pnpm lint', exitCode: 0 },
    });
  });

  it('returns null for malformed or missing evidence', () => {
    expect(extractCascadeEvidence('no evidence')).toBeNull();
    expect(extractCascadeEvidence('```json\n{bad}\n```')).toBeNull();
  });

  it('drops invalid individual checks without inventing evidence', () => {
    expect(
      extractCascadeEvidence(
        block({
          verification_evidence: {
            typecheck: { command: '', exitCode: 0 },
            tests: { command: 'pnpm test', exitCode: 'zero' },
          },
        }),
      ),
    ).toBeNull();
  });
});

describe('verifyCascadeEvidence', () => {
  it('marks matching real command outcomes verified', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0 });
    const result = await verifyCascadeEvidence(
      {
        typecheck: { command: 'pnpm typecheck', exitCode: 0 },
        lint: { command: 'pnpm lint', exitCode: 0 },
      },
      '.',
      run,
    );

    expect(result.status).toBe('verified');
    expect(result.checks).toHaveLength(2);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('marks an exit-code mismatch failed', async () => {
    const result = await verifyCascadeEvidence(
      { typecheck: { command: 'pnpm typecheck', exitCode: 0 } },
      '.',
      vi.fn().mockResolvedValue({ exitCode: 1 }),
    );

    expect(result.status).toBe('failed');
    expect(result.checks[0]).toEqual(
      expect.objectContaining({ claimedExitCode: 0, actualExitCode: 1, ok: false }),
    );
  });

  it('requires typecheck and rejects partial lint/test-only evidence', async () => {
    const result = await verifyCascadeEvidence(
      { lint: { command: 'pnpm lint', exitCode: 0 } },
      '.',
      vi.fn(),
    );
    expect(result.status).toBe('failed');
    expect(result.checks).toEqual([]);
  });

  it('rejects unsafe shell commands without executing them', async () => {
    const result = await verifyCascadeEvidence(
      { typecheck: { command: 'pnpm typecheck && echo forged', exitCode: 0 } },
      '.',
    );
    expect(result.status).toBe('failed');
    expect(result.checks[0]).toEqual(
      expect.objectContaining({ actualExitCode: 126, ok: false }),
    );
  });
});
