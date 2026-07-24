// makeCommandVerifier — the shared completion-gate verifier for an SDD parallel
// run. Both surfaces that start a run (the CLI `/sdd parallel` handler and the
// standalone WebUI wizard) need an identical `verifyTask`: when a task declares
// `metadata.verificationCommand`, run it in the task's worktree cwd and only let
// the task complete on exit 0. No command → no-op. Bounded by a timeout so a
// hung verifier can't wedge the run.
//
// core may use node:child_process directly — it already does for git detection.

import { spawn } from 'node:child_process';
import type { TaskNode, TaskResult } from '@wrongstack/core/types';

export interface CommandVerifierOptions {
  /** Metadata key holding the shell command to run. Default 'verificationCommand'. */
  metadataKey?: string;
  /** Kill + fail the verification after this many ms. Default 180_000 (3 min). */
  timeoutMs?: number;
}

export function verificationShell(platform: NodeJS.Platform): [shell: string, ...args: string[]] {
  return platform === 'win32' ? ['cmd', '/d', '/c'] : ['sh', '-c'];
}

/** Shape shared by every SDD task verifier (matches SddParallelRunOptions.verifyTask). */
export type SddVerifyTask = (info: {
  task: TaskNode;
  result: TaskResult;
  cwd: string;
}) => Promise<{ ok: boolean; reason?: string }>;

/**
 * AND-compose verifiers: run in order, first failure wins (its reason
 * propagates); later parts are skipped once one fails.
 */
export function makeCompositeVerifier(parts: SddVerifyTask[]): SddVerifyTask {
  return async function verifyTask(info) {
    for (const part of parts) {
      const outcome = await part(info);
      if (!outcome.ok) return outcome;
    }
    return { ok: true };
  };
}

export interface AcceptanceCriteriaVerifierOptions {
  /** Runs one self-contained, isolated LLM turn and resolves its final text. */
  run: (prompt: string) => Promise<string>;
  /** Cap on the result excerpt included in the prompt. Default 4000 chars. */
  maxResultChars?: number;
}

/**
 * LLM acceptance-criteria check: when a task's description carries an
 * "**Acceptance Criteria:**" block, ask an isolated judge turn whether the
 * worker's reported result satisfies the criteria. Fails CLOSED only on an
 * explicit FAIL verdict — judge errors or ambiguous output pass with the
 * command verifier remaining the deterministic backstop, so a flaky judge
 * can never wedge a run.
 */
export function makeAcceptanceCriteriaVerifier(
  options: AcceptanceCriteriaVerifierOptions,
): SddVerifyTask {
  const maxResultChars = options.maxResultChars ?? 4000;
  return async function verifyTask(info) {
    const description = info.task.description ?? '';
    const marker = description.indexOf('**Acceptance Criteria:**');
    if (marker === -1) return { ok: true };
    const criteria = description.slice(marker);
    const resultText =
      typeof info.result.result === 'string'
        ? info.result.result.slice(0, maxResultChars)
        : JSON.stringify(info.result.result ?? '').slice(0, maxResultChars);

    let text: string;
    try {
      text = await options.run(
        [
          'You are a strict acceptance reviewer for one completed engineering task.',
          `Task: ${info.task.title}`,
          '',
          criteria,
          '',
          "Worker's reported result:",
          resultText || '(no result text)',
          '',
          'Does the reported result plausibly satisfy EVERY acceptance criterion?',
          'Answer with exactly one line: "VERDICT: PASS" or "VERDICT: FAIL — <short reason>".',
        ].join('\n'),
      );
    } catch {
      return { ok: true };
    }
    const match = text.match(/VERDICT:\s*(PASS|FAIL)(?:\s*[—-]\s*(.*))?/i);
    if (!match) return { ok: true };
    if (match[1]!.toUpperCase() === 'PASS') return { ok: true };
    return {
      ok: false,
      reason: `acceptance criteria not met: ${match[2]?.trim() || 'judge rejected the result'}`,
    };
  };
}

/**
 * Build a `verifyTask` closure (shape matches {@link SddParallelRunOptions.verifyTask}).
 * Returns `{ ok: true }` immediately when the task carries no verification command,
 * otherwise spawns the command in `cwd` (shell, output discarded) and resolves
 * `{ ok: false, reason }` on non-zero exit, spawn error, or timeout.
 */
export function makeCommandVerifier(options: CommandVerifierOptions = {}) {
  const metadataKey = options.metadataKey ?? 'verificationCommand';
  const timeoutMs = options.timeoutMs ?? 180_000;

  return async function verifyTask(info: {
    task: TaskNode;
    result: TaskResult;
    cwd: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const cmd = info.task.metadata?.[metadataKey];
    if (typeof cmd !== 'string' || !cmd.trim()) return { ok: true };

    return await new Promise((resolve) => {
      // Parse the command string through an explicit shell invocation rather than
      // spawn(..., { shell: true }), which lets Node interpolate the whole string
      // and exposes any metacharacters (;  &&  |  $()  etc.) as injection vectors
      // in the command itself.  sh -c "cmd" / cmd /s /c "cmd" passes the full string
      // to the shell as a single positional argument — the shell interprets it, not Node.
      const [shell, ...shellArgs] = verificationShell(process.platform);
      const child = spawn(shell, [...shellArgs, cmd], {
        cwd: info.cwd,
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        resolve({ ok: false, reason: `verification timed out: ${cmd}` });
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        // Don't overwrite the timeout reason once the timer has fired.
        if (timedOut) return;
        resolve(
          code === 0
            ? { ok: true }
            : { ok: false, reason: `verification failed (exit ${code}): ${cmd}` },
        );
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: `verification spawn error: ${String(err)}` });
      });
    });
  };
}
