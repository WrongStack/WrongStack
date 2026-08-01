// makeCommandVerifier — the shared completion-gate verifier for an SDD parallel
// run. Both surfaces that start a run (the CLI `/sdd parallel` handler and the
// standalone WebUI wizard) need an identical `verifyTask`: when a task declares
// `metadata.verificationCommand`, run it in the task's worktree cwd and only let
// the task complete on exit 0. No command → no-op. Bounded by a timeout so a
// hung verifier can't wedge the run.
//
// SECURITY: verification commands are spawned as executable + argv with
// `shell: false`. The command string is tokenized into an argv array *without*
// shell interpolation, so metacharacters (;  &&  |  $()  etc.) are passed as
// literal arguments to the executable rather than being interpreted by a shell.
// This is defense-in-depth: even if the authorization gate on
// `set_task_verification` were bypassed, an attacker cannot achieve shell
// injection through the verification command.

import { spawn } from 'node:child_process';
import type { TaskNode, TaskResult } from '@wrongstack/core/types';

export interface CommandVerifierOptions {
  /** Metadata key holding the verification command. Default 'verificationCommand'. */
  metadataKey?: string;
  /** Kill + fail the verification after this many ms. Default 180_000 (3 min). */
  timeoutMs?: number;
}

/**
 * Tokenize a command string into an argv array **without** shell interpolation.
 *
 * Splits on whitespace while respecting single and double quotes (matching
 * POSIX shell quoting rules for the common cases). Shell metacharacters
 * (`;`, `|`, `&&`, `$()`, backticks, `>`, `<`) that appear *inside* a token
 * are preserved as literal characters — they are passed to the executable as
 * argument data, never interpreted by a shell.
 *
 * Returns `undefined` when the input is empty/whitespace or contains
 * unbalanced quotes (which would indicate a malformed command).
 */
export function tokenizeCommand(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  const argv: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < trimmed.length) {
        // Inside double quotes, backslash escapes only ", \, $, and `.
        const next = trimmed[i + 1]!;
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }

    if (ch === '\\' && i + 1 < trimmed.length) {
      // Outside quotes, backslash escapes the next character literally.
      current += trimmed[i + 1]!;
      i++;
      hasToken = true;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (hasToken) {
        argv.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += ch;
    hasToken = true;
  }

  // Unbalanced quote — refuse to execute.
  if (inSingle || inDouble) return undefined;

  if (hasToken) argv.push(current);

  return argv.length > 0 ? argv : undefined;
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
  /**
   * Task-metadata key that holds the deterministic verification command. Must
   * match {@link CommandVerifierOptions.metadataKey}: whether a command exists
   * is what decides if an inconclusive judge may fail open. Default
   * `'verificationCommand'`.
   */
  commandMetadataKey?: string;
}

/**
 * LLM acceptance-criteria check: when a task's description carries an
 * "**Acceptance Criteria:**" block, ask an isolated judge turn whether the
 * worker's reported result satisfies the criteria.
 *
 * WS-023: this used to pass on ANY non-explicit-FAIL — a provider error or an
 * unparseable verdict returned `{ok: true}` — justified by "the command
 * verifier remaining the deterministic backstop, so a flaky judge can never
 * wedge a run".
 *
 * That reasoning is sound where the backstop exists, and the backstop is
 * agent-authored task metadata that defaults to absent: `makeCommandVerifier`
 * returns `{ok: true}` when a task carries no verification command. So for a
 * task with acceptance criteria and no command — which the same agent decides
 * — an inconclusive judge meant nothing verified anything, and the work was
 * accepted on the worker's own say-so.
 *
 * The rule is therefore made true rather than reversed: an inconclusive judge
 * fails open ONLY when the deterministic backstop it defers to actually
 * exists. With no command verifier the judge is the only gate, so it fails
 * closed. Transient provider trouble is retried once first, so a single blip
 * still cannot wedge a run.
 */
export function makeAcceptanceCriteriaVerifier(
  options: AcceptanceCriteriaVerifierOptions,
): SddVerifyTask {
  const maxResultChars = options.maxResultChars ?? 4000;
  const commandMetadataKey = options.commandMetadataKey ?? 'verificationCommand';
  return async function verifyTask(info) {
    const description = info.task.description ?? '';
    const marker = description.indexOf('**Acceptance Criteria:**');
    // No criteria declared: nothing for this verifier to judge. Requiring
    // criteria on every task is a task-graph authoring policy, decided where
    // graphs are built, not here.
    if (marker === -1) return { ok: true };

    // Does the deterministic backstop this verifier may defer to exist?
    const rawCommand = info.task.metadata?.[commandMetadataKey];
    const hasCommandBackstop = typeof rawCommand === 'string' && rawCommand.trim().length > 0;
    const inconclusive = (detail: string): { ok: boolean; reason?: string } =>
      hasCommandBackstop
        ? { ok: true }
        : {
            ok: false,
            reason:
              `acceptance criteria could not be verified (${detail}) and this task declares ` +
              'no verification command, so nothing else checked the result',
          };
    const criteria = description.slice(marker);
    const resultText =
      typeof info.result.result === 'string'
        ? info.result.result.slice(0, maxResultChars)
        : JSON.stringify(info.result.result ?? '').slice(0, maxResultChars);

    const prompt = [
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
    ].join('\n');

    // One retry: a single transient provider failure must not be able to fail
    // a task closed, which would be its own way of making the gate useless.
    let text: string | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        text = await options.run(prompt);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (text === undefined) {
      return inconclusive(
        `judge unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
    const match = text.match(/VERDICT:\s*(PASS|FAIL)(?:\s*[—-]\s*(.*))?/i);
    if (!match) return inconclusive('judge returned no parseable verdict');
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
 * otherwise spawns the command in `cwd` as `executable + argv` with `shell: false`
 * (no shell interpolation), and resolves `{ ok: false, reason }` on non-zero exit,
 * spawn error, malformed command, or timeout.
 *
 * Defense-in-depth: even if the authorization gate on `set_task_verification`
 * were bypassed, shell metacharacters (`;`, `|`, `&&`, `$()`, etc.) are tokenized
 * into literal arguments rather than being interpreted by a shell.
 */
export function makeCommandVerifier(options: CommandVerifierOptions = {}) {
  const metadataKey = options.metadataKey ?? 'verificationCommand';
  const timeoutMs = options.timeoutMs ?? 180_000;

  return async function verifyTask(info: {
    task: TaskNode;
    result: TaskResult;
    cwd: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const rawCommand = info.task.metadata?.[metadataKey];
    if (typeof rawCommand !== 'string' || !rawCommand.trim()) return { ok: true };

    // Tokenize the command string into executable + argv WITHOUT shell
    // interpolation. Metacharacters become literal argument data.
    const argv = tokenizeCommand(rawCommand);
    if (!argv || argv.length === 0) {
      return { ok: false, reason: `verification command is malformed: ${rawCommand}` };
    }

    const [executable, ...args] = argv;

    return await new Promise((resolve) => {
      const child = spawn(executable!, args, {
        cwd: info.cwd,
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        resolve({ ok: false, reason: `verification timed out: ${rawCommand}` });
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        // Don't overwrite the timeout reason once the timer has fired.
        if (timedOut) return;
        resolve(
          code === 0
            ? { ok: true }
            : { ok: false, reason: `verification failed (exit ${code}): ${rawCommand}` },
        );
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: `verification spawn error: ${String(err)}` });
      });
    });
  };
}
