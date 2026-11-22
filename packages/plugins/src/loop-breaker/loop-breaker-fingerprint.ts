/**
 * loop-breaker plugin — detects runaway tool-call loops and breaks them.
 *
 * Agents occasionally get stuck re-issuing the same tool call with the
 * same input (a failing bash command retried forever, re-reading the
 * same file, re-writing identical content). Each repeat burns tokens
 * and wall-clock without making progress. This plugin fingerprints
 * every tool call (`toolName` + canonicalized input JSON) via a
 * `PreToolUse '*'` hook and tracks consecutive repeats:
 *
 *  - at `warnAfter` repeats  → inject `additionalContext` telling the
 *    model it is looping and should change approach
 *  - at `blockAfter` repeats → block the call outright with a clear
 *    reason (unless `mode: 'warn'`)
 *
 * Any *different* call resets the streak, so normal workflows (many
 * distinct reads/edits) are never touched. A small LRU of recent
 * fingerprints also catches A-B-A-B oscillation loops.
 *
 * Config (`config.extensions['loop-breaker']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "mode": "block",        // "block" (default) | "warn"
 *   "warnAfter": 3,                // consecutive identical calls before warning
 *   "blockAfter": 5,               // consecutive identical calls before blocking
 *   "oscillationWindow": 8,        // recent-call window for A-B-A-B detection
 *   "maxSteps": 0,                 // unlimited by default; positive values opt into a cap
 *   "noDiffWarnAfter": 6,          // edit/write steps with unchanged git diff before warning
 *   "noDiffBlockAfter": 10,        // edit/write steps with unchanged git diff before blocking
 *   "repeatedErrorWarnAfter": 2,   // same tool error before warning
 *   "repeatedErrorBlockAfter": 3,  // same tool error before blocking
 *   "ignoreTools": []              // tool names exempt from loop detection
 * }
 * ```
 *
 * Opt in with `"enabled": true` in `config.extensions['loop-breaker']`.
 *
 * @public
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { gitIsolationEnv } from '@wrongstack/primitives';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalize a tool input to a stable string: object keys are sorted
 * recursively so `{a:1,b:2}` and `{b:2,a:1}` produce the same
 * fingerprint. Non-serializable inputs fall back to String().
 */
export function canonicalize(value: unknown): string {
  try {
    return JSON.stringify(sortKeys(value));
  } catch {
    return String(value);
  }
}

/**
 * Depth beyond which nested values are summarised rather than walked.
 * Tool inputs are shallow in practice; this only bounds pathological ones.
 */
export const CANONICALIZE_MAX_DEPTH = 12;

/**
 * Key-sorted deep copy, used to give equivalent tool inputs the same
 * fingerprint regardless of key order.
 *
 * Bounded on both depth and cycles. Unbounded recursion here was not
 * merely a crash risk: a circular or very deep input blew the stack, the
 * caller caught the `RangeError`, and fell back to `String(value)` —
 * which is `"[object Object]"` for *every* such input. All of them then
 * fingerprinted identically, and loop-breaker saw a repeat loop that was
 * not happening. A false positive here interrupts the agent, so the
 * fingerprint has to stay discriminating even for awkward inputs.
 */
export function sortKeys(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  if (depth >= CANONICALIZE_MAX_DEPTH) {
    // Keep the subtree discriminating: a fixed marker made every input that
    // differed only below this depth fingerprint identically — a false repeat
    // loop. Unsorted keys here can only miss a repeat, never invent one.
    try {
      return `[deep:${JSON.stringify(value)}]`;
    } catch {
      return Array.isArray(value) ? `[array:${value.length}]` : '[deep-object]';
    }
  }
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => sortKeys(v, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      Object.defineProperty(out, key, {
        value: sortKeys((value as Record<string, unknown>)[key], depth + 1, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  } finally {
    // Leave the node once its subtree is done: a value that legitimately
    // appears twice in sibling branches is not a cycle, and collapsing it
    // to a marker would make two genuinely different inputs look alike.
    seen.delete(value as object);
  }
}

export function fingerprint(toolName: string, toolInput: unknown): string {
  return `${toolName}\u0000${canonicalize(toolInput)}`;
}

/**
 * Detect an A-B-A-B oscillation: the window alternates between exactly
 * two fingerprints for its entire length. Requires a full window.
 */
export function isOscillating(recent: string[], windowSize: number): boolean {
  if (recent.length < windowSize) return false;
  const window = recent.slice(-windowSize);
  const unique = new Set(window);
  if (unique.size !== 2) return false;
  for (let i = 2; i < window.length; i++) {
    if (window[i] !== window[i - 2]) return false;
  }
  return window[0] !== window[1];
}

/**
 * Digest a payload for the "did this change?" comparison in
 * {@link gitDiffFingerprint}.
 *
 * The whole string is hashed. Stopping at a fixed prefix made every payload
 * that agreed for its first megabyte fingerprint identically, so a genuinely
 * rewritten large file read as a mutating step without progress and the streak
 * blocked the run — the same false-repeat class this module exists to prevent.
 * The work is linear over a string the caller already materialised (the diff is
 * bounded by the spawn's `maxBuffer`, an untracked body was just read into
 * memory), and a bounded sample cannot promise that a change reaches the digest.
 */
export function hashString(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

export async function gitDiffFingerprint(
  cwd: string,
  targetPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  const pathspec = isAbsolute(targetPath) ? relative(cwd, targetPath) : targetPath;
  if (
    !pathspec ||
    isAbsolute(pathspec) ||
    pathspec === '..' ||
    pathspec.startsWith('../') ||
    pathspec.startsWith('..\\')
  ) {
    return null;
  }
  const git = async (args: string[]): Promise<string> => {
    // The repository's config names programs git runs on status/diff
    // (fsmonitor, `.gitattributes` filters); when they cannot be switched off,
    // git does not run.
    const isolation = await gitIsolationEnv(cwd, { timeoutMs: 1_000 });
    if (!isolation) throw new Error('git isolation unavailable');
    return new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd,
          env: { ...process.env, ...isolation },
          encoding: 'utf8',
          timeout: 1_000,
          // The hook follows only the file touched by this edit/write. A whole
          // repository diff duplicated diff-summary and could retain 16 MiB on
          // every mutation in a large dirty worktree.
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          signal,
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  };
  try {
    const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--', pathspec]);
    if (diff.length > 0) return hashString(diff);
    // `git diff` is empty for an UNTRACKED file however it changes, so every
    // write while scaffolding new files read as "no diff" and the streak
    // blocked a run that was making steady progress. Fingerprint such a file
    // by path + content instead: rewriting it unchanged still repeats.
    try {
      await git(['ls-files', '--error-unmatch', '--', pathspec]);
      return '';
    } catch (err) {
      if (signal.aborted) throw err;
      const content = await readFile(join(cwd, pathspec), 'utf8');
      return `untracked:${hashString(`${pathspec}\u0000${content}`)}`;
    }
  } catch (err) {
    if (signal.aborted) throw err;
    return null;
  }
}

export function normalizeError(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join('\n')
    .replace(/\b\d{2,}\b/g, '<n>')
    .slice(0, 1_000);
}
