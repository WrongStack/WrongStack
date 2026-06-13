import { spawn } from 'node:child_process';
import { buildChildEnv } from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';
import { compileUserRegex } from './_regex.js';
import { safeResolve } from './_util.js';

interface LogsInput {
  service?: string | undefined;
  path?: string | undefined;
  lines?: number | undefined;
  stream?: boolean | undefined;
  filter?: string | undefined;
  since?: '1h' | '6h' | '24h' | 'all' | undefined;
  cwd?: string | undefined;
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  source?: string | undefined;
}

interface LogsOutput {
  source: string;
  entries: LogEntry[];
  total: number;
  truncated: boolean;
  stream_mode: boolean;
}

export const logsTool: Tool<LogsInput, LogsOutput> = {
  name: 'logs',
  category: 'Logs',
  description:
    'Read or stream logs from files, Docker containers, or systemd services. Useful for debugging running applications.',
  usageHint:
    'DEBUGGING TOOL — USE CAREFULLY IN AUTONOMOUS MODE:\n\n' +
    '- Prefer `path` for local files or `service` for containers/systemd.\n' +
    '- `stream: true` = live tail (can be expensive).\n' +
    '- Always use `filter` (regex) when possible to reduce noise and token usage.\n' +
    '- Long-running streams should be avoided unless the user explicitly wants live logs.',
  permission: 'confirm',
  mutating: false,
  timeoutMs: 30_000,
  capabilities: ['shell.restricted'],
  inputSchema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description: 'Service name for Docker or systemd journal',
      },
      path: {
        type: 'string',
        description: 'Path to log file (alternative to service)',
      },
      lines: {
        type: 'integer',
        description: 'Number of log lines to fetch (default: 100, 0 for all)',
        minimum: 0,
        maximum: 10000,
      },
      stream: {
        type: 'boolean',
        description: 'Stream logs continuously (like tail -f) (default: false)',
      },
      filter: {
        type: 'string',
        description: 'Regex pattern to filter log lines',
      },
      since: {
        type: 'string',
        enum: ['1h', '6h', '24h', 'all'],
        description: 'Only show logs since duration',
      },
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
    },
  },
  async execute(input, ctx, opts) {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const lines = input.lines ?? 100;
    let filterRe: RegExp | null = null;
    if (input.filter) {
      const compiled = compileUserRegex(input.filter, 'i');
      if (!compiled.ok) {
        throw new Error(`logs: ${compiled.reason}`);
      }
      filterRe = compiled.regex;
    }

    if (input.service) {
      return await dockerLogs(input.service, lines, filterRe, cwd, opts.signal);
    }

    if (input.path) {
      return await fileLogs(safeResolve(input.path, ctx), lines, filterRe, input.stream ?? false);
    }

    return {
      source: 'none',
      entries: [],
      total: 0,
      truncated: false,
      stream_mode: false,
    };
  },
};

async function dockerLogs(
  service: string,
  lines: number,
  filterRe: RegExp | null,
  cwd: string,
  signal: AbortSignal,
  since?: string | undefined,
): Promise<LogsOutput> {
  const args = ['logs'];
  if (lines > 0) args.push('--tail', String(lines));
  if (since) {
    const sinceMap: Record<string, string> = { '1h': '1h', '6h': '6h', '24h': '24h' };
    args.push('--since', sinceMap[since] ?? '1h');
  }
  // Validate service name to prevent container name injection.
  // Docker container names are limited to [a-zA-Z0-9][a-zA-Z0-9._-]+.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]+$/.test(service)) {
    return {
      source: `docker:${service}`,
      entries: [],
      total: 0,
      truncated: false,
      stream_mode: false,
    };
  }
  args.push('--timestamps', service);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const MAX = 200_000;
    let settled = false;

    const empty = (): LogsOutput => ({
      source: `docker:${service}`,
      entries: [],
      total: 0,
      truncated: false,
      stream_mode: false,
    });
    const finish = (result: LogsOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn('docker', args, { cwd, signal, env: buildChildEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    // `docker logs --tail N` reads recent lines and exits — fast when the
    // daemon is up. But if the daemon is unreachable (common on CI runners
    // with no running Docker), the CLI can hang on the socket connection and
    // emit neither `close` nor `error`. Kill it and return empty so the tool
    // (and its tests) never hang.
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(empty());
    }, DOCKER_LOGS_TIMEOUT_MS);

    child.stdout?.on('data', (c) => {
      if (stdout.length < MAX) stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      if (stderr.length < MAX) stderr += c.toString();
    });
    // When the child is SIGTERM-killed on timeout (or aborted via `signal`),
    // its pipes can emit `error` (e.g. EPIPE on Windows). Without a listener
    // that surfaces as an unhandled error and can fail the host/test — swallow
    // it; `child.on('error')` and the timeout already drive the result.
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.on('close', () => {
      const output = stdout + stderr;
      const entries = parseLogLines(output, filterRe);
      finish({
        source: `docker:${service}`,
        entries,
        total: entries.length,
        truncated: output.length >= MAX,
        stream_mode: false,
      });
    });
    child.on('error', () => finish(empty()));
  });
}

/**
 * Hard ceiling for a `docker logs` read. The daemon may be unreachable on CI
 * (no Docker running), where the CLI hangs on the socket without ever exiting.
 */
const DOCKER_LOGS_TIMEOUT_MS = 3_000;

// Hard cap on tail-window size — `lines: 0` historically meant "all" and
// happily buffered an entire multi-GB log into memory. Cap at 100k lines;
// callers that need more should narrow with `filter`.
const MAX_TAIL_LINES = 100_000;

async function fileLogs(
  path: string,
  lines: number,
  filterRe: RegExp | null,
  stream: boolean,
): Promise<LogsOutput> {
  const { createInterface } = await import('node:readline');
  const { createReadStream } = await import('node:fs');
  const entries: LogEntry[] = [];

  // Effective tail window: clamp to MAX_TAIL_LINES; treat 0 / negative as
  // "max window" rather than "unlimited" so a malicious /proc/kcore path
  // cannot OOM the worker.
  const effLines = lines > 0 ? Math.min(lines, MAX_TAIL_LINES) : MAX_TAIL_LINES;
  // Rolling window backed by a fixed-size circular buffer — at most
  // `effLines` strings live in memory regardless of file size.
  const window: string[] = new Array(effLines);
  let writeIdx = 0;
  let totalLines = 0;

  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (filterRe && !filterRe.test(line)) continue;
    window[writeIdx] = line;
    writeIdx = (writeIdx + 1) % effLines;
    totalLines++;
  }

  // Read the window back in arrival order.
  const ordered: string[] = [];
  const start = totalLines >= effLines ? writeIdx : 0;
  const count = Math.min(totalLines, effLines);
  for (let i = 0; i < count; i++) {
    const v = window[(start + i) % effLines];
    if (v !== undefined) ordered.push(v);
  }

  for (const line of ordered) {
    const parsed = parseLine(line);
    if (parsed) entries.push(parsed);
  }

  return {
    source: path,
    entries,
    total: entries.length,
    truncated: totalLines > effLines,
    stream_mode: stream,
  };
}

function parseLogLines(output: string, filterRe: RegExp | null): LogEntry[] {
  const lines = output.split('\n').filter(Boolean);
  const entries: LogEntry[] = [];

  for (const line of lines) {
    if (filterRe && !filterRe.test(line)) continue;
    const parsed = parseLine(line);
    if (parsed) entries.push(parsed);
  }

  return entries;
}

function parseLine(line: string): LogEntry | null {
  const tsRe = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(?:\[?(\w+)\]?)\s*(.*)/;
  const match = tsRe.exec(line);

  if (match) {
    return {
      timestamp: match[1] ?? '',
      level: match[2]?.toLowerCase() ?? 'info',
      message: match[3] ?? '',
    };
  }

  const levelRe = /(ERROR|WARN|INFO|DEBUG|TRACE)\s+(.*)/i;
  const levelMatch = levelRe.exec(line);

  if (levelMatch) {
    return {
      timestamp: '',
      level: levelMatch[1]?.toLowerCase() ?? 'info',
      message: levelMatch[2] ?? line,
    };
  }

  return {
    timestamp: '',
    level: 'info',
    message: line,
  };
}
