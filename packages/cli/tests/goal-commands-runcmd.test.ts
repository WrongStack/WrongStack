/**
 * `runCmd` (autonomous goal verification):
 *
 * - It keeps only the tail of a verify command's output (the failure summary
 *   lives at the end). It used to push every chunk and slice once at `close`,
 *   so the whole transcript stayed in memory while the command ran: +146 MB
 *   retained for 150 MB of output. The tail is now trimmed as it grows.
 * - A WRONGSTACK_GOAL_VERIFY_CMD command line is gated on its executable, as
 *   docs/configuration.md documents (`go` in tools.exec.allow runs
 *   `go test ./...`). The whole line used to be looked up in the list of
 *   executable names, so any command with an argument was refused.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configureGoalPolicy,
  createTailBuffer,
  resetGoalPolicy,
  runCmd,
} from '../src/goal-commands.js';

const runtimeName = process.versions.bun ? 'bun' : 'node';

describe('createTailBuffer', () => {
  it('retains at most ~2x the cap while returning the exact tail', () => {
    const cap = 1_000;
    const tail = createTailBuffer(cap);
    let all = '';
    let maxRetained = 0;
    for (let i = 0; i < 5_000; i++) {
      const chunk = `line ${i} ${'x'.repeat(i % 37)}\n`;
      tail.push(chunk);
      all += chunk;
      maxRetained = Math.max(maxRetained, tail.retained());
    }
    expect(all.length).toBeGreaterThan(50 * cap);
    expect(maxRetained).toBeLessThanOrEqual(2 * cap + 64);
    expect(tail.value()).toBe(all.slice(-cap));
  });

  it('never starts the tail with half of a surrogate pair', () => {
    const tail = createTailBuffer(5);
    tail.push('x🚀🚀🚀'); // 7 code units: the last 5 start inside the first 🚀
    expect(tail.value()).toBe('🚀🚀');
  });

  it('returns short output untouched', () => {
    const tail = createTailBuffer(100);
    tail.push('a');
    tail.push('b');
    expect(tail.value()).toBe('ab');
    expect(tail.retained()).toBe(2);
  });
});

describe('runCmd output', () => {
  it('returns the tail of a large output', async () => {
    // A script file: runCmd rejects `;` in the command line (chaining gate).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runcmd-tail-'));
    const script = path.join(dir, 'spew.cjs');
    await fs.writeFile(
      script,
      [
        'const b = "y".repeat(1023) + "\\n";',
        'for (let i = 0; i < 600; i++) process.stdout.write(b);',
        'process.stdout.write("END-OF-OUTPUT\\n");',
      ].join('\n'),
    );
    configureGoalPolicy({ allow: [runtimeName] });
    try {
      const res = await runCmd(runtimeName, [script], dir);
      expect(res.code).toBe(0);
      expect(res.out.endsWith('END-OF-OUTPUT')).toBe(true);
    } finally {
      resetGoalPolicy();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // Each chunk used to be decoded alone: a character split at a pipe-chunk
  // boundary reached the agent's verify-failure message as U+FFFD U+FFFD.
  it('keeps multibyte characters split across pipe chunks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runcmd-utf8-'));
    const script = path.join(dir, 'turkce.cjs');
    // 102-byte lines: 65536 % 102 = 52, inside a 2-byte `ş`.
    await fs.writeFile(
      script,
      'process.stdout.write(("a" + "ş".repeat(50) + "\\n").repeat(1500));\n',
    );
    configureGoalPolicy({ allow: [runtimeName] });
    try {
      const res = await runCmd(runtimeName, [script], dir);
      expect(res.code).toBe(0);
      expect(res.out).not.toContain('\uFFFD');
      expect(res.out).toBe(`a${'ş'.repeat(50)}\n`.repeat(1500).trim());
    } finally {
      resetGoalPolicy();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('runCmd command-line gate', () => {
  it('runs an allowlisted executable with arguments (plain or quoted)', async () => {
    configureGoalPolicy({ allow: [runtimeName] });
    try {
      for (const line of [`${runtimeName} --version`, `  "${runtimeName}" --version`]) {
        const res = await runCmd(line, [], process.cwd(), true);
        expect(res.code).toBe(0);
        expect(res.out).toBe(process.versions.bun ?? process.version);
      }
    } finally {
      resetGoalPolicy();
    }
  }, 60_000);

  it('still refuses other executables and line-break chaining', async () => {
    configureGoalPolicy({ allow: [runtimeName] });
    try {
      expect((await runCmd('curl --version', [], process.cwd(), true)).out).toMatch(
        /not in autonomous safe-commands allowlist/,
      );
      expect((await runCmd(`${runtimeName} --version\ncurl x`, [], process.cwd(), true)).out).toMatch(
        /rejected destructive command pattern/,
      );
    } finally {
      resetGoalPolicy();
    }
  });
});
