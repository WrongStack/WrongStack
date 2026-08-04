import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskResult } from '@wrongstack/core/types/multi-agent.js';
import type { TaskNode } from '@wrongstack/core/types/task-graph.js';
import { describe, expect, it } from 'vitest';
import {
  makeAcceptanceCriteriaVerifier,
  makeCommandVerifier,
  makeCompositeVerifier,
  tokenizeCommand,
} from '../src/verify-task.js';

// Minimal stand-ins — the verifier only reads `task.metadata`.
function task(metadata?: Record<string, unknown>): TaskNode {
  return { metadata } as unknown as TaskNode;
}
const result = {} as TaskResult;
const cwd = os.tmpdir();

// Platform-safe executable helpers (no shell builtins).
const trueExe = process.platform === 'win32' ? 'cmd /c exit 0' : 'true';
const falseExe = process.platform === 'win32' ? 'cmd /c exit 3' : 'false';
// A long-running command to test timeout — killed after the verifier timeout.
const sleepCmd = process.platform === 'win32' ? 'ping -n 61 127.0.0.1' : 'sleep 61';

describe('tokenizeCommand', () => {
  it('splits a simple command into executable + args', () => {
    expect(tokenizeCommand('pnpm vitest run')).toEqual(['pnpm', 'vitest', 'run']);
  });

  it('handles single-quoted arguments with spaces', () => {
    expect(tokenizeCommand("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  it('handles double-quoted arguments with spaces', () => {
    expect(tokenizeCommand('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  it('preserves shell metacharacters as literal argument data', () => {
    // With shell: false, these are NOT interpreted — they become literal args.
    expect(tokenizeCommand('echo ; rm -rf /')).toEqual(['echo', ';', 'rm', '-rf', '/']);
    expect(tokenizeCommand('cat foo | grep bar')).toEqual(['cat', 'foo', '|', 'grep', 'bar']);
  });

  it('handles backslash escaping outside quotes', () => {
    expect(tokenizeCommand('echo a\\ b')).toEqual(['echo', 'a b']);
  });

  it('handles backslash escapes inside double quotes', () => {
    // Escaped double quote inside a double-quoted token.
    expect(tokenizeCommand('echo "say \\"hi\\""')).toEqual(['echo', 'say "hi"']);
    // Escaped dollar sign — not interpreted as a variable.
    expect(tokenizeCommand('echo "cost \\$5"')).toEqual(['echo', 'cost $5']);
    // Backslash before a non-special character is kept literally.
    expect(tokenizeCommand('echo "a\\b"')).toEqual(['echo', 'a\\b']);
  });

  it('returns undefined for empty/whitespace input', () => {
    expect(tokenizeCommand('')).toBeUndefined();
    expect(tokenizeCommand('   ')).toBeUndefined();
  });

  it('returns undefined for unbalanced quotes', () => {
    expect(tokenizeCommand("echo 'unclosed")).toBeUndefined();
    expect(tokenizeCommand('echo "unclosed')).toBeUndefined();
  });

  it('handles empty quotes as an empty-string argument', () => {
    expect(tokenizeCommand('echo ""')).toEqual(['echo', '']);
    expect(tokenizeCommand("echo ''")).toEqual(['echo', '']);
  });

  it('treats empty quoted tokens as an empty-string argument', () => {
    // `""` is a real token (empty string), not an absent one — it stays in
    // the argv rather than being dropped.
    expect(tokenizeCommand('""')).toEqual(['']);
    expect(tokenizeCommand('echo ""')).toEqual(['echo', '']);
  });

  it('handles mixed quoting', () => {
    expect(tokenizeCommand('pnpm test --filter "@wrongstack/core" -- --reporter=dot')).toEqual([
      'pnpm',
      'test',
      '--filter',
      '@wrongstack/core',
      '--',
      '--reporter=dot',
    ]);
  });
});

describe('makeCommandVerifier', () => {
  it('passes through (ok) when the task carries no verification command', async () => {
    const verify = makeCommandVerifier();
    expect(await verify({ task: task(), result, cwd })).toEqual({ ok: true });
    expect(await verify({ task: task({ verificationCommand: '   ' }), result, cwd })).toEqual({
      ok: true,
    });
    expect(await verify({ task: task({ verificationCommand: 42 }), result, cwd })).toEqual({
      ok: true,
    });
  });

  it('resolves ok on exit 0', async () => {
    const verify = makeCommandVerifier();
    const out = await verify({ task: task({ verificationCommand: trueExe }), result, cwd });
    expect(out.ok).toBe(true);
  });

  it('fails with a reason on non-zero exit', async () => {
    const verify = makeCommandVerifier();
    const out = await verify({ task: task({ verificationCommand: falseExe }), result, cwd });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('verification failed');
  });

  it('kills and fails on timeout', async () => {
    const verify = makeCommandVerifier({ timeoutMs: 150 });
    const out = await verify({ task: task({ verificationCommand: sleepCmd }), result, cwd });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('timed out');
  });

  it('honours a custom metadata key', async () => {
    const verify = makeCommandVerifier({ metadataKey: 'check' });
    // The default key is ignored…
    expect(await verify({ task: task({ verificationCommand: falseExe }), result, cwd })).toEqual({
      ok: true,
    });
    // …only the configured key runs.
    const out = await verify({ task: task({ check: falseExe }), result, cwd });
    expect(out.ok).toBe(false);
  });

  it('reports spawn errors on a missing cwd', async () => {
    const verify = makeCommandVerifier();
    const missingCwd = path.join(cwd, `definitely-missing-${Date.now()}`);
    // Guard: the test relies on a non-existent cwd to force a spawn error.
    expect(existsSync(missingCwd)).toBe(false);
    const out = await verify({
      task: task({ verificationCommand: trueExe }),
      result,
      cwd: missingCwd,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('spawn error');
  });

  it('rejects malformed commands with unbalanced quotes', async () => {
    const verify = makeCommandVerifier();
    const out = await verify({
      task: task({ verificationCommand: "echo 'unclosed" }),
      result,
      cwd,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('malformed');
  });

  it('does not interpret shell metacharacters (defense in depth)', async () => {
    // With shell: false, "; false" becomes literal arguments to `true`,
    // so `true ; false` should still exit 0 (the `;` and `false` are
    // passed as argv, not interpreted as a shell sequence).
    const verify = makeCommandVerifier();
    const out = await verify({
      task: task({ verificationCommand: `${trueExe.split(' ')[0]} ; false` }),
      result,
      cwd,
    });
    // On non-Windows, `true ; false` spawns `true` with args [';', 'false'].
    // true ignores its arguments and exits 0.
    if (process.platform !== 'win32') {
      expect(out.ok).toBe(true);
    }
    // On Windows, `cmd` is the executable — skip the assertion since
    // cmd interprets its own args differently.
  });
});

describe('makeCompositeVerifier', () => {
  it('ANDs parts, first failure wins and short-circuits', async () => {
    const calls: string[] = [];
    const pass = async () => {
      calls.push('pass');
      return { ok: true };
    };
    const failA = async () => {
      calls.push('failA');
      return { ok: false, reason: 'a broke' };
    };
    const failB = async () => {
      calls.push('failB');
      return { ok: false, reason: 'b broke' };
    };
    const composite = makeCompositeVerifier([pass, failA, failB]);
    const out = await composite({ task: task(), result, cwd });
    expect(out).toEqual({ ok: false, reason: 'a broke' });
    expect(calls).toEqual(['pass', 'failA']);

    expect(await makeCompositeVerifier([pass, pass])({ task: task(), result, cwd })).toEqual({
      ok: true,
    });
  });
});

describe('makeAcceptanceCriteriaVerifier', () => {
  const criteriaTask = () =>
    ({
      title: 'T',
      description: 'Do it.\n\n**Acceptance Criteria:**\n- output is sorted',
      metadata: {},
    }) as unknown as TaskNode;
  const withResult = { result: 'sorted output produced' } as TaskResult;

  it('passes tasks without an acceptance criteria block untouched', async () => {
    const verify = makeAcceptanceCriteriaVerifier({
      run: async () => {
        throw new Error('should not be called');
      },
    });
    expect(await verify({ task: task({}), result, cwd })).toEqual({ ok: true });
  });

  it('fails closed only on an explicit FAIL verdict', async () => {
    const failVerify = makeAcceptanceCriteriaVerifier({
      run: async () => 'VERDICT: FAIL — output was not sorted',
    });
    const out = await failVerify({ task: criteriaTask(), result: withResult, cwd });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('output was not sorted');

    const passVerify = makeAcceptanceCriteriaVerifier({ run: async () => 'VERDICT: PASS' });
    expect(await passVerify({ task: criteriaTask(), result: withResult, cwd })).toEqual({
      ok: true,
    });
  });

  // WS-023 (inverted). This asserted that a judge error or an unparseable
  // verdict passes the task. The justification in the source was "the command
  // verifier remaining the deterministic backstop" — but that backstop is
  // agent-authored task metadata that defaults to ABSENT (`makeCommandVerifier`
  // returns ok on a task with no command). `criteriaTask()` has `metadata: {}`,
  // so for this exact fixture nothing verified anything and the work was
  // accepted on the worker's own say-so.
  //
  // The rule is now conditional on the backstop actually existing, so both
  // halves are pinned: fails closed without a command, still degrades open
  // with one.
  it('fails closed on an inconclusive judge when no command verifier exists', async () => {
    const throwing = makeAcceptanceCriteriaVerifier({
      run: async () => {
        throw new Error('judge down');
      },
    });
    const errored = await throwing({ task: criteriaTask(), result: withResult, cwd });
    expect(errored.ok).toBe(false);
    expect(errored.reason).toContain('no verification command');

    const ambiguous = makeAcceptanceCriteriaVerifier({ run: async () => 'maybe fine?' });
    const unparseable = await ambiguous({ task: criteriaTask(), result: withResult, cwd });
    expect(unparseable.ok).toBe(false);
    expect(unparseable.reason).toContain('no parseable verdict');
  });

  it('still degrades open when the deterministic backstop is present', async () => {
    const backstopped = () =>
      ({
        title: 'T',
        description: 'Do it.\n\n**Acceptance Criteria:**\n- output is sorted',
        metadata: { verificationCommand: 'node --version' },
      }) as unknown as TaskNode;

    const throwing = makeAcceptanceCriteriaVerifier({
      run: async () => {
        throw new Error('judge down');
      },
    });
    expect(await throwing({ task: backstopped(), result: withResult, cwd })).toEqual({ ok: true });

    const ambiguous = makeAcceptanceCriteriaVerifier({ run: async () => 'maybe fine?' });
    expect(await ambiguous({ task: backstopped(), result: withResult, cwd })).toEqual({ ok: true });
  });

  it('retries once before declaring the judge unavailable', async () => {
    // A single transient provider blip must not fail a task closed — that
    // would be its own way of making the gate useless.
    let calls = 0;
    const flaky = makeAcceptanceCriteriaVerifier({
      run: async () => {
        calls++;
        if (calls === 1) throw new Error('transient');
        return 'VERDICT: PASS';
      },
    });
    expect(await flaky({ task: criteriaTask(), result: withResult, cwd })).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('reports a non-Error judge failure string', async () => {
    // A judge that rejects with a plain value (not an Error) must still be
    // reported — via String(lastError) — rather than crashing the verifier.
    const throwing = makeAcceptanceCriteriaVerifier({
      run: async () => {
        throw 'judge exploded'; // not an Error instance
      },
    });
    const errored = await throwing({ task: criteriaTask(), result: withResult, cwd });
    expect(errored.ok).toBe(false);
    expect(errored.reason).toContain('judge exploded');
  });

  it('serializes non-string results and supplies fallback prompt and rejection reason', async () => {
    const prompts: string[] = [];
    const reject = makeAcceptanceCriteriaVerifier({
      maxResultChars: 20,
      run: async (prompt) => {
        prompts.push(prompt);
        return 'VERDICT: FAIL';
      },
    });
    const out = await reject({
      task: criteriaTask(),
      result: { result: '' } as TaskResult,
      cwd,
    });
    expect(prompts[0]).toContain('(no result text)');
    expect(out.reason).toContain('judge rejected the result');

    const objectResult = makeAcceptanceCriteriaVerifier({
      run: async (prompt) => {
        prompts.push(prompt);
        return 'VERDICT: PASS';
      },
    });
    await objectResult({
      task: criteriaTask(),
      result: { result: { ok: true } } as TaskResult,
      cwd,
    });
    expect(prompts.at(-1)).toContain('{"ok":true}');
    await objectResult({
      task: criteriaTask(),
      result: { result: null } as TaskResult,
      cwd,
    });
    expect(prompts.at(-1)).toContain('""');
  });
});
