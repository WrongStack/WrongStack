import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';

/**
 * Every task workdir is its own project, and each `wstack` run starts that
 * project's daemons (session catalog, mailbox, kanban, chronicle, sage,
 * codebase index), which outlive the run by their idle timeout. A full
 * polyglot pass left 100+ of them alive at once; Windows then failed to
 * create processes (`spawn UNKNOWN`) and agents died on allocation failures.
 */

/**
 * Idle timeouts handed to each run's environment, which its daemons inherit:
 * they stay up while the agent is connected and exit soon after it is gone.
 */
export const BENCH_DAEMON_IDLE_ENV: Readonly<Record<string, string>> = {
  WRONGSTACK_SESSION_CATALOG_IDLE_MS: '15000',
  WRONGSTACK_MAILBOX_SERVER_IDLE_MS: '15000',
  WRONGSTACK_KANBAN_SERVER_IDLE_MS: '15000',
  WRONGSTACK_CHRONICLE_SERVER_IDLE_MS: '15000',
  WRONGSTACK_SAGE_SERVER_IDLE_MS: '15000',
  WRONGSTACK_INDEX_SERVER_IDLE_MS: '15000',
};

interface ProcessRow {
  pid: number;
  commandLine: string;
}

/**
 * Kill every process whose command line names one of `roots` (a finished
 * task's workdir and project home, or the whole sandbox). Best-effort and
 * never throws: a leftover daemon must not fail the benchmark.
 */
export async function reapProcessesUnder(roots: readonly string[]): Promise<number> {
  const needles = roots
    .map((root) => normalize(root).replace(/\/+$/, ''))
    .filter((root) => root.length > 0);
  if (needles.length === 0) return 0;
  let rows: ProcessRow[];
  try {
    rows = await listProcesses();
    /* v8 ignore next 3 -- an unreadable process table only skips the sweep. */
  } catch {
    return 0;
  }
  let killed = 0;
  for (const row of rows) {
    if (row.pid === process.pid) continue;
    const line = normalize(row.commandLine);
    if (!needles.some((needle) => commandLineNamesRoot(line, needle))) continue;
    try {
      process.kill(row.pid);
      killed++;
      /* v8 ignore next 3 -- the process exited between listing and kill. */
    } catch {
      // Already gone.
    }
  }
  return killed;
}

function isPathBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '/' || /[\s"'=,:;)\]}]/.test(ch);
}

/** Match `needle` only on path/argument boundaries so `task-1` never kills `task-10`. */
function commandLineNamesRoot(line: string, needle: string): boolean {
  let from = 0;
  while (from <= line.length - needle.length) {
    const idx = line.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? line[idx - 1] : undefined;
    const after = line[idx + needle.length];
    if (isPathBoundary(before) && isPathBoundary(after)) return true;
    from = idx + 1;
  }
  return false;
}

/** Case- and separator-insensitive form for matching paths inside command lines. */
function normalize(value: string): string {
  const unified = value.replaceAll('\\', '/');
  /* v8 ignore next -- one side per host platform. */
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/** Exported for tests. */
export function sandboxRootsFor(workdir: string, projectHome: string): string[] {
  return [path.resolve(workdir), path.resolve(projectHome)];
}

/* v8 ignore start -- the OS process table: one platform branch runs per host, and
   sandbox-reaper.test exercises it end-to-end there. */
function listProcesses(): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='bun.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { env: buildChildEnv(), windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
        (err, stdout) => {
          if (err) return reject(err);
          const raw = stdout.trim();
          if (!raw) return resolve([]);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw) as unknown;
          } catch (parseErr) {
            return reject(parseErr);
          }
          const list = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
            ProcessId?: unknown;
            CommandLine?: unknown;
          }>;
          resolve(
            list
              .filter((r) => typeof r.ProcessId === 'number' && typeof r.CommandLine === 'string')
              .map((r) => ({ pid: r.ProcessId as number, commandLine: r.CommandLine as string })),
          );
        },
      );
      return;
    }
    execFile(
      'ps',
      ['-eo', 'pid=,args='],
      { env: buildChildEnv(), maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const space = line.indexOf(' ');
              return { pid: Number(line.slice(0, space)), commandLine: line.slice(space + 1) };
            })
            .filter((row) => Number.isFinite(row.pid)),
        );
      },
    );
  });
}
/* v8 ignore stop */
