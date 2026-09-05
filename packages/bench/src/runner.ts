import { type ChildProcess, spawn } from 'node:child_process';
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
  const args = [
    opts.wstackEntry,
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
    ...(opts.extraArgs ?? []),
  ];

  const startedAt = Date.now();
  return new Promise<RawRun>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.nodeBin, args, {
        cwd: opts.workdir,
        env: { ...process.env, ...opts.env, WRONGSTACK_HOME: opts.homeDir },
        // windowsHide + no detached: per the repo spawn convention, detached on
        // win32 voids CREATE_NO_WINDOW and pops visible consoles for grandchildren.
        windowsHide: true,
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

    const timer = setTimeout(() => {
      timedOut = true;
      treeKill(child);
    }, opts.timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    const finish = (run: RawRun) => {
      /* v8 ignore next -- guards against a late close after error/timeout already settled; defensive. */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };

    child.on('error', (err) => {
      finish(crashed(startedAt, `process error: ${err.message}`));
    });

    child.on('close', (code) => {
      const elapsedMs = Date.now() - startedAt;
      if (timedOut) {
        finish({
          status: 'timeout',
          finalText: null,
          iterations: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          elapsedMs,
          exitCode: code,
        });
        return;
      }
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
  let foundStatus = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A malformed `{` line. If no valid status payload was found anywhere,
      // this malformed line is the true (broken) payload — abort rather than
      // substitute an earlier, unrelated run's JSON.
      if (!foundStatus) return undefined;
      continue;
    }
    if (typeof obj['status'] !== 'string') {
      // A valid JSON object but not a run payload (e.g. a log line). Not the
      // output we're looking for; keep scanning for an actual payload.
      continue;
    }
    foundStatus = true;
    const usage = (obj['usage'] as Record<string, unknown> | undefined) ?? {};
    const parsed: Omit<RawRun, 'elapsedMs' | 'exitCode'> = {
      status: normalizeStatus(obj['status'] as string),
      finalText: typeof obj['finalText'] === 'string' ? (obj['finalText'] as string) : null,
      iterations: num(usage['iterations']),
      tokensIn: num(usage['input']),
      tokensOut: num(usage['output']),
      costUsd: num(usage['cost']),
    };
    // The CLI reports *why* the loop failed in `error`. Dropping it left a
    // `failed` row in the report with no diagnosis at all.
    const message = errorMessage(obj['error']);
    if (message) parsed.errorMessage = message;
    return parsed;
  }
  return undefined;
}

/** Pull a readable reason out of the `--output-json` `error` object. */
function errorMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const err = raw as Record<string, unknown>;
  const message = typeof err['message'] === 'string' ? err['message'].trim() : '';
  if (message.length === 0) return undefined;
  const code = typeof err['code'] === 'string' && err['code'].length > 0 ? `${err['code']}: ` : '';
  return `${code}${message}`.slice(0, 500);
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

function crashDetail(code: number | null, stderr: string, stdout: string): string {
  const tail = [stderr, stdout]
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join('\n')
    .slice(-2000);
  const prefix = `exit ${code ?? 'null'}`;
  return tail ? `${prefix}: ${tail}` : prefix;
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
    elapsedMs: Date.now() - startedAt,
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
    killer.once('error', () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    });
    killer.unref();
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  /* v8 ignore start -- 2s SIGKILL backstop fires only if SIGTERM didn't end the process; not exercised in fast unit tests. */
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 2000).unref();
  /* v8 ignore stop */
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
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
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
