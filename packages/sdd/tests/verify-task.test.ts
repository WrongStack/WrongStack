import { existsSync } from 'node:fs';
import * as os from 'node:os';
import type { TaskResult } from '@wrongstack/core/types/multi-agent.js';
import type { TaskNode } from '@wrongstack/core/types/task-graph.js';
import { describe, expect, it } from 'vitest';
import {
  makeAcceptanceCriteriaVerifier,
  makeCommandVerifier,
  makeCompositeVerifier,
  verificationShell,
} from '../src/verify-task.js';

// Minimal stand-ins — the verifier only reads `task.metadata`.
function task(metadata?: Record<string, unknown>): TaskNode {
  return { metadata } as unknown as TaskNode;
}
const result = {} as TaskResult;
const cwd = os.tmpdir();

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
    const out = await verify({ task: task({ verificationCommand: 'exit 0' }), result, cwd });
    expect(out.ok).toBe(true);
  });

  it('fails with a reason on non-zero exit', async () => {
    const verify = makeCommandVerifier();
    const out = await verify({ task: task({ verificationCommand: 'exit 3' }), result, cwd });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('exit 3');
    expect(out.reason).toContain('verification failed');
  });

  it('kills and fails on timeout', async () => {
    const verify = makeCommandVerifier({ timeoutMs: 150 });
    // Use a command where the *spawned process itself* is what blocks — not a forked
    // child that outlives the spawn.  node -e "setTimeout(...)" forks in Node 18+ so
    // node exits immediately; ping (Windows) and sleep (Unix) run inside the shell.
    const cmd = process.platform === 'win32' ? 'ping -n 61 127.0.0.1 >nul' : 'sleep 61';
    const out = await verify({ task: task({ verificationCommand: cmd }), result, cwd });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('timed out');
  });

  it('honours a custom metadata key', async () => {
    const verify = makeCommandVerifier({ metadataKey: 'check' });
    // The default key is ignored…
    expect(await verify({ task: task({ verificationCommand: 'exit 1' }), result, cwd })).toEqual({
      ok: true,
    });
    // …only the configured key runs.
    const out = await verify({ task: task({ check: 'exit 1' }), result, cwd });
    expect(out.ok).toBe(false);
  });

  it('reports spawn errors and selects both platform shell forms', async () => {
    const verify = makeCommandVerifier();
    const missingCwd = `${cwd}/definitely-missing-${Date.now()}`;
    // Guard: the test relies on a non-existent cwd to force a spawn error.
    expect(existsSync(missingCwd)).toBe(false);
    const out = await verify({
      task: task({ verificationCommand: 'exit 0' }),
      result,
      cwd: missingCwd,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('spawn error');
    expect(verificationShell('win32')).toEqual(['cmd', '/d', '/c']);
    expect(verificationShell('linux')).toEqual(['sh', '-c']);
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

  it('degrades open on judge errors or ambiguous output', async () => {
    const throwing = makeAcceptanceCriteriaVerifier({
      run: async () => {
        throw new Error('judge down');
      },
    });
    expect(await throwing({ task: criteriaTask(), result: withResult, cwd })).toEqual({ ok: true });

    const ambiguous = makeAcceptanceCriteriaVerifier({ run: async () => 'maybe fine?' });
    expect(await ambiguous({ task: criteriaTask(), result: withResult, cwd })).toEqual({
      ok: true,
    });
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
