import { type ChildProcess, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { cliSpawnArgs } from '@wrongstack/core/utils';
import {
  treeKill as killChildTree,
  settleWin32Kill,
  WIN32_TREE_KILL_BUDGET_MS,
} from '@wrongstack/core/utils/tree-kill';
import { inheritedEnv } from './child-env.js';
import { type BenchProfile, LEAN_BENCH_TOOL_NAMES } from './isolation.js';
import { BENCH_DAEMON_IDLE_ENV } from './sandbox-reaper.js';
import { safePrefix, safeSuffix } from './string-boundaries.js';
import type { ModelCell, RawRun } from './types.js';

/** Everything needed to run one (task × cell) subprocess. */
export interface RunWstackOptions {
  /** Node executable (process.execPath). */
  nodeBin: string;
  /** Path to the wstack CLI entry (dist/index.js) — or a fake in tests. */
  wstackEntry: string;
  /** Isolated WRONGSTACK_HOME for this run. */
  homeDir: string;
  /** Task workdir (becomes the subprocess cwd / projectRoot). */
  workdir: string;
  cell: ModelCell;
  prompt: string;
  timeoutMs: number;
  /** Extra env merged over process.env (e.g. provider keys already present). */
  env?: NodeJS.ProcessEnv | undefined;
  /** Extra CLI args appended after the standard set (Phase 2 hooks). */
  extraArgs?: string[] | undefined;
  /** Lean runs pin six file/shell tools; host runs keep the active profile's tools. */
  profile?: BenchProfile | undefined;
  /** Kills the agent's process tree when the bench is stopped. */
  signal?: AbortSignal | undefined;
}

/**
 * Run the real `wstack` binary once, in single-shot `--output-json` mode, and
 * parse its machine-readable result. This is the heart of the model-independent
 * design: the subprocess is the *whole* harness (real wiring, real tools), and
 * the only thing that varies between calls is `--provider`/`--model`.
 *
 * Never rejects — a crash, non-JSON output, or timeout becomes a RawRun with an
 * explanatory status so the grader still produces a row.
 */
export async function runWstack(opts: RunWstackOptions): Promise<RawRun> {
  const args = cliSpawnArgs(opts.wstackEntry, [
    '--prompt',
    opts.prompt,
    '--provider',
    opts.cell.provider,
    '--model',
    opts.cell.model,
    '--output-json',
    '--no-tui',
    '--no-interactive',
    '--no-banner',
    '--yolo',
    '--no-models-refresh',
    '--skip-index',
    // The sandbox config is the harness (lean `quick`, or a `--harness` A/B
    // variant); without this the CLI's headless default would pin `quick` over it.
    '--host-profile',
    ...(opts.extraArgs ?? []),
    ...(opts.profile === 'host'
      ? []
      : [
          '--only-tools',
          LEAN_BENCH_TOOL_NAMES.join(','),
          // --only-tools preserves the lazy gateways by design. Deny them
          // explicitly so discovery cannot add schemas during a lean run.
          '--disallowed-tools',
          'tool_search,tool_use',
        ]),
  ]);

  const startedAt = performance.now();
  return new Promise<RawRun>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.nodeBin, args, {
        cwd: opts.workdir,
        env: {
          ...inheritedEnv(),
          ...BENCH_DAEMON_IDLE_ENV,
          ...opts.env,
          WRONGSTACK_HOME: opts.homeDir,
        },
        // POSIX needs a dedicated process group so timeout/abort reaches descendants.
        // Windows must stay attached so CREATE_NO_WINDOW hides grandchildren.
        detached: process.platform !== 'win32',
        windowsHide: true,
        // Closed stdin: single-shot mode reads piped stdin as prompt context,
        // and an open-but-silent pipe would cost every run the first-byte wait.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(
        /* v8 ignore next -- spawn throws Error subclasses; the String(err) branch is defensive. */
        crashed(startedAt, `spawn failed: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killBackstop: ReturnType<typeof setTimeout> | undefined;

    const MAX_TIMEOUT_CHUNK_MS = 2_147_483_647;
    let remainingMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
    let timer: ReturnType<typeof setTimeout>;
    const scheduleTimeout = () => {
      const chunkMs = Math.min(remainingMs, MAX_TIMEOUT_CHUNK_MS);
      remainingMs -= chunkMs;
      timer = setTimeout(() => {
        if (remainingMs > 0) {
          scheduleTimeout();
          return;
        }
        timedOut = true;
        treeKill(child);
        // A surviving descendant can keep the output pipes open after the
        // child exits. Let tree cleanup finish, but don't wait forever for close.
        const graceMs = process.platform === 'win32' ? WIN32_TREE_KILL_BUDGET_MS + 1000 : 5_000;
        killBackstop = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finishTimeout(child.exitCode);
        }, graceMs);
      }, chunkMs);
    };
    scheduleTimeout();
    const onAbort = () => treeKill(child);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Decode across chunks: `d.toString()` per Buffer turned a multibyte
    // character split between two pipe reads into U+FFFD pairs inside the
    // graded finalText.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr += d;
    });

    const finish = (run: RawRun) => {
      /* v8 ignore next -- guards against a late close after error/timeout already settled; defensive. */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killBackstop);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(run);
    };
    const finishTimeout = (code: number | null) => {
      finish({
        status: 'timeout',
        finalText: null,
        iterations: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        elapsedMs: performance.now() - startedAt,
        exitCode: code,
      });
    };

    child.on('error', (err) => {
      finish(crashed(startedAt, `process error: ${err.message}`));
    });

    child.on('close', (code) => {
      if (timedOut) {
        finishTimeout(code);
        return;
      }
      const elapsedMs = performance.now() - startedAt;
      const parsed = parseOutputJson(stdout);
      if (!parsed) {
        finish({
          status: 'crashed',
          finalText: null,
          iterations: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          elapsedMs,
          exitCode: code,
          crashDetail: crashDetail(code, stderr, stdout),
        });
        return;
      }
      finish({ ...parsed, elapsedMs, exitCode: code });
    });
  });
}

/**
 * Find and parse the `--output-json` payload. The CLI prints exactly one such
 * line via writeOut; we scan from the end so any stray stdout before it is
 * ignored. Returns the RawRun minus elapsedMs/exitCode (filled by the caller).
 */
function parseOutputJson(stdout: string): Omit<RawRun, 'elapsedMs' | 'exitCode'> | undefined {
  const lines = stdout.split('\n');
  // Scan from the end so any stray stdout/log lines before the payload are
  // ignored, and trailing non-payload noise (e.g. a `{ "level": "info" }` log
  // line AFTER the result) does not hide a valid payload that precedes it.
  // We pick the LAST line that parses to a status-bearing object. If NO line
  // parses but some line begins with `{`, the payload is genuinely malformed
  // (a multiline finalText, an adapter emitting a raw newline, or a truncated
  // write) — do not reach further back to a stale payload from an unrelated
  // earlier run; report the run as unparseable (crashed) instead.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A malformed `{` line. Since we scan backwards from the end, a broken
      // `{` line before finding a status payload means the payload is corrupted —
      // abort rather than substitute an earlier, unrelated run's JSON.
      return undefined;
    }
    if (typeof obj['status'] !== 'string') {
      // A valid JSON object but not a run payload (e.g. a log line). Not the
      // output we're looking for; keep scanning for an actual payload.
      continue;
    }
    const usage = (obj['usage'] as Record<string, unknown> | undefined) ?? {};
    const parsed: Omit<RawRun, 'elapsedMs' | 'exitCode'> = {
      status: normalizeStatus(obj['status'] as string),
      finalText: typeof obj['finalText'] === 'string' ? (obj['finalText'] as string) : null,
      iterations: num(usage['iterations']),
      tokensIn: num(usage['input']),
      tokensOut: num(usage['output']),
      costUsd: num(usage['cost']),
      costSource: usage['costSource'] === 'catalog-estimate' ? 'catalog-estimate' : 'unknown',
    };
    // The CLI reports *why* the loop failed in `error`. Dropping it left a
    // `failed` row in the report with no diagnosis at all.
    const message = errorMessage(obj['error']);
    if (message) parsed.errorMessage = message;
    return parsed;
  }
  return undefined;
}

/** Pull a readable reason out of the `--output-json` `error` object. Exported for tests. */
export function errorMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const err = raw as Record<string, unknown>;
  const message = typeof err['message'] === 'string' ? err['message'].trim() : '';
  if (message.length === 0) return undefined;
  const code = typeof err['code'] === 'string' && err['code'].length > 0 ? `${err['code']}: ` : '';
  return safePrefix(`${code}${message}`, 500);
}

function normalizeStatus(s: string): RawRun['status'] {
  switch (s) {
    case 'completed':
    case 'done':
      return 'completed';
    case 'failed':
    case 'aborted':
    case 'max_iterations':
      return s;
    default:
      return 'failed';
  }
}

/** Format crash diagnostic tail. Exported for tests. */
export function crashDetail(code: number | null, stderr: string, stdout: string): string {
  const tail = [stderr, stdout]
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join('\n');
  const boundedTail = safeSuffix(tail, 2000);
  const prefix = `exit ${code ?? 'null'}`;
  return boundedTail ? `${prefix}: ${boundedTail}` : prefix;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function crashed(startedAt: number, reason: string): RawRun {
  return {
    status: 'crashed',
    finalText: null,
    iterations: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    elapsedMs: performance.now() - startedAt,
    exitCode: null,
    crashDetail: reason,
  };
}

/**
 * Kill a child and its descendants. On Windows a plain child.kill() orphans
 * grandchildren (cmd.exe, bash, the model's spawned processes) that keep stdio
 * pipes open; taskkill /T tears down the whole tree. POSIX gets SIGTERM then a
 * SIGKILL backstop.
 */
export function treeKill(child: ChildProcess): void {
  /* v8 ignore next -- a successfully-spawned child always has a pid; the guard is defensive. */
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    settleWin32Kill(killer, child, () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    });
    return;
  }
  // All benchmark launchers create dedicated POSIX groups. The shared helper
  // checks PID safety before signaling the group and falls back to the handle.
  killChildTree(child, { force: true, processGroupLeader: true });
}

/**
 * Map `items` through `fn` with at most `concurrency` in flight at once.
 * Results preserve input order. A tiny dependency-free p-limit.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const limit = Math.max(1, Math.min(requested, items.length || 1));
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
