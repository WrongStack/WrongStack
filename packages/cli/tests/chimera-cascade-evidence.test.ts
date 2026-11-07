import { WIN32_TREE_KILL_BUDGET_MS } from '@wrongstack/core/utils/tree-kill';
import { describe, expect, it, vi } from 'vitest';
import { removeProjectFixtureDirectorySync } from '../../core/tests/helpers/project-server-harness.js';
import { extractCascadeEvidence, verifyCascadeEvidence } from '../src/chimera-cascade-evidence.js';

const block = (body: unknown): string => `fixed\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;

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

  it('extracts evidence from untagged code fences and handles trailing commas', () => {
    const raw = `fixed code\n\n\`\`\`\n{\n  "verification_evidence": {\n    "typecheck": { "command": "pnpm typecheck", "exitCode": 0, },\n  },\n}\n\`\`\``;
    expect(extractCascadeEvidence(raw)).toEqual({
      typecheck: { command: 'pnpm typecheck', exitCode: 0 },
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
    expect(result.checks[0]).toEqual(expect.objectContaining({ actualExitCode: 126, ok: false }));
  });

  it.skipIf(process.platform !== 'win32')(
    'tears down a timed-out check that runs behind the cmd.exe shim',
    async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-timeout-'));
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, 'hang.cjs'),
        "require('node:fs').writeFileSync('hang.pid', String(process.pid)); setInterval(() => {}, 1000);",
      );
      // npm cmd-shim spelling: `%~dp0` is wrong for a quoted call without CALL :label.
      fs.writeFileSync(
        path.join(bin, 'pnpm.cmd'),
        '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nCALL :find_dp0\r\nnode "%dp0%hang.cjs" %*\r\n',
      );
      const savedPath = process.env['PATH'];
      process.env['PATH'] = `${bin};${savedPath ?? ''}`;
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const result = await verifyCascadeEvidence(
          { typecheck: { command: 'pnpm typecheck', exitCode: 0 } },
          dir,
          undefined,
          2000,
        );
        expect(result.status).toBe('failed');
        const pid = Number(fs.readFileSync(path.join(dir, 'hang.pid'), 'utf8'));
        const deadline = Date.now() + 5000;
        while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        const leaked = alive(pid);
        if (leaked) process.kill(pid);
        expect(leaked).toBe(false);
      } finally {
        process.env['PATH'] = savedPath;
        removeProjectFixtureDirectorySync(dir, { maxRetries: 10, retryDelay: 100 });
      }
    },
    WIN32_TREE_KILL_BUDGET_MS + 15_000,
  );
});
